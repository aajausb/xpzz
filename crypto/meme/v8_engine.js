#!/usr/bin/env node
/**
 * v8 跟单引擎
 * 
 * 数据层: 币安PnL Rank → 验证(合约/空地址) → WR≥60%筛选 → 动态排名
 * 监控层: SOL WebSocket(毫秒) + BSC/Base轮询(5s)
 * 过滤层: 多钱包确认(≥2) + 合约审计 + 流动性检查
 * 交易层: OKX聚合器 + Jito加速 + 分阶段止损
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const { execSync } = require('child_process');

// ============ CONFIG ============
const CONFIG = {
  // 数据刷新
  rankRefreshInterval: 4 * 3600 * 1000,  // 4小时刷新币安排名
  // 不限数量，验证通过的全部跟踪，排名只决定优先级
  activeWinRateMin: 60,                     // 猎手: 胜率60-80%
  activeWinRateMax: 80,                     // >80%或<60%进哨兵状态
  evictMissCount: 3,                        // 连续3次(12h)没上榜
  evictMinWinRate: 50,                      // 且胜率<50%才踢出库

  // 监控
  evmPollInterval: 3000,                   // BSC/Base 3秒轮询（接近区块时间）
  
  // 过滤
  minSmartMoneyConfirm: 2,                 // 至少2个钱包确认才跟
  confirmWindowMs: 60 * 60 * 1000,          // 60分钟确认窗口
  minLiqMcRatio: 0.05,                     // Liq/MC ≥ 5%
  
  // 交易 — 按SM确认数决定仓位
  positionSizeTop10: 10,                   // SM≥10: $10
  positionSizeTop30: 7,                    // SM 5-9: $7
  positionSizeDefault: 5,                  // SM 2-4: $5
  maxPositions: 10,
  maxPerChain: 5,
  
  // 止损/止盈
  stopLoss: -30,                            // 兜底止损-30%（防SM没动但币崩了）
  timeLimitMs: 4 * 3600 * 1000,            // 持仓>4小时无SM动作且±10%内→平掉
  timeLimitPnlRange: 10,                   // 时间止损的盈亏范围±10%
  sellThreshold: 0.5,                      // SM卖出比例≥50%才触发跟卖
};

// ============ PATHS ============
const DATA_DIR = path.join(__dirname, 'data', 'v8');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');  // 排名快照（展示用）
const WALLET_DB_FILE = path.join(DATA_DIR, 'wallet_db.json');   // 钱包库（持久化）
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
// signals.json已废弃，信号记录在日志中
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');
const AUDIT_CACHE_FILE = path.join(DATA_DIR, 'audit_cache.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ STATE ============
let walletDb = {};         // 钱包库 { "addr_chain": { address, chain, pnl, winRate, tokens, ... } }
let rankedWallets = [];    // 排名后的钱包列表（从walletDb生成）
let positions = {};        // tokenAddress -> position
let pendingSignals = {};   // tokenAddress -> [{wallet, chain, timestamp}]
let boughtTokens = new Set(); // 已买过的token（防重复）
let blacklist = new Set();
let auditCache = {};

// Chain config
const CHAINS = {
  solana: { name: 'Solana', binanceId: 'CT_501', okxChainId: '501' },
  bsc:    { name: 'BSC',    binanceId: '56',     okxChainId: '56' },
  base:   { name: 'Base',   binanceId: '8453',   okxChainId: '8453' },
};

// SOL轮询用PublicNode（官方RPC留给WS订阅，互不抢）
const SOL_PUBLIC_RPC = 'https://solana-rpc.publicnode.com';
// Helius Parse API（仅用于解析SOL swap交易详情，WS/RPC已全部用官方）
const HELIUS_PARSE_KEY = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: process.env.OKX_API_KEY || '',
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '',
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || '',
};

const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');

// ============ UTILS ============
const log = (level, msg) => console.log(`${new Date().toLocaleTimeString('zh-CN')} [${level}] ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const loadJSON = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/2.0 (Skill)', ...headers } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity',
                 'User-Agent': 'binance-web3/2.0 (Skill)', 'Content-Length': Buffer.byteLength(postData), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function rpcPost(url, method, params) {
  return httpPost(url, { jsonrpc: '2.0', id: 1, method, params });
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
  
  // 去重: 同地址同链取PnL更高的
  const unique = new Map();
  for (const w of allWallets) {
    const key = w.address + '_' + w.chain;
    if (!unique.has(key) || w.pnl > unique.get(key).pnl) unique.set(key, w);
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
        const info = await rpcPost(SOL_PUBLIC_RPC, 'getAccountInfo', [w.address, { encoding: 'jsonParsed' }]);
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
      // 已有 → 更新数据，保留入库时间
      walletDb[key].pnl = w.pnl;
      walletDb[key].winRate = w.winRate;
      walletDb[key].tokens = w.tokens;
      walletDb[key].txCount = w.txCount;
      walletDb[key].balance = w.balance;
      walletDb[key].lastActivity = w.lastActivity;
      walletDb[key].topTokens = w.topTokens;
      walletDb[key].lastSeen = now;
      walletDb[key].missCount = 0; // 出现了，重置未命中计数
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
  
  // 淘汰: 这次没出现的钱包，missCount+1
  for (const [key, w] of Object.entries(walletDb)) {
    if (!seenKeys.has(key)) {
      w.missCount = (w.missCount || 0) + 1;
      // 连续N次没上榜 + 胜率低于阈值 → 踢出
      if (w.missCount >= CONFIG.evictMissCount && (w.winRate || 0) < CONFIG.evictMinWinRate) {
        log('INFO', `🗑 踢出钱包 ${w.address.slice(0,8)}...(${w.chain}) miss=${w.missCount} WR=${w.winRate}%`);
        delete walletDb[key];
      }
    }
  }
  
  saveJSON(WALLET_DB_FILE, walletDb);
  const total = Object.keys(walletDb).length;
  const newCount = verifiedWallets.filter(w => !walletDb[w.address + '_' + w.chain]?.addedAt || walletDb[w.address + '_' + w.chain]?.addedAt === now).length;
  log('INFO', `📦 钱包库: ${total}个 (本轮新增${seenKeys.size - (total - newCount)}个)`);
  
  return Object.values(walletDb);
}

function rankWallets(wallets) {
  // 综合评分: 胜率 × 样本量 × 盈利能力 × 活跃度
  const now = Date.now();
  for (const w of wallets) {
    const wr = (w.winRate || 0) / 100;                        // 0~1
    const sampleWeight = Math.log2((w.tokens || 1) + 1);      // 交易币数，log防大户碾压
    const pnlWeight = Math.log10(Math.max(w.pnl, 1) + 1);    // PnL取log
    const age = now - (w.lastActivity || 0);
    const activityMul = age < 7 * 86400000 ? 1.5              // 7天内活跃
                      : age < 30 * 86400000 ? 1.2             // 30天内
                      : 1.0;
    w.score = wr * sampleWeight * pnlWeight * activityMul;
    
    // 状态: 60-80%胜率=hunter(猎手), 其他=scout(哨兵)
    const winRate = w.winRate || 0;
    w.status = (winRate >= CONFIG.activeWinRateMin && winRate <= CONFIG.activeWinRateMax) ? 'hunter' : 'scout';
  }
  wallets.sort((a, b) => b.score - a.score);
  wallets.forEach((w, i) => w.rank = i + 1);
  
  // 持久化status/score/rank到walletDb
  for (const w of wallets) {
    const key = w.address + '_' + w.chain;
    if (walletDb[key]) {
      walletDb[key].status = w.status;
      walletDb[key].score = w.score;
      walletDb[key].rank = w.rank;
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
  ]),
  base: new Set([
    '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // Aerodrome
  ]),
};

// ERC20 Transfer event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const solLastSigs = new Map(); // wallet -> lastSignature

const SOL_WS_OFFICIAL = 'wss://api.mainnet-beta.solana.com';
let solOfficialWs = null; // 单连接
let solWsMode = 'none'; // 'official' | 'polling'

function setupSolanaMonitor() {
  const solWallets = rankedWallets.filter(w => w.chain === 'solana');
  for (const w of solWallets) solWalletSet.add(w.address);
  
  if (solWalletSet.size === 0) return;
  
  // 优先: 官方RPC logsSubscribe（1个WS连接，全部钱包）
  setupOfficialSolWs();
  
  
  // 兜底: 轮询（最慢但最稳）
  pollSolanaWallets();
}

// 官方RPC: WS只订阅猎手钱包（控制订阅数<50，哨兵靠轮询）
function setupOfficialSolWs() {
  const solHunters = rankedWallets.filter(w => w.chain === 'solana' && w.status === 'hunter').map(w => w.address);
  const walletList = solHunters.length > 0 ? solHunters : [...solWalletSet].slice(0, 40);
  if (walletList.length === 0) return;
  
  log('INFO', `🔌 [SOL] 官方RPC logsSubscribe ${walletList.length} 个猎手钱包 (单连接, 哨兵靠轮询)`);
  
  const ws = new WebSocket(SOL_WS_OFFICIAL);
  solOfficialWs = ws;
  let subscribed = 0;
  const idToAddr = {};
  
  ws.on('open', () => {
    walletList.forEach((addr, i) => {
      const id = i + 1;
      idToAddr[id] = addr;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id, method: 'logsSubscribe',
        params: [{ mentions: [addr] }, { commitment: 'confirmed' }]
      }));
    });
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
    log('WARN', '🔌 [SOL] 官方RPC WS断开，10秒后重连');
    solOfficialWs = null;
    solWsMode = 'polling';
    setTimeout(() => setupOfficialSolWs(), 10000);
  });
  
  ws.on('error', () => {});
  
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);
}




// 公共RPC轮询: 每10秒查每个钱包最近1条签名，检测新交易
async function pollSolanaWallets() {
  const interval = solOfficialWs ? 30000 : 10000; // WS连上了降频
  log('INFO', `🔌 [SOL] 轮询模式启动 ${solWalletSet.size} 个钱包 (${interval/1000}s)`);
  
  // 初始化: 记录每个钱包当前最新签名（失败重试3次）
  for (const addr of solWalletSet) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const d = await rpcPost(SOL_PUBLIC_RPC, 'getSignaturesForAddress', [addr, { limit: 1 }]);
        const sigs = d.result || [];
        if (sigs.length > 0) solLastSigs.set(addr, sigs[0].signature);
        break;
      } catch(e) { await sleep(500 * (retry + 1)); }
    }
    await sleep(150);
  }
  log('INFO', `🔌 [SOL] 初始化完成, ${solLastSigs.size}/${solWalletSet.size} 钱包有历史签名`);
  
  while (true) {
    await sleep(interval);
    
    for (const addr of solWalletSet) {
      try {
        const lastSig = solLastSigs.get(addr);
        const params = lastSig ? [addr, { limit: 5, until: lastSig }] : [addr, { limit: 1 }];
        const d = await rpcPost(SOL_PUBLIC_RPC, 'getSignaturesForAddress', params);
        const sigs = d.result || [];
        
        if (sigs.length === 0) continue;
        
        // 更新最新签名
        solLastSigs.set(addr, sigs[0].signature);
        
        for (const sig of sigs) {
          if (sig.err) continue; // 跳过失败交易
          await parseSolSignature(addr, sig.signature);
        }
      } catch(e) {}
      await sleep(200); // 每个钱包间隔200ms，37个钱包一轮~7秒
    }
  }
}

async function parseSolSignature(walletAddr, signature) {
  try {
    const d = await httpPost(`https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_PARSE_KEY}`, [signature]);
    if (!Array.isArray(d) || d.length === 0) return;
    
    const tx = d[0];
    if (tx.type !== 'SWAP') return; // 只关心swap
    
    const wallet = rankedWallets.find(w => w.address === walletAddr);
    const rank = wallet?.rank || 999;
    
    // 从tokenTransfers中找买入的token
    const transfers = tx.tokenTransfers || [];
    for (const t of transfers) {
      if (t.toUserAccount === walletAddr && t.fromUserAccount !== walletAddr) {
        const mint = t.mint;
        const WSOL = 'So11111111111111111111111111111111111111112';
        if (mint === WSOL) continue;
        
        const amount = t.tokenAmount || 0;
        log('INFO', `🔔 [SOL] swap检测! 钱包#${rank} ${walletAddr.slice(0,8)}... 买入 ${mint.slice(0,8)}... (${tx.source})`);
        
        await handleSignal({
          chain: 'solana',
          token: mint,
          symbol: tx.tokenTransfers?.[0]?.tokenStandard || '?',
          wallet: walletAddr,
          walletRank: rank,
          timestamp: Date.now(),
        });
      }
      
      // 检测卖出: 钱包把token转出去
      if (t.fromUserAccount === walletAddr && t.toUserAccount !== walletAddr) {
        const mint = t.mint;
        const WSOL = 'So11111111111111111111111111111111111111112';
        if (mint === WSOL) continue;
        if (positions[mint]) {
          log('INFO', `📉 [SOL] 卖出! 钱包#${rank} ${walletAddr.slice(0,8)}... 卖出 ${mint.slice(0,8)}...`);
          trackSmartMoneySell(mint, walletAddr, 1.0); // 记录该钱包卖了，managePositions按人数比例决定
        }
      }
    }
  } catch(e) {
  }
}

// 解析Solana swap交易 — 从tokenTransfers提取买入信号
async function parseSolanaSwap(result) {
  try {
  const tx = result.transaction;
  const meta = tx?.meta;
  if (!tx || !meta || meta.err) return; // 失败交易跳过
  
  const sig = result.signature;
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const feePayer = accountKeys[0]?.pubkey;
  if (!feePayer || !solWalletSet.has(feePayer)) return; // 不是我们的钱包发起的
  
  // 从tokenBalances变化中检测swap: SOL减少 + 某token增加 = 买入
  const preBalances = meta.preBalances || [];
  const postBalances = meta.postBalances || [];
  const solChange = (postBalances[0] || 0) - (preBalances[0] || 0);
  
  // 从tokenTransfers中找到获得的token
  const preTokenBals = meta.preTokenBalances || [];
  const postTokenBals = meta.postTokenBalances || [];
  
  // 构建token余额变化map
  const tokenChanges = {};
  for (const post of postTokenBals) {
    if (!post.owner || post.owner !== feePayer) continue;
    const mint = post.mint;
    const postAmt = parseFloat(post.uiTokenAmount?.uiAmountString || '0');
    const pre = preTokenBals.find(p => p.mint === mint && p.owner === feePayer);
    const preAmt = pre ? parseFloat(pre.uiTokenAmount?.uiAmountString || '0') : 0;
    const delta = postAmt - preAmt;
    if (delta > 0) tokenChanges[mint] = delta;
  }
  
  // SOL减少 + token增加 = 买入swap
  const WSOL = 'So11111111111111111111111111111111111111112';
  if (solChange < -1000000 && Object.keys(tokenChanges).length > 0) { // >0.001 SOL花费
    for (const [mint, amount] of Object.entries(tokenChanges)) {
      if (mint === WSOL) continue; // wSOL不算
      const solSpent = Math.abs(solChange) / 1e9;
      const wallet = rankedWallets.find(w => w.address === feePayer);
      const rank = wallet?.rank || 999;
      log('INFO', `🔔 [SOL] 检测到买入! 钱包#${rank} ${feePayer.slice(0,8)}... 花${solSpent.toFixed(3)}SOL 买 ${mint.slice(0,8)}...`);
      
      await handleSignal({
        chain: 'solana',
        token: mint,
        symbol: '?',
        wallet: feePayer,
        walletRank: rank,
        solSpent,
        timestamp: Date.now(),
      });
    }
  }
  
  // 检测卖出: token减少 + SOL增加
  for (const pre of preTokenBals) {
    if (!pre.owner || pre.owner !== feePayer) continue;
    const mint = pre.mint;
    if (mint === WSOL) continue;
    const preAmt = parseFloat(pre.uiTokenAmount?.uiAmountString || '0');
    const post = postTokenBals.find(p => p.mint === mint && p.owner === feePayer);
    const postAmt = post ? parseFloat(post.uiTokenAmount?.uiAmountString || '0') : 0;
    if (preAmt > 0 && postAmt < preAmt && solChange > 1000000) {
      const sellRatio = (preAmt - postAmt) / preAmt;
      if (positions[mint] && sellRatio > 0.3) {
        log('INFO', `🔔 [SOL] 检测到卖出! 钱包 ${feePayer.slice(0,8)}... 卖出 ${mint.slice(0,8)}... ${(sellRatio*100).toFixed(0)}%`);
        trackSmartMoneySell(mint, feePayer, sellRatio);
      }
    }
  }
  } catch(e) { log('WARN', `parseSolanaSwap异常: ${e.message}`); }
}

// 跟踪聪明钱卖出 — 积累到阈值触发跟卖
const sellTracker = {}; // token -> [{wallet, ratio, time}]

function trackSmartMoneySell(token, wallet, ratio) {
  if (!sellTracker[token]) sellTracker[token] = [];
  sellTracker[token].push({ wallet, ratio, time: Date.now() });
  // 清理60分钟前的（跟确认窗口一致）
  const cutoff = Date.now() - CONFIG.confirmWindowMs;
  sellTracker[token] = sellTracker[token].filter(s => s.time > cutoff);
  
  const uniqueSellers = new Set(sellTracker[token].map(s => s.wallet)).size;
  log('INFO', `⚠️ SM卖出追踪: ${token.slice(0,8)}... ${uniqueSellers}个钱包在卖`);
  // 实际跟卖由managePositions()驱动，这里只记录
}

// BSC/Base: WebSocket实时推送 — 订阅DEX Router的Transfer事件
const EVM_WS_ENDPOINTS = {
  bsc: "wss://bsc.publicnode.com",
  base: "wss://base.publicnode.com",
};
const evmWsRetries = { bsc: 0, base: 0 };

function setupEvmWebSocket(chainKey) {
  const chain = CHAINS[chainKey];
  const walletSet = chainKey === "bsc" ? bscWalletSet : baseWalletSet;
  const wallets = rankedWallets.filter(w => w.chain === chainKey);
  for (const w of wallets) walletSet.add(w.address.toLowerCase());
  
  if (walletSet.size === 0) return;
  
  const routers = DEX_ROUTERS[chainKey] || new Set();
  if (routers.size === 0) return;
  
  const wsUrl = EVM_WS_ENDPOINTS[chainKey];
  const ws = new WebSocket(wsUrl);
  
  ws.on("open", () => {
    let subId = 1;
    for (const routerAddr of routers) {
      // 买入: from=Router → to=我们的钱包（钱包收到token）
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: subId++, method: "eth_subscribe",
        params: ["logs", { topics: [TRANSFER_TOPIC, ethers.zeroPadValue(routerAddr, 32)] }]
      }));
      // 卖出: from=任意 → to=Router（token流向Router=卖出swap）
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: subId++, method: "eth_subscribe",
        params: ["logs", { topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(routerAddr, 32)] }]
      }));
    }
    evmWsRetries[chainKey] = 0;
    log("INFO", "🔌 [" + chain.name + "] WebSocket实时监控(买+卖) " + walletSet.size + " 个钱包 (" + routers.size + "个DEX)");
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
        const routerSet = new Set([...routers].map(r => r.toLowerCase()));
        
        // 买入: from=Router, to=我们的钱包
        if (routerSet.has(fromAddr) && walletSet.has(toAddr)) {
          if (blacklist.has(tokenAddr)) return;
          const wallet = rankedWallets.find(w => w.address?.toLowerCase() === toAddr);
          const rank = wallet?.rank || 999;
          log("INFO", "🔔 [" + chain.name + "] 买入! 钱包#" + rank + " " + toAddr.slice(0,8) + "... 获得 " + tokenAddr.slice(0,8) + "...");
          await handleSignal({ chain: chainKey, token: tokenAddr, symbol: "?", wallet: toAddr, walletRank: rank, timestamp: Date.now() });
        }
        
        // 卖出检测: from=SM钱包发出token → 查receipt确认是swap还是转仓
        if (walletSet.has(fromAddr) && !routerSet.has(fromAddr)) {
          if (positions[tokenAddr]) {
            const txHash = logEntry.transactionHash;
            if (txHash) {
              verifyEvmSell(chainKey, txHash, fromAddr, tokenAddr).catch(() => {});
            }
          }
        }
      }
    } catch(e) {}
  });
  
  ws.on("close", () => {
    evmWsRetries[chainKey] = (evmWsRetries[chainKey] || 0) + 1;
    const delay = Math.min(3000 * evmWsRetries[chainKey], 60000);
    if (evmWsRetries[chainKey] <= 3) log("WARN", "🔌 [" + chain.name + "] WS断开，" + delay/1000 + "秒后重连");
    setTimeout(() => setupEvmWebSocket(chainKey), delay);
  });
  
  ws.on("error", () => {});
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); else clearInterval(ping); }, 30000);
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
    const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const WETH_BASE = '0x4200000000000000000000000000000000000006';
    const nativeToken = chainKey === 'bsc' ? WBNB : WETH_BASE;
    
    let isSwap = false;
    for (const lg of receipt.logs) {
      // 检查有没有native token Transfer to=该钱包
      if (lg.address.toLowerCase() === nativeToken &&
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
          if (from === walletAddr.toLowerCase() && to !== walletAddr.toLowerCase()) {
            // 把转仓目标加入confirmWallets和walletSet
            const pos = positions[tokenAddr];
            if (pos && pos.confirmWallets && !pos.confirmWallets.includes(to)) {
              pos.confirmWallets.push(to);
              walletSet.add(to);
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
  const { chain, token, wallet, walletRank } = signal;
  
  // 去重: 已持仓或已买过的不重复
  if (positions[token]) return;
  if (boughtTokens.has(token)) return;
  if (Object.keys(positions).length >= CONFIG.maxPositions) return;
  
  const chainPositions = Object.values(positions).filter(p => p.chain === chain).length;
  if (chainPositions >= CONFIG.maxPerChain) return;
  
  // 检查钱包状态: watch的只记录不算确认
  const walletInfo = rankedWallets.find(w => w.address === wallet || w.address?.toLowerCase() === wallet);
  const walletStatus = walletInfo?.status || 'scout';
  
  // 多钱包确认 — 每个钱包只算1次，5分钟窗口
  if (!pendingSignals[token]) pendingSignals[token] = [];
  
  // 同一钱包不重复计数
  const alreadyCounted = pendingSignals[token].some(s => s.wallet === wallet);
  if (!alreadyCounted) {
    pendingSignals[token].push({ ...signal, walletStatus });
  }
  
  // 清理过期信号（5分钟窗口）
  const now = Date.now();
  pendingSignals[token] = pendingSignals[token].filter(s => now - s.timestamp < CONFIG.confirmWindowMs);
  
  // 计数 = 只算猎手钱包（哨兵的记录但不算确认数）
  const activeSignals = pendingSignals[token].filter(s => s.walletStatus === "hunter");
  const watchSignals = pendingSignals[token].filter(s => s.walletStatus === 'scout');
  const confirmCount = new Set(activeSignals.map(s => s.wallet)).size;
  const watchCount = new Set(watchSignals.map(s => s.wallet)).size;
  
  // 分级确认:
  // ≥2个猎手 → 买
  // 1个猎手 + ≥2个哨兵 → 买（哨兵当佐证）
  // 其他 → 等
  const confirmed = confirmCount >= 2 || (confirmCount >= 1 && watchCount >= 2);
  if (!confirmed) {
    const bestRank = Math.min(...pendingSignals[token].map(s => s.walletRank || 999));
    const extra = watchCount > 0 ? ` (+${watchCount}哨兵)` : '';
    log('INFO', `⏳ ${token.slice(0,8)}...(${chain}) 确认中 猎手=${confirmCount} 哨兵=${watchCount}${extra} 最高#${bestRank}`);
    return;
  }
  
  // 并行查: symbol + 审计 + 流动性（省时间）
  const [symbolData, audit, liqCheck] = await Promise.all([
    httpGet(`https://api.dexscreener.com/latest/dex/tokens/${token}`).catch(() => null),
    auditToken(chain, token),
    checkLiquidity(chain, token),
  ]);
  
  const symbol = symbolData?.pairs?.[0]?.baseToken?.symbol || '?';
  
  if (!audit.safe) {
    log('WARN', `❌ ${symbol}(${chain}) 审计不通过: ${audit.reason}`);
    blacklist.add(token);
    saveJSON(BLACKLIST_FILE, [...blacklist]);
    return;
  }
  
  if (!liqCheck.ok) {
    log('WARN', `❌ ${symbol}(${chain}) 流动性不足: ${liqCheck.reason}`);
    return;
  }
  
  // 通过所有过滤 → 买入
  const bestRank = Math.min(...activeSignals.map(s => s.walletRank || 999));
  const confirmWallets = [...new Set(activeSignals.map(s => s.wallet))];
  log('INFO', `✅ ${symbol}(${chain}) 通过过滤! SM=${confirmCount}个钱包 最高#${bestRank} 审计=OK Liq=${liqCheck.ratio}`);
  await executeBuy(chain, token, symbol, confirmCount, confirmWallets);
}

async function auditToken(chain, tokenAddress) {
  // 检查缓存
  if (auditCache[tokenAddress]) return auditCache[tokenAddress];
  
  try {
    const chainId = CHAINS[chain].binanceId;
    const d = await httpPost(
      'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit',
      { binanceChainId: chainId, contractAddress: tokenAddress, requestId: `${Date.now()}` },
      { 'Content-Type': 'application/json' }
    );
    
    const audit = d?.data || {};
    const riskLevel = audit.riskLevelEnum || 'UNKNOWN';
    let isHoneypot = false;
    let sellTax = 0;
    
    for (const cat of (audit.riskItems || [])) {
      for (const detail of (cat.details || [])) {
        if (detail.isHit && detail.riskType === 'RISK') {
          if (detail.title?.includes('Honeypot')) isHoneypot = true;
        }
      }
    }
    sellTax = parseFloat(audit.extraInfo?.sellTax || 0);
    
    const safe = riskLevel !== 'HIGH' && !isHoneypot && sellTax <= 10;
    const result = { safe, riskLevel, isHoneypot, sellTax, reason: safe ? 'OK' : `risk=${riskLevel} honeypot=${isHoneypot} tax=${sellTax}%` };
    auditCache[tokenAddress] = result;
    saveJSON(AUDIT_CACHE_FILE, auditCache);
    return result;
  } catch(e) {
    return { safe: false, reason: 'audit_failed_block' }; // 审计失败=拦截，不冒险
  }
}

async function checkLiquidity(chain, tokenAddress) {
  try {
    const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const pair = d?.pairs?.[0];
    if (!pair) return { ok: false, reason: 'no_pair' };
    
    const mc = parseFloat(pair.marketCap || 0);
    const liq = parseFloat(pair.liquidity?.usd || 0);
    
    if (mc <= 0) return { ok: false, reason: 'no_mc' };
    const ratio = liq / mc;
    
    return { ok: ratio >= CONFIG.minLiqMcRatio, ratio: (ratio * 100).toFixed(1) + '%', reason: ratio < CONFIG.minLiqMcRatio ? `Liq/MC=${(ratio*100).toFixed(1)}%<5%` : 'OK' };
  } catch(e) {
    return { ok: false, reason: 'check_failed_block' };
  }
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
  const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${NATIVE_TOKENS[chain]}`);
  // 匹配symbol+地址，避免DexScreener把别的币排第一
  const sym = NATIVE_SYMBOLS[chain];
  const pair = d?.pairs?.find(p => p.baseToken?.symbol === sym && parseFloat(p.priceUsd) > 1)
    || d?.pairs?.find(p => parseFloat(p.liquidity?.usd || 0) > 1000000) // 退而求其次找高流动性的
    || d?.pairs?.[0];
  const price = parseFloat(pair?.priceUsd || 0);
  if (price > 0) nativePriceCache[chain] = { price, time: Date.now() };
  return price;
}

// ============ PHASE 4: 交易层 ============
let buyLock = false;
async function executeBuy(chain, tokenAddress, symbol, confirmCount, confirmWallets = []) {
  // 并发锁 — 防止同时买入超过上限
  if (buyLock) { log('WARN', `⏳ 买入锁定中，跳过 ${symbol}`); return; }
  buyLock = true;
  try {
    return await _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets);
  } finally { buyLock = false; }
}

async function _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets) {
  // 二次检查持仓上限（防并发穿透）
  if (Object.keys(positions).length >= CONFIG.maxPositions) {
    log('WARN', `持仓已满(${CONFIG.maxPositions}个)，跳过 ${symbol}`);
    return;
  }
  // 确定仓位大小
  let size = CONFIG.positionSizeDefault;
  // 找参与的最高排名钱包
  const relatedWallets = rankedWallets.filter(w => w.chain === chain);
  // TODO: 精确匹配哪个钱包买了这个token
  // 暂用confirmCount加权
  if (confirmCount >= 5) size = CONFIG.positionSizeTop10;
  else if (confirmCount >= 3) size = CONFIG.positionSizeTop30;
  
  // 美元转原生代币单位（用缓存价格，30秒刷新）
  let nativeAmount;
  try {
    const price = await getNativePrice(chain);
    if (!price || isNaN(price) || price <= 0) throw new Error(`${chain}价格异常: ${price}`);
    
    if (chain === 'solana') {
      nativeAmount = Math.floor((size / price) * 1e9); // lamports
      log('INFO', `💰 买入 ${symbol}(${chain}) $${size} = ${(nativeAmount/1e9).toFixed(4)} SOL SM确认=${confirmCount}`);
    } else {
      nativeAmount = BigInt(Math.floor((size / price) * 1e18)).toString(); // wei
      const unit = chain === 'bsc' ? 'BNB' : 'ETH';
      log('INFO', `💰 买入 ${symbol}(${chain}) $${size} = ${(size/price).toFixed(6)} ${unit} SM确认=${confirmCount}`);
    }
  } catch(e) {
    log('ERROR', `价格转换失败 ${symbol}(${chain}): ${e.message}`);
    return;
  }
  
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    const trader = require('./dex_trader.js');
    if (attempt > 1) log('INFO', `🔄 重试买入 ${symbol}(${chain}) 第${attempt}次...`);
    const result = await trader.buy(chain, tokenAddress, nativeAmount);
    
    if (result.success) {
      // 查实际获得的token数量和价格
      let buyPrice = 0, buyAmount = 0;
      try {
        await sleep(3000); // 等链上确认
        const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        buyPrice = parseFloat(d?.pairs?.[0]?.priceUsd || 0);
        
        if (chain === 'solana') {
          // 查token余额
          const balData = await rpcPost(SOL_PUBLIC_RPC, 'getTokenAccountsByOwner', [
            require('./dex_trader.js').getWalletAddress('solana'),
            { mint: tokenAddress },
            { encoding: 'jsonParsed' }
          ]);
          const accts = balData.result?.value || [];
          for (const a of accts) {
            buyAmount += parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
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
      
      // 把EVM token加入known_tokens（看板扫描用）
      if (chain !== 'solana') {
        const ktFile = path.join(DATA_DIR, 'known_tokens.json');
        try {
          const kt = JSON.parse(fs.readFileSync(ktFile, 'utf8'));
          if (!kt.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase())) {
            kt.push({ chain: chain, address: tokenAddress, symbol });
            fs.writeFileSync(ktFile, JSON.stringify(kt, null, 2));
          }
        } catch { fs.writeFileSync(ktFile, JSON.stringify([{ chain, address: tokenAddress, symbol }], null, 2)); }
      }
      
      log('INFO', `✅ 买入成功 ${symbol} | $${size} | 数量=${buyAmount} | 价格=$${buyPrice} | tx: ${result.txHash || '?'}`);
      
      // 通知
      await notifyTelegram(`🟢 v8买入 ${symbol}(${chain})\n💰 $${size} | SM×${confirmCount}\n🔗 ${result.txHash || ''}`);
    } else {
      log('WARN', `❌ 买入失败 ${symbol}: ${result.error}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // 递增等待
        continue;
      }
    }
    break; // 成功或最后一次失败，退出循环
  } catch(e) {
    log('ERROR', `买入异常 ${symbol}(第${attempt}次): ${e.message}`);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
  }
  } // end retry loop
}

async function executeSell(tokenAddress, reason, ratio = 1.0) {
  const pos = positions[tokenAddress];
  if (!pos) return;
  
  const sellAmount = pos.buyAmount * ratio;
  log('INFO', `💸 卖出 ${pos.symbol}(${pos.chain}) ${(ratio*100).toFixed(0)}% 原因:${reason}`);
  
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const trader = require('./dex_trader.js');
      if (attempt > 1) log('INFO', `🔄 重试卖出 ${pos.symbol}(${pos.chain}) 第${attempt}次...`);
      const result = await trader.sell(pos.chain, tokenAddress, sellAmount);
      
      if (result.success) {
        if (ratio >= 0.99) {
          delete positions[tokenAddress];
        } else {
          pos.buyAmount -= sellAmount;
        }
        saveJSON(POSITIONS_FILE, positions);
        log('INFO', `✅ 卖出成功 ${pos.symbol} | tx: ${result.txHash || '?'}`);
        await notifyTelegram(`🔴 v8卖出 ${pos.symbol}(${pos.chain})\n📉 原因: ${reason}\n🔗 ${result.txHash || ''}`);
        break;
      } else if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
    } catch(e) {
      log('ERROR', `卖出异常 ${pos.symbol}(第${attempt}次): ${e.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
    }
  }
}

// ============ 持仓管理 ============
async function managePositions() {
  while (true) {
    for (const [tokenAddr, pos] of Object.entries(positions)) {
      try {
        // 查当前价格
        const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
        const pair = d?.pairs?.[0];
        if (!pair) continue;
        
        const currentPrice = parseFloat(pair.priceUsd || 0);
        if (!currentPrice || !pos.buyPrice) continue;
        
        const pnlPercent = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
        const holdTime = Date.now() - pos.buyTime;
        
        // 跟卖：查SM钱包是否还持有该token（余额=0→验证是卖出还是转仓）
        if (pos.confirmWallets) {
          try {
            for (const smWallet of pos.confirmWallets) {
              if (sellTracker[tokenAddr]?.some(s => s.wallet === smWallet)) continue; // 已确认过
              
              if (pos.chain === 'solana') {
                // SOL: 查token余额
                const balData = await rpcPost(SOL_PUBLIC_RPC, 'getTokenAccountsByOwner', [
                  smWallet, { mint: tokenAddr }, { encoding: 'jsonParsed' }
                ]);
                const bal = balData.result?.value?.reduce((s, a) => 
                  s + parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0) || 0;
                if (bal === 0) {
                  // 查最近签名看是不是swap
                  const sigs = await rpcPost(SOL_PUBLIC_RPC, 'getSignaturesForAddress', [smWallet, { limit: 3 }]);
                  for (const sig of (sigs.result || [])) {
                    if (!sig.err) await parseSolSignature(smWallet, sig.signature);
                  }
                }
              } else {
                // EVM: 查token余额
                const { ethers } = require('ethers');
                const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
                const bal = await erc20.balanceOf(smWallet);
                if (bal.toString() === '0') {
                  // 余额=0，查最近一笔涉及该token的交易验证
                  // 这里不直接算卖出，WebSocket的verifyEvmSell会处理
                  // 但如果WS漏掉了，查一次该钱包最近交易
                  const txCount = await provider.getTransactionCount(smWallet);
                  // 无法直接查ERC20 transfer历史，依赖WS检测
                  // 标记为"待确认离场"
                  log('INFO', `⏳ SM ${smWallet.slice(0,8)}... 余额=0 ${tokenAddr.slice(0,8)}... 等WS确认是卖出还是转仓`);
                }
              }
            }
          } catch(e) {}
        }
        
        const sells = sellTracker[tokenAddr] || [];
        const uniqueSellers = new Set(sells.map(s => s.wallet)).size;
        const totalConfirm = pos.confirmCount || 2;
        const sellRatio = uniqueSellers / totalConfirm; // SM卖出比例
        
        if (sellRatio >= CONFIG.sellThreshold && pos.buyAmount > 0) {
          // 我们的卖出比例 = SM卖出比例
          const ourSellRatio = Math.min(sellRatio, 1.0);
          if (ourSellRatio >= 0.99) {
            await executeSell(tokenAddr, `SM全部卖出(${uniqueSellers}/${totalConfirm})`);
          } else {
            // 部分卖出
            const alreadySold = pos.soldRatio || 0;
            const toSell = ourSellRatio - alreadySold;
            if (toSell > 0.05) { // 至少卖5%才执行（避免频繁小额卖出）
              await executeSell(tokenAddr, `跟卖${(ourSellRatio*100).toFixed(0)}%(${uniqueSellers}/${totalConfirm}SM卖出)`, toSell / (1 - alreadySold));
              pos.soldRatio = ourSellRatio;
              saveJSON(POSITIONS_FILE, positions);
            }
          }
          continue;
        }
        
        // 时间止损（>4小时无SM动作且盈亏在±10%内 → 平掉腾仓位）
        if (holdTime > CONFIG.timeLimitMs && Math.abs(pnlPercent) < CONFIG.timeLimitPnlRange && uniqueSellers === 0) {
          await executeSell(tokenAddr, `时间止损 ${(holdTime/3600000).toFixed(1)}h PnL=${pnlPercent.toFixed(1)}%`);
          continue;
        }
        
        saveJSON(POSITIONS_FILE, positions);
      } catch(e) {}
      await sleep(500);
    }
    await sleep(10000); // 10秒检查一轮
  }
}

// ============ 通知 ============
function notifyTelegram(msg) {
  try {
    // 用引擎内部通知，不烧token
    console.log('📢 ' + msg.replace(/\n/g, ' | '));
  } catch(e) {}
}

// ============ MAIN ============
async function main() {
  console.log('⚡ v8 跟单引擎');
  console.log('  数据源: 币安PnL Rank');
  console.log('  监控: SOL WebSocket + BSC/Base 5s轮询');
  console.log('  过滤: 多钱包确认 + 合约审计 + 流动性');
  
  // 加载状态
  positions = loadJSON(POSITIONS_FILE, {});
  blacklist = new Set(loadJSON(BLACKLIST_FILE, []));
  auditCache = loadJSON(AUDIT_CACHE_FILE, {});
  // 已买过的token（含当前持仓）
  boughtTokens = new Set(Object.keys(positions));
  
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
  
  const activeByChain = { solana: 0, bsc: 0, base: 0 };
  const watchByChain = { solana: 0, bsc: 0, base: 0 };
  for (const w of rankedWallets) {
    if (w.status === 'hunter') activeByChain[w.chain]++;
    else watchByChain[w.chain]++;
  }
  const totalActive = Object.values(activeByChain).reduce((a,b) => a+b, 0);
  const totalWatch = Object.values(watchByChain).reduce((a,b) => a+b, 0);
  console.log(`📋 🔥猎手(${totalActive}): SOL=${activeByChain.solana} BSC=${activeByChain.bsc} Base=${activeByChain.base}`);
  console.log(`👀 👁️哨兵(${totalWatch}): SOL=${watchByChain.solana} BSC=${watchByChain.bsc} Base=${watchByChain.base}`);
  console.log(`💼 持仓: ${Object.keys(positions).length}个`);
  
  // Phase 2: 启动监控
  setupSolanaMonitor();
  setupEvmWebSocket('bsc');
  setupEvmWebSocket('base');
  
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
      log('INFO', `  排名更新: ${rankedWallets.length}个钱包 (库${Object.keys(walletDb).length}个)`);
    } catch(e) {
      log('ERROR', `排名刷新失败: ${e.message}`);
    }
  }, CONFIG.rankRefreshInterval);
  
  console.log('🟢 引擎运行中...');
  
  // 内存管理
  if (global.gc) setInterval(() => global.gc(), 300000);
}

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
