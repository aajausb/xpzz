#!/usr/bin/env node
// 🐕 土狗主监控进程
const WebSocket = require('ws');
const config = require('./config');
const log = require('./logger');
const analyzer = require('./token_analyzer');
const trader = require('./trader');
const smartMoney = require('./smart_money');
const notifier = require('./notifier');

// ========== 状态 ==========
let ws = null;
let reconnectCount = 0;
let running = false;
let priceCheckTimer = null;
let smartWalletSet = new Set();
const recentMints = new Set(); // 防重复
const pendingAnalysis = new Set(); // 正在分析的sig
const MAX_CONCURRENT_ANALYSIS = 3;

// ========== pump.fun 事件检测 ==========
function isCreateEvent(logs) {
  if (!logs) return false;
  return logs.some(l => 
    l.includes('Instruction: CreateV2') || 
    l.includes('Instruction: Create')
  ) && logs.some(l => 
    l.includes('InitializeMint') || l.includes('MintTo')
  );
}

// ========== 新币处理 ==========
async function handleNewToken(signature) {
  if (pendingAnalysis.size >= MAX_CONCURRENT_ANALYSIS) return;
  if (pendingAnalysis.has(signature)) return;
  pendingAnalysis.add(signature);

  try {
    // 等数据传播
    await new Promise(r => setTimeout(r, 2000));

    // 用 Helius Enhanced TX 获取详情
    const enhancedTx = await analyzer.getEnhancedTx(signature);
    const tokenInfo = analyzer.extractNewTokenInfo(enhancedTx);

    if (!tokenInfo || !tokenInfo.mint) {
      // 不是pump.fun创建事件，或者解析失败
      return;
    }

    const { mint } = tokenInfo;
    if (recentMints.has(mint)) return;
    recentMints.add(mint);
    // 清理旧记录（保留最近500个）
    if (recentMints.size > 500) {
      const arr = [...recentMints];
      for (let i = 0; i < 200; i++) recentMints.delete(arr[i]);
    }

    log.info('monitor', `🆕 新币: ${mint.slice(0, 12)}... creator: ${tokenInfo.creator?.slice(0, 8)}`);

    // 分析
    const analysis = await analyzer.analyzeToken(mint, tokenInfo, smartWalletSet);

    if (!analysis.passed && analysis.issues.length > 0) {
      log.info('monitor', `❌ 淘汰 ${analysis.metadata?.symbol}: ${analysis.issues.join(', ')}`);
      return;
    }

    // 决定是否买入
    const score = analysis.score;
    let buyAmountSol = 0;
    let signalType = '';

    // 聪明钱参与 + 评分达标
    const smReasons = analysis.reasons.filter(r => r.includes('聪明钱'));
    if (smReasons.length > 0 && score >= config.score.smartMoneyBuy) {
      buyAmountSol = smReasons.some(r => r.includes('2')) 
        ? config.trade.largeBuyAmountSol 
        : config.trade.defaultBuyAmountSol;
      signalType = '聪明钱+新币';
    } else if (score >= config.score.newTokenPure) {
      buyAmountSol = config.trade.smallBuyAmountSol;
      signalType = '纯评分';
    }

    if (buyAmountSol === 0) {
      log.info('monitor', `📊 ${analysis.metadata?.symbol} 评分${score}不够，跳过`);
      return;
    }

    log.signal('monitor', `🎯 买入信号! ${analysis.metadata?.symbol} (${analysis.metadata?.name})`, {
      score, signalType, buyAmountSol,
      reasons: analysis.reasons,
    });

    // 执行买入
    const tradeResult = await trader.buyToken(mint, buyAmountSol);
    if (tradeResult) {
      trader.recordBuy(analysis, tradeResult);
      await notifier.buyAlert({
        symbol: analysis.metadata?.symbol || '???',
        mint,
        amountSol: buyAmountSol,
        amountUsd: (buyAmountSol * 170).toFixed(0),
        score,
        signalType,
        ageMinutes: tokenInfo.timestamp 
          ? Math.round((Date.now() / 1000 - tokenInfo.timestamp) / 60) 
          : 0,
      });
    }
  } catch (e) {
    log.error('monitor', `处理新币失败`, { sig: signature.slice(0, 12), error: e.message });
  } finally {
    pendingAnalysis.delete(signature);
  }
}

