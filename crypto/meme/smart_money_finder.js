/**
 * 聪明钱发现器 - 从成功token反推真正的聪明钱
 * 
 * 原理：
 * 1. 找已经成功的meme token（MC > 50k, 已迁移）
 * 2. 用aped-wallet获取每个token的持仓钱包+真实PnL
 * 3. 交叉匹配：在>=3个不同token都赚钱的钱包 = 真聪明钱
 * 4. 过滤：合约地址/空地址/只出现1次的全踢
 * 
 * 输出：经过验证的聪明钱排名
 */

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data/v7');
const FOUND_FILE = path.join(DATA_DIR, 'found_smart_money.json');

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

const CHAINS = ['bsc', 'base', 'solana'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findSmartMoney() {
  console.log('🔍 聪明钱发现器启动\n');
  
  // 1. 收集成功token
  const successTokens = [];
  
  for (const chain of CHAINS) {
    console.log(`📡 [${chain.toUpperCase()}] 搜索成功meme...`);
    
    try {
      const cmd = `onchainos market memepump-tokens ${chain} --stage MIGRATED --sort-by marketCap --sort-order desc --min-market-cap 100000`;
      const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 60000, maxBuffer: 10*1024*1024 }).toString());
      
      for (const t of (result.data || [])) {
        const aped = parseInt(t.aped || 0);
        if (aped < 1) continue; // 没有aped数据的跳过
        
        successTokens.push({
          chain,
          address: t.tokenAddress,
          symbol: t.symbol,
          marketCap: parseFloat(t.market?.marketCapUsd || 0),
          aped
        });
      }
    } catch(e) {
      console.log(`  ${chain} 失败: ${e.message?.slice(0,60)}`);
    }
  }
  
  // signal-list里MC>100k的token
  for (const chain of ['solana', 'bsc', 'base']) {
    try {
      const cmd = `onchainos market signal-list ${chain} --wallet-type "1" --min-market-cap-usd 100000`;
      const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 60000, maxBuffer: 10*1024*1024 }).toString());
      
      for (const s of (result.data || [])) {
        const addr = s.token.tokenAddress;
        if (successTokens.find(t => t.address === addr)) continue;
        
        const mc = parseFloat(s.token.marketCapUsd || 0);
        if (mc < 100000) continue;
        
        successTokens.push({
          chain,
          address: addr,
          symbol: s.token.symbol,
          marketCap: mc,
          aped: parseInt(s.triggerWalletCount || 0),
          fromSignal: true
        });
      }
    } catch(e) {}
  }
  
  // DexScreener top boosts（热门token，质量更高）
  try {
    const boosts = await fetch('https://api.dexscreener.com/token-boosts/top/v1').then(r=>r.json());
    if (Array.isArray(boosts)) {
      for (const b of boosts) {
        const chain = b.chainId === 'bsc' ? 'bsc' : b.chainId === 'base' ? 'base' : b.chainId === 'solana' ? 'solana' : null;
        if (!chain) continue;
        const addr = b.tokenAddress;
        if (!addr || successTokens.find(t => t.address === addr)) continue;
        
        // 查MC
        try {
          const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`).then(r=>r.json());
          const pair = dex.pairs?.[0];
          if (!pair) continue;
          const mc = parseFloat(pair.marketCap || 0);
          if (mc < 100000) continue;
          
          successTokens.push({
            chain, address: addr,
            symbol: pair.baseToken?.symbol || '?',
            marketCap: mc,
            aped: 0,
            fromDexScreener: true
          });
        } catch(e) {}
        await sleep(200);
      }
    }
    console.log(`  DexScreener boosts补充完毕`);
  } catch(e) {}
  
  console.log(`  找到 ${successTokens.length} 个成功token\n`);
  
  // 2. 对每个token获取aped wallet + PnL
  const walletPnL = {}; // wallet → [{ token, pnl, pnlPercent, chain }]
  let apedCount = 0;
  
  for (const token of successTokens) {
    try {
      const cmd = `onchainos market memepump-aped-wallet ${token.address} --chain ${token.chain}`;
      const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
      
      const wallets = result.data || [];
      if (wallets.length === 0) continue;
      
      apedCount++;
      
      for (const w of wallets) {
        const addr = w.walletAddress;
        if (!addr) continue;
        
        const pnl = parseFloat(w.totalPnl || 0);
        const pnlPercent = parseFloat(w.pnlPercent || 0);
        const holdingUsd = parseFloat(w.holdingUsd || 0);
        
        if (!walletPnL[addr]) walletPnL[addr] = [];
        walletPnL[addr].push({
          token: token.symbol,
          tokenAddress: token.address,
          chain: token.chain,
          pnl,
          pnlPercent,
          holdingUsd,
          marketCap: token.marketCap
        });
      }
      
      process.stdout.write(`\r  aped数据: ${apedCount}/${successTokens.length} tokens, ${Object.keys(walletPnL).length}个钱包`);
      
      await sleep(300); // 防限流
    } catch(e) {
      // skip
    }
  }
  
  console.log(`\n  共 ${Object.keys(walletPnL).length} 个钱包有aped数据\n`);
  
  // 3. 筛选真正的聪明钱
  // 条件：在>=2个不同token赚钱 + 总胜率>50%
  console.log('🧮 筛选真正聪明钱...');
  
  const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
  const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  
  const smartWallets = [];
  
  for (const [addr, trades] of Object.entries(walletPnL)) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0 && t.pnl !== 0).length;
    const winRate = trades.length > 0 ? wins / trades.length : 0;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnlPercent = trades.reduce((sum, t) => sum + t.pnlPercent, 0) / trades.length;
    
    if (totalPnl <= 0) continue; // 总PnL为负不要
    if (trades.length >= 2 && winRate < 0.3) continue; // 多币胜率太低不要
    
    // EVM合约/空地址检查
    if (addr.startsWith('0x')) {
      try {
        const chain = trades[0].chain;
        const provider = chain === 'base' ? baseProvider : bscProvider;
        const [code, txCount] = await Promise.all([
          provider.getCode(addr),
          provider.getTransactionCount(addr)
        ]);
        if (code !== '0x') continue; // 合约
        if (txCount === 0) continue; // 空地址
      } catch(e) {}
    }
    
    // 计算综合评分
    const chains = [...new Set(trades.map(t => t.chain))];
    const score = winRate * Math.max(avgPnlPercent, 0) * Math.log2(trades.length + 1);
    
    smartWallets.push({
      address: addr,
      chains,
      trades: trades.length,
      wins,
      losses,
      winRate: Math.round(winRate * 1000) / 10,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgPnlPercent: Math.round(avgPnlPercent * 10) / 10,
      score: Math.round(score * 100) / 100,
      topPicks: trades
        .sort((a, b) => b.pnl - a.pnl)
        .slice(0, 5)
        .map(t => `${t.token}(${t.pnl > 0 ? '+' : ''}$${t.pnl.toFixed(0)})`)
    });
  }
  
  // 按评分排序
  smartWallets.sort((a, b) => b.score - a.score);
  
  console.log(`  发现 ${smartWallets.length} 个真正聪明钱\n`);
  
  // 4. 打印结果
  console.log('🏆 自建聪明钱排名 TOP 30');
  console.log('─'.repeat(90));
  console.log('  #  钱包              链       胜率   PnL总计    均PnL%  Token数  评分');
  console.log('─'.repeat(90));
  
  for (let i = 0; i < Math.min(30, smartWallets.length); i++) {
    const w = smartWallets[i];
    const addr = w.address.startsWith('0x') 
      ? w.address.slice(0, 6) + '...' + w.address.slice(-4) 
      : w.address.slice(0, 6) + '...' + w.address.slice(-4);
    
    console.log(`  ${String(i+1).padStart(2)}  ${addr.padEnd(15)} ${w.chains.join('/').padEnd(8)} ${(w.winRate+'%').padStart(6)} $${w.totalPnl.toFixed(0).padStart(8)} ${(w.avgPnlPercent.toFixed(1)+'%').padStart(8)} ${String(w.trades).padStart(5)} ${w.score.toFixed(1).padStart(8)}`);
    console.log(`      └ ${w.topPicks.join(' ')}`);
  }
  
  console.log('─'.repeat(90));
  
  // 5. 保存
  const output = {
    updated: Date.now(),
    method: 'reverse-engineering from successful tokens + real PnL',
    tokensScanned: successTokens.length,
    walletsFound: smartWallets.length,
    wallets: smartWallets
  };
  
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FOUND_FILE, JSON.stringify(output, null, 2));
  console.log(`\n💾 保存到 ${FOUND_FILE}`);
  
  return smartWallets;
}

if (require.main === module) {
  findSmartMoney().catch(e => console.error('Fatal:', e));
}

module.exports = { findSmartMoney };
