#!/usr/bin/env node
// 聪明钱扫描器 v3 — 三链扫描，从30天内涨到$1M+的币中倒推早期买家
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

// ========== DexScreener: 找过去30天涨到$1M+的币 ==========

async function findBigWinners() {
  logger.info('scanner', '🔍 搜索30天内涨到$1M+市值的meme币（三链）...');
  const results = [];
  const seen = new Set();

  // Solana搜索词
  const solQueries = [
    'pump solana', 'meme solana', 'SOL meme', 'ai solana agent',
    'dog solana', 'cat solana', 'pepe solana', 'trump solana',
    'frog solana', 'bonk', 'degen solana', 'moon solana',
  ];

  // BSC搜索词  
  const bscQueries = [
    'meme bsc', 'bnb meme', 'four meme', 'pancake meme',
    'dog bsc', 'cat bsc', 'pepe bsc',
  ];

  // Base搜索词
  const baseQueries = [
    'meme base', 'base meme', 'degen base', 'virtual base',
    'ai base agent',
  ];

  const allQueries = [
    ...solQueries.map(q => ({ q, chain: 'solana' })),
    ...bscQueries.map(q => ({ q, chain: 'bsc' })),
    ...baseQueries.map(q => ({ q, chain: 'base' })),
  ];

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const { q, chain } of allQueries) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      const data = await r.json();

      const pairs = (data.pairs || []).filter(p => {
        if (p.chainId !== chain) return false;
        if (seen.has(p.baseToken?.address)) return false;
        if ((p.fdv || 0) < 1000000) return false; // 市值>$1M
        if (p.pairCreatedAt && p.pairCreatedAt < thirtyDaysAgo) return false; // 30天内创建
        return true;
      });

      for (const p of pairs) {
        seen.add(p.baseToken.address);
        results.push({
          mint: p.baseToken.address,
          symbol: p.baseToken.symbol,
          name: p.baseToken.name,
          chain,
          fdv: p.fdv,
          volume24h: p.volume?.h24 || 0,
          priceChange24h: p.priceChange?.h24 || 0,
          createdAt: p.pairCreatedAt,
          pairAddress: p.pairAddress,
        });
      }

      await new Promise(r => setTimeout(r, 600)); // DexScreener rate limit
    } catch (e) {
      logger.warn('scanner', `搜索失败(${q}): ${e.message}`);
    }
  }

  // 按市值排序
  results.sort((a, b) => (b.fdv || 0) - (a.fdv || 0));

  // 统计
  const chainCount = { solana: 0, bsc: 0, base: 0 };
  results.forEach(r => chainCount[r.chain]++);
  
  logger.info('scanner', `找到 ${results.length} 个大涨币: SOL=${chainCount.solana} BSC=${chainCount.bsc} BASE=${chainCount.base}`);
  for (const r of results.slice(0, 15)) {
    logger.info('scanner', `  ${r.symbol?.padEnd(12) || '?'} | ${r.chain} | $${(r.fdv/1e6).toFixed(1)}M | ${r.mint.slice(0,8)}`);
  }

  return results;
}

// ========== Solana: 找早期买家 ==========

async function findSolanaEarlyBuyers(mint, maxBuyers = 15) {
  try {
    // 获取最早的签名
    let allSigs = [];
    let before;
    for (let i = 0; i < 3; i++) {
      const sigs = await conn1.getSignaturesForAddress(new PublicKey(mint), { limit: 1000, before });
      if (sigs.length === 0) break;
      allSigs.push(...sigs);
      before = sigs[sigs.length - 1].signature;
      await new Promise(r => setTimeout(r, 200));
    }
    
    allSigs.sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
    
    const buyers = new Map();
    for (const sig of allSigs.slice(0, 50)) {
      try {
        const tx = await conn2.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) continue;
        const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
        const fp = keys[0]?.toString();
        if (fp && !buyers.has(fp)) {
          buyers.set(fp, { address: fp, time: sig.blockTime });
        }
      } catch {}
      if (buyers.size >= maxBuyers) break;
      await new Promise(r => setTimeout(r, 100));
    }
    
    return [...buyers.values()];
  } catch (e) {
    logger.error('scanner', `findSolanaEarlyBuyers failed: ${e.message}`);
    return [];
  }
}