// ========== WebSocket ==========
function connectWebSocket() {
  if (ws) try { ws.close(); } catch {}

  log.info('monitor', '连接 Helius WebSocket...');
  ws = new WebSocket(config.heliusWs1);

  ws.on('open', () => {
    log.info('monitor', '✅ WebSocket 已连接');
    reconnectCount = 0;

    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [config.PUMP_FUN_PROGRAM] },
        { commitment: 'confirmed' }
      ]
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.result !== undefined) {
        log.info('monitor', `订阅成功，ID: ${msg.result}`);
        return;
      }
      if (msg.params?.result?.value) {
        const { logs, signature } = msg.params.result.value;
        if (isCreateEvent(logs)) {
          handleNewToken(signature).catch(e => {
            log.error('monitor', 'handleNewToken异常', { error: e.message });
          });
        }
      }
    } catch (e) {
      log.error('monitor', 'WS消息解析失败', { error: e.message });
    }
  });

  ws.on('error', (e) => log.error('monitor', 'WS错误', { error: e.message }));

  ws.on('close', () => {
    log.warn('monitor', 'WebSocket断开');
    if (running && reconnectCount < config.monitor.maxReconnectAttempts) {
      reconnectCount++;
      setTimeout(connectWebSocket, config.monitor.wsReconnectDelayMs);
    }
  });
}

// ========== 持仓监控 ==========
function startPriceMonitor() {
  priceCheckTimer = setInterval(async () => {
    try { await trader.checkPositions(); } 
    catch (e) { log.error('monitor', '持仓检查失败', { error: e.message }); }
  }, config.monitor.priceCheckIntervalMs);
}

// ========== 启动/停止 ==========
async function start() {
  log.info('monitor', '🐕 土狗系统启动中...');
  running = true;

  // 初始化数据文件
  const fs = require('fs');
  for (const p of [config.paths.positions, config.paths.tradeHistory]) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  }
  if (!fs.existsSync(config.paths.dailyStats)) fs.writeFileSync(config.paths.dailyStats, '{}');
  if (!fs.existsSync(config.paths.smartWallets)) fs.writeFileSync(config.paths.smartWallets, '{"wallets":[],"lastScan":null}');

  // 余额
  const balance = await trader.getSolBalance();
  log.info('monitor', `💰 SOL余额: ${balance.toFixed(4)}`);
  if (balance < 0.1) {
    await notifier.emergencyAlert('SOL余额不足0.1，无法启动');
    return;
  }

  // 聪明钱
  const smData = smartMoney.loadSmartWallets();
  smartWalletSet = new Set(smData.wallets.map(w => w.address));
  log.info('monitor', `🧠 聪明钱: ${smartWalletSet.size}个`);

  // 持仓
  const positions = trader.loadPositions();
  log.info('monitor', `📦 持仓: ${positions.length}个`);

  // 启动
  connectWebSocket();
  startPriceMonitor();

  await notifier.raw(
    `🐕 <b>土狗系统已启动</b>\n` +
    `💰 余额: ${balance.toFixed(4)} SOL\n` +
    `🧠 聪明钱: ${smartWalletSet.size}个\n` +
    `📦 持仓: ${positions.length}个\n` +
    `⏱ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
  );

  log.info('monitor', '🐕 土狗系统启动完成 ✅');
}

function stop() {
  running = false;
  if (ws) try { ws.close(); } catch {} 
  ws = null;
  if (priceCheckTimer) clearInterval(priceCheckTimer);
  priceCheckTimer = null;
  log.info('monitor', '🐕 土狗系统已停止');
}

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

if (require.main === module) {
  start().catch(e => {
    log.error('monitor', '启动失败', { error: e.message });
    process.exit(1);
  });
}

module.exports = { start, stop };
