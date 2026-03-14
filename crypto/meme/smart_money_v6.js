#!/usr/bin/env node
/**
 * Smart Money Scanner v6
 * 
 * 核心思路：
 * 1. 从币安 Unified Token Rank (Trending/Alpha/TopSearch) 拿到三条链热门币
 * 2. 筛选出涨幅大、流动性够、不是假币的种子币
 * 3. 链上查这些种子币的早期买家（Helius for SOL, EVM logs for BSC/Base）
 * 4. 自己验证：买入时机、盈亏、是否bot、分仓行为
 * 5. 跨币交叉：在多个种子币里都赚了 = 真聪明钱
 * 6. 私有聪明钱库 → 监控新买入 → 跟单信号
 * 
 * 数据源：币安Web3 Skills Hub (免费，无需API Key)
 * 链上验证：Helius (Solana) / Public RPC (BSC/Base)
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

if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// === Config ===
const HELIUS_KEYS = [
  process.env.HELIUS_API_KEY || '',
  process.env.HELIUS_API_KEY_2 || '',
].filter(Boolean);
let heliusIdx = 0;
function nextHeliusKey() { return HELIUS_KEYS[heliusIdx++ % HELIUS_KEYS.length]; }

const EVM_RPCS = {
  bsc: process.env.BSC_RPC || 'https://bsc-mainnet.public.blastapi.io',
  base: process.env.BASE_RPC || 'https://base-mainnet.public.blastapi.io',
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// === 种子币筛选标准 ===
const SEED_FILTER = {
  minLiquidity: 50000,      // 最低流动性 $50k（防假币）
  minMarketCap: 100000,     // 最低MC $100k
  minHolders: 50,           // 最低持有者数
  minPercentChange: 100,    // 24h最低涨幅100%（翻倍以上）
  maxTop10Percent: 80,      // top10持有者占比不超80%（防庄控盘）
};

// === 聪明钱评分标准 ===
const SMART_MONEY_CRITERIA = {
  minSeedAppearance: 2,     // 至少在2个种子币中出现
  minProfitPerSeed: 1000,   // 单币最低盈利 $1k
  minWinRate: 0.4,          // 最低胜率40%
  maxBotScore: 0.5,         // bot分数低于50%
};

// === 链配置 ===
const CHAINS = [
  { name: 'Solana', chainId: 'CT_501', type: 'solana' },
  { name: 'BSC', chainId: '56', type: 'evm', rpcKey: 'bsc' },
  { name: 'Base', chainId: '8453', type: 'evm', rpcKey: 'base' },
];

// === 工具函数 ===
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  const logFile = path.join(LOG_DIR, `v6_${ts.slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === HTTP请求封装 ===
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': 'binance-web3/2.0 (Skill)',
        ...options.headers,
      },
      timeout: 15000,
    };

    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function binancePost(url, data) {
  return httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function binanceGet(url) {
  return httpRequest(url);
}

// ============================================================
// Phase 1: 从币安 Unified Token Rank 获取种子币
// ============================================================
async function fetchSeeds() {
  log('INFO', '🌱 Phase 1: 从币安排行榜获取种子币...');
  
  const url = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list';
  const allSeeds = new Map(); // contractAddress.lower() → seed info
  
  for (const chain of CHAINS) {
    // Trending (rankType=10) 按24h涨幅排序
    for (const [rankType, rankName] of [[10, 'Trending'], [11, 'TopSearch'], [20, 'Alpha']]) {
      try {
        const d = await binancePost(url, {
          rankType,
          chainId: chain.chainId,
          period: 50, // 24h
          sortBy: 50, // 按涨幅排序
          orderAsc: false,
          page: 1,
          size: 200,
        });
        
        const tokens = d?.data?.tokens || [];
        log('INFO', `  ${chain.name} ${rankName}: ${tokens.length} 个`);
        
        for (const t of tokens) {
          const ca = (t.contractAddress || '').toLowerCase();
          if (!ca) continue;
          
          const mc = parseFloat(t.marketCap || 0);
          const liq = parseFloat(t.liquidity || 0);
          const holders = parseInt(t.holders || 0);
          const pc24h = parseFloat(t.percentChange24h || 0);
          const top10 = parseFloat(t.holdersTop10Percent || 100);
          
          // 筛选
          if (liq < SEED_FILTER.minLiquidity) continue;
          if (mc < SEED_FILTER.minMarketCap) continue;
          if (holders < SEED_FILTER.minHolders) continue;
          if (pc24h < SEED_FILTER.minPercentChange) continue;
          if (top10 > SEED_FILTER.maxTop10Percent) continue;
          
          // 去重，保留最好的排名来源
          if (!allSeeds.has(ca)) {
            allSeeds.set(ca, {
              symbol: t.symbol || '?',
              name: t.name || t.symbol || '?',
              contractAddress: t.contractAddress,
              chain: chain.name,
              chainId: chain.chainId,
              chainType: chain.type,
              rpcKey: chain.rpcKey,
              marketCap: mc,
              liquidity: liq,
              holders,
              percentChange24h: pc24h,
              top10HolderPercent: top10,
              source: `${rankName}`,
              volume24h: parseFloat(t.volume24h || 0),
              launchTime: parseInt(t.launchTime || 0),
              fetchedAt: Date.now(),
            });
          } else {
            // 更新source
            const existing = allSeeds.get(ca);
            if (!existing.source.includes(rankName)) {
              existing.source += `+${rankName}`;
            }
          }
        }
        
        await sleep(300); // 温柔点
      } catch (e) {
        log('WARN', `  ${chain.name} ${rankName} 失败: ${e.message?.slice(0, 60)}`);
      }
    }
  }
  
  // 按涨幅排序
  const seeds = [...allSeeds.values()].sort((a, b) => b.percentChange24h - a.percentChange24h);
  
  log('INFO', `🌱 种子币筛选完成: ${seeds.length} 个通过`);
  for (const s of seeds.slice(0, 20)) {
    log('INFO', `  [${s.chain}] ${s.symbol} | MC:$${s.marketCap.toLocaleString()} | Liq:$${s.liquidity.toLocaleString()} | +${s.percentChange24h.toFixed(0)}% | Holders:${s.holders} | Source:${s.source}`);
  }
  
  saveJSON(SEEDS_FILE, { updatedAt: new Date().toISOString(), seeds });
  return seeds;
}

// ============================================================
// Phase 2: 从种子币链上挖掘早期买家
// ============================================================

// --- Solana: Helius ---
async function mineSolanaEarlyBuyers(seed) {
  log('INFO', `  🔍 [SOL] ${seed.symbol} 挖早期买家...`);
  
  const mint = seed.contractAddress;
  const buyers = new Map(); // wallet → { totalBuyUsd, totalSellUsd, firstBuyTime, txCount, buys, sells }
  
  // 用 Helius getSignaturesForAddress 查 mint 的交易
  // 然后 parseTransactions 分析买卖
  let beforeSig;
  let totalTxs = 0;
  const MAX_BATCHES = 5; // 最多5批 × 100 = 500笔交易（先快速跑通）
  
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const key = nextHeliusKey();
    let url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=100&type=SWAP`;
    if (beforeSig) url += `&before=${beforeSig}`;
    
    try {
      const resp = await httpRequest(url);
      if (!Array.isArray(resp) || resp.length === 0) break;
      
      totalTxs += resp.length;
      beforeSig = resp[resp.length - 1].signature;
      
      for (const tx of resp) {
        // 解析 token transfers
        const transfers = tx.tokenTransfers || [];
        const feePayer = tx.feePayer;
        if (!feePayer) continue;
        
        for (const tr of transfers) {
          if (tr.mint !== mint) continue;
          
          const amount = tr.tokenAmount || 0;
          if (amount <= 0) continue;
          
          // 买入：toUserAccount === feePayer 或者 fromUserAccount 是池子
          // 卖出：fromUserAccount === feePayer
          const isBuy = tr.toUserAccount === feePayer;
          const isSell = tr.fromUserAccount === feePayer;
          
          if (!isBuy && !isSell) continue;
          
          if (!buyers.has(feePayer)) {
            buyers.set(feePayer, {
              wallet: feePayer,
              totalBuyAmount: 0,
              totalSellAmount: 0,
              firstBuyTime: null,
              lastTxTime: null,
              buyCount: 0,
              sellCount: 0,
              txSignatures: [],
            });
          }
          
          const b = buyers.get(feePayer);
          if (isBuy) {
            b.totalBuyAmount += amount;
            b.buyCount++;
            const ts = (tx.timestamp || 0) * 1000;
            if (!b.firstBuyTime || ts < b.firstBuyTime) b.firstBuyTime = ts;
          } else if (isSell) {
            b.totalSellAmount += amount;
            b.sellCount++;
          }
          b.lastTxTime = Math.max(b.lastTxTime || 0, (tx.timestamp || 0) * 1000);
          if (b.txSignatures.length < 5) b.txSignatures.push(tx.signature);
        }
      }
      
      await sleep(200);
    } catch (e) {
      log('WARN', `    Helius batch ${batch} 失败: ${e.message?.slice(0, 60)}`);
      await sleep(1000);
    }
  }
  
  log('INFO', `    扫了 ${totalTxs} 笔交易，发现 ${buyers.size} 个买家`);
  return [...buyers.values()];
}

// --- EVM (BSC/Base): Transfer事件 ---
async function mineEvmEarlyBuyers(seed) {
  log('INFO', `  🔍 [${seed.chain}] ${seed.symbol} 挖早期买家...`);
  
  const rpc = EVM_RPCS[seed.rpcKey];
  if (!rpc) {
    log('WARN', `    无RPC: ${seed.rpcKey}`);
    return [];
  }
  
  const contract = seed.contractAddress.toLowerCase();
  const buyers = new Map();
  
  // 查Transfer事件找买家
  // Transfer(from, to, value) — to就是买家（from池子或其他来源）
  // 分批查，先查最近1万个block
  try {
    // 获取当前区块
    const blockResp = await httpRequest(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const currentBlock = parseInt(blockResp.result, 16);
    
    // BSC ~3s/block, Base ~2s/block, 查最近7天
    const blocksPerDay = seed.chain === 'BSC' ? 28800 : 43200;
    const fromBlock = currentBlock - blocksPerDay * 7;
    
    // 分批查（每批5000个block）
    const BATCH_SIZE = 5000;
    let totalEvents = 0;
    
    for (let start = fromBlock; start < currentBlock; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, currentBlock);
      
      try {
        const logsResp = await httpRequest(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getLogs',
            params: [{
              address: contract,
              topics: [TRANSFER_TOPIC],
              fromBlock: '0x' + start.toString(16),
              toBlock: '0x' + end.toString(16),
            }],
            id: 1,
          }),
        });
        
        const logs = logsResp.result || [];
        totalEvents += logs.length;
        
        for (const log_ of logs) {
          if (!log_.topics || log_.topics.length < 3) continue;
          
          const from = '0x' + log_.topics[1].slice(26);
          const to = '0x' + log_.topics[2].slice(26);
          const value = parseInt(log_.data, 16);
          
          // to 就是买家（收到token的人）
          // 排除零地址和合约地址（简单排除）
          if (to === '0x0000000000000000000000000000000000000000') continue;
          if (from === '0x0000000000000000000000000000000000000000') continue; // mint事件
          
          if (!buyers.has(to)) {
            buyers.set(to, {
              wallet: to,
              totalReceived: 0,
              totalSent: 0,
              receiveCount: 0,
              sendCount: 0,
              firstReceiveBlock: null,
              lastTxBlock: null,
            });
          }
          
          const b = buyers.get(to);
          b.totalReceived += value;
          b.receiveCount++;
          if (!b.firstReceiveBlock || parseInt(log_.blockNumber, 16) < b.firstReceiveBlock) {
            b.firstReceiveBlock = parseInt(log_.blockNumber, 16);
          }
          b.lastTxBlock = Math.max(b.lastTxBlock || 0, parseInt(log_.blockNumber, 16));
          
          // 也记录卖出（from是卖家）
          if (!buyers.has(from)) {
            buyers.set(from, {
              wallet: from,
              totalReceived: 0,
              totalSent: 0,
              receiveCount: 0,
              sendCount: 0,
              firstReceiveBlock: null,
              lastTxBlock: null,
            });
          }
          const s = buyers.get(from);
          s.totalSent += value;
          s.sendCount++;
        }
        
        await sleep(100);
      } catch (e) {
        // 单批失败继续
        await sleep(500);
      }
    }
    
    log('INFO', `    扫了 ${totalEvents} 个Transfer事件，发现 ${buyers.size} 个地址`);
  } catch (e) {
    log('WARN', `    EVM扫描失败: ${e.message?.slice(0, 60)}`);
  }
  
  return [...buyers.values()];
}

async function mineWallets(seeds) {
  log('INFO', `\n⛏️ Phase 2: 挖掘种子币早期买家 (${seeds.length} 个种子)...`);
  
  // 每个种子币的所有买家
  const seedBuyers = {}; // seedAddress → buyers[]
  
  // 限制每次最多处理前5个种子（先快速跑通）
  const toProcess = seeds.slice(0, 5);
  
  for (const seed of toProcess) {
    try {
      let buyers;
      if (seed.chainType === 'solana') {
        buyers = await mineSolanaEarlyBuyers(seed);
      } else {
        buyers = await mineEvmEarlyBuyers(seed);
      }
      
      seedBuyers[seed.contractAddress.toLowerCase()] = {
        seed: { symbol: seed.symbol, chain: seed.chain, contractAddress: seed.contractAddress },
        buyers,
        minedAt: new Date().toISOString(),
      };
      
      await sleep(500);
    } catch (e) {
      log('WARN', `  ${seed.symbol} 挖掘失败: ${e.message?.slice(0, 60)}`);
    }
  }
  
  saveJSON(WALLETS_FILE, { updatedAt: new Date().toISOString(), seedBuyers });
  return seedBuyers;
}

// ============================================================
// Phase 3: 跨币交叉验证 + 评分
// ============================================================
function crossValidate(seedBuyers) {
  log('INFO', '\n🔬 Phase 3: 跨币交叉验证...');
  
  // wallet → { seeds: Set<seedAddr>, seedDetails: { seedAddr: buyerInfo } }
  const walletMap = new Map();
  
  for (const [seedAddr, data] of Object.entries(seedBuyers)) {
    const chain = data.seed.chain;
    
    for (const buyer of data.buyers) {
      const w = buyer.wallet.toLowerCase();
      
      if (!walletMap.has(w)) {
        walletMap.set(w, {
          wallet: buyer.wallet,
          chain,
          seeds: new Set(),
          seedDetails: {},
          totalBuyCount: 0,
          totalSellCount: 0,
        });
      }
      
      const wInfo = walletMap.get(w);
      wInfo.seeds.add(seedAddr);
      wInfo.seedDetails[seedAddr] = {
        symbol: data.seed.symbol,
        ...buyer,
      };
      wInfo.totalBuyCount += buyer.buyCount || buyer.receiveCount || 0;
      wInfo.totalSellCount += buyer.sellCount || buyer.sendCount || 0;
    }
  }
  
  // 只保留出现在多个种子中的钱包
  const candidates = [];
  for (const [w, info] of walletMap) {
    const seedCount = info.seeds.size;
    if (seedCount < SMART_MONEY_CRITERIA.minSeedAppearance) continue;
    
    // Bot检测：买卖次数过多且无pause = 可能是bot
    const totalTx = info.totalBuyCount + info.totalSellCount;
    const botScore = totalTx > 500 ? 0.8 : totalTx > 200 ? 0.5 : totalTx > 100 ? 0.3 : 0.1;
    
    if (botScore > SMART_MONEY_CRITERIA.maxBotScore) continue;
    
    // 简单胜率：有卖出的种子 / 总种子数（卖了说明赚了跑了）
    const seedsWithSell = Object.values(info.seedDetails).filter(d => 
      (d.sellCount || d.sendCount || 0) > 0
    ).length;
    const winRate = seedsWithSell / seedCount;
    
    candidates.push({
      wallet: info.wallet,
      chain: info.chain,
      seedCount,
      seeds: [...info.seeds],
      seedSymbols: Object.values(info.seedDetails).map(d => d.symbol),
      totalBuys: info.totalBuyCount,
      totalSells: info.totalSellCount,
      botScore,
      estimatedWinRate: winRate,
      // 评分：种子数 × (1-botScore) × (winRate+0.3)
      score: seedCount * (1 - botScore) * (winRate + 0.3),
    });
  }
  
  // 按分数排序
  candidates.sort((a, b) => b.score - a.score);
  
  log('INFO', `🔬 交叉验证完成: ${candidates.length} 个候选聪明钱`);
  for (const c of candidates.slice(0, 20)) {
    log('INFO', `  ${c.wallet.slice(0, 20)}... | ${c.chain} | ${c.seedCount}币 [${c.seedSymbols.join(',')}] | Score:${c.score.toFixed(2)} | Bot:${(c.botScore*100).toFixed(0)}% | WR:${(c.estimatedWinRate*100).toFixed(0)}%`);
  }
  
  saveJSON(SMART_MONEY_FILE, {
    updatedAt: new Date().toISOString(),
    criteria: SMART_MONEY_CRITERIA,
    smartMoney: candidates,
  });
  
  return candidates;
}

// ============================================================
// Main
// ============================================================
async function main() {
  log('INFO', '🚀 Smart Money Scanner v6 启动');
  log('INFO', `Helius Keys: ${HELIUS_KEYS.length}, EVM RPCs: ${Object.keys(EVM_RPCS).join(',')}`);
  
  const mode = process.argv[2] || 'full';
  
  if (mode === 'seeds' || mode === 'full') {
    // Phase 1: 获取种子币
    const seeds = await fetchSeeds();
    log('INFO', `\n种子币总计: ${seeds.length}`);
    
    if (mode === 'seeds') {
      log('INFO', '仅种子模式，完成');
      return;
    }
    
    // Phase 2: 挖掘早期买家
    const seedBuyers = await mineWallets(seeds);
    
    // Phase 3: 交叉验证
    const smartMoney = crossValidate(seedBuyers);
    
    log('INFO', `\n✅ 完成！种子: ${seeds.length}, 聪明钱: ${smartMoney.length}`);
  } else if (mode === 'mine') {
    // 只挖掘（用已有种子）
    const seedData = loadJSON(SEEDS_FILE, { seeds: [] });
    const seedBuyers = await mineWallets(seedData.seeds);
    const smartMoney = crossValidate(seedBuyers);
    log('INFO', `\n✅ 完成！聪明钱: ${smartMoney.length}`);
  } else {
    log('INFO', `用法: node smart_money_v6.js [full|seeds|mine]`);
  }
}

main().catch(e => {
  log('ERROR', `致命错误: ${e.message}`);
  console.error(e);
  process.exit(1);
});
