#!/usr/bin/env node
/**
 * v8 跟单引擎看板
 * - Telegram消息实时更新（editMessage保持一条消息）
 * - HTTP server port 9877 支持一键刷新
 * - 显示钱包库/持仓/信号/余额
 */
require('dotenv').config({ path: '/root/.openclaw/.env' });
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');

const CHAT_ID = '877233818';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA_DIR = path.join(__dirname, 'data', 'v8');
const DASHBOARD_STATE = path.join(DATA_DIR, 'dashboard_state.json');

// 钱包地址
const SOL_WALLET = 'BubdLnFR8AX7nXuJtEXwHa3xyX1G4ufx2FYSaJ8kSgVQ';
const EVM_WALLET = '0xe00ca1d766f329eFfC05E704499f10dB1F14FD47';

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 查余额
async function getBalances() {
  const balances = {};
  
  // SOL
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL_WALLET] })
    });
    const d = await r.json();
    balances.sol = (d.result?.value || 0) / 1e9;
  } catch { balances.sol = 0; }

  // BNB
  try {
    const r = await fetch('https://bsc-dataseed1.binance.org', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [EVM_WALLET, 'latest'] })
    });
    const d = await r.json();
    balances.bnb = parseInt(d.result || '0', 16) / 1e18;
  } catch { balances.bnb = 0; }

  // ETH (Base)
  try {
    const r = await fetch('https://mainnet.base.org', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [EVM_WALLET, 'latest'] })
    });
    const d = await r.json();
    balances.eth = parseInt(d.result || '0', 16) / 1e18;
  } catch { balances.eth = 0; }

  // 查价格
  try {
    const [solR, bnbR, ethR] = await Promise.all([
      fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112').then(r => r.json()),
      fetch('https://api.dexscreener.com/latest/dex/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c').then(r => r.json()),
      fetch('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006').then(r => r.json()),
    ]);
    balances.solPrice = parseFloat(solR?.pairs?.find(p => p.baseToken?.symbol === 'SOL' && parseFloat(p.priceUsd) > 1)?.priceUsd || 0);
    balances.bnbPrice = parseFloat(bnbR?.pairs?.find(p => p.baseToken?.symbol === 'WBNB' && parseFloat(p.priceUsd) > 1)?.priceUsd || 0);
    balances.ethPrice = parseFloat(ethR?.pairs?.find(p => p.baseToken?.symbol === 'WETH' && parseFloat(p.priceUsd) > 1)?.priceUsd || 0);
  } catch {
    balances.solPrice = 0; balances.bnbPrice = 0; balances.ethPrice = 0;
  }

  return balances;
}

