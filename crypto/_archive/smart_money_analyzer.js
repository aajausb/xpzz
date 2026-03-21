#!/usr/bin/env node
/**
 * 聪明钱深度分析器 — smart_money_analyzer.js
 * 
 * 三大功能：
 * 1. 利润追踪：每个钱包买了什么、赚了多少、ROI多少
 * 2. 交叉验证：找到跨链活跃的钱包（多链都赚过钱的）
 * 3. 反向验证：拿已知暴涨币反查，看哪些聪明钱命中了
 * 
 * 输出：crypto/sm_deep_analysis.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_KEY2 = process.env.HELIUS_API_KEY_2;
const OUTPUT = path.join(WORKSPACE, 'crypto/sm_deep_analysis.json');

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers: { 'Accept': 'application/json' }, timeout: 15000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
    }).on('error', e => resolve(null));
  });
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ============================================================
// 1. Solana 利润追踪 — 用 Helius parseTransaction
// ============================================================
async function analyzeSolWalletProfit(address, apiKey) {
  // 获取最近的swap交易
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&type=SWAP&limit=50`;
  const txs = await httpGet(url);
  if (!txs || !Array.isArray(txs)) return null;
  
  const trades = []; // { token, action, solAmount, tokenAmount, timestamp }
  const tokenPnl = {}; // token -> { invested, returned, trades, firstBuy, lastSell }
  
  for (const tx of txs) {
    if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;
    const ts = tx.timestamp || 0;
    
    // 判断买还是卖：SOL出去=买，SOL进来=卖
    let solOut = 0, solIn = 0;
    let tokenMint = '', tokenAmount = 0, action = '';
    
    for (const tt of tx.tokenTransfers) {
      if (tt.mint === 'So11111111111111111111111111111111111111112') {
        if (tt.fromUserAccount === address) solOut += (tt.tokenAmount || 0);
        if (tt.toUserAccount === address) solIn += (tt.tokenAmount || 0);
      } else {
        tokenMint = tt.mint;
        tokenAmount = tt.tokenAmount || 0;
        if (tt.toUserAccount === address) action = 'buy';
        if (tt.fromUserAccount === address) action = 'sell';
      }
    }
    
    if (!tokenMint || !action) continue;
    
    const solAmount = action === 'buy' ? solOut : solIn;
    trades.push({ token: tokenMint, action, solAmount, tokenAmount, ts });
    
    if (!tokenPnl[tokenMint]) {
      tokenPnl[tokenMint] = { invested: 0, returned: 0, buyCount: 0, sellCount: 0, firstBuy: ts, lastSell: 0 };
    }
    if (action === 'buy') {
      tokenPnl[tokenMint].invested += solAmount;
      tokenPnl[tokenMint].buyCount++;
      if (ts < tokenPnl[tokenMint].firstBuy) tokenPnl[tokenMint].firstBuy = ts;
    } else {
      tokenPnl[tokenMint].returned += solAmount;
      tokenPnl[tokenMint].sellCount++;
      if (ts > tokenPnl[tokenMint].lastSell) tokenPnl[tokenMint].lastSell = ts;
    }
  }
  
  // 计算每个代币的PnL
  let totalInvested = 0, totalReturned = 0;
  let wins = 0, losses = 0;
  const tokenResults = [];
  
  for (const [token, pnl] of Object.entries(tokenPnl)) {
    const profit = pnl.returned - pnl.invested;
    const roi = pnl.invested > 0 ? (profit / pnl.invested * 100) : 0;
    totalInvested += pnl.invested;
    totalReturned += pnl.returned;
    
    if (pnl.sellCount > 0) { // 只统计已卖出的
      if (profit > 0) wins++;
      else losses++;
    }
    
    tokenResults.push({
      token: token.slice(0, 12) + '...',
      tokenFull: token,
      invested: +pnl.invested.toFixed(4),
      returned: +pnl.returned.toFixed(4),
      profit: +profit.toFixed(4),
      roi: +roi.toFixed(1),
      buys: pnl.buyCount,
      sells: pnl.sellCount,
    });
  }
  
  tokenResults.sort((a, b) => b.profit - a.profit);
  
  return {
    address,
    totalTrades: trades.length,
    totalInvested: +totalInvested.toFixed(4),
    totalReturned: +totalReturned.toFixed(4),
    totalProfit: +(totalReturned - totalInvested).toFixed(4),
    totalROI: totalInvested > 0 ? +((totalReturned - totalInvested) / totalInvested * 100).toFixed(1) : 0,
    wins, losses,
    winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
    topTokens: tokenResults.slice(0, 10),
    analyzedAt: new Date().toISOString()
  };
}

// ============================================================
// 2. EVM 利润追踪 — 用 GeckoTerminal 反查
// ============================================================
async function analyzeEvmWalletProfit(address, chain) {
  const networkId = chain === 'bsc' ? 'bsc' : 'base';
  const rpcUrl = chain === 'bsc' 
    ? 'https://bsc-mainnet.public.blastapi.io'
    : 'https://base-mainnet.public.blastapi.io';
  
  // 获取该钱包最近的ERC20 Transfer事件（买入/卖出记录）
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const addrPadded = '0x' + address.slice(2).toLowerCase().padStart(64, '0');
  
  // 获取最新区块
  const blockResp = await httpPost(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  const latestBlock = parseInt(blockResp?.result || '0', 16);
  if (!latestBlock) return null;
  
  const fromBlock = '0x' + Math.max(latestBlock - 200000, 0).toString(16); // ~7天
  
  // 买入（接收token）
  const buyLogs = await httpPost(rpcUrl, {
    jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
    params: [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, addrPadded] }]
  });
  
  // 卖出（发送token）
  const sellLogs = await httpPost(rpcUrl, {
    jsonrpc: '2.0', id: 3, method: 'eth_getLogs',
    params: [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, addrPadded, null] }]
  });
  
  const buys = buyLogs?.result || [];
  const sells = sellLogs?.result || [];
  
  // 按token汇总
  const tokenActivity = {};
  for (const log of buys) {
    const token = log.address.toLowerCase();
    if (!tokenActivity[token]) tokenActivity[token] = { buys: 0, sells: 0, buyBlocks: [], sellBlocks: [] };
    tokenActivity[token].buys++;
    tokenActivity[token].buyBlocks.push(parseInt(log.blockNumber, 16));
  }
  for (const log of sells) {
    const token = log.address.toLowerCase();
    if (!tokenActivity[token]) tokenActivity[token] = { buys: 0, sells: 0, buyBlocks: [], sellBlocks: [] };
    tokenActivity[token].sells++;
    tokenActivity[token].sellBlocks.push(parseInt(log.blockNumber, 16));
  }
  
  // 查价格变化来估算利润（用GeckoTerminal）
  const tokens = Object.entries(tokenActivity)
    .filter(([_, v]) => v.buys >= 2) // 至少买了2次
    .sort((a, b) => b[1].buys - a[1].buys)
    .slice(0, 10); // top 10 活跃代币
  
  let profitableTokens = 0, unprofitableTokens = 0;
  const tokenResults = [];
  
  for (const [token, activity] of tokens) {
    await sleep(500); // GeckoTerminal限流
    
    try {
      const priceData = await httpGet(`https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${token}/pools?page=1`);
      const pool = priceData?.data?.[0];
      const price = parseFloat(pool?.attributes?.base_token_price_usd || '0');
      const name = pool?.attributes?.name || token.slice(0, 10);
      
      if (price > 0) {
        // 获取K线估算买入时的价格
        const poolAddr = pool?.attributes?.address;
        if (poolAddr) {
          const kline = await httpGet(`https://api.geckoterminal.com/api/v2/networks/${networkId}/pools/${poolAddr}/ohlcv/hour?aggregate=4&limit=42`);
          const ohlcvList = kline?.data?.attributes?.ohlcv_list || [];
          
          if (ohlcvList.length > 0) {
            const oldPrice = ohlcvList[ohlcvList.length - 1][4]; // 最旧的收盘价
            const priceChange = oldPrice > 0 ? ((price - oldPrice) / oldPrice * 100) : 0;
            
            // 如果在底部买入（买入区块早于K线范围内）
            const isBuyEarly = activity.buyBlocks.length > 0 && 
              activity.buyBlocks[0] < latestBlock - 100000;
            
            tokenResults.push({
              token: token.slice(0, 12) + '...',
              tokenFull: token,
              name,
              currentPrice: price,
              priceChange7d: +priceChange.toFixed(1),
              buys: activity.buys,
              sells: activity.sells,
              earlyBuyer: isBuyEarly,
              stillHolding: activity.sells < activity.buys
            });
            
            if (priceChange > 0 && activity.buys > activity.sells) profitableTokens++;
            else if (priceChange < -20) unprofitableTokens++;
          }
        }
      }
    } catch(e) {}
    
    await sleep(300);
  }
  
  tokenResults.sort((a, b) => b.priceChange7d - a.priceChange7d);
  
  return {
    address,
    chain,
    totalBuys: buys.length,
    totalSells: sells.length,
    uniqueTokens: Object.keys(tokenActivity).length,
    profitableTokens,
    unprofitableTokens,
    topTokens: tokenResults.slice(0, 5),
    analyzedAt: new Date().toISOString()
  };
}

// ============================================================
// 3. 反向验证 — 拿暴涨币反查聪明钱命中率
// ============================================================
async function reverseValidation(chain, tokenAddress, pumpDate, pumpMultiple) {
  const networkId = chain === 'solana' ? 'solana' : (chain === 'bsc' ? 'bsc' : 'base');
  
  // 加载聪明钱列表
  const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), 'utf8'));
  const wallets = rank[chain] || [];
  const coreAddrs = new Set(wallets.filter(w => w.weight === 3).map(w => w.address));
  const normalAddrs = new Set(wallets.filter(w => w.weight === 2).map(w => w.address));
  const allAddrs = new Set(wallets.map(w => w.address));
  
  log(`反向验证: ${chain}/${tokenAddress.slice(0,12)}... 暴涨${pumpMultiple}x`);
  log(`聪明钱: 核心${coreAddrs.size} 正常${normalAddrs.size} 总${allAddrs.size}`);
  
  if (chain === 'solana') {
    // Helius查该代币的所有swap交易
    const url = `https://api.helius.xyz/v0/addresses/${tokenAddress}/transactions?api-key=${HELIUS_KEY}&type=SWAP&limit=100`;
    const txs = await httpGet(url);
    if (!txs || !Array.isArray(txs)) return null;
    
    const buyers = new Set();
    const smartBuyers = { core: [], normal: [], watch: [] };
    
    for (const tx of txs) {
      if (!tx.tokenTransfers) continue;
      for (const tt of tx.tokenTransfers) {
        if (tt.mint === tokenAddress && tt.toUserAccount) {
          const buyer = tt.toUserAccount;
          buyers.add(buyer);
          if (coreAddrs.has(buyer)) smartBuyers.core.push(buyer);
          else if (normalAddrs.has(buyer)) smartBuyers.normal.push(buyer);
          else if (allAddrs.has(buyer)) smartBuyers.watch.push(buyer);
        }
      }
    }
    
    return {
      token: tokenAddress,
      chain,
      pumpMultiple,
      totalBuyers: buyers.size,
      smartMoneyHits: {
        core: [...new Set(smartBuyers.core)],
        normal: [...new Set(smartBuyers.normal)],
        watch: [...new Set(smartBuyers.watch)]
      },
      hitRate: allAddrs.size > 0 ? +([...new Set([...smartBuyers.core, ...smartBuyers.normal, ...smartBuyers.watch])].length / allAddrs.size * 100).toFixed(2) : 0,
      analyzedAt: new Date().toISOString()
    };
  } else {
    // EVM: 查Transfer logs
    const rpcUrl = chain === 'bsc' 
      ? 'https://bsc-mainnet.public.blastapi.io'
      : 'https://base-mainnet.public.blastapi.io';
    
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    
    const blockResp = await httpPost(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const latestBlock = parseInt(blockResp?.result || '0', 16);
    const fromBlock = '0x' + Math.max(latestBlock - 600000, 0).toString(16); // ~20天
    
    const logs = await httpPost(rpcUrl, {
      jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
      params: [{
        fromBlock, toBlock: 'latest',
        address: tokenAddress,
        topics: [TRANSFER_TOPIC]
      }]
    });
    
    const buyers = new Set();
    const smartBuyers = { core: [], normal: [], watch: [] };
    
    for (const log of (logs?.result || [])) {
      if (log.topics && log.topics[2]) {
        const buyer = '0x' + log.topics[2].slice(26).toLowerCase();
        buyers.add(buyer);
        if (coreAddrs.has(buyer)) smartBuyers.core.push(buyer);
        else if (normalAddrs.has(buyer)) smartBuyers.normal.push(buyer);
        else if (allAddrs.has(buyer)) smartBuyers.watch.push(buyer);
      }
    }
    
    return {
      token: tokenAddress,
      chain,
      pumpMultiple,
      totalBuyers: buyers.size,
      smartMoneyHits: {
        core: [...new Set(smartBuyers.core)],
        normal: [...new Set(smartBuyers.normal)],
        watch: [...new Set(smartBuyers.watch)]
      },
      hitRate: allAddrs.size > 0 ? +([...new Set([...smartBuyers.core, ...smartBuyers.normal, ...smartBuyers.watch])].length / allAddrs.size * 100).toFixed(2) : 0,
      analyzedAt: new Date().toISOString()
    };
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), 'utf8'));
  
  const result = {
    profits: { solana: [], bsc: [], base: [] },
    crossChain: [],
    reverseValidation: [],
    summary: {},
    analyzedAt: new Date().toISOString()
  };
  
  // ---- 1. SOL 核心钱包利润追踪 ----
  log('=== 1. SOL 核心钱包利润追踪 ===');
  const solCore = (rank.solana || []).filter(w => w.weight === 3).slice(0, 15); // top15核心
  let keyToggle = false;
  
  for (const w of solCore) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    log(`  分析 ${w.address.slice(0,12)}...`);
    const profit = await analyzeSolWalletProfit(w.address, key);
    if (profit) {
      result.profits.solana.push(profit);
      log(`    投入:${profit.totalInvested} SOL 回收:${profit.totalReturned} SOL 利润:${profit.totalProfit} SOL ROI:${profit.totalROI}%`);
    }
    await sleep(500);
  }
  
  // ---- 2. BSC 核心钱包利润追踪 ----
  log('=== 2. BSC 核心钱包利润追踪 ===');
  const bscCore = (rank.bsc || []).filter(w => w.weight === 3).slice(0, 9);
  
  for (const w of bscCore) {
    log(`  分析 ${w.address.slice(0,12)}...`);
    const profit = await analyzeEvmWalletProfit(w.address, 'bsc');
    if (profit) {
      result.profits.bsc.push(profit);
      log(`    买入:${profit.totalBuys}次 卖出:${profit.totalSells}次 盈利代币:${profit.profitableTokens}`);
    }
    await sleep(1000);
  }
  
  // ---- 3. BASE 核心钱包利润追踪 ----
  log('=== 3. BASE 核心钱包利润追踪 ===');
  const baseCore = (rank.base || []).filter(w => w.weight === 3).slice(0, 3);
  
  for (const w of baseCore) {
    log(`  分析 ${w.address.slice(0,12)}...`);
    const profit = await analyzeEvmWalletProfit(w.address, 'base');
    if (profit) {
      result.profits.base.push(profit);
      log(`    买入:${profit.totalBuys}次 卖出:${profit.totalSells}次 盈利代币:${profit.profitableTokens}`);
    }
    await sleep(1000);
  }
  
  // ---- 4. 反向验证 — 用龙虾(BSC)做测试 ----
  log('=== 4. 反向验证 ===');
  const reverseTargets = [
    { chain: 'bsc', token: '0xeccbb861c0dda7efd964010085488b69317e4444', name: '龙虾', pump: 7 },
  ];
  
  for (const target of reverseTargets) {
    const rv = await reverseValidation(target.chain, target.token, null, target.pump);
    if (rv) {
      rv.name = target.name;
      result.reverseValidation.push(rv);
      log(`  ${target.name}: ${rv.totalBuyers}买家, 命中核心${rv.smartMoneyHits.core.length} 正常${rv.smartMoneyHits.normal.length}`);
    }
  }
  
  // ---- 汇总 ----
  const solProfits = result.profits.solana;
  const totalSolProfit = solProfits.reduce((s, p) => s + p.totalProfit, 0);
  const avgSolROI = solProfits.length > 0 ? solProfits.reduce((s, p) => s + p.totalROI, 0) / solProfits.length : 0;
  const avgSolWinRate = solProfits.length > 0 ? solProfits.reduce((s, p) => s + p.winRate, 0) / solProfits.length : 0;
  
  result.summary = {
    solana: {
      analyzed: solProfits.length,
      totalProfit: +totalSolProfit.toFixed(4),
      avgROI: +avgSolROI.toFixed(1),
      avgWinRate: +avgSolWinRate.toFixed(1),
      bestWallet: solProfits.sort((a,b) => b.totalProfit - a.totalProfit)[0]?.address?.slice(0,12) || '-',
      bestProfit: solProfits[0]?.totalProfit || 0
    },
    bsc: { analyzed: result.profits.bsc.length },
    base: { analyzed: result.profits.base.length },
    reverseHits: result.reverseValidation.map(rv => ({
      name: rv.name,
      totalBuyers: rv.totalBuyers,
      coreHits: rv.smartMoneyHits.core.length,
      normalHits: rv.smartMoneyHits.normal.length,
      hitRate: rv.hitRate
    }))
  };
  
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  log(`✅ 分析完成，结果保存到 sm_deep_analysis.json`);
  log(`📊 SOL核心: 总利润${totalSolProfit.toFixed(2)} SOL, 平均ROI ${avgSolROI.toFixed(0)}%, 平均胜率${avgSolWinRate.toFixed(0)}%`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
