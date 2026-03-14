#!/usr/bin/env node
// 聪明钱扫描器 v2 — 从涨幅大的币倒推早期买家
const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');
const smartMoney = require('./smart_money');

const conn1 = new Connection(config.heliusRpc1, 'confirmed');
const conn2 = new Connection(config.heliusRpc2, 'confirmed');
const HELIUS_KEY = config.heliusKey1;
const HELIUS_KEY2 = config.heliusKey2;

const WALLET_TYPES = {
  SNIPER: 'sniper',
  TREND: 'trend',
  ACCUMULATOR: 'accumulator',
  WHALE: 'whale',
};

// ========== Step 1: 找近期涨幅大的币 ==========

// 用 DexScreener API 找热门 Solana meme 币
async function findWinningTokens() {
  logger.info('scanner', '🔍 搜索近期涨幅大的Solana meme币...');
  
  const results = [];
  
  try {
    // DexScreener 热门代币
    const url = 'https://api.dexscreener.com/token-boosts/top/v1';
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const solTokens = (data || [])
        .filter(t => t.chainId === 'solana')
        .slice(0, 20);
      
      for (const t of solTokens) {
        results.push({
          mint: t.tokenAddress,
          source: 'dexscreener_boost',
        });
      }
      logger.info('scanner', `DexScreener boosts: ${solTokens.length}个`);
    }
  } catch (e) {
    logger.warn('scanner', `DexScreener boost failed: ${e.message}`);
  }
  
  try {
    // DexScreener 最近涨幅排行
    const url2 = 'https://api.dexscreener.com/latest/dex/search?q=pump';
    const resp2 = await fetch(url2);
    if (resp2.ok) {
      const data2 = await resp2.json();
      const pairs = (data2.pairs || [])
        .filter(p => p.chainId === 'solana' && p.priceChange?.h24 > 100) // 24h涨>100%
        .sort((a, b) => (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0))
        .slice(0, 20);
      
      for (const p of pairs) {
        if (!results.find(r => r.mint === p.baseToken?.address)) {
          results.push({
            mint: p.baseToken?.address,
            name: p.baseToken?.name,
            symbol: p.baseToken?.symbol,
            priceChange24h: p.priceChange?.h24,
            volume24h: p.volume?.h24,
            source: 'dexscreener_gainers',
          });
        }
      }
      logger.info('scanner', `DexScreener 24h涨幅>100%: ${pairs.length}个`);
    }
  } catch (e) {
    logger.warn('scanner', `DexScreener search failed: ${e.message}`);
  }

  try {
    // Birdeye 热门代币（备用）
    const url3 = 'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20';
    const resp3 = await fetch(url3, {
      headers: { 'X-API-KEY': 'public' },
    });
    if (resp3.ok) {
      const data3 = await resp3.json();
      const tokens = data3.data?.items || [];
      for (const t of tokens) {
        if (!results.find(r => r.mint === t.address)) {
          results.push({
            mint: t.address,
            name: t.name,
            symbol: t.symbol,
            source: 'birdeye_trending',
          });
        }
      }
      logger.info('scanner', `Birdeye trending: ${tokens.length}个`);
    }
  } catch (e) {
    logger.warn('scanner', `Birdeye failed: ${e.message}`);
  }

  logger.info('scanner', `共找到 ${results.length} 个候选币`);
  return results;
}

// ========== Step 2: 找某个币的早期买家 ==========

async function findEarlyBuyers(mint) {
  try {
    // 获取该token最早的交易签名
    const sigs = await conn1.getSignaturesForAddress(new PublicKey(mint), { 
      limit: 100 
    });
    
    if (sigs.length === 0) return [];
    
    // 按时间排序（最早的在前）
    sigs.sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
    
    // 取最早的30笔交易
    const earlySigs = sigs.slice(0, 30);
    const buyers = new Map(); // address → { firstBuyTime, txCount }
    
    for (const sig of earlySigs) {
      try {
        const tx = await conn2.getTransaction(sig.signature, { 
          maxSupportedTransactionVersion: 0 
        });
        if (!tx) continue;
        
        const keys = tx.transaction.message.staticAccountKeys 
          || tx.transaction.message.accountKeys;
        const feePayer = keys[0]?.toString();
        
        if (feePayer && !buyers.has(feePayer)) {
          buyers.set(feePayer, {
            address: feePayer,
            firstBuyTime: sig.blockTime,
            signature: sig.signature,
          });
        }
      } catch {}
      
      // rate limit
      if (buyers.size >= 20) break;
    }
    
    return [...buyers.values()];
  } catch (e) {
    logger.error('scanner', `findEarlyBuyers failed for ${mint.slice(0, 8)}`, { error: e.message });
    return [];
  }
}

