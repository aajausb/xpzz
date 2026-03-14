// Telegram 通知模块
const config = require('./config');
const logger = require('./logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = config.telegram.chatId;

async function send(text) {
  if (!config.telegram.enabled || !BOT_TOKEN) {
    logger.warn('notifier', 'Telegram not configured');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      logger.error('notifier', `Telegram send failed: ${resp.status}`);
    }
  } catch (e) {
    logger.error('notifier', `Telegram error: ${e.message}`);
  }
}

module.exports = {
  buyAlert: async (token, score, reason, amountSol) => {
    await send(
      `🟢 <b>买入信号</b>\n` +
      `币: <code>${token.symbol}</code> (${token.name})\n` +
      `Mint: <code>${token.mint}</code>\n` +
      `评分: ${score}/100\n` +
      `原因: ${reason}\n` +
      `金额: ${amountSol} SOL\n` +
      `🔗 <a href="https://pump.fun/coin/${token.mint}">pump.fun</a> | <a href="https://solscan.io/token/${token.mint}">Solscan</a>`
    );
  },

  sellAlert: async (token, pnlPct, reason, amountSol) => {
    const emoji = pnlPct >= 0 ? '💰' : '🔴';
    await send(
      `${emoji} <b>卖出</b>\n` +
      `币: <code>${token.symbol}</code>\n` +
      `盈亏: ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%\n` +
      `原因: ${reason}\n` +
      `金额: ${amountSol} SOL`
    );
  },

  emergencyAlert: async (msg) => {
    await send(`🚨 <b>紧急告警</b>\n${msg}`);
  },

  dailyReport: async (stats) => {
    await send(
      `📊 <b>每日报告</b>\n` +
      `交易次数: ${stats.trades}\n` +
      `胜率: ${(stats.winRate * 100).toFixed(0)}%\n` +
      `总盈亏: ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(4)} SOL\n` +
      `最佳: ${stats.bestTrade || 'N/A'}\n` +
      `最差: ${stats.worstTrade || 'N/A'}\n` +
      `当前持仓: ${stats.openPositions}个`
    );
  },

  info: async (msg) => {
    await send(`ℹ️ ${msg}`);
  },
};
