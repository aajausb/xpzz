const { ethers } = require('ethers');
const fs = require('fs');

const TOKEN = '0xbc16154c375184cf604cfdff5167fa03c26f7777';
const WALLET = '0xe00ca1d766f329eFfC05E704499f10dB1F14FD47';
const PROVIDER = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
const CONTRACT = new ethers.Contract(TOKEN, [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
], PROVIDER);

const BUY_PRICE_USD = 10;
const STOP_LOSS = -50;      // -50%止损
const TAKE_PROFIT = 100;    // +100%止盈
const CHECK_INTERVAL = 30000; // 30秒

async function check() {
  try {
    const bal = await CONTRACT.balanceOf(WALLET);
    const dec = await CONTRACT.decimals();
    const tokens = Number(bal) / 10**Number(dec);
    
    // 从DexScreener拿价格
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + TOKEN);
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) { console.log('无价格数据'); return; }
    
    const price = parseFloat(pair.priceUsd);
    const valueUsd = tokens * price;
    const pnl = ((valueUsd - BUY_PRICE_USD) / BUY_PRICE_USD * 100);
    const mc = parseFloat(pair.marketCap || 0);
    const liq = parseFloat(pair.liquidity?.usd || 0);
    const h24 = pair.priceChange?.h24 || '?';
    
    const emoji = pnl > 0 ? '📈' : '📉';
    const line = `${emoji} 天梯 | $${valueUsd.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%) | MC $${(mc/1000).toFixed(0)}k | Liq $${(liq/1000).toFixed(0)}k | 24h ${h24}%`;
    console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
    
    // 写状态文件供heartbeat读取
    fs.writeFileSync('/root/.openclaw/workspace/crypto/meme/data/v7/watch_status.json', JSON.stringify({
      symbol: '天梯', chain: 'bsc', tokens, price, valueUsd, pnl, mc, liq,
      buyPrice: BUY_PRICE_USD, lastCheck: Date.now()
    }));
    
    // 止损/止盈告警
    if (pnl <= STOP_LOSS) {
      console.log('🚨 触发止损! PnL=' + pnl.toFixed(1) + '%');
      // 自动卖出
      try {
        const { sell } = require('./dex_trader');
        const result = await sell('bsc', TOKEN, bal.toString());
        console.log('🔴 止损卖出:', result.success ? '✅' : '❌', result.txHash);
        process.exit(0);
      } catch(e) { console.log('卖出失败:', e.message); }
    }
    
    if (pnl >= TAKE_PROFIT) {
      console.log('🎉 翻倍了! PnL=' + pnl.toFixed(1) + '%');
      // 卖一半
      try {
        const { sell } = require('./dex_trader');
        const halfBal = (BigInt(bal.toString()) / 2n).toString();
        const result = await sell('bsc', TOKEN, halfBal);
        console.log('🟢 止盈卖半:', result.success ? '✅' : '❌', result.txHash);
      } catch(e) { console.log('卖出失败:', e.message); }
    }
    
  } catch(e) {
    console.log('检查出错:', e.message?.slice(0, 60));
  }
}

console.log('👀 开始盯天梯 | 止损-50% | 翻倍卖半 | 30秒/轮');
check();
setInterval(check, CHECK_INTERVAL);
