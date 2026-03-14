#!/usr/bin/env node
/**
 * Smart Money Scanner v5
 * 
 * 新架构：持有者 → 交易历史 → 跨币验证
 * 
 * 阶段1：找币 → 查每个币top20持有者 → 收集钱包候选
 * 阶段2：查每个钱包交易历史 → 算每个币的盈亏
 * 阶段3：跨币≥3 + 均利≥$2k + 胜率≥60% + 非bot → 入库
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_DIR = path.join(__dirname, 'logs');
const CANDIDATES_FILE = path.join(DATA_DIR, 'scan_candidates.json');
const WALLET_POOL_FILE = path.join(DATA_DIR, 'scan_wallet_pool_v5.json');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');

const HELIUS_KEY_1 = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_KEY_2 = process.env.HELIUS_API_KEY_2 || '824cb27b-0794-45ed-aa1c-0798658d8d80';
const heliusKeys = [HELIUS_KEY_1, HELIUS_KEY_2];
let heliusKeyIdx = 0;
function nextHeliusKey() { return heliusKeys[heliusKeyIdx++ % heliusKeys.length]; }

const HELIUS_RPC = () => `https://mainnet.helius-rpc.com/?api-key=${nextHeliusKey()}`;

// ============ THRESHOLDS ============
const MIN_FDV = 500_000;
const MIN_VOL_24H = 50_000;
const MAX_AGE_DAYS = 90;
const FINAL_MIN_COINS = 3;
const FINAL_MIN_AVG_PROFIT = 2000;
const FINAL_MIN_WIN_RATE = 0.6;
const SCAN_INTERVAL_MS = 60 * 1000;

// SOL价格
let cachedSolPrice = 88;
let solPriceUpdatedAt = 0;
async function getSolPrice() {
  if (Date.now() - solPriceUpdatedAt < 10 * 60 * 1000) return cachedSolPrice;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d.solana?.usd) {
      cachedSolPrice = d.solana.usd;
      solPriceUpdatedAt = Date.now();
      log('INFO', `SOL价格: $${cachedSolPrice}`);
    }
  } catch {}
  return cachedSolPrice;
}

// ============ Logger ============
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `scanner_${ts.slice(0, 10)}.log`), line + '\n');
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============ 阶段1：找币 ============
async function discoverCoins() {
  const candidates = loadJSON(CANDIDATES_FILE, { coins: [], scanned: [] });
  const seenMints = new Set(candidates.coins.map(c => c.mint).filter(Boolean));
  const ninetyDaysAgo = Date.now() - MAX_AGE_DAYS * 86400000;

  function addCoin(symbol, mint, fdv, vol, ageD) {
    if (!mint || seenMints.has(mint)) return;
    seenMints.add(mint);
    candidates.coins.push({ symbol, mint, fdv, vol, ageD, addedAt: new Date().toISOString() });
  }

  // DexScreener搜索
  const queries = [
    'trump', 'elon', 'doge', 'pepe', 'wojak', 'chad', 'based',
    'ape', 'monkey', 'cat', 'dog', 'frog', 'bird', 'bear', 'bull',
    'moon', 'rocket', 'diamond', 'gold',
    'ai', 'gpt', 'agent', 'bot', 'cyber',
    'war', 'fight', 'punch', 'kill', 'chaos',
    'baby', 'mega', 'super', 'turbo',
    'cash', 'money', 'rich', 'king', 'god',
    'meme', 'lol', 'kek',
    'whale', 'shark', 'dragon', 'wolf', 'lion', 'tiger',
    'ninja', 'pirate', 'wizard',
    'pump solana', 'meme solana', 'ai solana', 'degen solana',
    'smith', 'sos', 'drone', 'shape', 'runner', 'afk', 'birb',
  ];

  for (const q of queries) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      for (const p of (d.pairs || [])) {
        if (p.chainId !== 'solana') continue;
        if ((p.fdv || 0) < MIN_FDV) continue;
        if ((p.volume?.h24 || 0) < MIN_VOL_24H) continue;
        if (!p.pairCreatedAt || p.pairCreatedAt < ninetyDaysAgo) continue;
        addCoin(p.baseToken?.symbol, p.baseToken?.address, p.fdv, p.volume?.h24, Math.round((Date.now() - p.pairCreatedAt) / 86400000));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // DexScreener boosts + profiles
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await r.json();
    for (const b of (boosts || []).filter(b => b.chainId === 'solana')) {
      try {
        const r2 = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + b.tokenAddress);
        const d2 = await r2.json();
        const p = (d2.pairs || []).find(p => p.chainId === 'solana' && (p.fdv || 0) >= MIN_FDV);
        if (p && p.pairCreatedAt > ninetyDaysAgo && (p.volume?.h24 || 0) >= MIN_VOL_24H) {
          addCoin(p.baseToken?.symbol, b.tokenAddress, p.fdv, p.volume?.h24, Math.round((Date.now() - p.pairCreatedAt) / 86400000));
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}

  // 预存数据
  for (const file of ['coingecko_pumpfun.json', 'dexscreener_coins.json']) {
    try {
      const coins = loadJSON(path.join(DATA_DIR, file), []);
      for (const c of coins) {
        const mint = c.mint || c.address;
        if (mint && (c.mc || c.fdv || 0) >= MIN_FDV) addCoin(c.symbol, mint, c.mc || c.fdv, c.vol || 0, c.ageD || 0);
      }
    } catch {}
  }

  saveJSON(CANDIDATES_FILE, candidates);
  log('INFO', `发现 ${candidates.coins.length} 个币`);
  return candidates;
}

// ============ 阶段1b：查持有者 + 验证盈利 ============
const MIN_HOLDER_PROFIT = 2000; // 持有者在这个币上至少赚$2k才收集

async function getTopHolders(mint, symbol) {
  const conn = new Connection(HELIUS_RPC(), 'confirmed');
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(mint));
    const holders = [];
    
    for (const acc of largest.value) {
      try {
        const info = await conn.getParsedAccountInfo(new PublicKey(acc.address));
        const owner = info.value?.data?.parsed?.info?.owner;
        if (owner) {
          const amt = parseInt(acc.amount) / Math.pow(10, acc.decimals || 6);
          holders.push({ wallet: owner, amount: amt, tokenAccount: acc.address.toString() });
        }
      } catch {}
    }
    
    return holders;
  } catch (e) {
    log('WARN', `持有者查询失败 ${mint.slice(0, 16)}: ${e.message.slice(0, 60)}`);
    return [];
  }
}

// 验证持有者在某个币上是否赚钱
async function checkHolderProfit(wallet, mint) {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const solPrice = await getSolPrice();
  
  // 查这个钱包的交易，筛出跟这个mint相关的
  let allTxs = [];
  let beforeSig;
  
  for (let batch = 0; batch < 5; batch++) { // 最多500条
    let url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${nextHeliusKey()}&limit=100`;
    if (beforeSig) url += `&before=${beforeSig}`;
    try {
      const r = await fetch(url);
      if (!r.ok) break;
      const txs = await r.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      allTxs.push(...txs);
      beforeSig = txs[txs.length - 1].signature;
      if (txs.length < 100) break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 150));
  }
  
  // 只看涉及目标token的交易
  let solSpent = 0, solReceived = 0;
  let transfersIn = 0, swapBuys = 0, swapSells = 0;
  
  for (const tx of allTxs) {
    const transfers = tx.tokenTransfers || [];
    const hasTarget = transfers.some(tt => tt.mint === mint);
    if (!hasTarget) continue;
    
    let tokenIn = 0, tokenOut = 0;
    let txSolSpent = 0, txSolReceived = 0;
    
    for (const tt of transfers) {
      if (tt.mint === mint) {
        if (tt.toUserAccount === wallet) tokenIn += (tt.tokenAmount || 0);
        if (tt.fromUserAccount === wallet) tokenOut += (tt.tokenAmount || 0);
      }
      if (tt.mint === SOL_MINT) {
        if (tt.fromUserAccount === wallet) txSolSpent += (tt.tokenAmount || 0);
        if (tt.toUserAccount === wallet) txSolReceived += (tt.tokenAmount || 0);
      }
    }
    for (const nt of (tx.nativeTransfers || [])) {
      if (nt.fromUserAccount === wallet) txSolSpent += (nt.amount || 0) / 1e9;
      if (nt.toUserAccount === wallet) txSolReceived += (nt.amount || 0) / 1e9;
    }
    
    const isSwap = tx.type === 'SWAP' || tx.source === 'PUMP_AMM' || tx.source === 'JUPITER' || tx.source === 'RAYDIUM';
    
    if (tokenIn > tokenOut) {
      // 收到token
      if (isSwap) {
        swapBuys++;
        solSpent += txSolSpent;
      } else {
        transfersIn++; // 分仓转入
      }
    } else if (tokenOut > tokenIn) {
      // 送出token（卖出）
      swapSells++;
      solReceived += txSolReceived;
    }
  }
  
  const realizedProfitUsd = (solReceived - solSpent) * solPrice;
  
  return {
    realizedProfitUsd: Math.round(realizedProfitUsd),
    swapBuys,
    swapSells,
    transfersIn,
    pattern: transfersIn > 0 && swapBuys === 0 ? 'transfer_sell' : 'normal',
  };
}

// ============ 阶段2：查钱包交易历史 ============
async function analyzeWallet(wallet) {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2fvD2EcfY6hVckvyCuuP1CETn';
  const stables = new Set([SOL_MINT, USDC, USDT]);
  
  const solPrice = await getSolPrice();
  
  // 拉钱包的全部交易（最多2000条，覆盖几周到几个月）
  let allTxs = [];
  let beforeSig;
  
  for (let batch = 0; batch < 20; batch++) {
    let url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${nextHeliusKey()}&limit=100`;
    if (beforeSig) url += `&before=${beforeSig}`;
    
    try {
      const r = await fetch(url);
      if (!r.ok) break;
      const txs = await r.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      allTxs.push(...txs);
      beforeSig = txs[txs.length - 1].signature;
      if (txs.length < 100) break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 150));
  }
  
  if (allTxs.length === 0) return null;
  
  const timeSpanDays = allTxs.length >= 2 
    ? (allTxs[0].timestamp - allTxs[allTxs.length - 1].timestamp) / 86400 
    : 0;
  
  // 按token分析盈亏
  const tokenPnL = new Map(); // mint → { spent, received, buys, sells }
  
  for (const tx of allTxs) {
    const transfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];
    
    // 找这笔交易涉及的非stable token
    const tokenMints = new Set();
    for (const tt of transfers) {
      if (tt.mint && !stables.has(tt.mint)) tokenMints.add(tt.mint);
    }
    
    for (const mint of tokenMints) {
      let solSpent = 0, solReceived = 0;
      let tokenIn = 0, tokenOut = 0;
      
      // token流向
      for (const tt of transfers) {
        if (tt.mint === mint) {
          if (tt.toUserAccount === wallet) tokenIn += (tt.tokenAmount || 0);
          if (tt.fromUserAccount === wallet) tokenOut += (tt.tokenAmount || 0);
        }
        // SOL (wrapped)
        if (tt.mint === SOL_MINT) {
          if (tt.fromUserAccount === wallet) solSpent += (tt.tokenAmount || 0);
          if (tt.toUserAccount === wallet) solReceived += (tt.tokenAmount || 0);
        }
        // USDC/USDT
        if (tt.mint === USDC || tt.mint === USDT) {
          if (tt.fromUserAccount === wallet) solSpent += (tt.tokenAmount || 0) / solPrice; // 转换为SOL等价
          if (tt.toUserAccount === wallet) solReceived += (tt.tokenAmount || 0) / solPrice;
        }
      }
      
      // native SOL
      for (const nt of nativeTransfers) {
        if (nt.fromUserAccount === wallet) solSpent += (nt.amount || 0) / 1e9;
        if (nt.toUserAccount === wallet) solReceived += (nt.amount || 0) / 1e9;
      }
      
      const isBuy = tokenIn > tokenOut;
      const isSell = tokenOut > tokenIn;
      
      if (!tokenPnL.has(mint)) tokenPnL.set(mint, { spent: 0, received: 0, buys: 0, sells: 0 });
      const pnl = tokenPnL.get(mint);
      
      if (isBuy) {
        pnl.spent += solSpent;
        pnl.buys++;
      } else if (isSell) {
        pnl.received += solReceived;
        pnl.sells++;
      }
    }
  }
  
  // 计算每个token的盈亏
  const results = [];
  for (const [mint, pnl] of tokenPnL) {
    if (pnl.buys === 0 && pnl.sells === 0) continue;
    const profitSol = pnl.received - pnl.spent;
    const profitUsd = profitSol * solPrice;
    results.push({
      mint,
      profitUsd: Math.round(profitUsd),
      buys: pnl.buys,
      sells: pnl.sells,
      spentSol: pnl.spent,
      receivedSol: pnl.received,
    });
  }
  
  return {
    wallet,
    txCount: allTxs.length,
    timeSpanDays: Math.round(timeSpanDays),
    tokens: results,
    totalTokens: results.length,
    profitableTokens: results.filter(r => r.profitUsd > 0).length,
  };
}

// ============ 阶段3：Bot检测 ============
async function isBot(wallet) {
  try {
    const conn = new Connection(HELIUS_RPC(), 'confirmed');
    const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 20 });
    if (sigs.length < 5) return { isBot: false, reason: 'few_sigs' };

    const times = sigs.map(s => s.blockTime).filter(Boolean).sort();
    let shortIntervals = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= 2) shortIntervals++;
    }
    if (shortIntervals > times.length * 0.7) {
      return { isBot: true, reason: `high_freq: ${shortIntervals}/${times.length - 1}` };
    }
    return { isBot: false, reason: 'human' };
  } catch {
    return { isBot: false, reason: 'error' };
  }
}

// ============ Main ============
async function main() {
  log('INFO', '=== Smart Money Scanner v5 启动 ===');
  log('INFO', `标准: ≥${FINAL_MIN_COINS}币 + 均利≥$${FINAL_MIN_AVG_PROFIT} + 胜率≥${FINAL_MIN_WIN_RATE * 100}%`);
  
  await getSolPrice();
  
  while (true) {
    try {
      // === 阶段1：找币 + 收集持有者 ===
      const candidates = await discoverCoins();
      const scannedSet = new Set(candidates.scanned || []);
      const pending = candidates.coins.filter(c => c.mint && !scannedSet.has(c.mint));
      
      if (pending.length === 0) {
        log('INFO', '无新币，等待下一轮...');
        await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
        continue;
      }
      
      const pool = loadJSON(WALLET_POOL_FILE, { wallets: {}, analyzed: [] });
      const analyzedSet = new Set(pool.analyzed || []);
      const toScan = pending.slice(0, 5);
      
      for (const coin of toScan) {
        log('INFO', `查持有者: ${coin.symbol} ($${(coin.fdv / 1e6).toFixed(1)}M) mint:${coin.mint.slice(0, 16)}`);
        
        const holders = await getTopHolders(coin.mint, coin.symbol);
        log('INFO', `  ${coin.symbol}: ${holders.length} 个持有者，验证盈利...`);
        
        let qualified = 0;
        for (const h of holders) {
          // 跳过已知的pool/program地址（持仓极大的通常是LP池）
          if (h.amount > 1e9) {
            log('INFO', `  跳过LP池: ${h.wallet.slice(0, 16)} (${h.amount.toFixed(0)} tokens)`);
            continue;
          }
          
          // 验证这个持有者在这个币上是否赚钱
          const profit = await checkHolderProfit(h.wallet, coin.mint);
          
          if (profit.realizedProfitUsd >= MIN_HOLDER_PROFIT || (profit.pattern === 'transfer_sell' && profit.realizedProfitUsd >= MIN_HOLDER_PROFIT)) {
            qualified++;
            log('INFO', `  ✓ ${h.wallet.slice(0, 16)} 盈$${profit.realizedProfitUsd} (${profit.pattern}, buy:${profit.swapBuys} sell:${profit.swapSells} transfer:${profit.transfersIn})`);
            
            if (!pool.wallets[h.wallet]) {
              pool.wallets[h.wallet] = { 
                holdings: {}, 
                profitByMint: {},
                firstSeen: new Date().toISOString(),
              };
            }
            pool.wallets[h.wallet].holdings[coin.mint] = {
              symbol: coin.symbol,
              amount: h.amount,
            };
            pool.wallets[h.wallet].profitByMint[coin.mint] = {
              symbol: coin.symbol,
              profit: profit.realizedProfitUsd,
              pattern: profit.pattern,
              buys: profit.swapBuys,
              sells: profit.swapSells,
              transfersIn: profit.transfersIn,
            };
          }
          
          await new Promise(r => setTimeout(r, 500)); // 控制速率
        }
        
        log('INFO', `  ${coin.symbol}: ${qualified}/${holders.length} 个盈利≥$${MIN_HOLDER_PROFIT}`);
        
        // 标记已扫描
        if (!candidates.scanned) candidates.scanned = [];
        candidates.scanned.push(coin.mint);
        scannedSet.add(coin.mint);
        saveJSON(CANDIDATES_FILE, candidates);
        saveJSON(WALLET_POOL_FILE, pool);
        
        await new Promise(r => setTimeout(r, 1000));
      }
      
      saveJSON(WALLET_POOL_FILE, pool);
      
      const totalWallets = Object.keys(pool.wallets).length;
      const unanalyzed = Object.keys(pool.wallets).filter(w => !analyzedSet.has(w));
      log('INFO', `钱包池: ${totalWallets} 个, 待分析: ${unanalyzed.length}`);
      
      // === 阶段2：分析钱包交易历史 ===
      const toAnalyze = unanalyzed.slice(0, 3); // 每轮分析3个钱包
      
      for (const wallet of toAnalyze) {
        log('INFO', `分析钱包: ${wallet.slice(0, 20)}...`);
        
        const result = await analyzeWallet(wallet);
        
        if (!result || result.tokens.length === 0) {
          log('INFO', `  无交易数据，跳过`);
          pool.analyzed.push(wallet);
          analyzedSet.add(wallet);
          continue;
        }
        
        const profitable = result.tokens.filter(t => t.profitUsd > 0);
        const totalProfit = result.tokens.reduce((a, t) => a + t.profitUsd, 0);
        
        log('INFO', `  ${result.txCount}条交易, ${result.timeSpanDays}天, ${result.totalTokens}个token, ${profitable.length}个盈利, 总$${totalProfit}`);
        
        // 存分析结果
        pool.wallets[wallet].analysis = {
          txCount: result.txCount,
          timeSpanDays: result.timeSpanDays,
          totalTokens: result.totalTokens,
          profitableTokens: result.profitableTokens,
          totalProfitUsd: totalProfit,
          tokens: result.tokens.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, 20), // 保留top20
          analyzedAt: new Date().toISOString(),
        };
        
        pool.analyzed.push(wallet);
        analyzedSet.add(wallet);
        saveJSON(WALLET_POOL_FILE, pool);
        
        // === 阶段3：检查是否达标入库 ===
        const winRate = result.totalTokens > 0 ? result.profitableTokens / result.totalTokens : 0;
        const avgProfit = result.profitableTokens > 0 ? totalProfit / result.profitableTokens : 0;
        
        if (result.profitableTokens >= FINAL_MIN_COINS && avgProfit >= FINAL_MIN_AVG_PROFIT && winRate >= FINAL_MIN_WIN_RATE) {
          // Bot检测
          const botCheck = await isBot(wallet);
          if (botCheck.isBot) {
            log('INFO', `  ❌ Bot: ${botCheck.reason}`);
            continue;
          }
          
          log('INFO', `  ✅ 聪明钱! ${result.profitableTokens}币盈利, 胜率${(winRate * 100).toFixed(0)}%, 均利$${avgProfit.toFixed(0)}`);
          
          const smartWallets = loadJSON(WALLETS_FILE, { wallets: [], lastScan: null });
          if (!smartWallets.wallets.find(w => w.address === wallet)) {
            smartWallets.wallets.push({
              address: wallet,
              chain: 'solana',
              label: `sm_v5_${result.profitableTokens}coins`,
              totalProfit: Math.round(totalProfit),
              avgProfit: Math.round(avgProfit),
              winRate: Math.round(winRate * 100),
              profitableCoins: result.profitableTokens,
              totalCoins: result.totalTokens,
              txCount: result.txCount,
              timeSpanDays: result.timeSpanDays,
              topTokens: result.tokens.slice(0, 10),
              source: 'scanner_v5',
              addedAt: new Date().toISOString(),
            });
            smartWallets.lastScan = new Date().toISOString();
            saveJSON(WALLETS_FILE, smartWallets);
            log('INFO', `🎉 聪明钱入库! 总计: ${smartWallets.wallets.length}`);
          }
        } else {
          const reason = [];
          if (result.profitableTokens < FINAL_MIN_COINS) reason.push(`盈利币${result.profitableTokens}<${FINAL_MIN_COINS}`);
          if (avgProfit < FINAL_MIN_AVG_PROFIT) reason.push(`均利$${avgProfit.toFixed(0)}<$${FINAL_MIN_AVG_PROFIT}`);
          if (winRate < FINAL_MIN_WIN_RATE) reason.push(`胜率${(winRate*100).toFixed(0)}%<${FINAL_MIN_WIN_RATE*100}%`);
          log('INFO', `  未达标: ${reason.join(', ')}`);
        }
        
        await new Promise(r => setTimeout(r, 2000));
      }
      
      saveJSON(WALLET_POOL_FILE, pool);
      
    } catch (e) {
      log('ERROR', `Main: ${e.message}`);
    }
    
    log('INFO', `等待 ${SCAN_INTERVAL_MS / 1000}秒...`);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

process.on('SIGINT', () => { log('INFO', '收到SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', '收到SIGTERM'); process.exit(0); });

main().catch(e => { log('FATAL', e.message); process.exit(1); });
