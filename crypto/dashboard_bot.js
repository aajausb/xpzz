#!/usr/bin/env node
/**
 * Telegram看板快速刷新服务
 * 直接监听callback_query，秒级响应刷新按钮
 * 不经过AI，0 token消耗
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const BOT_TOKEN = '8174376151:AAECqG2cxFyOI4o5bzrdDJYyTPztFdTBnwk';
const CHAT_ID = '877233818';
const MESSAGE_ID = '1151';

const ARB_STATE = path.join(WORKSPACE, 'crypto', 'arbitrage_state.json');
const RANK_PATH = path.join(WORKSPACE, 'crypto', 'smart_money_rank.json');
const POS_PATH = path.join(WORKSPACE, 'crypto', 'positions.json');

function ts() { 
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); 
}
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function buildDashboard() {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  
  // 套利数据
  let arbLines = '';
  let totalPnl = 0;
  let crossPnl = 0;
  try {
    const arb = JSON.parse(fs.readFileSync(ARB_STATE, 'utf8'));
    totalPnl = arb.totalPnl || 0;
    crossPnl = arb.crossArbPnl || 0;
    const positions = arb.fundingPositions || [];
    const posLines = positions.map((p, i) => {
      const e = p.earned || 0;
      const sign = e >= 0 ? '+' : '';
      const icon = e >= 1 ? ' 🔥' : '';
      const prefix = i === positions.length - 1 ? '└' : '├';
      return `${prefix} ${p.symbol} 年化${p.ann.toFixed(0)}% → ${sign}$${e.toFixed(2)}${icon}`;
    });
    arbLines = posLines.join('\n');
  } catch(e) {}

  const pnlSign = totalPnl >= 0 ? '+' : '';
  const pnlEmoji = totalPnl > 5 ? ' 📈' : totalPnl > 0 ? ' ✅' : ' ⚠️';

  // 土狗持仓
  let dogStatus = '持仓0';
  try {
    const pos = JSON.parse(fs.readFileSync(POS_PATH, 'utf8'));
    if (pos.active && pos.active.length > 0) {
      dogStatus = `持仓${pos.active.length}个`;
    }
  } catch(e) {}

  // 聪明钱
  let smLines = '';
  try {
    const rank = JSON.parse(fs.readFileSync(RANK_PATH, 'utf8'));
    const chains = { solana: rank.solana || [], bsc: rank.bsc || [], base: rank.base || [] };
    for (const [chain, list] of Object.entries(chains)) {
      const core = list.filter(w => w.weight >= 3).length;
      const normal = list.filter(w => w.weight === 2).length;
      const watch = list.filter(w => w.weight === 1).length;
      const name = chain.charAt(0).toUpperCase() + chain.slice(1);
      smLines += `├ ${name}: ${list.length}个 🥇${core} 🥈${normal} 🥉${watch}\n`;
    }
  } catch(e) {}

  return `📊 *交易看板* | ${now}
━━━━━━━━━━━━━━━━━

🐕 *土狗猎手* ✅ 运行中
SOL=1.44 | ${dogStatus} | Solana实盘/BSC+Base模拟

💰 *套利v3* ✅ 模拟中 ($12,000)
OKX / Bybit / Bitget / Binance
费率仓 4/5 | *PnL: ${pnlSign}$${totalPnl.toFixed(2)}*${pnlEmoji}
${arbLines}
└ 跨所价差: +$${crossPnl.toFixed(2)}${crossPnl > 3 ? ' 🔥' : ''}

🧠 *聪明钱* 总211个 (三链独立识别)
${smLines}├ 实时防线: 7项检测
└ 信号: 横盘观察中

⏰ 下次费率结算 ~04:00`;
}

// 轮询callback_query
let offset = 0;

async function poll() {
  try {
    const res = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query'] });
    if (res?.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (cb && cb.data === 'refresh_dashboard') {
          log('🔄 收到刷新请求');
          
          // 立刻回应callback（消除loading）
          await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ 已刷新' });
          
          // 更新看板
          const text = buildDashboard();
          await tgApi('editMessageText', {
            chat_id: CHAT_ID,
            message_id: MESSAGE_ID,
            text,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 刷新看板', callback_data: 'refresh_dashboard' }]] }
          });
          
          log('✅ 看板已更新');
        }
      }
    }
  } catch(e) {
    log(`⚠️ ${e.message}`);
  }
  
  // 继续轮询
  setTimeout(poll, 100);
}

log('🚀 看板快速刷新服务启动');
poll();

process.on('uncaughtException', e => log(`❌ ${e.message}`));