// ========== Step 3: 分析钱包交易历史 ==========

async function analyzeWallet(address) {
  // 用Helius Enhanced TX查
  let trades = [];
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY2}&limit=100`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data)) trades = data;
    }
  } catch {}
  
  if (trades.length < 3) return null;

  // 按token分组分析盈亏
  const tokenMap = new Map();
  
  for (const tx of trades) {
    if (tx.type !== 'SWAP' && tx.type !== 'TRANSFER') continue;
    
    for (const transfer of (tx.tokenTransfers || [])) {
      const mint = transfer.mint;
      if (!mint || mint === config.SOL_MINT) continue;
      
      if (!tokenMap.has(mint)) tokenMap.set(mint, { buys: [], sells: [] });
      const record = tokenMap.get(mint);
      
      if (transfer.toUserAccount === address) {
        record.buys.push({
          amount: transfer.tokenAmount,
          timestamp: tx.timestamp,
          solSpent: (tx.nativeTransfers || [])
            .filter(n => n.fromUserAccount === address)
            .reduce((s, n) => s + n.amount, 0) / 1e9,
        });
      } else if (transfer.fromUserAccount === address) {
        record.sells.push({
          amount: transfer.tokenAmount,
          timestamp: tx.timestamp,
          solReceived: (tx.nativeTransfers || [])
            .filter(n => n.toUserAccount === address)
            .reduce((s, n) => s + n.amount, 0) / 1e9,
        });
      }
    }
  }

  if (tokenMap.size < 2) return null;

  let wins = 0, losses = 0, totalProfit = 0;
  let holdTimes = [];
  let buySizes = [];
  
  for (const [mint, record] of tokenMap) {
    const totalBuySol = record.buys.reduce((s, b) => s + b.solSpent, 0);
    const totalSellSol = record.sells.reduce((s, s2) => s + s2.solReceived, 0);
    
    if (totalBuySol < 0.01) continue; // 忽略极小交易
    
    const profit = totalSellSol - totalBuySol;
    totalProfit += profit;
    
    if (totalSellSol > totalBuySol * 1.1) wins++; // 赚>10%算赢
    else if (record.sells.length > 0) losses++; // 有卖出但没赚算亏
    // 没卖出的不计
    
    if (record.buys.length > 0 && record.sells.length > 0) {
      const firstBuy = Math.min(...record.buys.map(b => b.timestamp));
      const lastSell = Math.max(...record.sells.map(s => s.timestamp));
      if (lastSell > firstBuy) holdTimes.push(lastSell - firstBuy);
    }
    
    buySizes.push(totalBuySol);
  }

  const totalTrades = wins + losses;
  if (totalTrades < 2) return null;

  const winRate = wins / totalTrades;
  const avgHoldTime = holdTimes.length > 0 
    ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length 
    : 0;
  const avgBuySize = buySizes.length > 0 
    ? buySizes.reduce((a, b) => a + b, 0) / buySizes.length 
    : 0;

  // 分类
  let type = WALLET_TYPES.TREND;
  if (avgHoldTime < 1800) type = WALLET_TYPES.SNIPER;
  else if (avgHoldTime > 86400) type = WALLET_TYPES.ACCUMULATOR;
  if (avgBuySize > 5) type = WALLET_TYPES.WHALE;

  return {
    address,
    type,
    winRate,
    wins,
    losses,
    totalTrades,
    totalProfitSol: totalProfit,
    avgHoldTimeSec: avgHoldTime,
    avgHoldTimeHuman: formatDuration(avgHoldTime),
    avgBuySizeSol: avgBuySize,
    tokensTraded: tokenMap.size,
    analyzedAt: Date.now(),
  };
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}小时`;
  return `${(seconds / 86400).toFixed(1)}天`;
}

// ========== 主扫描流程 ==========

