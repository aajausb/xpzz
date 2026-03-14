// Telegram 通知模块
const config = require('./config');
const logger = require('./logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = config.telegram.chatId;

async function send(text) {
  if (!config.telegram.enabled || !BOT_TOKEN) {
    logger.warn('notifier', 'Telegram not configured, skip notification');
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
  buyAlert: async (tokenInfo, score, reason, amountSol) => {
    await send(
      `🟢 <b>买入</b> $${tokenInfo.symbol} (${tokenInfo.name})\n` +
      `💰 ${amountSol} SOL\n` +
      `📊 评分: ${score}/100\n` +
      `📋 原因: ${reason}\n` +
      `📍 <code>${tokenInfo.mint}</code>\n` +
      `🔗 <a href="https://pump.fun/coin/${tokenInfo.mint}">pump.fun</a> | <a href="https://solscan.io/token/${tokenInfo.mint}">Solscan</a>`
    );
  },

  sellAlert: async (position, pnlPct, reason, solReceived) => {
    const emoji = pnlPct >= 0 ? '💰' : '🔴';
    await send(
      `${emoji} <b>卖出</b> $${position.symbol}\n` +
      `盈亏: ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%\n` +
      `收到: ${solReceived.toFixed(4)} SOL\n` +
      `原因: ${reason}`
    );
  },

  emergencyAlert: async (msg) => {
    await send(`🚨 <b>紧急告警</b>\n${msg}`);
  },

  dailyReport: async (stats) => {
    await send(
      `📊 <b>日报</b> ${new Date().toISOString().slice(0, 10)}\n` +
      `交易: ${stats.trades}笔\n` +
      `胜率: ${(stats.winRate * 100).toFixed(0)}%\n` +
      `盈亏: ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(4)} SOL\n` +
      `最佳: ${stats.bestTrade || '-'}\n` +
      `最差: ${stats.worstTrade || '-'}\n` +
      `持仓: ${stats.openPositions}个`
    );
  },

  info: async (msg) => {
    await send(`ℹ️ ${msg}`);
  },

  raw: send,
};
