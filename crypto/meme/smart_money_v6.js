#!/usr/bin/env node
/**
 * Smart Money Scanner v6.1
 * 
 * 数据源: 币安 Unified Token Rank (Trending/Alpha/TopSearch) × 3链
 * 链上验证: Helius (Solana) / Public RPC (BSC/Base)
 * 
 * Phase 1: 拉种子币（币安排行榜，按涨幅排序）
 * Phase 2: 链上挖掘早期买家（计算真实盈亏）
 * Phase 3: 跨币交叉验证 + 评分 → 私有聪明钱库
 * 
 * 用法:
 *   node smart_money_v6.js full     # 全流程
 *   node smart_money_v6.js seeds    # 只拉种子
 *   node smart_money_v6.js mine     # 用已有种子挖钱包
 *   node smart_money_v6.js status   # 查看当前结果
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env', override: true });
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// === 目录 ===
const BASE_DIR = path.join(__dirname, 'data', 'v6');
const SEEDS_FILE = path.join(BASE_DIR, 'seeds.json');
const WALLETS_FILE = path.join(BASE_DIR, 'candidate_wallets.json');
const SMART_MONEY_FILE = path.join(BASE_DIR, 'smart_money.json');
const LOG_DIR = path.join(__dirname, 'logs');
for (const d of [BASE_DIR, LOG_DIR]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// === Config ===
const HELIUS_KEYS = [process.env.HELIUS_API_KEY, process.env.HELIUS_API_KEY_2].filter(Boolean);
let heliusIdx = 0;
function nextHeliusKey() { return HELIUS_KEYS[heliusIdx++ % HELIUS_KEYS.length]; }

const EVM_RPCS = {
  bsc: process.env.BSC_RPC || 'https://1rpc.io/bnb',
  base: process.env.BASE_RPC || 'https://1rpc.io/base',
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_STABLES = new Set([SOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2fvD2EcfY6hVckvyCuuP1CETn']);

// === 种子黑名单（手动标记：空投币、已确认的垃圾等） ===
const SEED_BLACKLIST = new Set([
  '0x7977bf3e7e0c954d12cdca3e013adaf57e0b06e0', // OPN: 空投币，筹码在项目方
]);

// === 种子币筛选标准（只用成熟通道） ===
// 爆发通道已废弃：垃圾太多（刷量盘、断头铡、庄家盘），过滤成本高且早期买家不可信
// 成熟通道：高流动性+高交易量+高持有者，自然过滤垃圾
const SEED_MATURE = {
  minLiquidity: 100000, minMarketCap: 500000, minHolders: 3000,
  minVolume24h: 500000, maxTop10Percent: 85,
};

// === 聪明钱标准 ===
const SM_CRITERIA = {
  minSeedAppearance: 2,
  minTotalProfit: 500,     // 总盈利至少$500
  maxBotScore: 0.6,
};

// === 链 ===
const CHAINS = [
  { name: 'Solana', chainId: 'CT_501', type: 'solana' },
  { name: 'BSC', chainId: '56', type: 'evm', rpcKey: 'bsc' },
  { name: 'Base', chainId: '8453', type: 'evm', rpcKey: 'base' },
];

// === 工具 ===
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, `v6_${ts.slice(0, 10)}.log`), line + '\n');
}
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function saveJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpReq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/2.0 (Skill)', ...opts.headers },
      timeout: 20000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Parse: ${d.slice(0, 100)}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function binPost(url, data) {
  return httpReq(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

// ============================================================
// Phase 1: 从币安拉种子币
// ============================================================
async function fetchSeeds() {
  log('INFO', '🌱 Phase 1: 从币安排行榜拉种子币...');
  const url = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list';
  const all = new Map();

  // 只用成熟通道 — 按交易量排序，从Trending和Alpha拉
  const rankTypes = [[10,'Trending'],[20,'Alpha']];
  
  for (const chain of CHAINS) {
    for (const [rt, rn] of rankTypes) {
      try {
        const d = await binPost(url, { rankType: rt, chainId: chain.chainId, period: 50,
          sortBy: 70, orderAsc: false, page: 1, size: 200 });
        const tokens = d?.data?.tokens || [];
        log('INFO', `  ${chain.name} ${rn}: ${tokens.length}`);
        for (const t of tokens) {
          const ca = (t.contractAddress || '').toLowerCase();
          if (!ca || SEED_BLACKLIST.has(ca)) continue;
          const mc = parseFloat(t.marketCap || 0);
          const liq = parseFloat(t.liquidity || 0);
          const holders = parseInt(t.holders || 0);
          const pc = parseFloat(t.percentChange24h || 0);
          const top10 = parseFloat(t.holdersTop10Percent || 100);
          const vol = parseFloat(t.volume24h || 0);
          
          // 成熟通道筛选
          if (liq < SEED_MATURE.minLiquidity || mc < SEED_MATURE.minMarketCap) continue;
          if (holders < SEED_MATURE.minHolders || vol < SEED_MATURE.minVolume24h) continue;
          if (top10 > SEED_MATURE.maxTop10Percent) continue;
          
          if (!all.has(ca)) {
            all.set(ca, {
              symbol: t.symbol || '?', contractAddress: t.contractAddress,
              chain: chain.name, chainId: chain.chainId, chainType: chain.type, rpcKey: chain.rpcKey,
              marketCap: mc, liquidity: liq, holders, percentChange24h: pc,
              top10HolderPercent: top10, source: rn, seedType: 'mature',
              volume24h: vol, launchTime: parseInt(t.launchTime || 0),
            });
          } else {
            const e = all.get(ca);
            if (!e.source.includes(rn)) e.source += `+${rn}`;
          }
        }
        await sleep(200);
      } catch (e) { log('WARN', `  ${chain.name} ${rn}: ${e.message?.slice(0, 50)}`); }
    }
  }
  // Phase 1b: 安全审计过滤（排除高风险/貔貅盘）
  log('INFO', `  🔒 安全审计 (${all.size} 个候选)...`);
  const auditUrl = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit';
  let audited = 0, kicked = 0;
  const toAudit = [...all.values()].slice(0, 50); // 最多审计50个（控制速度）
  for (const s of toAudit) {
    try {
      const d = await binPost(auditUrl, {
        binanceChainId: s.chainId, contractAddress: s.contractAddress,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      });
      const audit = d?.data || {};
      s.auditRiskLevel = audit.riskLevelEnum || 'UNKNOWN';
      s.auditBuyTax = audit.extraInfo?.buyTax || null;
      s.auditSellTax = audit.extraInfo?.sellTax || null;
      s.auditIsHoneypot = false;
      // 检查具体风险项
      for (const cat of (audit.riskItems || [])) {
        for (const detail of (cat.details || [])) {
          if (detail.isHit && detail.riskType === 'RISK') {
            if (detail.title?.includes('Honeypot')) s.auditIsHoneypot = true;
          }
        }
      }
      audited++;
      // 踢掉: HIGH风险 或 honeypot 或 卖税>10%
      const sellTax = parseFloat(s.auditSellTax || 0);
      if (audit.riskLevelEnum === 'HIGH' || s.auditIsHoneypot || sellTax > 10) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED: risk=${audit.riskLevelEnum} honeypot=${s.auditIsHoneypot} sellTax=${sellTax}%`);
        all.delete(s.contractAddress.toLowerCase());
        kicked++;
      }
      await sleep(100);
    } catch (e) {
      s.auditRiskLevel = 'ERROR';
    }
  }
  log('INFO', `  🔒 审计完成: ${audited}个审计, ${kicked}个踢掉`);
  
  // Phase 1c: DexScreener池子健康检查
  log('INFO', `  🏊 池子健康检查...`);
  const toCheck = [...all.values()].slice(0, 50);
  let poolKicked = 0;
  for (const s of toCheck) {
    try {
      const d = await httpReq(`https://api.dexscreener.com/latest/dex/tokens/${s.contractAddress}`);
      const pairs = d?.pairs || [];
      if (!pairs.length) continue;
      const mainPair = pairs.reduce((best, p) => 
        ((p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) ? p : best, pairs[0]);
      const totalLiq = pairs.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
      const mc = mainPair.marketCap || 1;
      const liqMcRatio = totalLiq / mc;
      const mainTxns = (mainPair.txns?.h24?.buys || 0) + (mainPair.txns?.h24?.sells || 0);
      s.dexPools = pairs.length;
      s.dexTotalLiq = totalLiq;
      s.dexLiqMcRatio = liqMcRatio;
      s.dexMainTxns = mainTxns;
      
      const mainBuys = mainPair.txns?.h24?.buys || 0;
      const mainSells = mainPair.txns?.h24?.sells || 0;
      const bsRatio = mainSells > 0 ? (mainBuys / mainSells) : 0;
      const volMcRatio = (mainPair.volume?.h24 || 0) / mc;
      const dexId = mainPair.dexId || '';
      const isPumpfun = s.contractAddress.endsWith('pump') || pairs.some(p => p.dexId === 'pumpfun' || p.dexId === 'pumpswap');
      
      s.dexPools = pairs.length;
      s.dexTotalLiq = totalLiq;
      s.dexLiqMcRatio = liqMcRatio;
      s.dexMainTxns = mainTxns;
      s.dexVolMcRatio = volMcRatio;
      s.dexBsRatio = bsRatio;
      s.dexMainDex = dexId;
      s.isPumpfun = isPumpfun;
      
      // 规则0a: 实时流动性 < $10,000 → 死币，直接踢
      if (totalLiq < 10000) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED(死币): Liq:$${totalLiq.toFixed(0)}`);
        all.delete(s.contractAddress.toLowerCase());
        poolKicked++;
        continue;
      }
      // 规则0b: 流动性/MC < 1% → 市值虚高，直接踢（不管交易量多少）
      if (liqMcRatio < 0.01) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED(市值虚高): Liq/MC=${(liqMcRatio*100).toFixed(2)}% Liq:$${totalLiq.toFixed(0)} MC:$${mc.toFixed(0)}`);
        all.delete(s.contractAddress.toLowerCase());
        poolKicked++;
        continue;
      }
      // 规则1: 流动性/MC < 5% 且 主池交易笔数 < 10000 → 断头铡
      if (liqMcRatio < 0.05 && mainTxns < 10000) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED(断头铡): Liq/MC=${(liqMcRatio*100).toFixed(1)}% Txns=${mainTxns}`);
        all.delete(s.contractAddress.toLowerCase());
        poolKicked++;
        continue;
      }
      // 规则2: 非Pump.fun + Vol/MC > 20x → 刷量盘
      if (!isPumpfun && volMcRatio > 20) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED(刷量): Vol/MC=${volMcRatio.toFixed(0)}x 非Pump.fun(${dexId})`);
        all.delete(s.contractAddress.toLowerCase());
        poolKicked++;
        continue;
      }
      // 规则3: B/S比 > 3.0 → 买单远大于卖单，bot刷买或貔貅卖不掉
      const bsRatioVal = mainSells > 10 ? (mainBuys / mainSells) : 0;
      if (bsRatioVal > 3.0) {
        log('INFO', `    ❌ ${s.symbol}[${s.chain}] KICKED(B/S异常): B/S=${bsRatioVal.toFixed(2)} Buys:${mainBuys} Sells:${mainSells}`);
        all.delete(s.contractAddress.toLowerCase());
        poolKicked++;
        continue;
      }
      await sleep(300); // DexScreener限流
    } catch (e) { /* skip */ }
  }
  
  // 规则3: 关联盘检测 — 同批创建+买卖比相同的踢掉
  const dexInfoMap = new Map();
  for (const s of [...all.values()]) {
    if (s.dexBsRatio && s.dexMainDex) {
      const key = `${s.dexMainDex}_${s.dexBsRatio.toFixed(2)}`;
      if (!dexInfoMap.has(key)) dexInfoMap.set(key, []);
      dexInfoMap.get(key).push(s);
    }
  }
  for (const [key, group] of dexInfoMap) {
    if (group.length >= 3) { // 3个以上币买卖比完全相同 = 同一套bot
      log('INFO', `    ❌ 关联盘(${group.length}个, B/S=${group[0].dexBsRatio.toFixed(2)}): ${group.map(g => g.symbol).join(', ')}`);
      for (const g of group) {
        all.delete(g.contractAddress.toLowerCase());
        poolKicked++;
      }
    }
  }
  
  log('INFO', `  🏊 池子检查完成: ${poolKicked}个踢掉`);
  
  const seeds = [...all.values()].sort((a, b) => b.percentChange24h - a.percentChange24h);
  log('INFO', `🌱 种子币: ${seeds.length} 个通过`);
  log('INFO', `  全部成熟型（高流动性+高交易量+高持有者）`);
  for (const s of seeds.slice(0, 20)) {
    log('INFO', `  [${s.chain}] ${s.symbol} MC:$${(s.marketCap/1000).toFixed(0)}k Liq:$${(s.liquidity/1000).toFixed(0)}k Vol:$${(s.volume24h/1e6).toFixed(1)}M H:${s.holders} ${s.source}`);
  }
  saveJSON(SEEDS_FILE, { updatedAt: new Date().toISOString(), count: seeds.length, seeds });
  return seeds;
}