async function scan() {
  logger.info('scanner', '🔍 聪明钱扫描 v2 — 从涨幅币倒推早期买家');
  const startTime = Date.now();

  // 1. 找涨幅大的币
  const winners = await findWinningTokens();
  if (winners.length === 0) {
    logger.warn('scanner', '没找到热门币');
    return { analyzed: 0, found: 0, newAdded: 0 };
  }

  // 2. 从每个涨幅币中提取早期买家
  const allBuyers = new Map(); // address → { appearances, tokens }
  
  for (const token of winners.slice(0, 15)) {
    if (!token.mint) continue;
    logger.info('scanner', `分析 ${token.symbol || token.mint.slice(0,8)} 的早期买家...`);
    
    const buyers = await findEarlyBuyers(token.mint);
    for (const buyer of buyers) {
      if (!allBuyers.has(buyer.address)) {
        allBuyers.set(buyer.address, { appearances: 0, tokens: [] });
      }
      const rec = allBuyers.get(buyer.address);
      rec.appearances++;
      rec.tokens.push(token.symbol || token.mint.slice(0, 8));
    }
    
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info('scanner', `共发现 ${allBuyers.size} 个早期买家`);
  
  // 3. 优先分析出现在多个涨幅币中的钱包（更可能是聪明钱）
  const sortedBuyers = [...allBuyers.entries()]
    .sort((a, b) => b[1].appearances - a[1].appearances);
  
  // 出现在2+个涨幅币中的 = 高优先级
  const highPriority = sortedBuyers.filter(([, v]) => v.appearances >= 2);
  const normalPriority = sortedBuyers.filter(([, v]) => v.appearances === 1).slice(0, 30);
  const toAnalyze = [...highPriority, ...normalPriority];
  
  logger.info('scanner', `高优先(出现2+次): ${highPriority.length}, 普通: ${normalPriority.length}`);

  // 4. 分析每个钱包
  const qualifiedWallets = [];
  let analyzed = 0;

  for (const [address, { appearances, tokens }] of toAnalyze) {
    try {
      const result = await analyzeWallet(address);
      analyzed++;
      
      if (result && result.winRate >= 0.4 && result.totalProfitSol > 0.1) {
        result.appearances = appearances;
        result.foundInTokens = tokens;
        qualifiedWallets.push(result);
        logger.info('scanner', `✅ 聪明钱: ${address.slice(0, 8)}...`, {
          type: result.type,
          winRate: `${(result.winRate * 100).toFixed(0)}%`,
          profit: `${result.totalProfitSol.toFixed(2)} SOL`,
          avgHold: result.avgHoldTimeHuman,
          appearances,
          tokens: tokens.join(','),
        });
      }
      
      if (analyzed % 10 === 0) {
        logger.info('scanner', `进度: ${analyzed}/${toAnalyze.length}`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      logger.error('scanner', `分析 ${address.slice(0, 8)} 失败`, { error: e.message });
    }
  }

  // 5. 保存结果
  const existing = smartMoney.loadSmartWallets();
  const existingAddresses = new Set(existing.wallets.map(w => w.address));
  
  let newCount = 0;
  for (const w of qualifiedWallets) {
    if (!existingAddresses.has(w.address)) {
      smartMoney.addSmartWallet(w.address, `${w.type}_v2`, {
        winRate: w.winRate,
        profitSol: w.totalProfitSol,
        trades: w.totalTrades,
        type: w.type,
        avgHoldTime: w.avgHoldTimeSec,
        appearances: w.appearances,
        foundInTokens: w.foundInTokens,
        source: 'winner_backtrack',
      });
      newCount++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // 类型分布
  const typeCount = {};
  for (const w of qualifiedWallets) {
    typeCount[w.type] = (typeCount[w.type] || 0) + 1;
  }
  
  logger.info('scanner', `🔍 扫描完成: ${elapsed}秒`);
  logger.info('scanner', `分析${analyzed}钱包, 发现${qualifiedWallets.length}个聪明钱(${newCount}新增)`);
  logger.info('scanner', '类型分布:', typeCount);

  return {
    analyzed,
    found: qualifiedWallets.length,
    newAdded: newCount,
    elapsed,
    typeDistribution: typeCount,
    wallets: qualifiedWallets,
  };
}

// 直接运行
if (require.main === module) {
  require('dotenv').config({ path: '/root/.openclaw/workspace/.env', override: true });
  scan().then(result => {
    console.log('\n=== 扫描结果 ===');
    if (result?.wallets) {
      for (const w of result.wallets) {
        console.log(`${w.address.slice(0,12)}... | ${w.type} | 胜率${(w.winRate*100).toFixed(0)}% | ${w.totalProfitSol.toFixed(2)}SOL | ${w.avgHoldTimeHuman} | 出现${w.appearances}次`);
      }
    }
    console.log(`\n总计: ${result?.found || 0}个聪明钱, ${result?.newAdded || 0}个新增`);
    process.exit(0);
  }).catch(e => {
    console.error('扫描失败:', e);
    process.exit(1);
  });
}

module.exports = { scan, analyzeWallet, findWinningTokens, findEarlyBuyers, WALLET_TYPES };