// ========== 分析Solana钱包 ==========

async function analyzeSolanaWallet(address) {
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

  const tokenMap = new Map();
  for (const tx of trades) {
    if (tx.type !== 'SWAP') continue;
    for (const transfer of (tx.tokenTransfers || [])) {
      const mint = transfer.mint;
      if (!mint || mint === config.SOL_MINT) continue;
      if (!tokenMap.has(mint)) tokenMap.set(mint, { buys: [], sells: [] });
      const record = tokenMap.get(mint);
      
      if (transfer.toUserAccount === address) {
        record.buys.push({
          timestamp: tx.timestamp,
          solSpent: (tx.nativeTransfers || [])
            .filter(n => n.fromUserAccount === address)
            .reduce((s, n) => s + n.amount, 0) / 1e9,
        });
      } else if (transfer.fromUserAccount === address) {
        record.sells.push({
          timestamp: tx.timestamp,
          solReceived: (tx.nativeTransfers || [])
            .filter(n => n.toUserAccount === address)
            .reduce((s, n) => s + n.amount, 0) / 1e9,
        });
      }
    }
  }

  if (tokenMap.size < 2) return null;

  let wins = 0, losses = 0, totalProfit = 0, holdTimes = [], buySizes = [];
  
  for (const [, record] of tokenMap) {
    const totalBuy = record.buys.reduce((s, b) => s + b.solSpent, 0);
    const totalSell = record.sells.reduce((s, s2) => s + s2.solReceived, 0);
    if (totalBuy < 0.01) continue;
    
    totalProfit += (totalSell - totalBuy);
    if (totalSell > totalBuy * 1.1) wins++;
    else if (record.sells.length > 0) losses++;
    
    if (record.buys.length > 0 && record.sells.length > 0) {
      const firstBuy = Math.min(...record.buys.map(b => b.timestamp));
      const lastSell = Math.max(...record.sells.map(s => s.timestamp));
      if (lastSell > firstBuy) holdTimes.push(lastSell - firstBuy);
    }
    buySizes.push(totalBuy);
  }

  const totalTrades = wins + losses;
  if (totalTrades < 2) return null;

  const winRate = wins / totalTrades;
  const avgHold = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;
  const avgBuy = buySizes.length > 0 ? buySizes.reduce((a, b) => a + b, 0) / buySizes.length : 0;

  let type = WALLET_TYPES.TREND;
  if (avgHold < 1800) type = WALLET_TYPES.SNIPER;
  else if (avgHold > 86400) type = WALLET_TYPES.ACCUMULATOR;
  if (avgBuy > 5) type = WALLET_TYPES.WHALE;

  return {
    address, chain: 'solana', type, winRate, wins, losses, totalTrades,
    totalProfitSol: totalProfit,
    avgHoldTimeSec: avgHold,
    avgHoldTimeHuman: fmtDur(avgHold),
    avgBuySizeSol: avgBuy,
    tokensTraded: tokenMap.size,
  };
}

function fmtDur(s) {
  if (s < 60) return `${Math.round(s)}秒`;
  if (s < 3600) return `${Math.round(s/60)}分钟`;
  if (s < 86400) return `${(s/3600).toFixed(1)}小时`;
  return `${(s/86400).toFixed(1)}天`;
}

// ========== 主扫描 ==========