// ============================================================
// Phase 2: 链上挖掘
// ============================================================

// --- SOL价格 ---
let solPrice = 130, bnbPrice = 580;
async function updatePrices() {
  try {
    const d = await httpReq('https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin&vs_currencies=usd');
    if (d.solana?.usd) solPrice = d.solana.usd;
    if (d.binancecoin?.usd) bnbPrice = d.binancecoin.usd;
    log('INFO', `价格: SOL=$${solPrice}, BNB=$${bnbPrice}`);
  } catch {}
}

// --- Solana挖掘（Helius parsed transactions） ---
async function mineSolana(seed) {
  const mint = seed.contractAddress;
  log('INFO', `  ⛏ [SOL] ${seed.symbol} (${mint.slice(0,12)}...)`);
  
  const wallets = new Map(); // wallet → stats
  let beforeSig, totalTx = 0;
  
  for (let batch = 0; batch < 10; batch++) {
    const key = nextHeliusKey();
    let url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=100&type=SWAP`;
    if (beforeSig) url += `&before=${beforeSig}`;
    try {
      const txs = await httpReq(url);
      if (!Array.isArray(txs) || !txs.length) break;
      totalTx += txs.length;
      beforeSig = txs[txs.length - 1].signature;
      
      for (const tx of txs) {
        const fp = tx.feePayer;
        if (!fp) continue;
        const ts = (tx.timestamp || 0) * 1000;
        
        // 分析 nativeTransfers + tokenTransfers 算真实盈亏
        let tokenIn = 0, tokenOut = 0, solSpent = 0, solReceived = 0;
        
        for (const nt of (tx.nativeTransfers || [])) {
          if (nt.fromUserAccount === fp) solSpent += (nt.amount || 0) / 1e9;
          if (nt.toUserAccount === fp) solReceived += (nt.amount || 0) / 1e9;
        }
        
        for (const tt of (tx.tokenTransfers || [])) {
          if (tt.mint === mint) {
            if (tt.toUserAccount === fp) tokenIn += tt.tokenAmount || 0;
            if (tt.fromUserAccount === fp) tokenOut += tt.tokenAmount || 0;
          }
        }
        
        const isBuy = tokenIn > 0 && solSpent > 0;
        const isSell = tokenOut > 0 && solReceived > 0;
        if (!isBuy && !isSell) continue;
        
        if (!wallets.has(fp)) {
          wallets.set(fp, {
            wallet: fp, chain: 'Solana',
            buys: [], sells: [],
            totalSolSpent: 0, totalSolReceived: 0,
            totalTokenBought: 0, totalTokenSold: 0,
            firstBuyTime: null, lastTxTime: null,
          });
        }
        const w = wallets.get(fp);
        if (isBuy) {
          w.buys.push({ sol: solSpent, token: tokenIn, time: ts, sig: tx.signature });
          w.totalSolSpent += solSpent;
          w.totalTokenBought += tokenIn;
          if (!w.firstBuyTime || ts < w.firstBuyTime) w.firstBuyTime = ts;
        }
        if (isSell) {
          w.sells.push({ sol: solReceived, token: tokenOut, time: ts });
          w.totalSolReceived += solReceived;
          w.totalTokenSold += tokenOut;
        }
        w.lastTxTime = Math.max(w.lastTxTime || 0, ts);
      }
      await sleep(150);
    } catch (e) {
      log('WARN', `    batch${batch}: ${e.message?.slice(0, 50)}`);
      await sleep(500);
    }
  }
  
  // 计算盈亏
  const result = [];
  for (const [addr, w] of wallets) {
    const profitSol = w.totalSolReceived - w.totalSolSpent;
    const profitUsd = profitSol * solPrice;
    const costUsd = w.totalSolSpent * solPrice;
    const roi = costUsd > 0 ? profitUsd / costUsd : 0;
    
    result.push({
      wallet: addr, chain: 'Solana',
      buyCount: w.buys.length, sellCount: w.sells.length,
      costUsd, profitUsd, roi,
      firstBuyTime: w.firstBuyTime,
      totalTokenBought: w.totalTokenBought,
      totalTokenSold: w.totalTokenSold,
    });
  }
  
  const profitable = result.filter(r => r.profitUsd > 100);
  log('INFO', `    ${totalTx}笔tx → ${wallets.size}个钱包, ${profitable.length}个盈利>$100`);
  return result;
}

// --- EVM挖掘（Transfer事件 + 估算盈亏） ---
async function mineEvm(seed) {
  log('INFO', `  ⛏ [${seed.chain}] ${seed.symbol} (${seed.contractAddress.slice(0,12)}...)`);
  const rpc = EVM_RPCS[seed.rpcKey];
  if (!rpc) return [];
  
  const contract = seed.contractAddress.toLowerCase();
  const wallets = new Map();
  
  try {
    // 获取当前区块
    const br = await httpReq(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }) });
    const curBlock = parseInt(br.result, 16);
    
    // 按种子币年龄查Transfer事件（最多60天）
    const blocksPerDay = seed.chain === 'BSC' ? 28800 : 43200;
    const ageDays = seed.launchTime ? Math.ceil((Date.now() - seed.launchTime) / 86400000) + 2 : 100;
    const lookbackDays = Math.min(ageDays, 100);
    const fromBlock = curBlock - blocksPerDay * lookbackDays;
    const BATCH = 5000;
    let totalEvents = 0;
    
    for (let start = fromBlock; start < curBlock && totalEvents < 5000; start += BATCH) {
      const end = Math.min(start + BATCH - 1, curBlock);
      try {
        const lr = await httpReq(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getLogs',
            params: [{ address: contract, topics: [TRANSFER_TOPIC],
              fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }], id: 1 }) });
        
        const logs = lr.result || [];
        totalEvents += logs.length;
        
        for (const l of logs) {
          if (!l.topics || l.topics.length < 3) continue;
          const from = '0x' + l.topics[1].slice(26).toLowerCase();
          const to = '0x' + l.topics[2].slice(26).toLowerCase();
          const value = parseInt(l.data || '0x0', 16);
          const block = parseInt(l.blockNumber, 16);
          if (to === '0x0000000000000000000000000000000000000000') continue;
          
          // 记录收到token（买入信号）和发出token（卖出信号）
          for (const [addr, isBuy] of [[to, true], [from, false]]) {
            if (addr === '0x0000000000000000000000000000000000000000') continue;
            if (!wallets.has(addr)) {
              wallets.set(addr, { wallet: addr, chain: seed.chain, received: 0, sent: 0,
                receiveCount: 0, sendCount: 0, firstBlock: null, lastBlock: null });
            }
            const w = wallets.get(addr);
            if (isBuy) { w.received += value; w.receiveCount++; }
            else { w.sent += value; w.sendCount++; }
            if (!w.firstBlock || block < w.firstBlock) w.firstBlock = block;
            w.lastBlock = Math.max(w.lastBlock || 0, block);
          }
        }
        await sleep(80);
      } catch { await sleep(300); }
    }
    
    log('INFO', `    ${totalEvents}个事件 → ${wallets.size}个地址`);
  } catch (e) {
    log('WARN', `    EVM失败: ${e.message?.slice(0, 50)}`);
  }
  
  // 转换格式（EVM没法直接算USD盈亏，用token净买入量作为指标）
  return [...wallets.values()].map(w => ({
    wallet: w.wallet, chain: w.chain,
    buyCount: w.receiveCount, sellCount: w.sendCount,
    netTokens: w.received - w.sent,
    profitUsd: 0, // EVM暂时无法算
    costUsd: 0,
    roi: w.sent > 0 && w.received > 0 ? (w.sent / w.received) : 0,
    firstBlock: w.firstBlock,
  }));
}

async function mineAll(seeds) {
  // 只挖100天内发射的种子（老币交易太多挖不动）
  const MAX_AGE_MS = 100 * 24 * 3600 * 1000;
  const youngSeeds = seeds.filter(s => s.launchTime && (Date.now() - s.launchTime) < MAX_AGE_MS);
  log('INFO', `\n⛏ Phase 2: 挖掘早期买家 (${youngSeeds.length}个45天内种子，跳过${seeds.length - youngSeeds.length}个老币)...`);
  await updatePrices();
  
  const seedBuyers = {};
  const toProcess = youngSeeds;
  
  for (const seed of toProcess) {
    try {
      const buyers = seed.chainType === 'solana' ? await mineSolana(seed) : await mineEvm(seed);
      seedBuyers[seed.contractAddress.toLowerCase()] = {
        seed: { symbol: seed.symbol, chain: seed.chain, ca: seed.contractAddress },
        buyerCount: buyers.length,
        profitableBuyers: buyers.filter(b => b.profitUsd > 100 || b.netTokens > 0).length,
        buyers,
      };
      await sleep(300);
    } catch (e) { log('WARN', `  ${seed.symbol}: ${e.message?.slice(0, 50)}`); }
  }
  
  saveJSON(WALLETS_FILE, { updatedAt: new Date().toISOString(), seedBuyers });
  return seedBuyers;
}

// ============================================================
// Phase 3: 交叉验证 + 评分
// ============================================================
async function crossValidate(seedBuyers) {
  log('INFO', '\n🔬 Phase 3: 交叉验证 + 评分...');
  
  const wMap = new Map(); // wallet → aggregated info
  
  for (const [seedAddr, data] of Object.entries(seedBuyers)) {
    for (const b of data.buyers) {
      const w = b.wallet.toLowerCase();
      if (!wMap.has(w)) {
        wMap.set(w, { wallet: b.wallet, chain: b.chain, seeds: new Map(), totalProfit: 0, totalCost: 0, totalBuys: 0, totalSells: 0 });
      }
      const info = wMap.get(w);
      info.seeds.set(seedAddr, { symbol: data.seed.symbol, profit: b.profitUsd, cost: b.costUsd, buys: b.buyCount, sells: b.sellCount });
      info.totalProfit += b.profitUsd;
      info.totalCost += b.costUsd;
      info.totalBuys += b.buyCount;
      info.totalSells += b.sellCount;
    }
  }
  
  // 筛选 + 评分
  const candidates = [];
  for (const [w, info] of wMap) {
    const seedCount = info.seeds.size;
    if (seedCount < SM_CRITERIA.minSeedAppearance) continue;
    
    // Bot检测
    const totalTx = info.totalBuys + info.totalSells;
    const botScore = totalTx > 500 ? 0.9 : totalTx > 200 ? 0.6 : totalTx > 50 ? 0.3 : 0.1;
    if (botScore > SM_CRITERIA.maxBotScore) continue;
    
    // 盈利种子数
    const profitableSeeds = [...info.seeds.values()].filter(s => s.profit > 0).length;
    const winRate = seedCount > 0 ? profitableSeeds / seedCount : 0;
    
    // 综合评分：种子覆盖 × 盈利能力 × 非bot × 胜率
    const score = seedCount * (1 + Math.log10(Math.max(info.totalProfit, 1))) * (1 - botScore) * (winRate + 0.2);
    
    const seedSymbols = [...info.seeds.values()].map(s => s.symbol);
    
    candidates.push({
      wallet: info.wallet, chain: info.chain,
      seedCount, seedSymbols,
      totalProfit: Math.round(info.totalProfit * 100) / 100,
      totalCost: Math.round(info.totalCost * 100) / 100,
      winRate: Math.round(winRate * 100),
      botScore: Math.round(botScore * 100),
      score: Math.round(score * 100) / 100,
      totalBuys: info.totalBuys, totalSells: info.totalSells,
    });
  }
  
  candidates.sort((a, b) => b.score - a.score);
  
  log('INFO', `🔬 结果: ${candidates.length} 个聪明钱候选`);
  log('INFO', `   链分布: SOL=${candidates.filter(c=>c.chain==='Solana').length} BSC=${candidates.filter(c=>c.chain==='BSC').length} Base=${candidates.filter(c=>c.chain==='Base').length}`);
  
  for (const c of candidates.slice(0, 30)) {
    log('INFO', `  ${c.wallet.slice(0, 16)}... [${c.chain}] ${c.seedCount}币(${c.seedSymbols.join(',')}) Profit:$${c.totalProfit.toLocaleString()} WR:${c.winRate}% Bot:${c.botScore}% Score:${c.score}`);
  }
  
  // Phase 3b: 查聪明钱当前持仓
  log('INFO', `\n👛 Phase 3b: 查聪明钱当前持仓 (前20个)...`);
  const posUrl = 'https://web3.binance.com/bapi/defi/v3/public/wallet-direct/buw/wallet/address/pnl/active-position-list';
  const chainIdMap = { 'Solana': 'CT_501', 'BSC': '56', 'Base': '8453' };
  
  for (const c of candidates.slice(0, 20)) {
    const cid = chainIdMap[c.chain];
    if (!cid) continue;
    try {
      const d = await httpReq(`${posUrl}?address=${c.wallet}&chainId=${cid}&offset=0`, {
        headers: { 'clienttype': 'web', 'clientversion': '1.2.0' },
      });
      const list = d?.data?.list || [];
      c.currentHoldings = list.map(t => ({
        symbol: t.symbol, name: t.name, ca: t.contractAddress,
        price: parseFloat(t.price || 0), qty: parseFloat(t.remainQty || 0),
        change24h: parseFloat(t.percentChange24h || 0),
        valueUsd: parseFloat(t.price || 0) * parseFloat(t.remainQty || 0),
      })).filter(t => t.valueUsd > 1).sort((a, b) => b.valueUsd - a.valueUsd);
      
      const totalValue = c.currentHoldings.reduce((s, t) => s + t.valueUsd, 0);
      const topSyms = c.currentHoldings.slice(0, 5).map(t => `${t.symbol}($${t.valueUsd.toFixed(0)})`).join(', ');
      log('INFO', `  ${c.wallet.slice(0,16)}... 持仓${c.currentHoldings.length}币 $${totalValue.toFixed(0)} | ${topSyms}`);
      await sleep(150);
    } catch (e) {
      c.currentHoldings = [];
    }
  }
  
  saveJSON(SMART_MONEY_FILE, { updatedAt: new Date().toISOString(), count: candidates.length, criteria: SM_CRITERIA, smartMoney: candidates });
  return candidates;
}

// ============================================================
// Status
// ============================================================
function showStatus() {
  const seeds = loadJSON(SEEDS_FILE, { seeds: [] });
  const sm = loadJSON(SMART_MONEY_FILE, { smartMoney: [] });
  
  console.log('\n📊 Smart Money Scanner v6 状态');
  console.log(`种子币: ${seeds.seeds?.length || 0} 个 (更新: ${seeds.updatedAt || 'N/A'})`);
  console.log(`聪明钱: ${sm.smartMoney?.length || 0} 个 (更新: ${sm.updatedAt || 'N/A'})`);
  
  if (sm.smartMoney?.length) {
    console.log('\nTop 10 聪明钱:');
    for (const c of sm.smartMoney.slice(0, 10)) {
      console.log(`  ${c.wallet.slice(0,20)}... [${c.chain}] ${c.seedCount}币 Profit:$${c.totalProfit} WR:${c.winRate}% Score:${c.score}`);
    }
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  const mode = process.argv[2] || 'full';
  
  if (mode === 'status') return showStatus();
  
  log('INFO', `🚀 Smart Money Scanner v6.1 启动 (mode=${mode})`);
  log('INFO', `Helius: ${HELIUS_KEYS.length}keys, RPC: ${Object.keys(EVM_RPCS).join(',')}`);
  
  let seeds, seedBuyers;
  
  if (mode === 'seeds' || mode === 'full') {
    seeds = await fetchSeeds();
    if (mode === 'seeds') return;
  }
  
  if (mode === 'mine') {
    seeds = loadJSON(SEEDS_FILE, { seeds: [] }).seeds;
  }
  
  if (mode === 'full' || mode === 'mine') {
    seedBuyers = await mineAll(seeds);
    const sm = await crossValidate(seedBuyers);
    log('INFO', `\n✅ 完成！种子:${seeds.length} 聪明钱:${sm.length}`);
  }
}

main().catch(e => { log('ERROR', `致命: ${e.stack}`); process.exit(1); });
