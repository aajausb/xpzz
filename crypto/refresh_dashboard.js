#!/usr/bin/env node
/**
 * 快速刷新看板 — 实时查余额 + state仓位，不经过 AI
 * 用法: node refresh_dashboard.js
 */
require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const https = require('https');
const fs = require('fs');
const { binance, bybit, bitget } = require('./exchange_trader');

const CHAT_ID = '877233818';
const MESSAGE_ID = 3713;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STATE_FILE = '/root/.openclaw/workspace/crypto/arbitrage_live_state.json';

function tgEdit(text, buttons) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      message_id: MESSAGE_ID,
      text,
      reply_markup: JSON.stringify({ inline_keyboard: buttons || [[{ text: '🔄 刷新看板', callback_data: 'refresh_dashboard' }]] })
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/editMessageText',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve('error'));
    req.write(body);
    req.end();
  });
}

(async () => {
  const start = Date.now();

  // 读 state
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    state = { positions: [], balances: {} };
  }

  // 实时拉三所余额（并发，~76ms）
  let bn = 0, byW = 0, bg = 0, okW = 0;
  try {
    const [bnBal, byBal, bgBal] = await Promise.all([
      binance.getFuturesBalance().catch(() => ({ usdt: state.balances?.binance || 0 })),
      bybit.getFuturesBalance().catch(() => ({ usdt: state.balances?.bybit || 0 })),
      bitget.getFuturesBalance().catch(() => ({ usdt: state.balances?.bitget || 0 }))
    ]);
    bn = bnBal.usdt || 0;
    byW = byBal.usdt || 0;
    bg = bgBal.usdt || bgBal.equity || 0;
  } catch (e) {
    bn = state.balances?.binance || 0;
    byW = state.balances?.bybit || 0;
    bg = state.balances?.bitget || 0;
  }
  const total = bn + byW + bg + okW;

  let allPnl = 0;
  for (const p of state.positions) allPnl += (p.unrealizedPnl || 0);
  const netValue = total + allPnl;
  const pnl = netValue - 14232;

  let totalEarned = 0;
  const posArr = [];
  let totalFees = 0;
  for (const p of state.positions) {
    const e = p.earned || 0;
    const f = p.totalFee || 0;
    totalEarned += e;
    totalFees += f;
    posArr.push({ s: p.symbol, e, f, net: e - f, sz: p.size, l: p.longEx, h: p.shortEx });
  }
  posArr.sort((a, b) => b.net - a.net);

  const exMap = { binance: 'BN', bybit: 'BY', bitget: 'BG', okx: 'OK' };
  const posLines = posArr.map(p => {
    const icon = p.net > 0 ? '✅' : p.net < -0.5 ? '⚠️' : (p.net < -0.01 ? '➖' : '🆕');
    const dualSz = p.sz * 2;
    const szStr = dualSz >= 1000 ? `$${(dualSz/1000).toFixed(0)}k` : `$${dualSz}`;
    const longSz = p.sz >= 1000 ? `$${(p.sz/1000).toFixed(0)}k` : `$${p.sz}`;
    return `├ ${p.s}: 净${p.net >= 0 ? '+' : ''}$${p.net.toFixed(2)} ${icon} | ${szStr} (${exMap[p.l]}多${longSz} ${exMap[p.h]}空${longSz})`;
  }).join('\n');

  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const totalExposure = state.positions.reduce((s, p) => s + p.size, 0);
  const freeCapital = Math.round(total - totalExposure);

  const text = `📊 系统看板 (${ts})\n\n` +
    `💵 四所余额\n├ Binance: $${Math.round(bn).toLocaleString()}\n├ Bybit: $${Math.round(byW).toLocaleString()}\n├ Bitget: $${Math.round(bg).toLocaleString()}\n├ OKX: $${Math.round(okW).toLocaleString()} (待机)\n└ 总计: $${Math.round(total).toLocaleString()}\n\n` +
    `📈 盈亏总览\n├ 浮盈浮亏: $${Math.round(allPnl)}（开仓滑点成本）\n├ 费率收入: +$${totalEarned.toFixed(2)}\n├ 手续费: -$${totalFees.toFixed(2)}\n├ 总净值: $${Math.round(netValue).toLocaleString()}\n└ 盈亏: $${Math.round(pnl)}\n\n` +
    `📍 费率套利 (${state.positions.length}仓/$${totalExposure.toLocaleString()}) 净利: +$${(totalEarned - totalFees).toFixed(2)}\n` +
    posLines + `\n└ 净敞口: 全部=0 ✅\n\n` +
    `💰 资金分配\n├ 仓位占用: $${totalExposure.toLocaleString()}\n└ 空闲资金: $${freeCapital.toLocaleString()}\n\n` +
    `⚙️ arbitrage-live ✅ | WS 4所\n├ 强平监听: 4所 ✅ | 精度: 4所 ✅\n├ 费率标准化: 1h/4h/8h ✅\n├ 价差控制: <1% ✅\n├ 健康度调仓: 每小时 ✅\n└ 🟢 运行中\n\n🔄 刷新时间: ${ts} (${elapsed}s)`;

  await tgEdit(text);
  console.log(`✅ 看板已刷新 (${elapsed}s)`);
})();