async function scan() {
  logger.info('scanner', '🔍 聪明钱扫描 v3 — 三链大涨币倒推');
  const t0 = Date.now();

  // 1. 找大涨币
  const winners = await findBigWinners();
  if (winners.length === 0) return { found: 0 };

  // 按链分组
  const solWinners = winners.filter(w => w.chain === 'solana');
  // TODO: BSC/Base 早期买家提取（需要不同的RPC）

  // 2. 从每个Solana大涨币中提取早期买家
  const buyerAppearances = new Map(); // address → { count, tokens, chain }

  logger.info('scanner', `\n分析 ${solWinners.length} 个Solana大涨币的早期买家...`);
  
  for (const token of solWinners.slice(0, 20)) {
    logger.info('scanner', `📊 ${token.symbol} ($${(token.fdv/1e6).toFixed(1)}M) — 找早期买家...`);
    
    const buyers = await findSolanaEarlyBuyers(token.mint);
    for (const b of buyers) {
      if (!buyerAppearances.has(b.address)) {
        buyerAppearances.set(b.address, { count: 0, tokens: [], chain: 'solana' });
      }
      const rec = buyerAppearances.get(b.address);
      rec.count++;
      rec.tokens.push(token.symbol || token.mint.slice(0, 8));
    }
    
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info('scanner', `共发现 ${buyerAppearances.size} 个早期买家`);

  // 3. 优先分析出现多次的
  const sorted = [...buyerAppearances.entries()]
    .sort((a, b) => b[1].count - a[1].count);

  const highPri = sorted.filter(([, v]) => v.count >= 2);
  const normalPri = sorted.filter(([, v]) => v.count === 1).slice(0, 30);
  const toAnalyze = [...highPri, ...normalPri];
  
  logger.info('scanner', `高优先(2+币): ${highPri.length}, 普通: ${normalPri.length}`);

  // 4. 分析
  const qualified = [];
  let analyzed = 0;

  for (const [address, { count, tokens, chain }] of toAnalyze) {
    try {
      let result = null;
      if (chain === 'solana') {
        result = await analyzeSolanaWallet(address);
      }
      analyzed++;
      
      if (result && result.winRate >= 0.35 && result.totalProfitSol > 0) {
        result.appearances = count;
        result.foundInTokens = tokens;
        qualified.push(result);
        logger.info('scanner', `✅ ${address.slice(0,8)}... | ${result.type} | 胜率${(result.winRate*100).toFixed(0)}% | ${result.totalProfitSol.toFixed(2)}SOL | ${result.avgHoldTimeHuman} | 出现${count}次 [${tokens.join(',')}]`);
      }
      
      if (analyzed % 10 === 0) {
        logger.info('scanner', `进度: ${analyzed}/${toAnalyze.length}, 已发现${qualified.length}个`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      logger.error('scanner', `分析失败 ${address.slice(0,8)}`, { error: e.message });
    }
  }

  // 5. 保存
  const existing = smartMoney.loadSmartWallets();
  const existingSet = new Set(existing.wallets.map(w => w.address));
  let newCount = 0;
  
  for (const w of qualified) {
    if (!existingSet.has(w.address)) {
      smartMoney.addSmartWallet(w.address, `${w.type}_v3`, {
        winRate: w.winRate,
        profitSol: w.totalProfitSol,
        trades: w.totalTrades,
        type: w.type,
        avgHoldTime: w.avgHoldTimeSec,
        appearances: w.appearances,
        foundInTokens: w.foundInTokens,
        chain: w.chain,
        source: 'big_winner_backtrack_v3',
      });
      newCount++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const typeCount = {};
  qualified.forEach(w => typeCount[w.type] = (typeCount[w.type] || 0) + 1);
  
  logger.info('scanner', `\n🔍 扫描完成: ${elapsed}秒`);
  logger.info('scanner', `大涨币: ${winners.length}(SOL:${solWinners.length})`);
  logger.info('scanner', `分析${analyzed}钱包, 发现${qualified.length}个聪明钱(${newCount}新增)`);
  logger.info('scanner', `类型: ${JSON.stringify(typeCount)}`);

  return { winners: winners.length, analyzed, found: qualified.length, newAdded: newCount, elapsed, typeDistribution: typeCount, wallets: qualified };
}

if (require.main === module) {
  require('dotenv').config({ path: '/root/.openclaw/workspace/.env', override: true });
  scan().then(r => {
    console.log('\n=== 扫描结果 ===');
    if (r?.wallets) {
      for (const w of r.wallets) {
        console.log(`${w.address.slice(0,12)}... | ${w.chain} | ${w.type} | 胜率${(w.winRate*100).toFixed(0)}% | ${w.totalProfitSol.toFixed(2)}SOL | ${w.avgHoldTimeHuman} | 在${w.appearances}个币中`);
      }
    }
    console.log(`\n大涨币${r?.winners||0}个 | 分析${r?.analyzed||0}钱包 | 发现${r?.found||0}聪明钱 | ${r?.newAdded||0}新增`);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { scan, findBigWinners, WALLET_TYPES };
