#!/usr/bin/env node
/**
 * 交易看板更新器
 * 每5分钟更新置顶消息内容，有交易时立即更新
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const POSITIONS_FILE = path.join(WORKSPACE, 'crypto', 'positions.json');
const TRADE_LOG = path.join(WORKSPACE, 'crypto', 'trade_log.jsonl');
const DASHBOARD_STATE = path.join(WORKSPACE, 'crypto', 'dashboard_state.json');
const WALLET = 'jLVNxrQ6QX8neHx8bFeEvcTgRed4e4YXiePpfcPHosK';

require('dotenv').config({ path: path.join(WORKSPACE, '.env') });
const HELIUS_KEY = process.env.HELIUS_API_KEY;

// 看板消息ID — 固定这条消息
const DASHBOARD_MSG_ID = '1077';
const CHAT_ID = '877233818';

function ts() { 
  return new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai', hour12: false, 
    hour: '2-digit', minute: '2-digit' 
  }); 
}

function log(msg) { console.log(`[${ts()}] ${msg}`); }

// 获取SOL余额
async function getSOLBalance() {
  return new Promise((resolve) => {
    const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[WALLET]});
    const url = new URL(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve((JSON.parse(d).result?.value || 0) / 1e9); }
        catch(e) { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// 检查进程是否在运行
function isRunning(name) {
  try {
    execSync(`pgrep -f "${name}"`, { timeout: 3000 });
    return true;
  } catch(e) { return false; }
}

// 读取持仓
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); }
  catch(e) { return { active: [], closed: [] }; }
}

// 读取今日交易统计
function getTodayStats() {
  const today = new Date().toISOString().split('T')[0];
  let trades = 0, signals = 0;
  try {
    const lines = fs.readFileSync(TRADE_LOG, 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        if (t.time && t.time.startsWith(today)) trades++;
      } catch(e) {}
    }
  } catch(e) {}
  
  // 信号数从scanner.log统计
  try {
    const scanLog = fs.readFileSync(path.join(WORKSPACE, 'crypto', 'scanner.log'), 'utf8');
    const todayLines = scanLog.split('\n').filter(l => l.includes('横盘观察') || l.includes('聪明钱共识'));
    signals = todayLines.length;
  } catch(e) {}
  
  return { trades, signals };
}

// 读取最新信号
function getLatestSignal() {
  try {
    const scanLog = fs.readFileSync(path.join(WORKSPACE, 'crypto', 'scanner.log'), 'utf8');
    const lines = scanLog.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('横盘') || lines[i].includes('聪明钱') || lines[i].includes('买入')) {
        const match = lines[i].match(/\[(\d{2}:\d{2}:\d{2})\]/);
        const time = match ? match[1] : '';
        // 提取关键信息
        const short = lines[i].replace(/\[.*?\]\s*/, '').slice(0, 50);
        return `${time} ${short}`;
      }
    }
  } catch(e) {}
  return '暂无';
}

// 计算累计盈亏
function calcPnL() {
  const pos = loadPositions();
  let totalPnL = 0;
  // 已关闭的仓位
  for (const p of (pos.closed || [])) {
    // 简化：后续可以加详细计算
    totalPnL += (p.closePrice || 0) - (p.buyPrice || 0);
  }
  return totalPnL;
}

// 生成看板文本
async function generateDashboard() {
  const balance = await getSOLBalance();
  const scannerOK = isRunning('scanner_daemon.js');
  const traderOK = isRunning('auto_trader.js');
  const pos = loadPositions();
  const stats = getTodayStats();
  const latestSignal = getLatestSignal();
  const pnl = calcPnL();
  
  // 持仓详情
  let posDetail = '';
  if (pos.active.length > 0) {
    for (const p of pos.active) {
      const token = p.token ? p.token.slice(0, 8) + '...' : '?';
      const status = p.halfSold ? '已出本金🟢' : '持仓中🟡';
      posDetail += `\n│  ${token} | ${p.amountSol}SOL | ${status}`;
    }
  }

  const text = `🏠 小胖崽崽交易看板
━━━━━━━━━━━━━━━━━

🐕 【土狗板块】
├ 状态: ${scannerOK && traderOK ? '✅ 运行中' : '❌ 异常!'}
├ Scanner: ${scannerOK ? '🟢在线' : '🔴离线'}
├ Trader: ${traderOK ? '🟢在线' : '🔴离线'}
├ 余额: ${balance.toFixed(4)} SOL
├ 持仓: ${pos.active.length}个${posDetail}
├ 已平仓: ${(pos.closed || []).length}个
├ 累计盈亏: $${pnl.toFixed(2)}
├ 聪明钱: 150个监听中
└ 最新: ${latestSignal}

💰 【套利板块】
├ 状态: ⏳ 等待API Key
├ 资金费率: 未启动
├ 跨所价差: 未启动
├ DEX-CEX: 未启动
└ 累计盈亏: $0

📊 【今日统计】
├ 信号数: ${stats.signals}
├ 交易数: ${stats.trades}
└ 收益率: 0%

🕐 更新: ${ts()}`;

  return text;
}

// 更新看板消息（通过openclaw edit）
async function updateDashboard() {
  try {
    const text = await generateDashboard();
    
    // 保存状态
    fs.writeFileSync(DASHBOARD_STATE, JSON.stringify({ lastUpdate: new Date().toISOString(), msgId: DASHBOARD_MSG_ID }));
    
    // 通过openclaw编辑消息
    const escaped = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    execSync(`openclaw send --channel telegram --to ${CHAT_ID} --edit ${DASHBOARD_MSG_ID} "${escaped}"`, { timeout: 10000 });
    log('✅ 看板已更新');
  } catch(e) {
    log(`❌ 看板更新失败: ${e.message}`);
  }
}

// 监听trade_log变化 — 有交易立即更新
let lastTradeSize = 0;
try { lastTradeSize = fs.statSync(TRADE_LOG).size; } catch(e) {}

function checkTradeUpdate() {
  try {
    const stat = fs.statSync(TRADE_LOG);
    if (stat.size > lastTradeSize) {
      lastTradeSize = stat.size;
      updateDashboard();
    }
  } catch(e) {}
}

// 主循环
async function main() {
  log('📊 看板更新器启动');
  
  // 立即更新一次
  await updateDashboard();
  
  // 每5分钟定时更新
  setInterval(updateDashboard, 5 * 60 * 1000);
  
  // 每10秒检查是否有新交易
  setInterval(checkTradeUpdate, 10000);
  
  log('✅ 看板更新器就绪');
}

main().catch(console.error);