async function buildDashboard() {
  const walletDb = loadJSON(path.join(DATA_DIR, 'wallet_db.json'), {});
  const positions = loadJSON(path.join(DATA_DIR, 'positions.json'), {});
  const signals = loadJSON(path.join(DATA_DIR, 'signals.json'), {});
  const blacklist = loadJSON(path.join(DATA_DIR, 'blacklist.json'), []);

  const wallets = Object.values(walletDb);
  const active = { solana: 0, bsc: 0, base: 0 };
  const watch = { solana: 0, bsc: 0, base: 0 };
  for (const w of wallets) {
    if (w.winRate >= 60 && w.winRate <= 80) active[w.chain]++;
    else watch[w.chain]++;
  }
  const totalActive = Object.values(active).reduce((a, b) => a + b, 0);
  const totalWatch = Object.values(watch).reduce((a, b) => a + b, 0);

  const bal = await getBalances();
  const solUsd = (bal.sol * bal.solPrice).toFixed(2);
  const bnbUsd = (bal.bnb * bal.bnbPrice).toFixed(2);
  const ethUsd = (bal.eth * bal.ethPrice).toFixed(2);
  const totalUsd = (parseFloat(solUsd) + parseFloat(bnbUsd) + parseFloat(ethUsd)).toFixed(2);

  // 持仓详情
  const posEntries = Object.entries(positions);
  let posText = '';
  let totalPnl = 0;
  
  if (posEntries.length > 0) {
    for (const [token, pos] of posEntries) {
      // 查当前价
      let curPrice = 0;
      try {
        const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`).then(r => r.json());
        curPrice = parseFloat(d?.pairs?.[0]?.priceUsd || 0);
      } catch {}
      
      const pnl = pos.buyPrice > 0 ? ((curPrice - pos.buyPrice) / pos.buyPrice * 100) : 0;
      const pnlUsd = pos.buyCost ? (pos.buyCost * pnl / 100) : 0;
      totalPnl += pnlUsd;
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      const smSold = pos.soldRatio ? `已卖${(pos.soldRatio * 100).toFixed(0)}%` : '';
      posText += `\n${emoji} ${pos.symbol || '?'}(${pos.chain}) $${pos.buyCost || '?'}\n   ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% ($${pnlUsd.toFixed(2)}) SM×${pos.confirmCount || '?'} ${smSold}`;
    }
  } else {
    posText = '\n   空仓，等信号...';
  }

  // 最近信号
  const sigEntries = Object.entries(signals);
  let sigText = '';
  const now = Date.now();
  let recentSigs = 0;
  for (const [token, sigs] of sigEntries) {
    const recent = (sigs || []).filter(s => now - s.time < 3600000);
    if (recent.length > 0) {
      recentSigs += recent.length;
    }
  }

  // 引擎运行时间
  let uptime = '';
  try {
    const { execSync } = require('child_process');
    const out = execSync('systemctl show meme-v8 --property=ActiveEnterTimestamp').toString().trim();
    const startTime = new Date(out.split('=')[1]);
    const uptimeMs = Date.now() - startTime.getTime();
    const hours = Math.floor(uptimeMs / 3600000);
    const mins = Math.floor((uptimeMs % 3600000) / 60000);
    uptime = `${hours}h${mins}m`;
  } catch { uptime = '?'; }

  const now2 = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const text = `⚡ v8 跟单引擎看板
━━━━━━━━━━━━━━━━━━

💰 余额
   SOL: ${bal.sol.toFixed(4)} ($${solUsd})
   BNB: ${bal.bnb.toFixed(4)} ($${bnbUsd})
   ETH: ${bal.eth.toFixed(4)} ($${ethUsd})
   总计: $${totalUsd}

📋 钱包库 (${wallets.length}个)
   可跟单: ${totalActive}个 (SOL=${active.solana} BSC=${active.bsc} Base=${active.base})
   观察中: ${totalWatch}个 (SOL=${watch.solana} BSC=${watch.bsc} Base=${watch.base})

📊 持仓 (${posEntries.length}/${10}) PnL: $${totalPnl.toFixed(2)}${posText}

📡 信号: 1h内${recentSigs}个 | 黑名单${blacklist.length}个
⏱ 运行: ${uptime} | 更新: ${now2}`;

  return text;
}

async function sendOrEdit(text) {
  const state = loadJSON(DASHBOARD_STATE, {});
  const buttons = [[{ text: '🔄 刷新', callback_data: 'v8_refresh' }]];
  
  if (state.messageId) {
    // 编辑已有消息
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      message_id: state.messageId,
      text,
      reply_markup: { inline_keyboard: buttons },
    });
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      const d = await r.json();
      if (d.ok) return state.messageId;
      // 消息不存在了，发新的
    } catch {}
  }
  
  // 发新消息
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    reply_markup: { inline_keyboard: buttons },
  });
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    const d = await r.json();
    if (d.ok) {
      state.messageId = d.result.message_id;
      saveJSON(DASHBOARD_STATE, state);
      return d.result.message_id;
    }
  } catch {}
  return null;
}

async function refresh() {
  const text = await buildDashboard();
  return await sendOrEdit(text);
}

// HTTP server
const server = http.createServer(async (req, res) => {
  if (req.url === '/refresh' || req.url === '/') {
    try {
      const msgId = await refresh();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId: msgId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(9877, '127.0.0.1', () => {
  console.log('📊 v8看板 HTTP server on :9877');
});

// 首次刷新
refresh().then(id => {
  console.log('📊 看板已发送 messageId=' + id);
});

// 每60秒自动刷新
setInterval(() => {
  refresh().catch(e => console.error('看板刷新失败:', e.message));
}, 60000);

// 处理callback_query（刷新按钮）
async function pollUpdates() {
  let offset = 0;
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["callback_query"]`);
      const d = await r.json();
      for (const update of (d.result || [])) {
        offset = update.update_id + 1;
        if (update.callback_query?.data === 'v8_refresh') {
          await refresh();
          // 应答callback
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: update.callback_query.id, text: '已刷新' })
          });
        }
      }
    } catch {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// 不启动polling，会跟openclaw的bot冲突
// 用HTTP触发代替: curl http://127.0.0.1:9877/refresh
