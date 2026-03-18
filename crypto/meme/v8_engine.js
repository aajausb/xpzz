#!/usr/bin/env node
/**
 * v8 跟单引擎
 * 
 * 数据层: 币安PnL Rank → 验证(合约/空地址) → WR≥60%筛选 → 动态排名
 * 监控层: SOL WebSocket(毫秒) + BSC/Base轮询(5s)
 * 过滤层: 多钱包确认(≥2) + 合约审计 + 流动性检查
 * 交易层: OKX聚合器 + 私有RPC防夹 + 跟卖止损
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { ethers } = require('ethers');
// ============ CONFIG ============
const CONFIG = {
  // 数据刷新
  rankRefreshInterval: 4 * 3600 * 1000,  // 4小时刷新币安排名
  // 不限数量，验证通过的全部跟踪，排名只决定优先级
  hunterMinWinRate: 60,                     // 猎手: 胜率≥60%
  scoutMinWinRate: 50,                      // 哨兵: 胜率50-65%
  // <50% = 观察(watcher)，30天没涨回50%就踢
  watcherEvictDays: 30,                     // 观察期30天

  // 监控
  
  // 过滤
  minSmartMoneyConfirm: 2,                 // 至少2个钱包确认才跟
  confirmWindowMs: 72 * 60 * 60 * 1000,          // 72小时确认窗口
  minMarketCap: 10000,                     // 最低市值$10K，太小的流动性差买卖滑点大
  maxMarketCap: 50000000,                  // 最高市值$50M，过滤CAKE/BNB等大币
  
  // 交易 — 动态仓位(余额×百分比): TOP10=20% TOP30=15% 其他=10% min$5 max$200
  maxPositions: 999,
  maxPerChain: 999,
  
  // 止损/止盈
  sellThreshold: 0.5,                      // SM卖出比例≥50%才触发跟卖
};

// ============ PATHS ============
const DATA_DIR = path.join(__dirname, 'data', 'v8');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');  // 排名快照（展示用）
const WALLET_DB_FILE = path.join(DATA_DIR, 'wallet_db.json');   // 钱包库（持久化）
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const AUDIT_CACHE_FILE = path.join(DATA_DIR, 'audit_cache.json');
const BOUGHT_TOKENS_FILE = path.join(DATA_DIR, 'bought_tokens.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ STATE ============
let walletDb = {};         // 钱包库 { "addr_chain": { address, chain, pnl, winRate, tokens, ... } }
let rankedWallets = [];    // 排名后的钱包列表（从walletDb生成）
let positions = {};        // tokenAddress -> position
let pendingSignals = {};   // tokenAddress -> [{wallet, chain, timestamp}]
let boughtTokens = new Set(); // 已买过的token（防重复）
const lowBalNotified = {};    // 低余额通知去重（chain → timestamp）
// 稳定币/大币过滤（symbol级别，不走审计直接跳过）
const SKIP_SYMBOLS = new Set(['USDT','USDC','BUSD','DAI','TUSD','FDUSD','USD1','WBNB','WETH','WBTC','CBBTC','CBETH','STETH','RETH','BNB','ETH','BTC','SOL','WSOL']);
let auditCache = {};

// Chain config
const CHAINS = {
  solana: { name: 'Solana', binanceId: 'CT_501', okxChainId: '501' },
  bsc:    { name: 'BSC',    binanceId: '56',     okxChainId: '56' },
  base:   { name: 'Base',   binanceId: '8453',   okxChainId: '8453' },
};

// SOL RPC: 三级fallback（QuickNode→官方→PublicNode）
const SOL_RPCS = [
  'https://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/',
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
let solRpcIdx = 0;
const solRpcCooldown = new Array(SOL_RPCS.length).fill(0);
function getSolRpc() {
  const now = Date.now();
  // 轮转：每次取下一个可用的RPC，均匀分散请求
  for (let i = 0; i < SOL_RPCS.length; i++) {
    const idx = (solRpcIdx + i) % SOL_RPCS.length;
    if (now >= solRpcCooldown[idx]) {
      solRpcIdx = (idx + 1) % SOL_RPCS.length; // 下次从下一个开始
      return SOL_RPCS[idx];
    }
  }
  return SOL_RPCS[SOL_RPCS.length - 1]; // 全挂用最后一个
}
function markSolRpcDown(url) {
  const idx = SOL_RPCS.indexOf(url);
  if (idx >= 0) {
    solRpcCooldown[idx] = Date.now() + 600000; // 10分钟冷却
    solRpcIdx = (idx + 1) % SOL_RPCS.length;
    log('WARN', `🔌 SOL RPC #${idx} 限速，切换到 #${solRpcIdx}`);
  }
}
const SOL_QN_RPC = SOL_RPCS[0];
const SOL_PUBLIC_RPC = SOL_RPCS[0]; // 兼容旧引用

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: process.env.OKX_API_KEY || '',
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '',
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || '',
};

const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');

// OKX DEX链ID和原生代币
const CHAIN_ID = { solana: '501', bsc: '56', base: '8453' };
const NATIVE = {
  solana: '11111111111111111111111111111111',  // OKX V6用原生SOL地址
  bsc: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  base: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
};

// OKX签名GET请求

// ============ UTILS ============
const log = (level, msg) => console.log(`${new Date().toLocaleTimeString('zh-CN')} [${level}] ${msg}`);

// DexScreener价格缓存（10秒有效，减少API调用）
const _dexCache = {};
async function dexScreenerGet(tokenAddr) {
  const cached = _dexCache[tokenAddr];
  if (cached && Date.now() - cached.time < 10000) return cached.data;
  const data = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`).catch(() => null);
  if (data) _dexCache[tokenAddr] = { data, time: Date.now() };
  // 清理过期缓存（防内存泄漏）
  const now = Date.now();
  for (const k in _dexCache) { if (now - _dexCache[k].time > 60000) delete _dexCache[k]; }
  return data;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const saveJSON = (file, data) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // rename是原子操作
};
const loadJSON = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };

function httpGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/2.0 (Skill)', ...headers }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP超时')); });
  });
}

function httpPost(url, body, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity',
                 'User-Agent': 'binance-web3/2.0 (Skill)', 'Content-Length': Buffer.byteLength(postData), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP超时')); });
    req.write(postData);
    req.end();
  });
}

async function rpcPost(url, method, params) {
  // SOL RPC自动fallback
  const isSol = SOL_RPCS.includes(url);
  const actualUrl = isSol ? getSolRpc() : url;
  const result = await httpPost(actualUrl, { jsonrpc: '2.0', id: 1, method, params });
  // 429或限额错误 → 标记down，换下一个重试
  if (isSol && result?.error && (result.error.code === -32003 || result.error.code === 429 || result.error.message?.includes('429'))) {
    markSolRpcDown(actualUrl);
    const fallbackUrl = getSolRpc();
    if (fallbackUrl !== actualUrl) {
      return httpPost(fallbackUrl, { jsonrpc: '2.0', id: 1, method, params });
    }
  }
  return result;
}

// ============ PHASE 1: 数据层 — 币安PnL Rank ============
async function fetchBinanceRank() {
  log('INFO', '📡 刷新币安PnL排名...');
  const allWallets = [];
  
  for (const [chainKey, chain] of Object.entries(CHAINS)) {
    for (const period of ['7d', '30d']) {
      for (let page = 1; page <= 4; page++) {
        try {
          const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${page}&chainId=${chain.binanceId}&pageSize=25&sortBy=0&orderBy=0&period=${period}`;
          const d = await httpGet(url);
          const wallets = d?.data?.data || [];
          for (const w of wallets) {
            allWallets.push({
              chain: chainKey,
              address: w.address,
              pnl: parseFloat(w.realizedPnl || 0),
              winRate: parseFloat(w.winRate || 0) * 100,
              tokens: w.totalTradedTokens || 0,
              txCount: w.totalTxCnt || 0,
              period,
              topTokens: (w.topEarningTokens || []).slice(0, 5),
              balance: parseFloat(w.balance || 0),
              lastActivity: w.lastActivity || 0,
            });
          }
          if (wallets.length < 25) break;
          await sleep(300);
        } catch(e) {
          log('WARN', `  ${chain.name} ${period} p${page} 失败: ${e.message}`);
        }
      }
    }
  }
  
  // 去重: 同地址同链优先用7d数据（更能反映近期表现）
  const unique = new Map();
  for (const w of allWallets) {
    const key = w.address + '_' + w.chain;
    if (!unique.has(key)) {
      unique.set(key, w);
    } else {
      const existing = unique.get(key);
      // 7d优先；都是同周期取PnL高的
      if (w.period === '7d' && existing.period !== '7d') {
        unique.set(key, w);
      } else if (w.period === existing.period && w.pnl > existing.pnl) {
        unique.set(key, w);
      }
    }
  }
  
  const wallets = [...unique.values()];
  log('INFO', `  📡 候选池: ${wallets.length} 个钱包`);
  return wallets;
}

async function verifyWallets(wallets) {
  log('INFO', '🔍 验证钱包真实性...');
  const verified = [];
  
  for (const w of wallets) {
    try {
      if (w.chain === 'solana') {
        const info = await rpcPost(getSolRpc(), 'getAccountInfo', [w.address, { encoding: 'jsonParsed' }]);
        const acct = info.result?.value;
        if (!acct) continue; // 账户不存在
        const bal = (acct.lamports || 0) / 1e9;
        // 排除程序账户（executable=true）和非System Program owner的程序
        if (acct.executable) continue;
        if (bal > 0) { w.verifiedBal = bal; verified.push(w); }
      } else {
        const provider = w.chain === 'bsc' ? bscProvider : baseProvider;
        const [code, txCount] = await Promise.all([
          provider.getCode(w.address),
          provider.getTransactionCount(w.address)
        ]);
        if (code === '0x' && txCount > 0) { w.verifiedTx = txCount; verified.push(w); }
      }
    } catch(e) {}
    await sleep(80);
  }
  
  log('INFO', `  验证通过: ${verified.length}/${wallets.length}`);
  return verified;
}

// 合并验证通过的钱包到钱包库
function mergeToWalletDb(verifiedWallets) {
  const now = Date.now();
  const seenKeys = new Set();
  
  // 更新/新增
  for (const w of verifiedWallets) {
    const key = w.address + '_' + w.chain;
    seenKeys.add(key);
    
    if (walletDb[key]) {
      // 已有 → 更新lastSeen + 核心数据（winRate/pnl/tokens可能变化）
      walletDb[key].lastSeen = now;
      walletDb[key].missCount = 0;
      // 更新胜率和PnL（币安排名每次刷新数据不同）
      if (w.winRate !== undefined) walletDb[key].winRate = w.winRate;
      if (w.pnl !== undefined) walletDb[key].pnl = w.pnl;
      if (w.tokens !== undefined) walletDb[key].tokens = w.tokens;
      if (w.txCount !== undefined) walletDb[key].txCount = w.txCount;
    } else {
      // 新钱包 → 入库
      walletDb[key] = {
        ...w,
        addedAt: now,
        lastSeen: now,
        missCount: 0,
      };
    }
  }
  
  // winRate更新后由rankWallets统一处理status，这里不做降级
  
  const totalBefore = Object.keys(walletDb).length;
  saveJSON(WALLET_DB_FILE, walletDb);
  const total = Object.keys(walletDb).length;
  log('INFO', `📦 钱包库: ${total}个 (本轮验证${seenKeys.size}个)`);
  
  return Object.values(walletDb);
}

function rankWallets(wallets) {
  // 综合评分: 胜率 × 样本量 × 盈利能力 × 活跃度
  const now = Date.now();
  for (const w of wallets) {
    const wr = (w.winRate || 0) / 100;                        // 0~1
    const sampleWeight = Math.log2((w.tokens || 1) + 1);      // 交易币数，log防大户碾压
    const pnlWeight = Math.log10(Math.max(w.pnl, 1) + 1);    // PnL取log
    const age = now - (w.lastSeen || w.lastActivity || 0);
    const activityMul = age < 7 * 86400000 ? 1.5              // 7天内活跃
                      : age < 30 * 86400000 ? 1.2             // 30天内
                      : 1.0;
    w.score = wr * sampleWeight * pnlWeight * activityMul;
    
    // 三级状态: ≥60%=hunter(猎手), 50-60%=scout(哨兵), <50%=watcher(观察)
    const winRate = w.winRate || 0;
    const key2 = w.address + '_' + w.chain;
    // 过时降级的钱包不自动升回（等重新出现在排名时lastSeen更新后才解锁）
    if (walletDb[key2]?._staleDemoted) {
      if (walletDb[key2].lastSeen && (Date.now() - walletDb[key2].lastSeen) < 48 * 3600000) {
        // 重新出现在排名了，解锁
        delete walletDb[key2]._staleDemoted;
      } else {
        // 还是过时的，不升级
        w.status = walletDb[key2].status || 'scout';
        // 跳过下面的分级
      }
    }
    if (!walletDb[key2]?._staleDemoted) {
      if (winRate >= CONFIG.hunterMinWinRate) {
        w.status = 'hunter';
      } else if (winRate >= CONFIG.scoutMinWinRate) {
        w.status = 'scout';
      } else {
        w.status = 'watcher';
        // 观察期：记录降级时间，超过30天没涨回50%就踢
        const key = w.address + '_' + w.chain;
        if (walletDb[key] && !walletDb[key].watcherSince) {
          walletDb[key].watcherSince = Date.now();
        }
      }
    }
  }
  // 按链独立排名（SOL/BSC/Base各自TOP10/TOP30）
  for (const chain of ['solana', 'bsc', 'base']) {
    const chainWallets = wallets.filter(w => w.chain === chain);
    chainWallets.sort((a, b) => b.score - a.score);
    chainWallets.forEach((w, i) => w.rank = i + 1);
  }
  
  // 持久化status/score/rank到walletDb + 观察期淘汰
  const evictKeys = [];
  for (const w of wallets) {
    const key = w.address + '_' + w.chain;
    if (walletDb[key]) {
      const oldStatus = walletDb[key].status;
      walletDb[key].status = w.status;
      walletDb[key].score = w.score;
      walletDb[key].rank = w.rank;
      // 升降级日志
      if (oldStatus && oldStatus !== w.status) {
        log('INFO', `📊 ${w.address.slice(0,10)}(${w.chain}) ${oldStatus}→${w.status} WR:${w.winRate?.toFixed(1)}%`);
      }
      // 脱离观察状态 → 清除watcherSince
      if (w.status !== 'watcher') {
        delete walletDb[key].watcherSince;
      }
      // 观察超过30天 → 踢出
      if (w.status === 'watcher' && walletDb[key].watcherSince) {
        const days = (Date.now() - walletDb[key].watcherSince) / (24 * 3600 * 1000);
        if (days >= CONFIG.watcherEvictDays) {
          log('INFO', `🗑 踢出观察钱包 ${w.address.slice(0,10)}...(${w.chain}) WR=${w.winRate}% 观察${Math.round(days)}天`);
          evictKeys.push(key);
        }
      }
    }
  }
  for (const k of evictKeys) delete walletDb[k];
  
  // 超过48小时不在币安排名的钱包，降级保护（数据可能过时）
  // 必须在rankWallets里做，不能在mergeToWalletDb里（会被覆盖）
  const STALE_HOURS = 48;
  const now2 = Date.now();
  for (const [key, dbw] of Object.entries(walletDb)) {
    if (dbw.lastSeen) {
      const hours = (now2 - dbw.lastSeen) / 3600000;
      if (hours >= STALE_HOURS && dbw.status === 'hunter' && !dbw._staleDemoted) {
        log('INFO', `📊 ${dbw.address?.slice(0,10)}(${dbw.chain}) hunter→scout (${Math.round(hours)}h未出现在排名)`);
        dbw.status = 'scout';
        dbw._staleDemoted = true;
      } else if (hours >= STALE_HOURS * 2 && dbw.status === 'scout') {
        log('INFO', `📊 ${dbw.address?.slice(0,10)}(${dbw.chain}) scout→watcher (${Math.round(hours)}h未出现在排名)`);
        dbw.status = 'watcher';
        if (!dbw.watcherSince) dbw.watcherSince = now2;
      }
    }
  }
  
  saveJSON(WALLET_DB_FILE, walletDb);
  
  return wallets;
}

// ============ PHASE 2: 监控层 — 直接盯链上交易 ============
let solWs = null;
let solWsRetries = 0;
const solWalletSet = new Set();
const bscWalletSet = new Set();
const baseWalletSet = new Set();

// 已知DEX Router地址（检测swap用）
const DEX_ROUTERS = {
  bsc: new Set([
    '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2
    '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', // PancakeSwap V3
    '0x1b81d678ffb9c0263ab9dfd4c89b4200bc0353d8', // PancakeSwap Universal
    '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2', // Four.meme Router
    '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // OKX DEX Router 1
    '0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc', // OKX DEX Router 2
    '0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6', // OKX DEX Router 3
  ]),
  base: new Set([
    '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // Aerodrome
    '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // OKX DEX Router 1
    '0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc', // OKX DEX Router 2
    '0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6', // OKX DEX Router 3
  ]),
};
// 所有链共用的合约/Router地址，不能当作SM钱包
const ALL_ROUTERS = new Set([
  ...DEX_ROUTERS.bsc, ...DEX_ROUTERS.base,
  // 我们自己的钱包也排除
  '0xe00ca1d766f329effc05e704499f10db1f14fd47',
  // SOL DEX Programs
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'BubdLnFR8AX7nXuJtEXwHa3xyX1G4ufx2FYSaJ8kSgVQ', // 我们的SOL钱包
]);

// 转仓追踪：SM转到小号 → 追踪小号
// { tokenAddr: { smWallet: { subWallet, time } } }
const transferTracker = {};

// 检查EVM最后一笔Transfer是转给Router(卖出)还是普通地址(转仓)
async function checkEvmTransferTarget(chain, tokenAddr, smWallet) {
  try {
    const provider = chain === 'bsc' ? bscProvider : baseProvider;
    const routers = DEX_ROUTERS[chain] || new Set();
    const latestBlock = await provider.getBlockNumber();
    // 查最近5000块的Transfer事件（~4小时BSC）
    const logs = await provider.getLogs({
      address: tokenAddr,
      topics: [TRANSFER_TOPIC, '0x000000000000000000000000' + smWallet.slice(2).toLowerCase()],
      fromBlock: Math.max(0, latestBlock - 5000),
      toBlock: latestBlock,
    });
    if (logs.length === 0) return { type: 'unknown' };
    const last = logs[logs.length - 1];
    const toAddr = '0x' + last.topics[2].slice(26).toLowerCase();
    if (routers.has(toAddr)) return { type: 'sell', to: toAddr };
    return { type: 'transfer', to: toAddr };
  } catch { return { type: 'unknown' }; }
}

// 检查SOL最后一笔交易是swap(卖出)还是transfer(转仓)
async function checkSolTransferTarget(tokenAddr, smWallet) {
  try {
    const sigs = await rpcPost(getSolRpc(), 'getSignaturesForAddress', [smWallet, { limit: 3 }]);
    if (!sigs?.result?.length) return { type: 'unknown' };
    for (const sig of sigs.result) {
      const tx = await rpcPost(getSolRpc(), 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx?.result) continue;
      const instructions = tx.result.transaction?.message?.instructions || [];
      // Jupiter/Raydium等DEX program常见ID
      const dexPrograms = new Set([
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
        'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
      ]);
      const isDex = instructions.some(i => dexPrograms.has(i.programId));
      if (isDex) return { type: 'sell', sig: sig.signature };
      // 查token transfer的目标地址
      const innerInstructions = tx.result.meta?.innerInstructions || [];
      for (const inner of innerInstructions) {
        for (const inst of (inner.instructions || [])) {
          if (inst.parsed?.type === 'transfer' && inst.parsed?.info?.source) {
            return { type: 'transfer', to: inst.parsed.info.destination };
          }
        }
      }
    }
    return { type: 'unknown' };
  } catch { return { type: 'unknown' }; }
}

// ERC20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const solLastSigs = new Map(); // wallet -> lastSignature

const SOL_WS_OFFICIAL = 'wss://api.mainnet-beta.solana.com'; // Solana官方WS（免费，限100订阅）
let solOfficialWs = null; // 单连接
let solWsMode = 'none'; // 'official' | 'polling'
const solWsSubscribedAddrs = new Set(); // WS已订阅的钱包（轮询时跳过）

function setupSolanaMonitor() {
  const solWallets = rankedWallets.filter(w => w.chain === 'solana');
  for (const w of solWallets) solWalletSet.add(w.address);
  
  if (solWalletSet.size === 0) return;
  
  // Solana官方WS最多100个订阅，猎手+哨兵优先，观察走轮询
  setupOfficialSolWs();
  
  
  // 兜底: 轮询（最慢但最稳）
  pollSolanaWallets();
}

// Solana官方WS: 最多100个订阅，猎手+哨兵优先
function setupOfficialSolWs() {
  // 按优先级排序: hunter > scout > watcher
  const priorityOrder = { hunter: 0, scout: 1, watcher: 2 };
  const sorted = rankedWallets
    .filter(w => w.chain === 'solana')
    .sort((a, b) => (priorityOrder[a.status] || 2) - (priorityOrder[b.status] || 2) || (a.rank || 999) - (b.rank || 999));
  const walletList = sorted.slice(0, 100).map(w => w.address); // 官方WS限100
  if (walletList.length === 0) return;
  solWsSubscribedAddrs.clear();
  for (const a of walletList) solWsSubscribedAddrs.add(a);
  
  const wsWalletCount = walletList.length;
  const pollOnly = [...solWalletSet].filter(a => !walletList.includes(a));
  log('INFO', `🔌 [SOL] 官方WS订阅${wsWalletCount}个(猎手+哨兵优先) + 轮询${pollOnly.length}个观察`);
  
  const ws = new WebSocket(SOL_WS_OFFICIAL);
  solOfficialWs = ws;
  let subscribed = 0;
  const idToAddr = {};
  
  ws.on('open', async () => {
    // Solana官方WS: 每批5个等1秒（稳定，30秒订完100个）
    for (let i = 0; i < walletList.length; i++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const addr = walletList[i];
      const id = i + 1;
      idToAddr[id] = addr;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id, method: 'logsSubscribe',
        params: [{ mentions: [addr] }, { commitment: 'confirmed' }]
      }));
      if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    }
  });
  
  const subIdToAddr = {};
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.id && msg.result !== undefined) {
        subscribed++;
        subIdToAddr[msg.result] = idToAddr[msg.id];
        if (subscribed === 1 || subscribed % 20 === 0 || subscribed === walletList.length) {
          log('INFO', `🔌 [SOL] 官方RPC ${subscribed}/${walletList.length} 已订阅`);
        }
        if (subscribed === walletList.length) solWsMode = 'official';
        return;
      }
      if (msg.id && msg.error) {
        log('WARN', `🔌 [SOL] 订阅失败 #${msg.id}: ${msg.error.message}`);
        return;
      }
      if (msg.params?.result) {
        const subId = msg.params.subscription;
        const addr = subIdToAddr[subId];
        const sig = msg.params.result.value?.signature;
        if (sig && addr && !msg.params.result.value?.err) {
          await parseSolSignature(addr, sig);
        }
      }
    } catch(e) {}
  });
  
  ws.on('close', () => {
    log('WARN', '🔌 [SOL] 官方WS断开，5秒后重连');
    solOfficialWs = null;
    solWsMode = 'polling';
    setTimeout(() => setupOfficialSolWs(), 5000);
  });
  
  ws.on('error', (e) => { if (e.message) log('WARN', `[SOL] WS错误: ${e.message.slice(0,40)}`); });
  
  // 活跃度检测：5分钟没收到任何消息→静默断连→主动重连
  let lastMsgTime = Date.now();
  const origOnMsg = ws.listeners('message')[0];
  if (origOnMsg) {
    ws.removeListener('message', origOnMsg);
    ws.on('message', (data) => { lastMsgTime = Date.now(); origOnMsg(data); });
  }
  
  const healthCheck = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(healthCheck); return; }
    ws.ping();
    // 5分钟无消息→判定静默断连
    if (Date.now() - lastMsgTime > 300000) {
      log('WARN', '🔌 [SOL] WS静默断连(5分钟无消息)，主动重连');
      clearInterval(healthCheck);
      try { ws.removeAllListeners(); ws.terminate(); } catch {}
      solOfficialWs = null;
      solWsMode = 'polling';
      setTimeout(() => setupOfficialSolWs(), 5000);
    }
  }, 30000);
}
// 公共RPC轮询: 每10秒查每个钱包最近1条签名，检测新交易
async function pollSolanaWallets() {
  log('INFO', `🔌 [SOL] 轮询模式启动 ${solWalletSet.size} 个钱包`);
  
  // 初始化: 记录每个钱包当前最新签名（失败重试3次，限速友好）
  for (const addr of solWalletSet) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const d = await rpcPost(getSolRpc(), 'getSignaturesForAddress', [addr, { limit: 1 }]);
        const sigs = d.result || [];
        if (sigs.length > 0) solLastSigs.set(addr, sigs[0].signature);
        break;
      } catch(e) { await sleep(1000 * (retry + 1)); }
    }
    await sleep(250); // QuickNode 15/s限速，留余量
  }
  log('INFO', `🔌 [SOL] 初始化完成, ${solLastSigs.size}/${solWalletSet.size} 钱包有历史签名`);
  
  while (true) {
    const interval = 15000;
    await sleep(interval);
    
    // 收集要轮询的钱包
    const pollAddrs = [];
    for (const addr of solWalletSet) {
      if (solOfficialWs && solWsSubscribedAddrs.has(addr)) {
        const w = rankedWallets.find(rw => rw.address === addr);
        if (w?.status !== 'hunter') continue;
      }
      pollAddrs.push(addr);
    }
    
    // 并行3个一批（3个RPC轮转，每个承担1个请求）
    const BATCH = 3;
    for (let i = 0; i < pollAddrs.length; i += BATCH) {
      const batch = pollAddrs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (addr) => {
        try {
          const lastSig = solLastSigs.get(addr);
          const params = lastSig ? [addr, { limit: 5, until: lastSig }] : [addr, { limit: 1 }];
          const d = await rpcPost(getSolRpc(), 'getSignaturesForAddress', params);
          const sigs = d.result || [];
          if (sigs.length === 0) return;
          solLastSigs.set(addr, sigs[0].signature);
          for (const sig of sigs) {
            if (sig.err) continue;
            await parseSolSignature(addr, sig.signature);
          }
        } catch(e) { if (e.message && !e.message.includes('429') && !e.message.includes('超时')) log('WARN', `SOL轮询 ${addr.slice(0,8)} 异常: ${e.message.slice(0,40)}`); }
      }));
      await sleep(150);
    }
  }
}

const _processedSigs = new Set(); // SOL签名去重（防WS重复推送）
async function parseSolSignature(walletAddr, signature) {
  if (_processedSigs.has(signature)) return;
  _processedSigs.add(signature);
  // 控制内存：超过5000条清理旧的一半
  if (_processedSigs.size > 5000) {
    const arr = [..._processedSigs];
    for (let i = 0; i < 2500; i++) _processedSigs.delete(arr[i]);
  }
  try {
    // 用QuickNode getTransaction解析swap（不依赖Helius）
    const txData = await rpcPost(getSolRpc(), 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const meta = txData.result?.meta;
    if (!meta || meta.err) return;
    
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    if (post.length === 0) return; // 没有token变动，不是swap
    
    const wallet = rankedWallets.find(w => w.address === walletAddr);
    const rank = wallet?.rank || 999;
    const WSOL = 'So11111111111111111111111111111111111111112';
    
    // 找钱包的token余额变化
    for (const p of post) {
      if (p.owner !== walletAddr) continue;
      if (p.mint === WSOL) continue;
      
      const preB = pre.find(x => x.accountIndex === p.accountIndex && x.mint === p.mint);
      const preAmt = parseFloat(preB?.uiTokenAmount?.uiAmount || 0);
      const postAmt = parseFloat(p?.uiTokenAmount?.uiAmount || 0);
      const diff = postAmt - preAmt;
      
      if (diff > 0) {
        // 买入: 余额增加
        log('INFO', `🔔 [SOL] swap检测! 钱包#${rank} ${walletAddr.slice(0,10)}... 买入 ${p.mint}`);
        await handleSignal({
          chain: 'solana',
          token: p.mint,
          symbol: '?',
          wallet: walletAddr,
          walletRank: rank,
          timestamp: Date.now(),
        });
      } else if (diff < 0 && positions[p.mint]) {
        // 卖出: 余额减少 + 我们持有该币
        // SOL不直接标sellTracker（可能是转仓），只打日志，让巡检查余额+区分转仓/卖出
        log('INFO', `📉 [SOL] 卖出信号! 钱包#${rank} ${walletAddr.slice(0,10)}... 减持 ${p.mint} (待巡检确认)`);
      }
    }
  } catch(e) {
    if (e.message && !e.message.includes('429')) log('WARN', `parseSolSig异常 ${walletAddr.slice(0,8)}: ${e.message.slice(0,50)}`);
  }
}

// 解析Solana swap交易 — 从tokenTransfers提取买入信号

// 跟踪聪明钱卖出 — 积累到阈值触发跟卖（持久化到positions）
const sellTracker = {}; // token -> [{wallet, time, source}]

// 启动时从positions恢复sellTracker和transferTracker
function restoreSellTracker() {
  for (const [token, pos] of Object.entries(positions)) {
    if (pos._sells && pos._sells.length > 0) {
      sellTracker[token] = pos._sells;
    }
    if (pos._transfers && Object.keys(pos._transfers).length > 0) {
      transferTracker[token] = pos._transfers;
    }
  }
  const sellTotal = Object.values(sellTracker).reduce((s, a) => s + a.length, 0);
  const transferTotal = Object.values(transferTracker).reduce((s, o) => s + Object.keys(o).length, 0);
  if (sellTotal > 0) log('INFO', `📦 恢复sellTracker: ${sellTotal}条卖出记录`);
  if (transferTotal > 0) log('INFO', `📦 恢复transferTracker: ${transferTotal}个转仓追踪`);
}

function saveSellTracker(token) {
  if (positions[token]) {
    positions[token]._sells = sellTracker[token] || [];
    if (transferTracker[token]) positions[token]._transfers = transferTracker[token];
    saveJSON(POSITIONS_FILE, positions);
  }
}

function saveTransferTracker(token) {
  if (positions[token]) {
    positions[token]._transfers = transferTracker[token] || {};
    saveJSON(POSITIONS_FILE, positions);
  }
}

function trackSmartMoneySell(token, wallet, ratio) {
  if (!sellTracker[token]) sellTracker[token] = [];
  if (sellTracker[token].some(s => s.wallet === wallet)) return; // 已记录
  sellTracker[token].push({ wallet, time: Date.now(), source: 'ws' });
  
  const uniqueSellers = new Set(sellTracker[token].map(s => s.wallet)).size;
  log('INFO', `⚠️ SM卖出追踪: ${token.slice(0,8)}... ${uniqueSellers}个钱包在卖`);
  saveSellTracker(token); // 持久化
}

// BSC/Base: WebSocket实时推送 — 订阅DEX Router的Transfer事件
const EVM_WS_ENDPOINTS = {
  bsc: ["wss://bsc.publicnode.com", "wss://bsc.drpc.org"],
  base: ["wss://base.publicnode.com", "wss://base.drpc.org"],
};
const evmWsIdx = { bsc: 0, base: 0 }; // 当前endpoint索引
const evmWsRetries = { bsc: 0, base: 0 };

const _evmWsRefs = {}; // 存WS引用，重连前关旧的
function setupEvmWebSocket(chainKey) {
  const chain = CHAINS[chainKey];
  const walletSet = chainKey === "bsc" ? bscWalletSet : baseWalletSet;
  const wallets = rankedWallets.filter(w => w.chain === chainKey);
  for (const w of wallets) walletSet.add(w.address.toLowerCase());
  
  if (walletSet.size === 0) return;
  
  const routers = DEX_ROUTERS[chainKey] || new Set();
  if (routers.size === 0) return;
  
  // 关闭所有旧WS连接
  if (_evmWsRefs[chainKey]) {
    const refs = Array.isArray(_evmWsRefs[chainKey]) ? _evmWsRefs[chainKey] : [_evmWsRefs[chainKey]];
    for (const ws of refs) { try { ws.removeAllListeners(); ws.terminate(); } catch {} }
  }
  
  // 按优先级排序：hunter > scout > watcher
  const sorted = [...walletSet].sort((a, b) => {
    const wa = rankedWallets.find(w => w.address?.toLowerCase() === a);
    const wb = rankedWallets.find(w => w.address?.toLowerCase() === b);
    const order = { hunter: 0, scout: 1, watcher: 2 };
    return (order[wa?.status] ?? 3) - (order[wb?.status] ?? 3);
  });
  
  // 拆分成多个连接，每个最多80个钱包(160个订阅)，留余量防截断
  const WALLETS_PER_WS = 80;
  const chunks = [];
  for (let i = 0; i < sorted.length; i += WALLETS_PER_WS) {
    chunks.push(sorted.slice(i, i + WALLETS_PER_WS));
  }
  
  const endpoints = EVM_WS_ENDPOINTS[chainKey];
  const wsConns = [];
  
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const wsUrl = endpoints[(evmWsIdx[chainKey] + ci) % endpoints.length];
    const ws = new WebSocket(wsUrl);
    wsConns.push(ws);
    
    ws.on("open", () => {
      let subId = 1;
      for (const walletAddr of chunk) {
        const paddedWallet = ethers.zeroPadValue(walletAddr, 32);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: subId++, method: "eth_subscribe", params: ["logs", { topics: [TRANSFER_TOPIC, null, paddedWallet] }] }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: subId++, method: "eth_subscribe", params: ["logs", { topics: [TRANSFER_TOPIC, paddedWallet] }] }));
      }
      if (ci === 0) evmWsRetries[chainKey] = 0;
      const hunterCount = chunk.filter(a => { const w = rankedWallets.find(rw => rw.address?.toLowerCase() === a); return w?.status === 'hunter'; }).length;
      log("INFO", `🔌 [${chain.name}] WS#${ci+1}/${chunks.length} 订阅${chunk.length}个(猎手${hunterCount}) ${subId-1}个订阅`);
    });
    
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id && msg.result) return;
        if (msg.params?.result) {
          const logEntry = msg.params.result;
          const fromAddr = "0x" + logEntry.topics[1].slice(26).toLowerCase();
          const toAddr = "0x" + logEntry.topics[2].slice(26).toLowerCase();
          const tokenAddr = logEntry.address.toLowerCase();
          const nativeTokens = new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0x4200000000000000000000000000000000000006','0x55d398326f99059ff775485246999027b3197955','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
          if (walletSet.has(toAddr) && !walletSet.has(fromAddr) && !nativeTokens.has(tokenAddr)) {
            if (boughtTokens.has(tokenAddr)) return;
            const wallet = rankedWallets.find(w => w.address?.toLowerCase() === toAddr);
            const rank = wallet?.rank || 999;
            log("INFO", "🔔 [" + chain.name + "] 买入! 钱包#" + rank + " " + toAddr.slice(0,10) + "... 获得 " + tokenAddr);
            await handleSignal({ chain: chainKey, token: tokenAddr, symbol: "?", wallet: toAddr, walletRank: rank, timestamp: Date.now() });
          }
          if (walletSet.has(fromAddr) && !walletSet.has(toAddr)) {
            if (positions[tokenAddr]) {
              const txHash = logEntry.transactionHash;
              if (txHash) { verifyEvmSell(chainKey, txHash, fromAddr, tokenAddr).catch(() => {}); }
            }
          }
        }
      } catch(e) { if (e.message) log('WARN', `EVM WS消息处理异常(${chainKey}#${ci+1}): ${e.message.slice(0,50)}`); }
    });
    
    ws.on("close", () => {
      evmWsRetries[chainKey] = (evmWsRetries[chainKey] || 0) + 1;
      evmWsIdx[chainKey] = (evmWsIdx[chainKey] + 1) % endpoints.length;
      const delay = Math.min(2000 * Math.ceil(evmWsRetries[chainKey] / endpoints.length), 30000);
      const nextUrl = endpoints[evmWsIdx[chainKey] % endpoints.length].replace('wss://','');
      if (evmWsRetries[chainKey] <= 5) log("WARN", `🔌 [${chain.name}] WS#${ci+1} 断开，${delay/1000}秒后重连`);
      // 任何一个连接断了都全部重连（防抖：100ms内只触发一次）
      if (!setupEvmWebSocket._reconnectTimer?.[chainKey]) {
        if (!setupEvmWebSocket._reconnectTimer) setupEvmWebSocket._reconnectTimer = {};
        setupEvmWebSocket._reconnectTimer[chainKey] = setTimeout(() => {
          delete setupEvmWebSocket._reconnectTimer[chainKey];
          setupEvmWebSocket(chainKey);
        }, delay);
      }
    });
    
    ws.on("error", (e) => { if (e.message) log('WARN', `[${chain.name}] WS#${ci+1}错误: ${e.message.slice(0,40)}`); });
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); else clearInterval(ping); }, 30000);
  }
  
  _evmWsRefs[chainKey] = wsConns;
  log("INFO", `🔌 [${chain.name}] 共${chunks.length}个WS连接 覆盖全部${sorted.length}个钱包`);
}
// EVM猎手轮询兜底：WS可能静默丢事件，对top猎手每60秒查最近区块的Transfer
const _evmPollLastBlock = { bsc: 0, base: 0 };
async function pollEvmHunters() {
  await sleep(30000); // 等WS先连上
  log('INFO', '🔌 [EVM] 猎手轮询兜底启动');
  while (true) {
    for (const chainKey of ['bsc', 'base']) {
      try {
        // 轮询用drpc（binance dataseed对getLogs限速严重）
        const pollProvider = chainKey === 'bsc' 
          ? new ethers.JsonRpcProvider('https://bsc.drpc.org')
          : new ethers.JsonRpcProvider('https://base.drpc.org');
        const currentBlock = await pollProvider.getBlockNumber();
        if (!_evmPollLastBlock[chainKey]) _evmPollLastBlock[chainKey] = currentBlock;
        const fromBlock = _evmPollLastBlock[chainKey] + 1;
        if (fromBlock > currentBlock) continue;
        // 不提前更新lastBlock，等全部查完再更新（防止getLogs失败导致区间跳过）
        
        // 只查猎手
        const hunters = rankedWallets.filter(w => w.chain === chainKey && w.status === 'hunter');
        if (hunters.length === 0) continue;
        
        const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const nativeTokens = new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0x4200000000000000000000000000000000000006','0x55d398326f99059ff775485246999027b3197955','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
        
        // 串行查猎手（drpc限速，2个一批）
        const BATCH = 2;
        for (let i = 0; i < hunters.length; i += BATCH) {
          const batch = hunters.slice(i, i + BATCH);
          await Promise.all(batch.map(async (h) => {
            try {
              const padded = ethers.zeroPadValue(h.address.toLowerCase(), 32);
              const logs = await pollProvider.getLogs({ fromBlock, toBlock: currentBlock, topics: [TRANSFER_TOPIC, null, padded] });
              for (const l of logs) {
                const tokenAddr = l.address.toLowerCase();
                if (nativeTokens.has(tokenAddr)) continue;
                const fromAddr = '0x' + l.topics[1].slice(26).toLowerCase();
                const walletSet = chainKey === 'bsc' ? bscWalletSet : baseWalletSet;
                if (walletSet.has(fromAddr)) continue;
                if (boughtTokens.has(tokenAddr)) continue;
                const chain = CHAINS[chainKey];
                log('INFO', '🔔 [' + chain.name + '] 轮询检测! 猎手#' + h.rank + ' ' + h.address.slice(0,10) + '... 获得 ' + tokenAddr);
                await handleSignal({ chain: chainKey, token: tokenAddr, symbol: '?', wallet: h.address.toLowerCase(), walletRank: h.rank, timestamp: Date.now() });
              }
            } catch(e) { if(e.message && !e.message.includes('rate limit')) log('WARN', `EVM轮询猎手${h.rank}异常: ${e.message.slice(0,40)}`); }
          }));
          await sleep(200);
        }
        // 全部猎手查完才更新lastBlock
        _evmPollLastBlock[chainKey] = currentBlock;
      } catch(e) { if(e.message) log('WARN', `EVM轮询异常(${chainKey}): ${e.message.slice(0,40)}`); }
      // 查完这条链才更新lastBlock
      if (_evmPollLastBlock[chainKey + '_pending']) {
        _evmPollLastBlock[chainKey] = _evmPollLastBlock[chainKey + '_pending'];
        delete _evmPollLastBlock[chainKey + '_pending'];
      }
    }
    await sleep(15000); // 15秒一轮
  }
}

// 验证EVM卖出：查交易receipt，看有没有native token流入钱包（swap的标志）
async function verifyEvmSell(chainKey, txHash, walletAddr, tokenAddr) {
  const chain = CHAINS[chainKey];
  const provider = chainKey === 'bsc' ? bscProvider : baseProvider;
  
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return;
    
    // 检查同一笔交易的所有logs
    // swap特征: 有WBNB/WETH的Transfer to=钱包（卖token换到了native）
    // 检查swap特征：native/稳定币流入SM钱包
    const swapTokens = new Set([
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
      '0x4200000000000000000000000000000000000006', // WETH(Base)
      '0x55d398326f99059ff775485246999027b3197955', // USDT(BSC)
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC(Base)
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC(BSC)
    ]);
    
    let isSwap = false;
    for (const lg of receipt.logs) {
      if (swapTokens.has(lg.address.toLowerCase()) &&
          lg.topics[0] === TRANSFER_TOPIC &&
          lg.topics.length >= 3) {
        const toAddr = '0x' + lg.topics[2].slice(26).toLowerCase();
        if (toAddr === walletAddr.toLowerCase()) {
          isSwap = true;
          break;
        }
      }
    }
    
    if (isSwap) {
      const wallet = rankedWallets.find(w => w.address?.toLowerCase() === walletAddr.toLowerCase());
      const rank = wallet?.rank || 999;
      log('INFO', `📉 [${chain.name}] 确认卖出! 钱包#${rank} ${walletAddr.slice(0,8)}... swap卖出 ${tokenAddr.slice(0,8)}...`);
      trackSmartMoneySell(tokenAddr, walletAddr.toLowerCase(), 1.0);
    } else {
      // 转仓：把目标地址加入监控（可能是SM的小号）
      for (const lg of receipt.logs) {
        if (lg.address.toLowerCase() === tokenAddr.toLowerCase() &&
            lg.topics[0] === TRANSFER_TOPIC &&
            lg.topics.length >= 3) {
          const from = '0x' + lg.topics[1].slice(26).toLowerCase();
          const to = '0x' + lg.topics[2].slice(26).toLowerCase();
          if (from === walletAddr.toLowerCase() && to !== walletAddr.toLowerCase() && !ALL_ROUTERS.has(to)) {
            // 把转仓目标加入confirmWallets、walletSet和transferTracker（排除Router/合约地址）
            const pos = positions[tokenAddr];
            if (pos && pos.confirmWallets && !pos.confirmWallets.includes(to)) {
              pos.confirmWallets.push(to);
              const ws = chainKey === 'bsc' ? bscWalletSet : baseWalletSet;
              ws.add(to);
              if (!transferTracker[tokenAddr]) transferTracker[tokenAddr] = {};
              transferTracker[tokenAddr][walletAddr.toLowerCase()] = { subWallet: to, time: Date.now() };
              saveTransferTracker(tokenAddr);
              saveJSON(POSITIONS_FILE, positions);
              log('INFO', `🔄 [${chain.name}] 转仓 ${walletAddr.slice(0,8)}→${to.slice(0,8)} 已加入跟踪`);
            }
            break;
          }
        }
      }
    }
  } catch(e) {}
}

// ============ PHASE 3: 过滤层 ============
async function handleSignal(signal) {
  const { chain, wallet, walletRank } = signal;
  // EVM地址统一小写，SOL保持原样（base58区分大小写）
  const token = chain === 'solana' ? signal.token : signal.token.toLowerCase();
  
  // 已持仓 → 不买但把新SM加入confirmWallets（跟卖追踪，上限20个防巡检爆炸）
  if (positions[token]) {
    const pos = positions[token];
    const walletLower = chain === 'solana' ? wallet : wallet.toLowerCase();
    if (pos.confirmWallets && !pos.confirmWallets.includes(wallet) && pos.confirmWallets.length < 20
        && !ALL_ROUTERS.has(walletLower)) {
      pos.confirmWallets.push(wallet);
      saveJSON(POSITIONS_FILE, positions);
      log('INFO', `📎 ${pos.symbol}(${chain}) 新增SM跟踪: ${wallet.slice(0,10)} (共${pos.confirmWallets.length}个)`);
    }
    return;
  }
  if (boughtTokens.has(token)) return;
  if (Object.keys(positions).length >= CONFIG.maxPositions) return;
  
  const chainPositions = Object.values(positions).filter(p => p.chain === chain).length;
  if (chainPositions >= CONFIG.maxPerChain) return;
  
  // 检查钱包状态: watch的只记录不算确认
  const walletLower = wallet.toLowerCase();
  const walletInfo = rankedWallets.find(w => w.address === wallet || w.address?.toLowerCase() === walletLower);
  const walletStatus = walletInfo?.status || 'watcher';
  
  // 多钱包确认 — 每个钱包只算1次，5分钟窗口
  if (!pendingSignals[token]) pendingSignals[token] = [];
  
  // 同一钱包不重复计数
  const alreadyCounted = pendingSignals[token].some(s => s.wallet === wallet);
  if (!alreadyCounted) {
    pendingSignals[token].push({ ...signal, walletStatus });
  }
  
  // 清理过期信号（60分钟窗口）
  const now = Date.now();
  pendingSignals[token] = pendingSignals[token].filter(s => now - s.timestamp < CONFIG.confirmWindowMs);
  // 过期后清空的key直接删除（防内存泄漏）
  if (pendingSignals[token].length === 0) { delete pendingSignals[token]; return; }
  
  // 三级计数: 猎手=确认, 哨兵=佐证, 观察=只记录不算
  const activeSignals = pendingSignals[token].filter(s => s.walletStatus === "hunter");
  const watchSignals = pendingSignals[token].filter(s => s.walletStatus === 'scout');
  const watcherSignals = pendingSignals[token].filter(s => s.walletStatus === 'watcher');
  const confirmCount = new Set(activeSignals.map(s => s.wallet)).size;
  const watchCount = new Set(watchSignals.map(s => s.wallet)).size;
  const watcherCount = new Set(watcherSignals.map(s => s.wallet)).size;
  
  // 分级确认:
  // ≥2个猎手 → 买
  // 1个猎手 + ≥2个哨兵 → 买（哨兵当佐证）
  // 其他 → 等
  const confirmed = confirmCount >= 2 || (confirmCount >= 1 && watchCount >= 2);
  if (!confirmed) {
    const bestRank = Math.min(...pendingSignals[token].map(s => s.walletRank || 999));

    const extra = (watchCount > 0 ? ` +${watchCount}哨兵` : '') + (watcherCount > 0 ? ` +${watcherCount}观察` : '');
    log('INFO', `⏳ ${token}(${chain}) 确认中 猎手=${confirmCount} 哨兵=${watchCount}${extra} 最高#${bestRank}`);
    return;
  }
  
  // 同名币去重：持仓中→拒绝；清仓后1小时冷却期内也拒绝
  let earlyDexData = null;
  try { earlyDexData = await dexScreenerGet(token); } catch {}
  const earlySymbol = earlyDexData?.pairs?.[0]?.baseToken?.symbol || '?';
  if (earlySymbol !== '?') {
    const symKey = earlySymbol.toUpperCase() + '_' + chain;
    // 检查1: 当前持仓有同名
    const sameNameHeld = Object.values(positions).some(p => 
      p.symbol && p.symbol.toUpperCase() === earlySymbol.toUpperCase() && p.chain === chain
    );
    if (sameNameHeld) {
      log('INFO', `🚫 ${earlySymbol}(${chain}) 已持有同名币，跳过`);
      return;
    }
    // 检查2: 清仓后1小时冷却
    if (!handleSignal._symbolCooldown) handleSignal._symbolCooldown = {};
    const cooldownUntil = handleSignal._symbolCooldown[symKey] || 0;
    if (Date.now() < cooldownUntil) {
      const minLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
      log('INFO', `🚫 ${earlySymbol}(${chain}) 同名冷却中(${minLeft}分钟后解除)，跳过`);
      return;
    }
  }

  // SM频率降权：1小时内买>5个不同币的SM临时降为观察（撒网型打法）
  if (!handleSignal._smBuyFreq) handleSignal._smBuyFreq = {};
  const smNow = Date.now();
  for (const sig of [...activeSignals, ...watchSignals]) {
    if (!handleSignal._smBuyFreq[sig.wallet]) handleSignal._smBuyFreq[sig.wallet] = [];
    // 记录这个SM买了这个token（去重）
    const existing = handleSignal._smBuyFreq[sig.wallet];
    if (!existing.some(r => r.token === token)) {
      existing.push({ token, time: smNow });
    }
    // 清理1小时前的记录
    handleSignal._smBuyFreq[sig.wallet] = existing.filter(r => smNow - r.time < 3600000);
  }
  // 过滤掉撒网SM（1小时内买>5个不同币）
  const nonSpamHunters = activeSignals.filter(s => {
    const freq = (handleSignal._smBuyFreq[s.wallet] || []).length;
    if (freq > 5) { log('INFO', `⚡ ${s.wallet.slice(0,10)} 1h内买${freq}个币，降权(撒网)`); return false; }
    return true;
  });
  const nonSpamScouts = watchSignals.filter(s => {
    const freq = (handleSignal._smBuyFreq[s.wallet] || []).length;
    return freq <= 5;
  });
  const filteredConfirmCount = new Set(nonSpamHunters.map(s => s.wallet)).size;
  const filteredWatchCount = new Set(nonSpamScouts.map(s => s.wallet)).size;
  const stillConfirmed = filteredConfirmCount >= 2 || (filteredConfirmCount >= 1 && filteredWatchCount >= 2);
  if (!stillConfirmed) {
    log('INFO', `🚫 ${token.slice(0,10)}(${chain}) 过滤撒网SM后不达标: 猎手=${filteredConfirmCount} 哨兵=${filteredWatchCount}`);
    return;
  }

  // 验证SM真实持仓（过滤空投/撒币：持仓<$1的不算有效确认）
  const MIN_SM_HOLDING_USD = 1; // SM至少持有$1才算有效
  let realHunters = 0, realScouts = 0;
  const realConfirmWallets = [];
  let dexData = null;
  try {
    dexData = await dexScreenerGet(token);
    const price = parseFloat(dexData?.pairs?.[0]?.priceUsd || 0);
    if (price > 0) {
      // 用降权过滤后的SM列表（不是原始activeSignals）
      const allSigs = [...nonSpamHunters, ...nonSpamScouts];
      const results = await Promise.all(allSigs.map(async (sig) => {
        try {
          let holdingUsd = 0;
          if (chain === 'solana') {
            const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
              sig.wallet, { mint: token }, { encoding: 'jsonParsed' }
            ]);
            const bal = (balData.result?.value || []).reduce((s, a) =>
              s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
            holdingUsd = bal * price;
          } else {
            const { ethers } = require('ethers');
            const provider = chain === 'bsc' ? bscProvider : baseProvider;
            const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
            const [bal, dec] = await Promise.all([erc20.balanceOf(sig.wallet), erc20.decimals()]);
            holdingUsd = parseFloat(ethers.formatUnits(bal, dec)) * price;
          }
          return { sig, holdingUsd };
        } catch { return { sig, holdingUsd: -1 }; } // -1=查询失败，算有效
      }));
      for (const { sig, holdingUsd } of results) {
        if (holdingUsd < 0 || holdingUsd >= MIN_SM_HOLDING_USD) {
          realConfirmWallets.push(sig.wallet);
          if (sig.walletStatus === 'hunter') realHunters++;
          else realScouts++;
          if (holdingUsd < 0) log('WARN', `查SM ${sig.wallet.slice(0,10)} 余额失败，默认算有效`);
        } else {
          log('INFO', `🚫 ${sig.wallet.slice(0,10)} 持仓$${holdingUsd.toFixed(2)}<$${MIN_SM_HOLDING_USD}，不算确认`);
        }
      }
    } else {
      // 查不到价格→不过滤，用降权后的列表
      realHunters = filteredConfirmCount;
      realScouts = filteredWatchCount;
      for (const sig of [...nonSpamHunters, ...nonSpamScouts]) realConfirmWallets.push(sig.wallet);
    }
  } catch {
    realHunters = filteredConfirmCount;
    realScouts = filteredWatchCount;
    for (const sig of [...nonSpamHunters, ...nonSpamScouts]) realConfirmWallets.push(sig.wallet);
  }
  
  // 重新检查确认门槛（过滤空投后）
  const realConfirmed = realHunters >= 2 || (realHunters >= 1 && realScouts >= 2);
  if (!realConfirmed) {
    log('INFO', `🚫 ${token.slice(0,10)}(${chain}) 过滤空投后不达标: 真实猎手=${realHunters} 哨兵=${realScouts}`);
    return;
  }
  
  // Bug fix: 审计锁（防同一token并发审计+买入）
  if (!handleSignal._auditLock) handleSignal._auditLock = new Set();
  if (handleSignal._auditLock.has(token)) { log('INFO', `${token.slice(0,10)} 审计进行中，跳过`); return; }
  handleSignal._auditLock.add(token);
  try {
  
  // symbol复用空投验证时已查的DexScreener数据（省API调用）
  let symbol = dexData?.pairs?.[0]?.baseToken?.symbol || '?';
  
  // Bug fix: symbol为?时尝试从合约查name
  if (symbol === '?' && chain !== 'solana') {
    try {
      const provider = chain === 'bsc' ? bscProvider : baseProvider;
      const erc20 = new ethers.Contract(token, ['function symbol() view returns (string)'], provider);
      const onChainSymbol = await erc20.symbol();
      if (onChainSymbol) symbol = onChainSymbol;
    } catch {}
  }
  
  const audit = await auditToken(chain, token);
  
  // 稳定币/大币直接跳过
  if (SKIP_SYMBOLS.has(symbol.toUpperCase())) {
    log('INFO', `⏭️ ${symbol}(${chain}) 是稳定币/大币，跳过`);
    return;
  }
  
  if (!audit.safe) {
    log('WARN', `❌ ${symbol}(${chain}) 审计不通过: ${audit.reason}`);
    delete pendingSignals[token]; // 审计不过清掉，不重复查
    return;
  }
  
  // 通过审计 → 买入（用降权+空投过滤后的真实SM列表）
  const bestRank = realConfirmWallets.length > 0
    ? Math.min(...realConfirmWallets.map(addr => {
        const w = rankedWallets.find(rw => rw.address === addr || rw.address?.toLowerCase() === addr?.toLowerCase());
        return w?.rank || 999;
      }))
    : 999;
  const confirmWallets = [...new Set(realConfirmWallets)];
  log('INFO', `✅ ${symbol}(${chain}) 通过审计! 真实猎手=${realHunters} 哨兵=${realScouts} 最高#${bestRank}`);
  delete pendingSignals[token];
  // 提前标记boughtTokens（防另一个handleSignal并发通过检查→重复买入）
  if (boughtTokens.has(token)) { log('INFO', `${symbol} 已在买入中，跳过`); return; }
  boughtTokens.add(token);
  saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
  
  // Bug fix: 买入前再次检查SM是否还持有（防龙虾问题：SM已卖我们才买）
  try {
    const price = parseFloat(dexData?.pairs?.[0]?.priceUsd || 0);
    if (price > 0) {
      let stillHolding = 0;
      for (const smWallet of confirmWallets.slice(0, 5)) { // 最多查5个
        try {
          if (chain === 'solana') {
            const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [smWallet, { mint: token }, { encoding: 'jsonParsed' }]);
            const bal = (balData.result?.value || []).reduce((s, a) => s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
            if (bal * price >= 1) stillHolding++;
          } else {
            const provider = chain === 'bsc' ? bscProvider : baseProvider;
            const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
            const [bal, dec] = await Promise.all([erc20.balanceOf(smWallet), erc20.decimals()]);
            if (parseFloat(ethers.formatUnits(bal, dec)) * price >= 1) stillHolding++;
          }
        } catch { stillHolding++; } // 查询失败算持有
      }
      if (stillHolding === 0) {
        log('WARN', `🚫 ${symbol}(${chain}) SM已全部卖出，取消买入`);
        boughtTokens.delete(token);
        saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
        return;
      }
      log('INFO', `✅ ${symbol} SM仍持有(${stillHolding}/${Math.min(confirmWallets.length,5)})，执行买入`);
    }
  } catch(e) { log('WARN', `买前SM检查异常: ${e.message?.slice(0,40)}，继续买入`); }
  
  await executeBuy(chain, token, symbol, realHunters, confirmWallets);
  } finally { handleSignal._auditLock.delete(token); }
}

async function auditToken(chain, tokenAddress) {
  // 检查缓存（safe结果24小时过期，unsafe永久缓存）
  const cached = auditCache[tokenAddress];
  if (cached) {
    if (!cached.safe) return cached; // unsafe永久缓存
    if (cached._time && Date.now() - cached._time < 24 * 3600 * 1000) return cached; // safe 24h有效
    // 过期了，重新审计
  }
  
  // SOL暂无审计API，直接通过（靠确认门槛过滤）
  if (chain === 'solana') {
    const result = { safe: true, reason: 'SOL跳过审计', source: 'skip' };
    auditCache[tokenAddress] = result;
    return result;
  }

  // 币安审计
  try {
    const b = await auditBinance(chain, tokenAddress);
    const safe = !b.isHoneypot && b.sellTax <= 10 && b.riskLevel !== 'HIGH';
    const reasons = [];
    if (b.isHoneypot) reasons.push('蜜罐');
    if (b.sellTax > 10) reasons.push(`卖出税${b.sellTax}%`);
    if (b.riskLevel === 'HIGH') reasons.push('HIGH风险');
    
    const result = { safe, isHoneypot: b.isHoneypot, sellTax: b.sellTax, riskLevel: b.riskLevel, reason: safe ? 'OK' : reasons.join('+'), _time: Date.now() };
    auditCache[tokenAddress] = result;
    saveJSON(AUDIT_CACHE_FILE, auditCache);
    return result;
  } catch(e) {
    return { safe: false, reason: 'audit_failed_block' };
  }
}

async function auditBinance(chain, tokenAddress) {
  const chainId = CHAINS[chain].binanceId;
  const d = await httpPost(
    'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit',
    { binanceChainId: chainId, contractAddress: tokenAddress, requestId: `${Date.now()}` },
    { 'Content-Type': 'application/json' }
  );
  const audit = d?.data || {};
  let isHoneypot = false;
  for (const cat of (audit.riskItems || [])) {
    for (const detail of (cat.details || [])) {
      if (detail.isHit && detail.riskType === 'RISK' && detail.title?.includes('Honeypot')) isHoneypot = true;
    }
  }
  return {
    riskLevel: audit.riskLevelEnum || 'UNKNOWN',
    isHoneypot,
    sellTax: parseFloat(audit.extraInfo?.sellTax || 0),
  };
}
// 原生代币价格缓存（30秒有效）
const nativePriceCache = {};
const NATIVE_TOKENS = {
  solana: 'So11111111111111111111111111111111111111112',
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  base: '0x4200000000000000000000000000000000000006',
};
const NATIVE_SYMBOLS = { solana: 'SOL', bsc: 'WBNB', base: 'WETH' };
async function getNativePrice(chain) {
  const cached = nativePriceCache[chain];
  if (cached && Date.now() - cached.time < 30000) return cached.price;
  
  // CoinGecko优先（大币价格最准）
  const cgIds = { solana: 'solana', bsc: 'binancecoin', base: 'ethereum' };
  try {
    const cg = await httpGet(`https://api.coingecko.com/api/v3/simple/price?ids=${cgIds[chain]}&vs_currencies=usd`);
    const price = cg?.[cgIds[chain]]?.usd;
    if (price && price > 0) {
      nativePriceCache[chain] = { price, time: Date.now() };
      return price;
    }
  } catch {}
  
  // DexScreener fallback
  try {
    const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${NATIVE_TOKENS[chain]}`);
    const sym = NATIVE_SYMBOLS[chain];
    const pair = d?.pairs?.find(p => p.baseToken?.symbol === sym && parseFloat(p.priceUsd) > 1)
      || d?.pairs?.find(p => parseFloat(p.liquidity?.usd || 0) > 1000000)
      || d?.pairs?.[0];
    const price = parseFloat(pair?.priceUsd || 0);
    if (price > 0) nativePriceCache[chain] = { price, time: Date.now() };
    return price;
  } catch {}
  
  return cached?.price || 0;
}

// ============ PHASE 4: 交易层 ============
let buyLock = false;
async function executeBuy(chain, tokenAddress, symbol, confirmCount, confirmWallets = []) {
  // 并发锁 — 等前一个完成再执行（不丢信号）
  const maxWait = 30000; // 最多等30秒
  const start = Date.now();
  while (buyLock && Date.now() - start < maxWait) {
    await sleep(500);
  }
  if (buyLock) {
    log('WARN', `⏳ 买入锁等待超时，跳过 ${symbol}`);
    // 超时也要解锁boughtTokens
    if (boughtTokens.has(tokenAddress) && !positions[tokenAddress]) {
      boughtTokens.delete(tokenAddress);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
    }
    return;
  }
  buyLock = true;
  try {
    return await _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets);
  } finally {
    buyLock = false;
    // 兜底：如果买入没成功且没记录持仓→解锁boughtTokens
    if (boughtTokens.has(tokenAddress) && !positions[tokenAddress]) {
      boughtTokens.delete(tokenAddress);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
      log('INFO', `🔓 ${symbol} executeBuy结束无持仓，解锁boughtTokens`);
    }
  }
}

async function _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets) {
  // 二次检查持仓上限（防并发穿透）
  if (Object.keys(positions).length >= CONFIG.maxPositions) {
    log('WARN', `持仓已满(${CONFIG.maxPositions}个)，跳过 ${symbol}`);
    return;
  }
  // 动态仓位 — 按余额百分比 + 猎手排名加成
  let nativeAmount, size = 0;
  try {
    const price = await getNativePrice(chain);
    if (!price || isNaN(price) || price <= 0) throw new Error(`${chain}价格异常: ${price}`);
    
    // 查链上余额
    let balUsd = 0;
    if (chain === 'solana') {
      const balData = await rpcPost(getSolRpc(), 'getBalance', [require('./dex_trader.js').getWalletAddress('solana')]);
      balUsd = (balData.result?.value || 0) / 1e9 * price;
    } else {
      const { ethers } = require('ethers');
      const provider = chain === 'bsc' ? bscProvider : baseProvider;
      const bal = await provider.getBalance(require('./dex_trader.js').getWalletAddress('evm'));
      balUsd = parseFloat(ethers.formatEther(bal)) * price;
    }
    
    // 留10%给gas
    const available = balUsd * 0.9;
    if (available < 5) {
      log('WARN', `❌ ${chain}余额$${balUsd.toFixed(0)}太低，跳过 ${symbol}`);
      // 每条链10分钟内只通知一次
      const notifyKey = `lowbal_${chain}`;
      if (!lowBalNotified[notifyKey] || Date.now() - lowBalNotified[notifyKey] > 600000) {
        lowBalNotified[notifyKey] = Date.now();
        await notifyTelegram(`⚠️ ${chain}余额不足$${balUsd.toFixed(0)}，错过 ${symbol} 请充值！`);
      }
      return;
    }
    
    // 按猎手排名决定仓位百分比
    const bestRank = confirmWallets.length > 0 
      ? Math.min(...confirmWallets.map(addr => {
          const w = rankedWallets.find(rw => rw.address === addr || rw.address?.toLowerCase() === addr?.toLowerCase());
          return w ? w.rank : 999;
        }))
      : 999;
    
    // TOP10: 20%余额, TOP30: 15%, 其他: 10%
    let pct = 0.10;
    if (bestRank <= 10) pct = 0.20;
    else if (bestRank <= 30) pct = 0.15;
    
    size = Math.floor(available * pct);
    // 最低$5，最高$200
    size = Math.max(5, Math.min(200, size));
    
    if (chain === 'solana') {
      nativeAmount = Math.floor((size / price) * 1e9);
      log('INFO', `💰 买入 ${symbol}(${chain}) $${size} = ${(nativeAmount/1e9).toFixed(4)} SOL 猎手=${confirmCount}`);
    } else {
      const { ethers } = require('ethers');
      nativeAmount = ethers.parseEther((size / price).toFixed(18)).toString();
      const unit = chain === 'bsc' ? 'BNB' : 'ETH';
      log('INFO', `💰 买入 ${symbol}(${chain}) $${size} = ${(size/price).toFixed(6)} ${unit} 猎手=${confirmCount}`);
    }
  } catch(e) {
    log('ERROR', `价格转换失败 ${symbol}(${chain}): ${e.message}`);
    return;
  }
  
  const MAX_RETRIES = 3;
  let txSucceeded = false; // 交易已上链成功的标记
  let lastBuyError = ''; // 最后一次失败原因（区分临时/永久）
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    const trader = require('./dex_trader.js');
    if (txSucceeded) { log('INFO', `交易已成功但保存失败，不再重发交易`); break; }
    if (attempt > 1) log('INFO', `🔄 重试买入 ${symbol}(${chain}) 第${attempt}次...`);
    // 发交易前就标记已买，防止重启/崩溃后重复买
    if (!boughtTokens.has(tokenAddress)) {
      boughtTokens.add(tokenAddress);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
    }
    const result = await trader.buy(chain, tokenAddress, nativeAmount);
    
    // 有txHash说明交易已发送到链上，不管确认结果都不能重发
    if (result.txHash) txSucceeded = true;
    
    if (result.success) {
      // 查实际获得的token数量和价格
      let buyPrice = 0, buyAmount = 0;
      try {
        await sleep(3000); // 等链上确认
        const d = await dexScreenerGet(tokenAddress);
        buyPrice = parseFloat(d?.pairs?.[0]?.priceUsd || 0);
        
        if (chain === 'solana') {
          // 查token余额（三次重试不同RPC）
          for (let _try = 0; _try < 3 && buyAmount === 0; _try++) {
            try {
              if (_try > 0) await sleep(2000);
              const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
                require('./dex_trader.js').getWalletAddress('solana'),
                { mint: tokenAddress },
                { encoding: 'jsonParsed' }
              ]);
              const accts = balData.result?.value || [];
              for (const a of accts) {
                buyAmount += parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
              }
            } catch(e) { if (_try < 2) log('WARN', `查SOL余额第${_try+1}次失败: ${e.message?.slice(0,40)}`); }
          }
        } else {
          // EVM查ERC20余额
          const { ethers } = require('ethers');
          const provider = chain === 'bsc' ? bscProvider : baseProvider;
          const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
          const [bal, dec] = await Promise.all([erc20.balanceOf(require('./dex_trader.js').getWalletAddress('evm')), erc20.decimals()]);
          buyAmount = parseFloat(ethers.formatUnits(bal, dec));
        }
      } catch(e) {
        log('WARN', `查询买入详情失败: ${e.message}, 用估算值`);
        buyPrice = buyPrice || 0;
        buyAmount = buyAmount || (size / (buyPrice || 1));
      }
      
      positions[tokenAddress] = {
        chain,
        token: tokenAddress,
        symbol,
        buyPrice,
        buyAmount,
        buyAmountRaw: buyAmount, // 保存原始数量用于卖出
        buyCost: size,
        buyTime: Date.now(),
        confirmCount,
        confirmWallets, // 记录确认的SM钱包
      };
      boughtTokens.add(tokenAddress);
      saveJSON(POSITIONS_FILE, positions);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]); // 持久化防重启重复买
      
      // 把EVM token加入known_tokens（看板扫描用）
      if (chain !== 'solana') {
        const ktFile = path.join(DATA_DIR, 'known_tokens.json');
        try {
          const kt = JSON.parse(fs.readFileSync(ktFile, 'utf8'));
          if (!kt.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase())) {
            kt.push({ chain: chain, address: tokenAddress, symbol });
            saveJSON(ktFile, kt);
          }
        } catch { saveJSON(ktFile, [{ chain, address: tokenAddress, symbol }]); }
      }
      
      log('INFO', `✅ 买入成功 ${symbol} | $${size} | 数量=${buyAmount} | 价格=$${buyPrice} | tx: ${result.txHash || '?'}`);
      
      // 通知
      await notifyTelegram(`🟢 v8买入 ${symbol}(${chain})\n💰 $${size} | 猎手${confirmCount}+哨兵${confirmWallets.length - confirmCount}\n🔗 ${result.txHash || ''}`);
    } else if (result.error === 'SOL确认超时' && result.txHash) {
      // 交易已发送但确认超时→可能已上链，查余额确认
      log('WARN', `⚠️ ${symbol} 确认超时，查链上余额...`);
      await sleep(5000);
      let actualAmount = 0;
      try {
        const trader2 = require('./dex_trader.js');
        if (chain === 'solana') {
          const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
            trader2.getWalletAddress('solana'), { mint: tokenAddress }, { encoding: 'jsonParsed' }
          ]);
          for (const a of (balData.result?.value || [])) {
            actualAmount += parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
          }
        }
      } catch {}
      if (actualAmount > 0) {
        log('INFO', `✅ ${symbol} 确认超时但链上有余额(${actualAmount})，记录持仓`);
        const d = await dexScreenerGet(tokenAddress).catch(() => null);
        const buyPrice = parseFloat(d?.pairs?.[0]?.priceUsd || 0);
        positions[tokenAddress] = {
          chain, token: tokenAddress, symbol, buyPrice, buyAmount: actualAmount,
          buyAmountRaw: actualAmount, buyCost: size, buyTime: Date.now(),
          confirmCount, confirmWallets,
        };
        saveJSON(POSITIONS_FILE, positions);
        await notifyTelegram(`🟢 v8买入 ${symbol}(${chain}) [确认超时但成功]\n💰 $${size} | 猎手${confirmCount}\n🔗 ${result.txHash}`);
      } else {
        log('WARN', `❌ ${symbol} 确认超时且链上无余额，买入失败`);
      }
    } else {
      lastBuyError = result.error || 'unknown';
      log('WARN', `❌ 买入失败 ${symbol}: ${result.error}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // 递增等待
        continue;
      }
    }
    break; // 成功或最后一次失败，退出循环
  } catch(e) {
    lastBuyError = e.message || 'exception';
    log('ERROR', `买入异常 ${symbol}(第${attempt}次): ${e.message}`);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
  }
  } // end retry loop
  
  // 买入完全失败（3次重试+无链上余额）
  if (!txSucceeded && !positions[tokenAddress]) {
    // 区分错误类型：只有纯网络问题(timeout/429)临时跳过，其他全拉黑
    const lastErr = (lastBuyError || '').toLowerCase();
    const isNetworkOnly = (lastErr.includes('timeout') || lastErr.includes('429')) && !lastErr.includes('liquidity') && !lastErr.includes('revert');
    if (isNetworkOnly) {
      // 纯网络问题：解锁让下次SM信号可重新触发
      boughtTokens.delete(tokenAddress);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
      log('WARN', `⏳ ${symbol} 买入失败(网络:${lastErr.slice(0,30)})，临时跳过`);
    } else {
      // revert/无流动性/合约问题：永久拉黑
      auditCache[tokenAddress] = { safe: false, reason: 'buy_failed_3x', _time: Date.now() };
      saveJSON(AUDIT_CACHE_FILE, auditCache);
      log('WARN', `🚫 ${symbol} 买入3次全失败(${lastErr.slice(0,30)})，加入黑名单`);
    }
  }
}

const _sellLocks = new Set(); // 卖出锁（防同一token并发卖出）
async function executeSell(tokenAddress, reason, ratio = 1.0) {
  const pos = positions[tokenAddress];
  if (!pos) return;
  if (pos.unsellable) {
    // Bug fix: unsellable每30分钟重试一次（不永久放弃）
    const since = pos.unsellableSince || 0;
    if (Date.now() - since < 30 * 60 * 1000) return;
    log('INFO', `🔄 ${pos.symbol} unsellable已过30分钟，重试卖出...`);
    delete pos.unsellable;
    delete pos.unsellableReason;
    delete pos.unsellableSince;
  }
  if (_sellLocks.has(tokenAddress)) { log('INFO', `⏳ ${pos.symbol} 卖出中，跳过重复触发`); return; }
  _sellLocks.add(tokenAddress);
  try {
    await _executeSellInner(tokenAddress, pos, reason, ratio);
  } finally { _sellLocks.delete(tokenAddress); }
}
async function _executeSellInner(tokenAddress, pos, reason, ratio) {
  log('INFO', `💸 卖出 ${pos.symbol}(${pos.chain}) ${(ratio*100).toFixed(0)}% 原因:${reason}`);
  
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const trader = require('./dex_trader.js');
      if (attempt > 1) log('INFO', `🔄 重试卖出 ${pos.symbol}(${pos.chain}) 第${attempt}次...`);
      // ratio<1时部分卖出：查链上余额×ratio，ratio≥0.99全卖
      let result;
      if (ratio < 0.99) {
        // 查链上余额算部分数量
        let partialAmount;
        try {
          if (pos.chain === 'solana') {
            const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
              trader.getWalletAddress('solana'), { mint: tokenAddress }, { encoding: 'jsonParsed' }
            ]);
            let onChainBal = 0n;
            for (const a of (balData.result?.value || [])) {
              onChainBal += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || '0');
            }
            partialAmount = (onChainBal * BigInt(Math.floor(ratio * 1000)) / 1000n).toString();
          } else {
            const { ethers } = require('ethers');
            const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
            const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
            const bal = await erc20.balanceOf(trader.getWalletAddress('evm'));
            partialAmount = (bal * BigInt(Math.floor(ratio * 1000)) / 1000n).toString();
          }
        } catch(e) {
          log('WARN', `查余额失败，改全卖: ${e.message}`);
          partialAmount = undefined;
        }
        result = (partialAmount && partialAmount !== '0') ? await trader.sell(pos.chain, tokenAddress, partialAmount) : await trader.sell(pos.chain, tokenAddress);
      } else {
        result = await trader.sell(pos.chain, tokenAddress);
      }
      
      if (result.success) {
        // 估算卖出收益（卖出数量×当前价格）
        try {
          // Bug fix: ratio是相对剩余的比例，换算成实际卖出数量
          const remaining = (pos.buyAmount || 0) * (1 - (pos.soldRatio || 0));
          const sellAmount = ratio < 0.99 ? remaining * ratio : remaining;
          // Bug fix: 用_dexCache而不是dexScreenerCache
          const dexData = _dexCache[tokenAddress]?.data || await (async()=>{
            try { return await (await fetch('https://api.dexscreener.com/latest/dex/tokens/'+tokenAddress,{headers:{'User-Agent':'Mozilla/5.0'}})).json(); } catch{return null;}
          })();
          const curPrice = parseFloat(dexData?.pairs?.[0]?.priceUsd || 0);
          const revenue = sellAmount * curPrice;
          if (revenue > 0) {
            pos.sellRevenue = (pos.sellRevenue || 0) + revenue;
            log('INFO', `💵 卖出收益估算: ${revenue.toFixed(2)} (累计${pos.sellRevenue.toFixed(2)})`);
          }
        } catch {}
        if (ratio >= 0.99) {
          // 全卖：保存最终sellRevenue到日志后删除
          const finalRevenue = pos.sellRevenue || 0;
          const finalPnl = finalRevenue - (pos.buyCost || 0);
          log('INFO', `📊 ${pos.symbol} 最终PnL: 成本${pos.buyCost||0} 回收${finalRevenue.toFixed(2)} 盈亏${finalPnl.toFixed(2)}`);
          delete positions[tokenAddress];
          delete sellTracker[tokenAddress];
          delete transferTracker[tokenAddress];
          // 清仓后解锁，允许SM再次买入时跟进
          boughtTokens.delete(tokenAddress);
          saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
        }
        saveJSON(POSITIONS_FILE, positions);
        const pctStr = ratio < 0.99 ? `${(ratio*100).toFixed(0)}%` : '全部';
        log('INFO', `✅ 卖出成功 ${pos.symbol}(${pctStr}) | tx: ${result.txHash || '?'}`);
        await notifyTelegram(`🔴 v8卖出 ${pos.symbol}(${pos.chain}) ${pctStr}\n📉 原因: ${reason}\n🔗 ${result.txHash || ''}`);
        break;
      } else if (result.error === '余额为0') {
        // 链上确认没余额了 → 清理持仓（可能已经被手动卖了）
        log('WARN', `${pos.symbol} 链上余额为0，清理持仓`);
        delete positions[tokenAddress];
        delete sellTracker[tokenAddress];
        delete transferTracker[tokenAddress];
        boughtTokens.delete(tokenAddress);
        saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
        saveJSON(POSITIONS_FILE, positions);
        break;
      } else if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      } else if (attempt >= MAX_RETRIES && positions[tokenAddress]) {
        // 非异常路径也标记unsellable
        positions[tokenAddress].unsellable = true;
        positions[tokenAddress].unsellableReason = result?.error?.substring?.(0, 200) || 'sell failed';
        positions[tokenAddress].unsellableSince = Date.now();
        saveJSON(POSITIONS_FILE, positions);
        log('WARN', `🚫 ${pos.symbol}(${pos.chain}) 3次卖出全失败，标记unsellable停止重试`);
        await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖不出!\n❌ 3次全失败: ${result?.error || 'unknown'}\n🔧 需手动处理`);
      }
    } catch(e) {
      log('ERROR', `卖出异常 ${pos.symbol}(第${attempt}次): ${e.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      // 3次全失败 → 标记unsellable，停止重试，通知跑步哥
      if (attempt >= MAX_RETRIES && positions[tokenAddress]) {
        positions[tokenAddress].unsellable = true;
        positions[tokenAddress].unsellableReason = e.message?.substring(0, 200);
        positions[tokenAddress].unsellableSince = Date.now();
        saveJSON(POSITIONS_FILE, positions);
        log('WARN', `🚫 ${pos.symbol}(${pos.chain}) 3次卖出全失败，标记unsellable停止重试`);
        await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖不出!\n❌ 3次全失败: ${e.message?.substring(0, 100)}\n🔧 可能是貔貅币/流动性耗尽，需手动处理`);
      }
    }
  }
}

// ============ 持仓管理 ============
async function managePositions() {
  while (true) {
    const posKeys = Object.keys(positions);
    if (posKeys.length > 0) log('INFO', `🔍 巡检持仓 ${posKeys.length}个...`);
    for (const [tokenAddr, pos] of Object.entries(positions)) {
      try {
        const holdTime = Date.now() - pos.buyTime;
        
        // 先查价格（独立于SM检查，确保每轮都能更新）
        try {
          const d = await dexScreenerGet(tokenAddr);
          const currentPrice = parseFloat(d?.pairs?.[0]?.priceUsd || 0);
          if (currentPrice > 0) {
            pos.currentPrice = currentPrice;
            // 修复buyAmount=0：查链上余额回填（RPC 429导致买入时没记到数量）
            if (!pos.buyAmount || pos.buyAmount === 0) {
              try {
                const trader = require('./dex_trader.js');
                if (pos.chain === 'solana') {
                  const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
                    trader.getWalletAddress('solana'), { mint: tokenAddr }, { encoding: 'jsonParsed' }
                  ]);
                  let onChainBal = 0;
                  for (const a of (balData.result?.value || [])) {
                    onChainBal += parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
                  }
                  if (onChainBal > 0) {
                    pos.buyAmount = onChainBal;
                    pos.buyAmountRaw = onChainBal;
                    log('INFO', `📝 ${pos.symbol} buyAmount回填: ${onChainBal}`);
                  }
                } else {
                  const { ethers } = require('ethers');
                  const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                  const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
                  const [bal, dec] = await Promise.all([erc20.balanceOf(trader.getWalletAddress('evm')), erc20.decimals()]);
                  const onChainBal = parseFloat(ethers.formatUnits(bal, dec));
                  if (onChainBal > 0) {
                    pos.buyAmount = onChainBal;
                    pos.buyAmountRaw = onChainBal;
                    log('INFO', `📝 ${pos.symbol} buyAmount回填: ${onChainBal}`);
                  }
                }
              } catch(e) { log('WARN', `${pos.symbol} buyAmount回填失败: ${(e.message||'').slice(0,40)}`); }
            }
            // 检查我们自己链上余额是否=0（部分卖出实际全卖了的情况）
            if (pos.soldRatio > 0 && pos.buyAmount > 0) {
              try {
                const trader = require('./dex_trader.js');
                let ourBal = -1;
                if (pos.chain === 'solana') {
                  const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
                    trader.getWalletAddress('solana'), { mint: tokenAddr }, { encoding: 'jsonParsed' }
                  ]);
                  if (balData?.result) {
                    ourBal = (balData.result.value || []).reduce((s, a) => 
                      s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
                  }
                } else {
                  const { ethers } = require('ethers');
                  const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                  const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
                  const bal = await erc20.balanceOf(trader.getWalletAddress('evm'));
                  ourBal = bal.toString() === '0' ? 0 : 1;
                }
                if (ourBal === 0) {
                  log('INFO', `🧹 ${pos.symbol}(${pos.chain}) 链上余额=0但positions还在，清仓`);
                  const finalRevenue = pos.sellRevenue || 0;
                  const finalPnl = finalRevenue - (pos.busCost || pos.buyCost || 0);
                  log('INFO', `📊 ${pos.symbol} 最终PnL: 成本${pos.busCost||pos.buyCost||0} 回收${finalRevenue.toFixed(2)} 盈亏${finalPnl.toFixed(2)}`);
                  delete positions[tokenAddr];
                  boughtTokens.delete(tokenAddr);
                  saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
                  saveJSON(POSITIONS_FILE, positions);
                  continue;
                }
              } catch(e) {} // RPC失败不处理，下轮重试
            }
            const remaining = pos.buyAmount * (1 - (pos.soldRatio || 0));
            pos.currentValue = currentPrice * remaining;
            // 修复buyPrice=0：用当前价格回填（首次查到的价格作为buyPrice）
            if (!pos.buyPrice || pos.buyPrice === 0) {
              pos.buyPrice = currentPrice;
              log('INFO', `📝 ${pos.symbol} buyPrice回填: $${currentPrice}`);
            }
            if (pos.buyPrice > 0) {
              pos.pnlPercent = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
            }
            // 真实PnL = 当前价值 + 已卖收入 - 成本
            pos.totalPnl = pos.currentValue + (pos.sellRevenue || 0) - (pos.buyCost || 0);
            pos.totalPnlPercent = pos.buyCost > 0 ? (pos.totalPnl / pos.buyCost * 100) : 0;
            // symbol为?时尝试修复
            if (pos.symbol === '?' && d?.pairs?.[0]?.baseToken?.symbol) {
              pos.symbol = d.pairs[0].baseToken.symbol;
            }
          }
        } catch {}
        
        // 跟卖优先：查SM钱包是否还持有该token（不依赖价格）
        // SOL RPC限速严重，SM查询降频到每60秒一次（价格查询每轮都跑）
        if (!pos._lastSmCheck) pos._lastSmCheck = 0;
        const smCheckInterval = 30000; // 三链统一30秒
        if (pos.confirmWallets && (Date.now() - pos._lastSmCheck >= smCheckInterval)) {
          pos._lastSmCheck = Date.now();
          try {
            for (const smWallet of pos.confirmWallets) {
              if (sellTracker[tokenAddr]?.some(s => s.wallet === smWallet)) continue; // 已确认过
              if (pos.chain === 'solana') {
                // SOL: 查token余额
                const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
                  smWallet, { mint: tokenAddr }, { encoding: 'jsonParsed' }
                ]);
                // 必须区分"查到余额=0"和"查询失败"
                if (!balData?.result || balData.error) { log('WARN', `查SM ${smWallet.slice(0,10)} ${pos.symbol} SOL RPC失败，跳过`); continue; }
                const accounts = balData.result.value || [];
                const bal = accounts.reduce((s, a) => 
                  s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
                // 灰尘判定：余额×当前价格<$0.01视为已清仓
                const balValue = bal * (pos.currentPrice || 0);
                if (bal === 0 || (bal > 0 && balValue < 0.01 && pos.currentPrice > 0)) {
                  if (bal > 0) log('INFO', `🧹 SM ${smWallet.slice(0,10)} ${pos.symbol} 灰尘余额${bal.toFixed(2)}≈$${balValue.toFixed(4)}，视为已卖`);
                  // 余额=0或灰尘 → 查最后一笔是卖出还是转仓
                  const check = await checkSolTransferTarget(tokenAddr, smWallet);
                  if (check.type === 'transfer' && check.to) {
                    // 转到小号 → 追踪小号
                    log('INFO', `🔄 SM ${smWallet.slice(0,10)}... 转仓到 ${check.to.slice(0,10)}(${pos.chain}) — 追踪小号`);
                    if (!transferTracker[tokenAddr]) transferTracker[tokenAddr] = {};
                    transferTracker[tokenAddr][smWallet] = { subWallet: check.to, time: Date.now() };
                    saveTransferTracker(tokenAddr);
                    // 不标记为卖出
                  } else {
                    // 卖出或未知 → 标记卖出
                    log('INFO', `🔴 SM ${smWallet.slice(0,10)}... 已卖出 ${pos.symbol || tokenAddr.slice(0,10)}(${pos.chain}) — 巡检确认${check.type === 'sell' ? '(DEX)' : ''}`);
                    if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                    if (!sellTracker[tokenAddr].some(s => s.wallet === smWallet)) {
                      sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'patrol' });
                      saveSellTracker(tokenAddr);
                    }
                  }
                }
              } else {
                // EVM: 查token余额
                const { ethers } = require('ethers');
                const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
                let bal;
                try { bal = await erc20.balanceOf(smWallet); } catch(e) { log('WARN', `查SM ${smWallet.slice(0,10)} ${pos.symbol} 余额失败: ${e.message?.slice(0,40)}`); continue; }
                // EVM灰尘判定：余额极小视为已清仓
                const balNum = parseFloat(ethers.formatUnits(bal, 18));
                const balValue = balNum * (pos.currentPrice || 0);
                const isDust = bal.toString() === '0' || (balValue < 0.01 && pos.currentPrice > 0 && balNum > 0);
                if (isDust) {
                  if (bal.toString() !== '0') log('INFO', `🧹 SM ${smWallet.slice(0,10)} ${pos.symbol} EVM灰尘余额≈$${balValue.toFixed(4)}，视为已卖`);
                  // 余额=0或灰尘 → 查最后一笔是卖出还是转仓
                  const check = await checkEvmTransferTarget(pos.chain, tokenAddr, smWallet);
                  if (check.type === 'transfer' && check.to) {
                    log('INFO', `🔄 SM ${smWallet.slice(0,10)}... 转仓到 ${check.to.slice(0,10)}(${pos.chain}) — 追踪小号`);
                    if (!transferTracker[tokenAddr]) transferTracker[tokenAddr] = {};
                    transferTracker[tokenAddr][smWallet] = { subWallet: check.to, time: Date.now() };
                    saveTransferTracker(tokenAddr);
                  } else {
                    log('INFO', `🔴 SM ${smWallet.slice(0,10)}... 已卖出 ${pos.symbol || tokenAddr.slice(0,10)}(${pos.chain}) — 巡检确认${check.type === 'sell' ? '(DEX)' : ''}`);
                    if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                    if (!sellTracker[tokenAddr].some(s => s.wallet === smWallet)) {
                      sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'patrol' });
                      saveSellTracker(tokenAddr);
                    }
                  }
                }
              }
            }
          } catch(e) { if(e.message) log("WARN", `巡检SM余额异常 ${pos.symbol}: ${e.message?.slice(0,50)}`); }
        }
        
        // 追踪转仓小号：检查小号是否也清仓了（真正卖出）
        if (transferTracker[tokenAddr]) {
          for (const [smWallet, info] of Object.entries(transferTracker[tokenAddr])) {
            if (sellTracker[tokenAddr]?.some(s => s.wallet === smWallet)) continue; // 已确认卖出
            try {
              const sub = info.subWallet;
              if (pos.chain === 'solana') {
                const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [sub, { mint: tokenAddr }, { encoding: 'jsonParsed' }]);
                if (!balData?.result || balData.error) continue;
                const bal = (balData.result.value || []).reduce((s, a) => s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
                if (bal === 0) {
                  log('INFO', `🔴 小号 ${sub.slice(0,10)}... 已清仓 ${pos.symbol}(${pos.chain}) — SM${smWallet.slice(0,10)}的小号也卖了`);
                  if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                  sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'sub-patrol' });
                  saveSellTracker(tokenAddr);
                }
              } else {
                const { ethers } = require('ethers');
                const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
                let bal; try { bal = await erc20.balanceOf(sub); } catch(e) { log('WARN', `查小号 ${sub.slice(0,10)} 余额失败: ${e.message?.slice(0,40)}`); continue; }
                if (bal.toString() === '0') {
                  log('INFO', `🔴 小号 ${sub.slice(0,10)}... 已清仓 ${pos.symbol}(${pos.chain}) — SM${smWallet.slice(0,10)}的小号也卖了`);
                  if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                  sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'sub-patrol' });
                  saveSellTracker(tokenAddr);
                }
              }
            } catch {}
          }
        }
        
        // 止盈：2x回本，剩余利润跟SM走
        if (pos.currentPrice > 0 && pos.buyPrice > 0 && !pos._tpDone) {
          const multiple = pos.currentPrice / pos.buyPrice;
          if (multiple >= 2.0) {
            // 回本：卖50%（收回本金），剩下50%纯利润跟SM
            const alreadySold = pos.soldRatio || 0;
            if (alreadySold < 0.49) { // 还没卖过回本仓
              const toSell = 0.5 - alreadySold;
              log('INFO', `🎯 ${pos.symbol}(${pos.chain}) 翻倍${multiple.toFixed(1)}x! 卖50%回本`);
              await executeSell(tokenAddr, `止盈回本(${multiple.toFixed(1)}x)`, toSell / (1 - alreadySold));
              if (positions[tokenAddr]) {
                // 只有卖出成功才标记（unsellable=失败，不标记，下轮重试）
                if (!pos.unsellable) {
                  pos.soldRatio = 0.5;
                  pos._tpDone = true;
                }
                saveJSON(POSITIONS_FILE, positions);
              }
              continue;
            }
          }
        }

        // 归零快速清仓：跌99%以上 或 绝对价值<$0.01 直接清（不等SM，币已经死了）
        if (pos.buyPrice > 0 && pos.currentPrice > 0) {
          const dropPct = ((pos.buyPrice - pos.currentPrice) / pos.buyPrice) * 100;
          const remaining = (pos.buyAmount || 0) * (1 - (pos.soldRatio || 0));
          const absValue = remaining * pos.currentPrice;
          if (dropPct >= 99 || (absValue < 0.01 && pos.buyCost > 1)) {
            const reason = absValue < 0.01 ? `价值$${absValue.toExponential(1)}归零` : `跌${dropPct.toFixed(0)}%归零`;
            log('INFO', `💀 ${pos.symbol}(${pos.chain}) ${reason}，清仓`);
            // 同名冷却1小时
            if (pos.symbol && pos.symbol !== '?') {
              if (!handleSignal._symbolCooldown) handleSignal._symbolCooldown = {};
              handleSignal._symbolCooldown[pos.symbol.toUpperCase() + '_' + pos.chain] = Date.now() + 3600000;
            }
            delete positions[tokenAddr];
            delete sellTracker[tokenAddr];
            delete transferTracker[tokenAddr];
            boughtTokens.delete(tokenAddr);
            saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
            saveJSON(POSITIONS_FILE, positions);
            await notifyTelegram(`💀 v8归零 ${pos.symbol}(${pos.chain}) ${reason} 成本$${pos.buyCost||0}`);
            continue;
          }
        }

        const sells = sellTracker[tokenAddr] || [];
        const uniqueSellers = new Set(sells.map(s => s.wallet)).size;
        const totalConfirm = (pos.confirmWallets || []).length || pos.confirmCount || 2;
        const sellRatio = uniqueSellers / totalConfirm; // SM卖出比例
        
        if (sellRatio >= CONFIG.sellThreshold) {
          // 我们的卖出比例 = SM卖出比例
          const ourSellRatio = Math.min(sellRatio, 1.0);
          if (ourSellRatio >= 0.99) {
            // SM全卖清仓 → 同名冷却1小时
            if (pos.symbol && pos.symbol !== '?') {
              if (!handleSignal._symbolCooldown) handleSignal._symbolCooldown = {};
              handleSignal._symbolCooldown[pos.symbol.toUpperCase() + '_' + pos.chain] = Date.now() + 3600000;
            }
            await executeSell(tokenAddr, `SM全部卖出(${uniqueSellers}/${totalConfirm})`);
          } else {
            // 部分卖出
            const alreadySold = pos.soldRatio || 0;
            const toSell = ourSellRatio - alreadySold;
            if (toSell > 0.05) { // 至少卖5%才执行（避免频繁小额卖出）
              const beforeSell = Object.keys(positions).length;
              await executeSell(tokenAddr, `跟卖${(ourSellRatio*100).toFixed(0)}%(${uniqueSellers}/${totalConfirm}SM卖出)`, toSell / (1 - alreadySold));
              // 只在卖出成功（positions仍存在=部分卖出）或已删除（全卖）时更新soldRatio
              if (positions[tokenAddr]) {
                pos.soldRatio = ourSellRatio;
                saveJSON(POSITIONS_FILE, positions);
              }
            }
          }
          continue;
        }
        
        saveJSON(POSITIONS_FILE, positions);
      } catch(e) { if (e.message) log('WARN', `巡检异常 ${pos?.symbol || tokenAddr?.slice(0,8)}: ${e.message.slice(0,60)}`); }
      await sleep(500);
    }
    await sleep(10000); // 10秒检查一轮
  }
}

// ============ 通知 ============
async function notifyTelegram(msg) {
  console.log('📢 ' + msg.replace(/\n/g, ' | '));
  // 写入本地通知队列文件，由OpenClaw heartbeat转发给跑步哥
  try {
    const queueFile = path.join(__dirname, 'data/v8/notify_queue.json');
    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch {}
    queue.push({ ts: Date.now(), msg });
    // 原子写入
    const tmp = queueFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue));
    fs.renameSync(tmp, queueFile);
  } catch(e) { log('WARN', `通知队列写入失败: ${e.message?.slice(0,60)}`); }
}

// ============ MAIN ============
async function main() {
  console.log('⚡ v8 跟单引擎');
  console.log('  数据源: 币安PnL Rank');
  console.log('  监控: SOL WebSocket + BSC/Base 5s轮询');
  console.log('  过滤: 多钱包确认 + 合约审计 + 流动性');
  
  // 加载状态
  positions = loadJSON(POSITIONS_FILE, {});
  restoreSellTracker(); // 从positions恢复SM卖出记录（重启不丢）
  auditCache = loadJSON(AUDIT_CACHE_FILE, {});
  // 已买过的token（从持仓+历史记录双重加载）
  const savedBought = loadJSON(BOUGHT_TOKENS_FILE, []);
  boughtTokens = new Set([...Object.keys(positions), ...savedBought]);
  
  // Bug fix: 清理boughtTokens孤儿（不在positions里的=已卖完，解锁让它能重新被买）
  const orphans = [...boughtTokens].filter(t => !positions[t]);
  if (orphans.length > 0) {
    for (const t of orphans) boughtTokens.delete(t);
    saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
    log('INFO', `🧹 清理boughtTokens孤儿: ${orphans.length}个`);
  }
  
  // 加载钱包库
  walletDb = loadJSON(WALLET_DB_FILE, {});
  log('INFO', `📦 加载钱包库: ${Object.keys(walletDb).length}个`);
  
  // Phase 1: 拉取排名 → 验证 → 合并到钱包库 → 排名
  const rawWallets = await fetchBinanceRank();
  const verified = await verifyWallets(rawWallets);
  const allWalletsFromDb = mergeToWalletDb(verified);
  rankedWallets = rankWallets(allWalletsFromDb);
  saveJSON(WALLETS_FILE, rankedWallets.map(w => ({
    rank: w.rank, address: w.address, chain: w.chain,
    pnl: w.pnl, winRate: w.winRate, tokens: w.tokens,
    status: w.status,
    topTokens: (w.topTokens || []).map(t => t.tokenSymbol || t),
  })));
  
  const hunterByChain = { solana: 0, bsc: 0, base: 0 };
  const scoutByChain = { solana: 0, bsc: 0, base: 0 };
  const watcherByChain = { solana: 0, bsc: 0, base: 0 };
  for (const w of rankedWallets) {
    if (w.status === 'hunter') hunterByChain[w.chain]++;
    else if (w.status === 'scout') scoutByChain[w.chain]++;
    else watcherByChain[w.chain]++;
  }
  const totalHunter = Object.values(hunterByChain).reduce((a,b) => a+b, 0);
  const totalScout = Object.values(scoutByChain).reduce((a,b) => a+b, 0);
  const totalWatcher = Object.values(watcherByChain).reduce((a,b) => a+b, 0);
  console.log(`📋 🔥猎手(${totalHunter}): SOL=${hunterByChain.solana} BSC=${hunterByChain.bsc} Base=${hunterByChain.base}`);
  console.log(`👁️哨兵(${totalScout}): SOL=${scoutByChain.solana} BSC=${scoutByChain.bsc} Base=${scoutByChain.base}`);
  console.log(`👀观察(${totalWatcher}): SOL=${watcherByChain.solana} BSC=${watcherByChain.bsc} Base=${watcherByChain.base}`);
  console.log(`💼 持仓: ${Object.keys(positions).length}个`);
  
  // Phase 2: 启动监控
  setupSolanaMonitor();
  setupEvmWebSocket('bsc');
  setupEvmWebSocket('base');
  pollEvmHunters(); // EVM猎手轮询兜底（WS可能静默丢事件）
  
  // 持仓管理
  managePositions();
  
  // 定时刷新排名
  setInterval(async () => {
    try {
      log('INFO', '🔄 定时刷新排名...');
      const raw = await fetchBinanceRank();
      const ver = await verifyWallets(raw);
      const allFromDb = mergeToWalletDb(ver);
      rankedWallets = rankWallets(allFromDb);
      saveJSON(WALLETS_FILE, rankedWallets.map(w => ({
        rank: w.rank, address: w.address, chain: w.chain,
        pnl: w.pnl, winRate: w.winRate, tokens: w.tokens, status: w.status,
      })));
      // 更新walletSet（新钱包加入轮询监控；EVM WS需重连才能订阅新钱包）
      let newBsc = 0, newBase = 0, newSol = 0;
      for (const w of rankedWallets) {
        if (w.chain === 'bsc' && !bscWalletSet.has(w.address.toLowerCase())) { bscWalletSet.add(w.address.toLowerCase()); newBsc++; }
        else if (w.chain === 'base' && !baseWalletSet.has(w.address.toLowerCase())) { baseWalletSet.add(w.address.toLowerCase()); newBase++; }
        else if (w.chain === 'solana' && !solWalletSet.has(w.address)) { solWalletSet.add(w.address); newSol++; }
      }
      if (newBsc + newBase + newSol > 0) {
        log('INFO', `  新增监控钱包: SOL+${newSol} BSC+${newBsc} Base+${newBase}`);
        // 有新EVM钱包→重连WS以订阅新地址
        if (newBsc > 0) { log('INFO', '  🔌 BSC WS重连(新钱包)'); setupEvmWebSocket('bsc'); }
        if (newBase > 0) { log('INFO', '  🔌 Base WS重连(新钱包)'); setupEvmWebSocket('base'); }
      }
      log('INFO', `  排名更新: ${rankedWallets.length}个钱包 (库${Object.keys(walletDb).length}个)`);
    } catch(e) {
      log('ERROR', `排名刷新失败: ${e.message}`);
    }
  }, CONFIG.rankRefreshInterval);
  
  console.log('🟢 引擎运行中...');
  
  // 内存管理
  if (global.gc) setInterval(() => global.gc(), 300000);
}

// 全局错误处理（防崩溃丢信号）
process.on('uncaughtException', (e) => { console.error(`[FATAL] 未捕获异常: ${e.message}\n${e.stack}`); });
process.on('unhandledRejection', (e) => { console.error(`[FATAL] 未处理Promise: ${e?.message || e}`); });

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
