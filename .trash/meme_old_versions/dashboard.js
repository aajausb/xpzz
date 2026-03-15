/**
 * 土狗看板 - 三链钱包 + 持仓动态
 * HTTP server port 9877，供TG看板刷新
 */
const http = require('http');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const fs = require('fs');

const PORT = 9877;

const WALLETS = {
  solana: 'BubdLnFR8AX7nXuJtEXwHa3xyX1G4ufx2FYSaJ8kSgVQ',
  evm: '0xe00ca1d766f329eFfC05E704499f10dB1F14FD47'
};

const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';

// 持仓列表（手动+自动都在这）
const POSITIONS_FILE = '/root/.openclaw/workspace/crypto/meme/data/v7/positions.json';
const WATCH_FILE = '/root/.openclaw/workspace/crypto/meme/data/v7/watch_status.json';

// TG看板
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = '877233818';
let dashboardMsgId = null;
const MSGID_FILE = '/root/.openclaw/workspace/crypto/meme/data/v7/dashboard_msg_id.txt';

try { dashboardMsgId = parseInt(fs.readFileSync(MSGID_FILE, 'utf8').trim()); } catch(e) {}

async function getBalances() {
  const prices = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin,ethereum&vs_currencies=usd').then(r=>r.json()).catch(()=>({}));
  
  const solPrice = prices.solana?.usd || 0;
  const bnbPrice = prices.binancecoin?.usd || 0;
  const ethPrice = prices.ethereum?.usd || 0;
  
  // Solana
  let solBal = 0;
  try {
    const conn = new Connection(HELIUS_RPC);
    solBal = await conn.getBalance(new PublicKey(WALLETS.solana)) / 1e9;
  } catch(e) {}
  
  // BSC
  let bnbBal = 0;
  try {
    const p = new ethers.JsonRpcProvider(BSC_RPC);
    bnbBal = parseFloat(ethers.formatEther(await p.getBalance(WALLETS.evm)));
  } catch(e) {}
  
  // Base
  let ethBal = 0;
  try {
    const p = new ethers.JsonRpcProvider(BASE_RPC);
    ethBal = parseFloat(ethers.formatEther(await p.getBalance(WALLETS.evm)));
  } catch(e) {}
  
  return {
    solana: { native: solBal, usd: solBal * solPrice, symbol: 'SOL', price: solPrice },
    bsc: { native: bnbBal, usd: bnbBal * bnbPrice, symbol: 'BNB', price: bnbPrice },
    base: { native: ethBal, usd: ethBal * ethPrice, symbol: 'ETH', price: ethPrice }
  };
}

async function getPositions() {
  const positions = [];
  
  // 从watch_status读天梯
  try {
    const w = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    positions.push(w);
  } catch(e) {}
  
  // 从positions.json读v7自动仓位
  try {
    const ps = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    for (const p of ps) {
      if (p.status === 'open') {
        positions.push({
          symbol: p.symbol,
          chain: p.chain,
          valueUsd: p.currentValueUsd || p.buyPriceUsd,
          pnl: p.pnlPercent || 0,
          buyPrice: p.buyPriceUsd,
          smartMoneyCount: p.smartMoneyCount
        });
      }
    }
  } catch(e) {}
  
  return positions;
}

function buildDashboard(balances, positions) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  
  const totalUsd = balances.solana.usd + balances.bsc.usd + balances.base.usd;
  
  let text = `🐕 <b>土狗看板</b>\n`;
  text += `⏰ ${now}\n\n`;
  
  // 钱包
  text += `💰 <b>三链钱包</b> — 总计 $${totalUsd.toFixed(2)}\n`;
  text += `┌ 🟣 SOL: ${balances.solana.native.toFixed(4)} ($${balances.solana.usd.toFixed(2)})\n`;
  text += `├ 🟡 BNB: ${balances.bsc.native.toFixed(4)} ($${balances.bsc.usd.toFixed(2)})\n`;
  text += `└ 🔵 ETH: ${balances.base.native.toFixed(6)} ($${balances.base.usd.toFixed(2)})\n\n`;
  
  // 持仓
  if (positions.length > 0) {
    let totalPosValue = 0;
    let totalPosCost = 0;
    
    text += `📊 <b>持仓</b>\n`;
    for (const p of positions) {
      const pnl = p.pnl || 0;
      const emoji = pnl > 20 ? '🚀' : pnl > 0 ? '📈' : pnl > -20 ? '📉' : '💀';
      const chainEmoji = p.chain === 'solana' ? '🟣' : p.chain === 'bsc' ? '🟡' : '🔵';
      const smTag = p.smartMoneyCount ? ` SM:${p.smartMoneyCount}` : '';
      text += `${chainEmoji} ${emoji} <b>${p.symbol}</b> $${(p.valueUsd||0).toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)${smTag}\n`;
      
      totalPosValue += (p.valueUsd || 0);
      totalPosCost += (p.buyPrice || 0);
    }
    
    const totalPnl = totalPosCost > 0 ? ((totalPosValue - totalPosCost) / totalPosCost * 100) : 0;
    text += `\n💼 持仓总值: $${totalPosValue.toFixed(2)} (${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%)\n`;
  } else {
    text += `📊 <b>持仓</b>: 无\n`;
  }
  
  // 系统状态
  text += `\n⚙️ v7 OKX聪明钱跟单 | 30s监控`;
  
  return text;
}

async function refreshDashboard() {
  const [balances, positions] = await Promise.all([getBalances(), getPositions()]);
  const text = buildDashboard(balances, positions);
  return text;
}

async function sendOrEditTG(text) {
  if (!TG_BOT_TOKEN) return;
  
  const buttons = JSON.stringify({
    inline_keyboard: [[
      { text: '🔄 刷新', callback_data: 'refresh_meme_dashboard' }
    ]]
  });
  
  try {
    if (dashboardMsgId) {
      // 编辑
      const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          message_id: dashboardMsgId,
          text,
          parse_mode: 'HTML',
          reply_markup: buttons
        })
      });
      const data = await res.json();
      if (!data.ok) dashboardMsgId = null; // 消息可能被删了
    }
    
    if (!dashboardMsgId) {
      // 新发
      const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text,
          parse_mode: 'HTML',
          reply_markup: buttons
        })
      });
      const data = await res.json();
      if (data.ok) {
        dashboardMsgId = data.result.message_id;
        fs.writeFileSync(MSGID_FILE, String(dashboardMsgId));
      }
    }
  } catch(e) {}
}

// HTTP server
const server = http.createServer(async (req, res) => {
  if (req.url === '/refresh' || req.url === '/') {
    try {
      const text = await refreshDashboard();
      await sendOrEditTG(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  } else if (req.url === '/status') {
    // 纯JSON状态
    try {
      const [balances, positions] = await Promise.all([getBalances(), getPositions()]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, balances, positions }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`🐕 土狗看板 HTTP: http://127.0.0.1:${PORT}/refresh`);
});

// 启动时刷新一次
setTimeout(async () => {
  const text = await refreshDashboard();
  await sendOrEditTG(text);
  console.log('首次看板已发送');
}, 2000);
