// 持仓监控模块 — 止损止盈 + 紧急卖出
const config = require('./config');
const logger = require('./logger');
const trader = require('./trader');
const notifier = require('./notifier');

let monitoring = false;
let monitorTimer = null;

// 价格历史（用于检测闪崩）
const priceHistory = {}; // mint -> [{price, time}]

async function checkPositions() {
  const positions = trader.loadPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const currentPrice = await trader.getTokenPrice(pos.mint);
      if (!currentPrice) continue;

      // 记录价格历史
      if (!priceHistory[pos.mint]) priceHistory[pos.mint] = [];
      priceHistory[pos.mint].push({ price: currentPrice, time: Date.now() });
      // 只保留最近5分钟
      const cutoff = Date.now() - 5 * 60 * 1000;
      priceHistory[pos.mint] = priceHistory[pos.mint].filter(p => p.time > cutoff);

      // 计算盈亏
      const pnlMultiple = currentPrice / pos.buyPrice;
      const pnlPct = pnlMultiple - 1;
      const remainingPct = 1 - (pos.soldPct || 0);

      // ====== 紧急卖出检查 ======

      // 闪崩检测：5分钟内跌>30%
      const history = priceHistory[pos.mint];
      if (history.length >= 2) {
        const oldestPrice = history[0].price;
        const flashCrashPct = (currentPrice - oldestPrice) / oldestPrice;
        if (flashCrashPct < config.risk.emergencySell.flashCrash) {
          logger.signal('monitor', `⚡ 闪崩检测 ${pos.symbol}: 5分钟跌${(flashCrashPct * 100).toFixed(1)}%`);
          await trader.sell(pos, remainingPct, `闪崩${(flashCrashPct * 100).toFixed(1)}%`);
          continue;
        }
      }

      // ====== 止损 ======
      if (pnlPct <= config.risk.stopLoss) {
        logger.signal('monitor', `🛑 止损 ${pos.symbol}: ${(pnlPct * 100).toFixed(1)}%`);
        await trader.sell(pos, remainingPct, `止损${(pnlPct * 100).toFixed(1)}%`);
        continue;
      }

      // ====== 阶梯止盈 ======
      for (const tp of config.risk.takeProfit) {
        if (pnlMultiple >= tp.multiple && !pos.takeProfitHits?.includes(tp.multiple)) {
          logger.signal('monitor', `💰 止盈 ${pos.symbol}: ${pnlMultiple.toFixed(1)}x, 卖${(tp.sellPct * 100)}%`);
          await trader.sell(pos, tp.sellPct, `${pnlMultiple.toFixed(1)}x止盈`);
          
          // 记录已触发的止盈档位
          const positions = trader.loadPositions();
          const p = positions.find(pp => pp.mint === pos.mint);
          if (p) {
            if (!p.takeProfitHits) p.takeProfitHits = [];
            p.takeProfitHits.push(tp.multiple);
            trader.savePositions(positions);
          }
          break; // 一次只触发一档
        }
      }

    } catch (e) {
      logger.error('monitor', `检查 ${pos.symbol} 失败: ${e.message}`);
    }
  }
}

function start() {
  if (monitoring) return;
  monitoring = true;
  logger.info('monitor', `持仓监控启动，间隔${config.monitor.priceCheckIntervalMs}ms`);
  
  monitorTimer = setInterval(async () => {
    try {
      await checkPositions();
    } catch (e) {
      logger.error('monitor', `监控循环异常: ${e.message}`);
    }
  }, config.monitor.priceCheckIntervalMs);
}

function stop() {
  monitoring = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  logger.info('monitor', '持仓监控停止');
}

module.exports = { start, stop, checkPositions };
