#!/usr/bin/env node
/**
 * 快捷买入 - 直接传美元金额
 * 用法: node scripts/quick_buy.js <chain> <token> <amountUsd>
 * 例: node scripts/quick_buy.js solana 6N5BBBbW... 200
 */
const trader = require('../dex_trader.js');
const https = require('https');

function get(url) {
  return new Promise((ok, no) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => ok(d));
    }).on('error', no);
  });
}

async function main() {
  const [chain, token, usdStr] = process.argv.slice(2);
  if (!chain || !token || !usdStr) {
    console.log('用法: node scripts/quick_buy.js <chain> <token> <amountUsd>');
    process.exit(1);
  }
  const usd = parseFloat(usdStr);

  let nativeAmount;
  if (chain === 'solana') {
    // 查SOL价格
    const data = JSON.parse(await get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'));
    const pair = data.pairs?.find(p => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
    const price = parseFloat(pair?.priceUsd || 0);
    if (!price) throw new Error('获取SOL价格失败');
    nativeAmount = Math.floor((usd / price) * 1e9);
    console.log(`SOL=$${price} → $${usd} = ${(nativeAmount/1e9).toFixed(4)} SOL`);
  } else {
    // EVM: 查ETH/BNB价格
    const { ethers } = require('ethers');
    const nativeToken = chain === 'bsc' ? 'binancecoin' : 'ethereum';
    const data = JSON.parse(await get(`https://api.dexscreener.com/latest/dex/tokens/${chain === 'bsc' ? '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' : '0x4200000000000000000000000000000000000006'}`));
    const pair = data.pairs?.find(p => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
    const price = parseFloat(pair?.priceUsd || 0);
    if (!price) throw new Error(`获取${chain}原生代币价格失败`);
    nativeAmount = ethers.parseEther((usd / price).toFixed(18)).toString();
    console.log(`${chain} native=$${price} → $${usd} = ${(usd/price).toFixed(6)}`);
  }

  const t0 = Date.now();
  const r = await trader.buy(chain, token, nativeAmount);
  const ms = Date.now() - t0;
  if (r.success) {
    console.log(`✅ ${ms}ms tx=${r.txHash}`);
  } else {
    console.log(`❌ ${ms}ms error=${r.error}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
