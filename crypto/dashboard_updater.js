#!/usr/bin/env node
/**
 * 看板自动更新器
 * 每30分钟读取最新数据，编辑Telegram看板消息
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const ARB_STATE = path.join(WORKSPACE, 'crypto', 'arbitrage_state.json');
const RANK_PATH = path.join(WORKSPACE, 'crypto', 'smart_money_rank.json');
const DASHBOARD_STATE = path.join(WORKSPACE, 'crypto', 'dashboard_state.json');

// Telegram
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '877233818';
let MESSAGE_ID = '1151'; // 看板消息ID

// 读取上次的messageId
try {
  const ds = JSON.parse(fs.readFileSync(DASHBOARD_STATE, 'utf8'));
  if (ds.messageId) MESSAGE_ID = ds.messageId;
} catch(e) {}

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function editTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: CHAT_ID,
      message_id: MESSAGE_ID,
      text,
      parse_mode: 'Markdown'
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/editMessageText`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) resolve(r);
          else reject(new Error(r.description || 'Telegram API error'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function updateDashboard() {
  try {
    // 1. 套利数据
    let arbText = '(未运行)';
    let totalPnl = 0;
    try {
      const arb = JSON.parse(fs.readFileSync(ARB_STATE, 'utf8'));
      totalPnl = arb.totalPnl || 0;
      const positions = arb.fundingPositions || [];
      const posLines = positions.map(p => {
        const earned = p.earned || 0;
        const sign = earned >= 0 ? '+' : '';
        return `├ ${p.symbol} 年化${p.ann.toFixed(0)}% → ${sign}$${earned.toFixed(2)}`;
      });
      // 最后一行用└
      if (posLines.length > 0) {
        posLines[posLines.length - 1] = posLines[posLines.length - 1].replace('├', '└');
      }
      const pnlSign = totalPnl >= 0 ? '+' : '';
      arbText = `费率仓 ${positions.length}/5 | *PnL: ${pnlSign}$${totalPnl.toFixed(2)}*\n${posLines.join('\n')}\n跨所价差: $${(arb.crossArbPnl||0).toFixed(2)} | DEX搬砖: $${(arb.dexCexPnl||0).toFixed(2)}`;
    } catch(e) {}

    // 2. 聪明钱排名
    let smText = '(未运行)';
    try {
      const rank = JSON.parse(fs.readFileSync(RANK_PATH, 'utf8'));
      const chains = { solana: rank.solana || [], bsc: rank.bsc || [], base: rank.base || [] };
      const lines = [];
      for (const [chain, list] of Object.entries(chains)) {
        const core = list.filter(w => w.weight >= 3).length;
        const normal = list.filter(w => w.weight === 2).length;
        const watch = list.filter(w => w.weight === 1).length;
        const name = chain.charAt(0).toUpperCase() + chain.slice(1);
        lines.push(`├ ${name}: ${list.length}个 🥇${core} 🥈${normal} 🥉${watch}`);
      }
      if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
      const total = Object.values(chains).reduce((s, l) => s + l.length, 0);
      smText = `总${total}个 (三链独立识别)\n${lines.join('\n')}`;
    } catch(e) {}

    // 3. 土狗状态
    let dogStatus = '❌ 未运行';
    try {
      execSync('pgrep -f scanner_daemon.js', { timeout: 3000 });
      dogStatus = '✅ 运行中';
    } catch(e) { dogStatus = '❌ 已停止'; }

    // 4. 下次结算时间
    const now = new Date();
    const utcH = now.getUTCHours();
    const nextSettleUTC = utcH < 8 ? 8 : utcH < 16 ? 16 : 24;
    const hoursLeft = nextSettleUTC - utcH;
    const nextSettleLocal = new Date(now);
    nextSettleLocal.setUTCHours(nextSettleUTC, 0, 0, 0);
    if (nextSettleUTC === 24) nextSettleLocal.setDate(nextSettleLocal.getDate() + 1);
    const nextStr = nextSettleLocal.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });

    const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    const msg = `📊 *交易看板* | ${timeStr}
━━━━━━━━━━━━━━━━━

🐕 *土狗猎手* ${dogStatus}
SOL=1.44 | 持仓0 | Solana实盘/BSC+Base模拟

💰 *套利v3* ✅ 模拟中 ($12,000)
OKX / Bybit / Bitget / Binance
${arbText}

🧠 *聪明钱* ${smText}
├ 钓鱼拦截: 56个
├ 实时防线: 7项检测
└ 信号: 横盘观察中

⏰ 下次费率结算 ~${nextStr} (${hoursLeft}h后)`;

    await editTelegramMessage(msg);
    log(`✅ 看板已更新 | PnL: $${totalPnl.toFixed(2)}`);
  } catch(e) {
    log(`⚠️ 看板更新失败: ${e.message}`);
  }
}

// 启动
log('📊 看板自动更新器启动（每30分钟）');
updateDashboard(); // 立刻更新一次
setInterval(updateDashboard, 30 * 60 * 1000); // 30分钟

// 保持进程
process.on('uncaughtException', e => log(`❌ ${e.message}`));
