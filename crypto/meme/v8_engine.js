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

// 全局异常兜底 — 防止未捕获异常导致进程崩溃丢数据
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
  try {
    const fs2 = require('fs'), path2 = require('path');
    const dir = path2.join(__dirname, 'data', 'v8');
    const save = (f, d) => { try { fs2.writeFileSync(path2.join(dir, f), JSON.stringify(d, null, 2)); } catch {} };
    if (typeof pendingSignals !== 'undefined' && Object.keys(pendingSignals).length > 0) save('pending_signals.json', pendingSignals);
    if (typeof positions !== 'undefined' && Object.keys(positions).length > 0) save('positions.json', positions);
    // walletDb不在崩溃时保存（防止空数据覆盖）
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] unhandledRejection: ${reason?.message || reason}`);
});

// ============ CONFIG ============
const CONFIG = {
  // 数据刷新
  rankRefreshInterval: 4 * 3600 * 1000,  // 4小时刷新币安排名
  // 不限数量，验证通过的全部跟踪，排名只决定优先级
  hunterMinWinRate: 70,                     // 猎手: 胜率≥70%
  scoutMinWinRate: 60,                      // 哨兵: 胜率60-70%
  // <60% 不入库; ≥70% = 猎手(hunter); 60-70% = 哨兵(scout)

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
  
  // 启用的链（关掉的链不监控、不交易）
  enabledChains: ['solana', 'bsc', 'base'],  // 三链全开
};

// ============ PATHS ============
const DATA_DIR = path.join(__dirname, 'data', 'v8');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');  // 排名快照（展示用）
const WALLET_DB_FILE = path.join(DATA_DIR, 'wallet_db.json');   // 钱包库（持久化）
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const AUDIT_CACHE_FILE = path.join(DATA_DIR, 'audit_cache.json');
const BOUGHT_TOKENS_FILE = path.join(DATA_DIR, 'bought_tokens.json');
const TRADE_LOG_FILE = path.join(DATA_DIR, 'trade_log.json');
const PENDING_SIGNALS_FILE = path.join(DATA_DIR, 'pending_signals.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ STATE ============
let walletDb = {};         // 钱包库 { "addr_chain": { address, chain, pnl, winRate, tokens, ... } }
let rankedWallets = [];    // 排名后的钱包列表（从walletDb生成）
let positions = {};        // tokenAddress -> position
let pendingSignals = {};   // tokenAddress -> [{wallet, chain, timestamp}]
// 恢复持久化的确认数据
try {
  if (fs.existsSync(PENDING_SIGNALS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PENDING_SIGNALS_FILE, 'utf8'));
    const now = Date.now();
    let restored = 0;
    for (const [token, signals] of Object.entries(saved)) {
      const valid = signals.filter(s => now - s.timestamp < CONFIG.confirmWindowMs);
      if (valid.length > 0) { pendingSignals[token] = valid; restored += valid.length; }
    }
    if (restored > 0) console.log(`📦 恢复确认数据: ${Object.keys(pendingSignals).length}个币 ${restored}条信号`);
  }
} catch(e) { console.warn(`恢复确认数据失败: ${e.message}`); }
let boughtTokens = new Set(); // 已买过的token（防重复）
let tradeHistory = {};     // tokenAddress -> { lastSoldTime, lastBuyPrice, soldCount, pnl } SM二次买入参考
const lowBalNotified = {};    // 低余额通知去重（chain → timestamp）

// 记录交易历史（清仓时调用）
function recordTradeHistory(tokenAddr, pos) {
  tradeHistory[tokenAddr] = {
    lastSoldTime: Date.now(),
    lastBuyPrice: pos.buyPrice || 0,
    buyCost: pos.buyCost || 0,
    symbol: pos.symbol,
    chain: pos.chain,
    soldCount: (tradeHistory[tokenAddr]?.soldCount || 0) + 1,
    confirmWallets: pos.confirmWallets || [],
  };
}

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
  'https://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/',
  'https://api.mainnet-beta.solana.com',
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
    console.warn(`[WARN] 🔌 SOL RPC #${idx} 限速，切换到 #${solRpcIdx}`);
  }
}
const SOL_QN_RPC = SOL_RPCS[0];
const SOL_PUBLIC_RPC = SOL_RPCS[0]; // 兼容旧引用

// Token-2022兼容：查余额同时查spl-token和spl-token-2022
async function getSolTokenBalance(owner, mint) {
  let total = 0;
  let anySuccess = false;
  const seenAccounts = new Set();
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    try {
      const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
        owner, { mint }, { encoding: 'jsonParsed', programId, commitment: 'confirmed' }
      ]);
      anySuccess = true;
      for (const a of (balData.result?.value || [])) {
        const pubkey = a.pubkey;
        if (seenAccounts.has(pubkey)) continue; // 去重！
        seenAccounts.add(pubkey);
        total += parseFloat(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
      }
    } catch(e) {
      console.warn(`[WARN] getSolTokenBalance ${programId.slice(0,10)} 失败: ${e.message?.slice(0,50)}`);
    }
  }
  // 两个programId都RPC失败→返回-1（不是0），防止误判余额=0
  if (!anySuccess) return -1;
  return total;
}


// 已知DEX程序ID（SOL）
const SOL_DEX_PROGRAMS = new Set([
  'pAMMBay6oceH9fJKkHRpqjoYXGmXnrfLz',        // Pump.fun AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun (old)
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',  // Raydium Route
]);

// 查SM余额=0时，判断是DEX卖出还是转仓
// 返回 'sold'（DEX卖出）、'transferred'（转到普通钱包）、'unknown'（查不到）
async function checkSolSellOrTransfer(smWallet, mint) {
  try {
    // 先找SM的token account
    const ataResp = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
      smWallet, { mint }, { encoding: 'jsonParsed', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }
    ]);
    let tokenAccount = ataResp.result?.value?.[0]?.pubkey;
    if (!tokenAccount) {
      // 试Token-2022
      const ata2 = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
        smWallet, { mint }, { encoding: 'jsonParsed', programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }
      ]);
      tokenAccount = ata2.result?.value?.[0]?.pubkey;
    }
    if (!tokenAccount) {
      // token account还没索引到，改查SM主钱包最近交易
      const walletSigsResp = await rpcPost(getSolRpc(), 'getSignaturesForAddress', [smWallet, { limit: 3 }]);
      const walletSigs = walletSigsResp.result || [];
      for (const ws of walletSigs) {
        if (!ws.signature) continue;
        try {
          const txResp2 = await rpcPost(getSolRpc(), 'getTransaction', [ws.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          const tx2 = txResp2.result;
          if (!tx2) continue;
          // 这笔交易涉及目标token吗？
          const postBals = (tx2.meta?.postTokenBalances || []).filter(b => b.mint === mint && b.owner === smWallet);
          if (postBals.length === 0) continue;
          // 涉及目标token，看余额变化
          const preBal = (tx2.meta?.preTokenBalances || []).find(b => b.mint === mint && b.owner === smWallet)?.uiTokenAmount?.uiAmount || 0;
          const postBal = postBals[0]?.uiTokenAmount?.uiAmount || 0;
          if (postBal > preBal) return 'transferred'; // 买入
          // 余额减少，查是否DEX
          const allPrograms = new Set();
          for (const ix of (tx2.transaction?.message?.instructions || [])) { const p = ix.programId || ix.program; if (p) allPrograms.add(p); }
          for (const inner of (tx2.meta?.innerInstructions || [])) { for (const ix of (inner.instructions || [])) { const p = ix.programId || ix.program; if (p) allPrograms.add(p); } }
          for (const p of allPrograms) { if (SOL_DEX_PROGRAMS.has(p)) return 'sold'; }
          // 没DEX，查接收方小号有没有余额
          const otherOwners2 = (tx2.meta?.postTokenBalances || [])
            .filter(b => b.mint === mint && b.owner && b.owner !== smWallet)
            .map(b => b.owner);
          for (const recv of otherOwners2) {
            try { if (await getSolTokenBalance(recv, mint) > 0) return 'transferred'; } catch {}
          }
          return 'sold';
        } catch {}
      }
      return 'unknown'; // 3笔都查不到涉及token的交易
    }
    
    // 查token account最近1笔交易
    const sigsResp = await rpcPost(getSolRpc(), 'getSignaturesForAddress', [tokenAccount, { limit: 1 }]);
    const sig = sigsResp.result?.[0]?.signature;
    if (!sig) return 'unknown';
    
    // 解析交易，看是否涉及DEX程序
    const txResp = await rpcPost(getSolRpc(), 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const tx = txResp.result;
    if (!tx) return 'unknown';
    
    // 先看SM的token余额变化方向：增加=买入，减少=卖出/转出
    const pre = (tx.meta?.preTokenBalances || []).find(b => b.mint === mint && b.owner === smWallet);
    const post = (tx.meta?.postTokenBalances || []).find(b => b.mint === mint && b.owner === smWallet);
    const preBal = pre?.uiTokenAmount?.uiAmount || 0;
    const postBal = post?.uiTokenAmount?.uiAmount || 0;
    
    if (postBal > preBal) return 'transferred'; // 余额增加=刚买入，不是卖出（算持有）
    if (postBal >= preBal && postBal > 0) return 'transferred'; // 余额没变且>0=无关交易
    
    // 余额减少了，检查是DEX卖出还是转仓
    const instructions = tx.transaction?.message?.instructions || [];
    const innerInstructions = tx.meta?.innerInstructions || [];
    const allPrograms = new Set();
    for (const ix of instructions) {
      const pid = ix.programId || ix.program;
      if (pid) allPrograms.add(pid);
    }
    for (const inner of innerInstructions) {
      for (const ix of (inner.instructions || [])) {
        const pid = ix.programId || ix.program;
        if (pid) allPrograms.add(pid);
      }
    }
    
    for (const p of allPrograms) {
      if (SOL_DEX_PROGRAMS.has(p)) return 'sold';
    }
    // 没DEX程序，查接收方有没有持有该token（转仓验证）
    // 从postTokenBalances找其他owner（不是SM自己的）
    const otherOwners = (tx.meta?.postTokenBalances || [])
      .filter(b => b.mint === mint && b.owner && b.owner !== smWallet)
      .map(b => b.owner);
    for (const receiver of otherOwners) {
      try {
        const recvBal = await getSolTokenBalance(receiver, mint);
        if (recvBal > 0) return 'transferred'; // 小号确实持有，是转仓
      } catch {}
    }
    return 'sold'; // 没找到持有的小号，算卖出
  } catch(e) {
    console.warn(`[WARN] checkSolSellOrTransfer ${smWallet.slice(0,10)} 异常: ${e.message?.slice(0,50)}`);
    return 'unknown';
  }
}

// EVM: 判断是DEX卖出还是转仓（查最近一笔token Transfer事件的接收方是否是合约）
async function checkEvmSellOrTransfer(chain, smWallet, tokenAddress) {
  try {
    const provider = chain === 'bsc' ? bscProvider : baseProvider;
    const erc20 = new ethers.Contract(tokenAddress, ['event Transfer(address indexed from, address indexed to, uint256 value)'], provider);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 500);
    
    // 先查有没有转入（买入）
    const inFilter = erc20.filters.Transfer(null, smWallet);
    const inEvents = await erc20.queryFilter(inFilter, fromBlock, currentBlock);
    
    // 再查转出（卖出/转仓）
    const outFilter = erc20.filters.Transfer(smWallet, null);
    const outEvents = await erc20.queryFilter(outFilter, fromBlock, currentBlock);
    
    if (inEvents.length === 0 && outEvents.length === 0) return 'unknown';
    
    // 比较最近一笔：转入更新=刚买入，转出更新=卖出/转仓
    const lastIn = inEvents.length > 0 ? inEvents[inEvents.length - 1] : null;
    const lastOut = outEvents.length > 0 ? outEvents[outEvents.length - 1] : null;
    
    if (!lastOut) return 'transferred'; // 只有转入没有转出=刚买入
    if (!lastIn || lastOut.blockNumber > lastIn.blockNumber) {
      // 最近一笔是转出，查接收方是合约（DEX）还是EOA（转仓）
      const toAddr = lastOut.args?.[1] || lastOut.args?.to;
      if (!toAddr) return 'unknown';
      const code = await provider.getCode(toAddr);
      if (code && code !== '0x') return 'sold';
      // EOA，查这个地址有没有余额（转仓验证）
      try {
        const erc20Check = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
        const recvBal = await erc20Check.balanceOf(toAddr);
        if (recvBal > 0n) return 'transferred'; // 小号确实持有
      } catch {}
      return 'sold'; // EOA但没余额，不算转仓
    }
    return 'transferred'; // 最近一笔是转入=刚买入
  } catch(e) {
    console.warn(`[WARN] checkEvmSellOrTransfer ${smWallet.slice(0,10)} 异常: ${e.message?.slice(0,50)}`);
    return 'unknown';
  }
}


const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: process.env.OKX_API_KEY || '',
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '',
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || '',
};

const bscProvider = new ethers.JsonRpcProvider('https://smart-snowy-patina.bsc.quiknode.pro/4ef7626a956d23dd691755d8f81d3b4489072098/');
const baseProvider = new ethers.JsonRpcProvider('https://green-polished-glitter.base-mainnet.quiknode.pro/e2d252d6fc15ae83fa0369621e55fc847b63c0e1/');

// Multicall3: 一次RPC批量查N个EVM余额（BSC/Base都有）
const MULTICALL3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])'
];
const ERC20_BALANCE_SIG = '0x70a08231'; // balanceOf(address)
const ERC20_DECIMALS_SIG = '0x313ce567'; // decimals()

/**
 * 批量查询EVM token余额（Multicall3，1次RPC搞定N个地址）
 * @param {string} chainKey - 'bsc' | 'base'
 * @param {string} tokenAddr - token合约地址
 * @param {string[]} wallets - 要查的钱包地址列表
 * @returns {Map<string, {bal: bigint, balNum: number}>} wallet → balance（查询失败的不在map中）
 */
async function batchBalanceOf(chainKey, tokenAddr, wallets) {
  const result = new Map();
  if (!wallets.length) return result;
  const provider = chainKey === 'bsc' ? bscProvider : baseProvider;
  const mc = new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, provider);
  
  // 构建calls: 每个wallet查balanceOf + 第一个额外查decimals
  const calls = [];
  // 先查decimals
  calls.push({
    target: tokenAddr,
    allowFailure: true,
    callData: ERC20_DECIMALS_SIG
  });
  // 再查每个wallet的balanceOf
  for (const w of wallets) {
    const paddedAddr = ethers.zeroPadValue(w.toLowerCase(), 32);
    calls.push({
      target: tokenAddr,
      allowFailure: true,
      callData: ERC20_BALANCE_SIG + paddedAddr.slice(2)
    });
  }
  
  try {
    const results = await mc.aggregate3(calls);
    // 解析decimals
    let decimals = 18;
    if (results[0].success && results[0].returnData.length >= 66) {
      try { decimals = parseInt(results[0].returnData, 16); } catch { decimals = 18; }
    }
    // 解析每个wallet的余额
    for (let i = 0; i < wallets.length; i++) {
      const r = results[i + 1]; // +1因为第0个是decimals
      if (r.success && r.returnData.length >= 66) {
        try {
          const bal = BigInt(r.returnData);
          const balNum = parseFloat(ethers.formatUnits(bal, decimals));
          result.set(wallets[i].toLowerCase(), { bal, balNum });
        } catch {}
      }
    }
  } catch(e) {
    // Multicall失败→逐个查（fallback）
    console.warn(`[WARN] Multicall3失败(${chainKey}): ${e.message?.slice(0,40)}，逐个查`);
    for (const w of wallets) {
      try {
        const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
        const [bal, dec] = await Promise.all([erc20.balanceOf(w), erc20.decimals()]);
        const balNum = parseFloat(ethers.formatUnits(bal, dec));
        result.set(w.toLowerCase(), { bal, balNum });
      } catch {}
    }
  }
  return result;
}

// SOL余额缓存（仅SOL用，EVM走Multicall不需要缓存了）
const _solBalanceCache = {};
const SOL_BALANCE_CACHE_TTL = 30000; // SOL缓存30秒（比EVM短，因为没Multicall）
function getCachedSolBalance(wallet, token) {
  const key = wallet + '_' + token;
  const c = _solBalanceCache[key];
  if (c && Date.now() - c.time < SOL_BALANCE_CACHE_TTL) return c.value;
  return undefined;
}
function setCachedSolBalance(wallet, token, value) {
  const key = wallet + '_' + token;
  _solBalanceCache[key] = { value, time: Date.now() };
  if (!setCachedSolBalance._count) setCachedSolBalance._count = 0;
  if (++setCachedSolBalance._count % 100 === 0) {
    const now = Date.now();
    for (const k in _solBalanceCache) { if (now - _solBalanceCache[k].time > SOL_BALANCE_CACHE_TTL * 2) delete _solBalanceCache[k]; }
  }
}

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

// 防抖保存pendingSignals（最多每5秒写一次磁盘）
let _pendingSaveTimer = null;
function savePendingSignals() {
  if (_pendingSaveTimer) return;
  _pendingSaveTimer = setTimeout(() => {
    _pendingSaveTimer = null;
    try { saveJSON(PENDING_SIGNALS_FILE, pendingSignals); } catch {}
  }, 5000);
}
const loadJSON = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };

// 交易日志：追加写入，每条一行JSON（JSONL格式，方便复盘）
function logTrade(entry) {
  try {
    fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch(e) { log('WARN', `写trade_log失败: ${e.message?.slice(0,40)}`); }
}

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

// fetch with timeout (防DexScreener/OKX挂住阻塞)
async function fetchTimeout(url, opts = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
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
    if (!CONFIG.enabledChains.includes(chainKey)) continue;
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
        // 过滤余额<0.5 SOL的空壳地址
        if (bal < 0.5) continue;
        // 过滤无swap交易的地址（查最近5笔，必须有非System Program交互）
        try {
          const sigs = await rpcPost(getSolRpc(), 'getSignaturesForAddress', [w.address, { limit: 5 }]);
          if (!sigs?.result?.length) continue;
          // 抽查第一笔成功交易，看是否涉及DEX程序
          const firstOk = sigs.result.find(s => !s.err);
          if (firstOk) {
            const txDetail = await rpcPost(getSolRpc(), 'getTransaction', [firstOk.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
            const programs = (txDetail?.result?.transaction?.message?.instructions || []).map(i => i.programId || i.program || '');
            const hasSwap = programs.some(p => 
              p !== '11111111111111111111111111111111' && // System Program
              p !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && // Token Program (transfer只用这个)
              p !== 'ComputeBudget111111111111111111111111111111'
            );
            if (!hasSwap) {
              log('INFO', `  🚫 ${w.address.slice(0,10)} SOL无swap交易，跳过`);
              continue;
            }
          }
        } catch {}
        w.verifiedBal = bal; verified.push(w);
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
  
  // 更新/新增（WR<60%不入库）
  for (const w of verifiedWallets) {
    const wr = w.winRate || 0;
    const key = w.address + '_' + w.chain;
    seenKeys.add(key);
    
    if (walletDb[key]) {
      // 已有 → 更新数据
      walletDb[key].lastSeen = now;
      if (w.winRate !== undefined) walletDb[key].winRate = w.winRate;
      if (w.pnl !== undefined) walletDb[key].pnl = w.pnl;
      if (w.tokens !== undefined) walletDb[key].tokens = w.tokens;
      if (w.txCount !== undefined) walletDb[key].txCount = w.txCount;
      // 已有钱包WR跌到<60%→踢出
      if (walletDb[key].winRate < CONFIG.scoutMinWinRate) {
        delete walletDb[key];
        continue;
      }
    } else {
      // 新钱包 → WR≥60%才入库
      if (wr < CONFIG.scoutMinWinRate) continue;
      walletDb[key] = {
        ...w,
        addedAt: now,
        lastSeen: now,
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
  // 综合评分: 胜率 × 样本量 × 盈利能力
  for (const w of wallets) {
    const wr = (w.winRate || 0) / 100;                        // 0~1
    const sampleWeight = Math.log2((w.tokens || 1) + 1);      // 交易币数，log防大户碾压
    const pnlWeight = Math.log10(Math.max(w.pnl, 1) + 1);    // PnL取log
    w.score = wr * sampleWeight * pnlWeight;
    
    // 三级状态: ≥60%=hunter(猎手), 50-60%=scout(哨兵), <50%=watcher(观察)
    const winRate = w.winRate || 0;
    const tokens = w.tokens || 0;
    const key2 = w.address + '_' + w.chain;
    // SOL空壳过滤：余额<0.5 SOL强制观察（无swap的空地址/bot）
    if (w.chain === 'solana' && (w.verifiedBal || 0) < 0.5) {
      w.status = 'watcher';
    } else if (winRate >= CONFIG.hunterMinWinRate) {
      w.status = 'hunter';
    } else if (winRate >= CONFIG.scoutMinWinRate) {
      w.status = 'scout';
    } else {
      w.status = 'watcher';
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
      // 观察钱包直接踢出（不再入库）
      if (w.status === 'watcher') {
        evictKeys.push(key);
      }
    }
  }
  for (const k of evictKeys) delete walletDb[k];
  
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

const SOL_WS_OFFICIAL = 'wss://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/'; // QuickNode WS（无订阅限制）
let solOfficialWs = null; // 单连接
let solWsMode = 'none'; // 'official' | 'polling'
const solWsSubscribedAddrs = new Set(); // WS已订阅的钱包（轮询时跳过）

function setupSolanaMonitor() {
  const solWallets = rankedWallets.filter(w => w.chain === 'solana' && (w.status === 'hunter' || w.status === 'scout'));
  for (const w of solWallets) solWalletSet.add(w.address);
  
  if (solWalletSet.size === 0) return;
  
  // Solana官方WS最多100个订阅，猎手+哨兵优先，观察走轮询
  setupOfficialSolWs();
  
  
  // 兜底: 轮询（最慢但最稳）
  pollSolanaWallets();
}

// SOL WS统一重连：防抖+递增退避+锁
let _solWsReconnectTimer = null;
let _solWsReconnectDelay = 10000; // 起步10秒
const _SOL_WS_MAX_DELAY = 120000; // 最大120秒
function _triggerSolWsReconnect() {
  if (_solWsReconnectTimer) return; // 已有定时器在等，跳过
  const delay = Math.min(_solWsReconnectDelay, _SOL_WS_MAX_DELAY);
  log('INFO', `🔌 [SOL] WS将在${Math.round(delay/1000)}秒后重连`);
  _solWsReconnectTimer = setTimeout(() => {
    _solWsReconnectTimer = null;
    _solWsReconnectDelay = Math.min(_solWsReconnectDelay * 1.5, _SOL_WS_MAX_DELAY); // 递增
    setupOfficialSolWs();
  }, delay);
}
function _resetSolWsReconnectDelay() { _solWsReconnectDelay = 10000; } // WS成功连接后重置

// 单连接重连：只重建断掉的那个WS，不影响其他连接
const _singleWsReconnectTimers = {};
const _singleWsReconnectDelays = {};
function _reconnectSingleSolWs(ci, chunk) {
  if (_singleWsReconnectTimers[ci]) return;
  const delay = Math.min(_singleWsReconnectDelays[ci] || 15000, _SOL_WS_MAX_DELAY);
  log('INFO', `🔌 [SOL] WS#${ci+1} 将在${Math.round(delay/1000)}秒后单独重连(${chunk.length}个钱包)`);
  _singleWsReconnectTimers[ci] = setTimeout(async () => {
    _singleWsReconnectTimers[ci] = null;
    _singleWsReconnectDelays[ci] = Math.min((delay || 15000) * 1.5, _SOL_WS_MAX_DELAY);
    try {
      const ws = new WebSocket(SOL_WS_OFFICIAL);
      if (setupOfficialSolWs._wsPool) setupOfficialSolWs._wsPool[ci] = ws;
      if (ci === 0) solOfficialWs = ws;
      const idToAddr = {};
      let subscribed = 0;
      ws.on('open', async () => {
        _singleWsReconnectDelays[ci] = 15000;
        for (let i = 0; i < chunk.length; i++) {
          if (ws.readyState !== WebSocket.OPEN) break;
          const addr = chunk[i];
          const id = i + 1;
          idToAddr[id] = addr;
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id, method: 'logsSubscribe',
            params: [{ mentions: [addr] }, { commitment: 'confirmed' }]
          }));
          if ((i + 1) % 40 === 0) await new Promise(r => setTimeout(r, 1100));
        }
      });
      const subIdToAddr = {};
      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.id && msg.result !== undefined) {
            subscribed++;
            subIdToAddr[msg.result] = idToAddr[msg.id];
            if (subscribed === chunk.length) log('INFO', `🔌 [SOL] WS#${ci+1} 重连完成 ${subscribed}/${chunk.length}`);
            if (ci === 0 && subscribed === chunk.length) solWsMode = 'official';
            return;
          }
          if (msg.id && msg.error) return;
          if (msg.params?.result) {
            const subId = msg.params.subscription;
            const addr = subIdToAddr[subId];
            const sig = msg.params.result.value?.signature;
            if (sig && addr && !msg.params.result.value?.err) await parseSolSignature(addr, sig);
          }
        } catch(e) {}
      });
      ws.on('close', () => {
        log('WARN', `🔌 [SOL] WS#${ci+1} 断开`);
        if (ci === 0) { solOfficialWs = null; solWsMode = 'polling'; }
        _reconnectSingleSolWs(ci, chunk);
      });
      ws.on('error', (e) => { if (e.message) log('WARN', `[SOL] WS#${ci+1}重连错误: ${e.message.slice(0,40)}`); });
      let lastMsgTime = Date.now();
      const origOnMsg = ws.listeners('message')[0];
      if (origOnMsg) {
        ws.removeListener('message', origOnMsg);
        ws.on('message', (d) => { lastMsgTime = Date.now(); origOnMsg(d); });
      }
      const hc = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(hc); return; }
        ws.ping();
        // 动态超时：钱包少的连接消息少，给更长时间
        const silentTimeout = 3600000; // 60分钟无消息才判死（减少无意义重连）
        if (Date.now() - lastMsgTime > silentTimeout) { log('WARN', `[SOL] WS#${ci+1} ${silentTimeout/60000}分钟无消息，主动重连`); clearInterval(hc); ws.close(); }
      }, 60000);
    } catch(e) {
      log('WARN', `[SOL] WS#${ci+1} 重连异常: ${e.message?.slice(0,40)}`);
      _reconnectSingleSolWs(ci, chunk);
    }
  }, delay);
}

// QuickNode WS: 100个/连接限制，多连接分片覆盖全部钱包
function setupOfficialSolWs() {
  // 按优先级排序: hunter > scout > watcher
  const priorityOrder = { hunter: 0, scout: 1, watcher: 2 };
  const sorted = rankedWallets
    .filter(w => w.chain === 'solana' && (w.status === 'hunter' || w.status === 'scout'))
    .sort((a, b) => (priorityOrder[a.status] || 2) - (priorityOrder[b.status] || 2) || (a.rank || 999) - (b.rank || 999));
  const walletList = sorted.map(w => w.address);
  if (walletList.length === 0) return;
  solWsSubscribedAddrs.clear();
  for (const a of walletList) solWsSubscribedAddrs.add(a);
  
  const WS_LIMIT = 95; // 每连接95个（留余量）
  const chunks = [];
  for (let i = 0; i < walletList.length; i += WS_LIMIT) {
    chunks.push(walletList.slice(i, i + WS_LIMIT));
  }
  
  const pollOnly = [...solWalletSet].filter(a => !walletList.includes(a));
  log('INFO', `🔌 [SOL] QuickNode WS订阅${walletList.length}个(${chunks.length}连接×${WS_LIMIT}) + 轮询${pollOnly.length}个`);
  
  // 关闭旧连接
  if (solOfficialWs) { try { solOfficialWs.close(); } catch {} }
  if (!setupOfficialSolWs._wsPool) setupOfficialSolWs._wsPool = [];
  for (const old of setupOfficialSolWs._wsPool) { try { old.close(); } catch {} }
  setupOfficialSolWs._wsPool = [];
  
  // 串行创建连接：一个连接订阅完再开下一个，避免并发超50/s
  async function _setupSingleWs(ci, chunk) {
    return new Promise((resolve) => {
    const ws = new WebSocket(SOL_WS_OFFICIAL);
    setupOfficialSolWs._wsPool.push(ws);
    if (ci === 0) solOfficialWs = ws;
    
    const idToAddr = {};
    let subscribed = 0;
    
    ws.on('open', async () => {
      if (ci === 0) _resetSolWsReconnectDelay();
      for (let i = 0; i < chunk.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const addr = chunk[i];
        const id = i + 1;
        idToAddr[id] = addr;
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id, method: 'logsSubscribe',
          params: [{ mentions: [addr] }, { commitment: 'confirmed' }]
        }));
        // 每30个等1秒（单连接独占50/s限额）
        if ((i + 1) % 30 === 0) await new Promise(r => setTimeout(r, 1100));
      }
    });
    
    const subIdToAddr = {};
  
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id && msg.result !== undefined) {
          subscribed++;
          subIdToAddr[msg.result] = idToAddr[msg.id];
          if (subscribed === 1 || subscribed % 20 === 0 || subscribed === chunk.length) {
            log('INFO', `🔌 [SOL] WS#${ci+1}/${chunks.length} ${subscribed}/${chunk.length} 已订阅`);
          }
          if (ci === 0 && subscribed === chunk.length) solWsMode = 'official';
          return;
        }
        if (msg.id && msg.error) {
          if (subscribed < 3) log('WARN', `🔌 [SOL] WS#${ci+1} 订阅失败 #${msg.id}: ${msg.error.message}`);
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
      log('WARN', `🔌 [SOL] WS#${ci+1} 断开`);
      if (ci === 0) { solOfficialWs = null; solWsMode = 'polling'; }
      // 只重连这一个连接，不影响其他连接
      _reconnectSingleSolWs(ci, chunk);
    });
    
    ws.on('error', (e) => { if (e.message) log('WARN', `[SOL] WS#${ci+1}错误: ${e.message.slice(0,40)}`); });
    
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
      const silentTimeout2 = 3600000;
      if (Date.now() - lastMsgTime > silentTimeout2) {
        log('WARN', `🔌 [SOL] WS#${ci+1} 静默断连(${silentTimeout2/60000}分钟无消息)，主动重连`);
        clearInterval(healthCheck);
        try { ws.removeAllListeners(); ws.terminate(); } catch {}
        if (ci === 0) { solOfficialWs = null; solWsMode = 'polling'; }
        _reconnectSingleSolWs(ci, chunk);
      }
    }, 30000);
    // 等订阅完成再resolve（或超时30秒）
    const checkDone = setInterval(() => {
      if (subscribed >= chunk.length || ws.readyState !== WebSocket.OPEN) { clearInterval(checkDone); resolve(); }
    }, 1000);
    setTimeout(() => { clearInterval(checkDone); resolve(); }, 30000);
    }); // end Promise
  } // end _setupSingleWs
  
  // 串行：一个连接订完再开下一个
  (async () => {
    for (let ci = 0; ci < chunks.length; ci++) {
      await _setupSingleWs(ci, chunks[ci]);
      // 连接之间等2秒
      await new Promise(r => setTimeout(r, 2000));
    }
    log('INFO', `🔌 [SOL] 全部${chunks.length}个WS连接建立完成`);
  })();
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
        // 计算SM花了多少SOL（从preBalances/postBalances）
        let smSpendSol = 0;
        const accountKeys = txData.result?.transaction?.message?.accountKeys?.map(k => typeof k === 'string' ? k : k.pubkey || k) || [];
        // staticAccountKeys+writableAccounts+readonlyAccounts合并（v0交易addressTable格式）
        const loadedW = txData.result?.meta?.loadedAddresses?.writable || [];
        const loadedR = txData.result?.meta?.loadedAddresses?.readonly || [];
        const allKeys = [...accountKeys, ...loadedW, ...loadedR];
        const walletIdx = allKeys.indexOf(walletAddr);
        if (walletIdx >= 0) {
          const preBal = (meta.preBalances || [])[walletIdx] || 0;
          const postBal = (meta.postBalances || [])[walletIdx] || 0;
          smSpendSol = (preBal - postBal) / 1e9;
          if (smSpendSol < 0) smSpendSol = 0; // 负数说明收到SOL不是花出
        }
        // 转USD
        let smBuyAmountUsd = 0;
        if (smSpendSol > 0.01) {
          try {
            const solPrice = await getNativePrice('solana');
            smBuyAmountUsd = smSpendSol * solPrice;
          } catch {}
        }
        const spendTag = smBuyAmountUsd > 0 ? ` $${Math.round(smBuyAmountUsd)}` : '';
        log('INFO', `🔔 [SOL] swap检测! 钱包#${rank} ${walletAddr.slice(0,10)}... 买入 ${p.mint}${spendTag}`);
        await handleSignal({
          chain: 'solana',
          token: p.mint,
          symbol: '?',
          wallet: walletAddr,
          walletRank: rank,
          timestamp: Date.now(),
          smBuyAmountUsd,
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
  bsc: ["wss://smart-snowy-patina.bsc.quiknode.pro/4ef7626a956d23dd691755d8f81d3b4489072098/", "wss://bsc.publicnode.com"],
  base: ["wss://green-polished-glitter.base-mainnet.quiknode.pro/e2d252d6fc15ae83fa0369621e55fc847b63c0e1/", "wss://base.publicnode.com"],
};
const evmWsIdx = { bsc: 0, base: 0 }; // 当前endpoint索引
const evmWsRetries = { bsc: 0, base: 0 };

const _evmWsRefs = {}; // 存WS引用，重连前关旧的
function setupEvmWebSocket(chainKey) {
  const chain = CHAINS[chainKey];
  const walletSet = chainKey === "bsc" ? bscWalletSet : baseWalletSet;
  const wallets = rankedWallets.filter(w => w.chain === chainKey && (w.status === 'hunter' || w.status === 'scout'));
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
            // 异步查SM买入花费（不阻塞信号处理）
            let smBuyAmountUsd = 0;
            try {
              const txHash = logEntry.transactionHash;
              if (txHash) {
                const provider = chainKey === 'bsc' ? bscProvider : baseProvider;
                const tx = await provider.getTransaction(txHash);
                if (tx && tx.value > 0n) {
                  // 原生币(BNB/ETH)买入
                  const nativePrice = await getNativePrice(chainKey);
                  const { ethers } = require('ethers');
                  smBuyAmountUsd = parseFloat(ethers.formatEther(tx.value)) * nativePrice;
                }
                if (smBuyAmountUsd < 1) {
                  // 可能用稳定币买：查同tx里的稳定币Transfer
                  const receipt = await provider.getTransactionReceipt(txHash);
                  const STABLES = {
                    '0x55d398326f99059ff775485246999027b3197955': { sym: 'USDT', dec: 18 }, // BSC USDT
                    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { sym: 'USDC', dec: 18 }, // BSC USDC
                    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { sym: 'BUSD', dec: 18 }, // BSC BUSD
                    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': { sym: 'USD1', dec: 18 }, // BSC USD1
                    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { sym: 'WBNB', dec: 18, native: 'bsc' }, // BSC WBNB
                    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { sym: 'USDC', dec: 6 },  // Base USDC
                    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { sym: 'DAI', dec: 18 },  // Base DAI
                    '0x4200000000000000000000000000000000000006': { sym: 'WETH', dec: 18, native: 'base' }, // Base WETH
                  };
                  const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
                  for (const log2 of (receipt?.logs || [])) {
                    const stableInfo = STABLES[log2.address?.toLowerCase()];
                    if (!stableInfo) continue;
                    if (log2.topics?.[0] !== TRANSFER_SIG) continue;
                    const from2 = '0x' + (log2.topics[1] || '').slice(26).toLowerCase();
                    if (from2 === toAddr) {
                      // SM转出稳定币/WBNB/WETH = 买入花费
                      const { ethers } = require('ethers');
                      let amt = parseFloat(ethers.formatUnits(log2.data, stableInfo.dec));
                      if (stableInfo.native) {
                        // WBNB/WETH需要乘以原生币价格转USD
                        const np = await getNativePrice(stableInfo.native);
                        amt = amt * np;
                      }
                      if (amt > smBuyAmountUsd) smBuyAmountUsd = amt;
                    }
                  }
                }
              }
            } catch(e) { log('WARN', `EVM花费查询失败(WS): ${e.message?.slice(0,40)}`); }
            // 如果第一次没查到，等3秒重试一次（BSC出块3秒，1秒不够）
            if (smBuyAmountUsd < 1 && logEntry.transactionHash) {
              try {
                await sleep(3000);
                const provider2 = chainKey === 'bsc' ? bscProvider : baseProvider;
                const tx2 = await provider2.getTransaction(logEntry.transactionHash);
                if (tx2 && tx2.value > 0n) {
                  const { ethers } = require('ethers');
                  const nativePrice2 = await getNativePrice(chainKey);
                  smBuyAmountUsd = parseFloat(ethers.formatEther(tx2.value)) * nativePrice2;
                }
                if (smBuyAmountUsd < 1) {
                  const receipt2 = await provider2.getTransactionReceipt(logEntry.transactionHash);
                  const STABLES2 = {
                    '0x55d398326f99059ff775485246999027b3197955': { dec: 18 },
                    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { dec: 18 },
                    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { dec: 18 },
                    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': { dec: 18 },
                    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { dec: 18, native: 'bsc' },
                    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { dec: 6 },
                    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { dec: 18 },
                    '0x4200000000000000000000000000000000000006': { dec: 18, native: 'base' },
                  };
                  const TS2 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
                  for (const l2 of (receipt2?.logs || [])) {
                    const si = STABLES2[l2.address?.toLowerCase()];
                    if (!si || l2.topics?.[0] !== TS2) continue;
                    const f2 = '0x' + (l2.topics[1] || '').slice(26).toLowerCase();
                    if (f2 === toAddr) {
                      const { ethers } = require('ethers');
                      let a2 = parseFloat(ethers.formatUnits(l2.data, si.dec));
                      if (si.native) a2 = a2 * await getNativePrice(si.native);
                      if (a2 > smBuyAmountUsd) smBuyAmountUsd = a2;
                    }
                  }
                }
              } catch {}
            }
            const spendTag = smBuyAmountUsd > 1 ? ` $${Math.round(smBuyAmountUsd)}` : '';
            if (smBuyAmountUsd < 1 && logEntry.transactionHash) log('DEBUG', `💰0检测 tx:${logEntry.transactionHash.slice(0,15)} wallet:${toAddr.slice(0,10)}`);
            log("INFO", "🔔 [" + chain.name + "] 买入! 钱包#" + rank + " " + toAddr.slice(0,10) + "... 获得 " + tokenAddr + spendTag);
            await handleSignal({ chain: chainKey, token: tokenAddr, symbol: "?", wallet: toAddr, walletRank: rank, timestamp: Date.now(), smBuyAmountUsd });
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
      if (!CONFIG.enabledChains.includes(chainKey)) continue;
      try {
        // 轮询直接用QuickNode（付费，不限速）
        const pollProvider = chainKey === 'bsc' ? bscProvider : baseProvider;
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
                // 查SM买入花费
                let smBuyAmountUsd = 0;
                try {
                  const txHash = l.transactionHash;
                  if (txHash) {
                    const tx = await pollProvider.getTransaction(txHash);
                    if (tx && tx.value > 0n) {
                      const nativePrice = await getNativePrice(chainKey);
                      smBuyAmountUsd = parseFloat(ethers.formatEther(tx.value)) * nativePrice;
                    }
                    if (smBuyAmountUsd < 1) {
                      const receipt = await pollProvider.getTransactionReceipt(txHash);
                      const STABLES = {
                        '0x55d398326f99059ff775485246999027b3197955': { dec: 18 },
                        '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { dec: 18 },
                        '0xe9e7cea3dedca5984780bafc599bd69add087d56': { dec: 18 },
                        '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': { dec: 18 },
                        '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { dec: 18, native: 'bsc' },
                        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { dec: 6 },
                        '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { dec: 18 },
                        '0x4200000000000000000000000000000000000006': { dec: 18, native: 'base' },
                      };
                      for (const log3 of (receipt?.logs || [])) {
                        const stableInfo = STABLES[log3.address?.toLowerCase()];
                        if (!stableInfo || log3.topics?.[0] !== TRANSFER_TOPIC) continue;
                        const from3 = '0x' + (log3.topics[1] || '').slice(26).toLowerCase();
                        if (from3 === h.address.toLowerCase()) {
                          let amt = parseFloat(ethers.formatUnits(log3.data, stableInfo.dec));
                          if (stableInfo.native) amt = amt * await getNativePrice(stableInfo.native);
                          if (amt > smBuyAmountUsd) smBuyAmountUsd = amt;
                        }
                      }
                    }
                  }
                } catch {}
                const spendTag = smBuyAmountUsd > 1 ? ` $${Math.round(smBuyAmountUsd)}` : '';
                log('INFO', '🔔 [' + chain.name + '] 轮询检测! 猎手#' + h.rank + ' ' + h.address.slice(0,10) + '... 获得 ' + tokenAddr + spendTag);
                await handleSignal({ chain: chainKey, token: tokenAddr, symbol: '?', wallet: h.address.toLowerCase(), walletRank: h.rank, timestamp: Date.now(), smBuyAmountUsd });
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
// 已知稳定币/大币合约地址（信号阶段过滤，不用等审计）
const SKIP_TOKENS = new Set([
  // BSC
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // ETH on BSC
  // Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x4200000000000000000000000000000000000006', // WETH
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  // Solana
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',    // wSOL
].map(a => a.toLowerCase()));

async function handleSignal(signal) {
  const { chain, wallet, walletRank } = signal;
  // EVM地址统一小写，SOL保持原样（base58区分大小写）
  const token = chain === 'solana' ? signal.token : signal.token.toLowerCase();
  
  // 稳定币/大币地址直接跳过（不等审计）
  if (SKIP_TOKENS.has(token.toLowerCase())) return;
  
  // 已持仓 → 不买但把新SM加入confirmWallets（跟卖追踪，上限20个防巡检爆炸）
  if (positions[token]) {
    const pos = positions[token];
    const walletLower = chain === 'solana' ? wallet : wallet.toLowerCase();
    if (pos.confirmWallets && !pos.confirmWallets.includes(wallet) && pos.confirmWallets.length < 20
        && !ALL_ROUTERS.has(walletLower)) {
      pos.confirmWallets.push(wallet);
      // 同步加到allSMWallets
      if (!pos.allSMWallets) pos.allSMWallets = [...pos.confirmWallets];
      if (!pos.allSMWallets.includes(wallet)) pos.allSMWallets.push(wallet);
      saveJSON(POSITIONS_FILE, positions);
      log('INFO', `📎 ${pos.symbol}(${chain}) 新增SM跟踪: ${wallet.slice(0,10)} (共${pos.allSMWallets.length}个)`);
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
    pendingSignals[token].push({ ...signal, walletStatus, smBuyAmountUsd: signal.smBuyAmountUsd || 0 });
  } else if (signal.smBuyAmountUsd > 0) {
    // SM加仓：累加金额（同一SM多次买同一币=加仓，金额叠加）
    const existing = pendingSignals[token].find(s => s.wallet === wallet);
    if (existing) {
      existing.smBuyAmountUsd = (existing.smBuyAmountUsd || 0) + signal.smBuyAmountUsd;
    }
  }
  
  // 清理过期信号（72小时窗口）
  const now = Date.now();
  pendingSignals[token] = pendingSignals[token].filter(s => now - s.timestamp < CONFIG.confirmWindowMs);
  // 过期后清空的key直接删除（防内存泄漏）
  if (pendingSignals[token].length === 0) { delete pendingSignals[token]; savePendingSignals(); return; }
  
  // 持久化确认数据
  savePendingSignals();
  
  // 三级计数: 猎手=确认, 哨兵=佐证, 观察=只记录不算
  const activeSignals = pendingSignals[token].filter(s => s.walletStatus === "hunter");
  const watchSignals = pendingSignals[token].filter(s => s.walletStatus === 'scout');
  const watcherSignals = pendingSignals[token].filter(s => s.walletStatus === 'watcher');
  const confirmCount = new Set(activeSignals.map(s => s.wallet)).size;
  const watchCount = new Set(watchSignals.map(s => s.wallet)).size;
  const watcherCount = new Set(watcherSignals.map(s => s.wallet)).size;
  
  // 分级确认:
  // ≥2个猎手 → 买
  // BSC门槛更高：≥3猎手 或 2猎手+3哨兵（信号多但质量参差不齐）
  // SOL/Base：≥2猎手 或 1猎手+2哨兵
  let confirmed;
  if (chain === 'bsc') {
    confirmed = confirmCount >= 3 || (confirmCount >= 2 && watchCount >= 3);
  } else {
    confirmed = confirmCount >= 2 || (confirmCount >= 1 && watchCount >= 2);
  }
  if (!confirmed) {
    const bestRank = Math.min(...pendingSignals[token].map(s => s.walletRank || 999));
    // 去重日志：同token+同确认数 60秒内不重复打印
    if (!handleSignal._logDedup) handleSignal._logDedup = {};
    const dedupKey = `${token}_${confirmCount}_${watchCount}`;
    const now = Date.now();
    if (!handleSignal._logDedup[dedupKey] || now - handleSignal._logDedup[dedupKey] >= 60000) {
      handleSignal._logDedup[dedupKey] = now;
      const extra = (watchCount > 0 ? ` +${watchCount}哨兵` : '') + (watcherCount > 0 ? ` +${watcherCount}观察` : '');
      log('INFO', `⏳ ${token.slice(0,10)}(${chain}) 确认中 猎手=${confirmCount} 哨兵=${watchCount}${extra} 最高#${bestRank}`);
      // 清理过期key
      if (Object.keys(handleSignal._logDedup).length > 200) {
        for (const k in handleSignal._logDedup) { if (now - handleSignal._logDedup[k] > 120000) delete handleSignal._logDedup[k]; }
      }
    }
    return;
  }
  
  // 同名币去重：持仓中→拒绝
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
  let stillConfirmed;
  if (chain === 'bsc') {
    stillConfirmed = filteredConfirmCount >= 3 || (filteredConfirmCount >= 2 && filteredWatchCount >= 3);
  } else {
    stillConfirmed = filteredConfirmCount >= 2 || (filteredConfirmCount >= 1 && filteredWatchCount >= 2);
  }
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
      const allSigs = [...nonSpamHunters, ...nonSpamScouts];
      
      if (chain === 'solana') {
        // SOL: 逐个查，走缓存
        const results = await Promise.all(allSigs.map(async (sig) => {
          const cachedSolBal = getCachedSolBalance(sig.wallet, token);
          if (cachedSolBal !== undefined) {
            let holdingUsd = cachedSolBal * price;
            return { sig, holdingUsd };
          }
          // 无缓存，查一次失败再查一次
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const bal = await getSolTokenBalance(sig.wallet, token);
              setCachedSolBalance(sig.wallet, token, bal);
              let holdingUsd = bal * price;
              return { sig, holdingUsd };
            } catch {
              if (attempt === 1) await new Promise(r => setTimeout(r, 500));
            }
          }
          return { sig, holdingUsd: -1 };
        }));
        for (const { sig, holdingUsd } of results) {
          if (holdingUsd === -1) {
            // 查询失败，不计入确认（宁可漏跟不误跟）
            log('WARN', `⚠️ ${sig.wallet.slice(0,10)} SOL余额查询失败，不计入确认`);
          } else if (holdingUsd >= MIN_SM_HOLDING_USD) {
            realConfirmWallets.push(sig.wallet);
            if (sig.walletStatus === 'hunter') realHunters++;
            else realScouts++;
          } else {
            // 余额<$1，查是DEX卖出还是转仓
            const action = await checkSolSellOrTransfer(sig.wallet, token);
            if (action === 'transferred') {
              realConfirmWallets.push(sig.wallet);
              if (sig.walletStatus === 'hunter') realHunters++;
              else realScouts++;
              log('INFO', `📎 ${sig.wallet.slice(0,10)} 余额$${holdingUsd.toFixed(2)}但转到普通钱包（转仓），算确认`);
            } else {
              log('INFO', `🚫 ${sig.wallet.slice(0,10)} 持仓$${holdingUsd.toFixed(2)}<$${MIN_SM_HOLDING_USD}，${action === 'sold' ? 'SM已卖出不跟' : '不算确认'}`);
            }
          }
        }
      } else {
        // EVM: Multicall3批量查所有SM余额（1次RPC）
        const walletAddrs = allSigs.map(s => s.wallet);
        let balMap = await batchBalanceOf(chain, token, walletAddrs);
        // 查不到的再查一次
        const missedWallets = walletAddrs.filter(w => !balMap.has(w.toLowerCase()));
        if (missedWallets.length > 0) {
          log('INFO', `🔄 ${missedWallets.length}个SM余额Multicall未返回，逐个重试`);
          const provider = chain === 'bsc' ? bscProvider : baseProvider;
          for (const w of missedWallets) {
            try {
              const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
              const [bal, dec] = await Promise.all([erc20.balanceOf(w), erc20.decimals().catch(() => 18)]);
              const balNum = parseFloat(ethers.formatUnits(bal, dec));
              balMap.set(w.toLowerCase(), { bal, balNum });
            } catch {}
          }
        }
        for (const sig of allSigs) {
          const info = balMap.get(sig.wallet.toLowerCase());
          let holdingUsd = -1; // -1=查询失败
          if (info) {
            holdingUsd = info.balNum * price;
          }
          // 余额=0但有买入信号的情况：不再特殊处理，余额=0就是卖了
          if (holdingUsd === -1) {
            // 查询失败，不计入确认（宁可漏跟不误跟）
            log('WARN', `⚠️ ${sig.wallet.slice(0,10)} EVM余额查询失败，不计入确认`);
          } else if (holdingUsd >= MIN_SM_HOLDING_USD) {
            realConfirmWallets.push(sig.wallet);
            if (sig.walletStatus === 'hunter') realHunters++;
            else realScouts++;
          } else {
            // 余额<$1，查是DEX卖出还是转仓
            const action = await checkEvmSellOrTransfer(chain, sig.wallet, token);
            if (action === 'transferred') {
              realConfirmWallets.push(sig.wallet);
              if (sig.walletStatus === 'hunter') realHunters++;
              else realScouts++;
              log('INFO', `📎 ${sig.wallet.slice(0,10)} 余额$${holdingUsd.toFixed(2)}但转到EOA（转仓），算确认`);
            } else {
              log('INFO', `🚫 ${sig.wallet.slice(0,10)} 持仓$${holdingUsd.toFixed(2)}<$${MIN_SM_HOLDING_USD}，${action === 'sold' ? 'SM已卖出不跟' : '不算确认'}`);
            }
          }
        }
      }
    } else {
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
  let realConfirmed;
  if (chain === 'bsc') {
    realConfirmed = realHunters >= 3 || (realHunters >= 2 && realScouts >= 3);
  } else {
    realConfirmed = realHunters >= 2 || (realHunters >= 1 && realScouts >= 2);
  }
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
  // SOL: DexScreener没有时从链上metadata查symbol
  if (symbol === '?' && chain === 'solana') {
    try {
      const metaData = await rpcPost(getSolRpc(), 'getAccountInfo', [token, { encoding: 'jsonParsed' }]);
      const parsed = metaData.result?.value?.data?.parsed;
      if (parsed?.info?.symbol) symbol = parsed.info.symbol;
      else if (parsed?.info?.name) symbol = parsed.info.name.slice(0, 20);
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
  
  // 市值过滤（DexScreener fdv → OKX报价反推）
  let mcap = parseFloat(dexData?.pairs?.[0]?.fdv || dexData?.pairs?.[0]?.marketCap || 0);
  const minMcap = chain === 'bsc' ? 10000 : CONFIG.minMarketCap; // BSC最低$10K
  const maxMcap = CONFIG.maxMarketCap;
  
  // DexScreener没市值（内盘/新币）→ 用OKX报价 × totalSupply反推
  if (mcap === 0 && chain !== 'solana') {
    try {
      const { ethers } = require('ethers');
      const provider = chain === 'bsc' ? bscProvider : baseProvider;
      const erc20 = new ethers.Contract(token, ['function totalSupply() view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
      const [supply, dec] = await Promise.all([erc20.totalSupply(), erc20.decimals()]);
      const supplyNum = parseFloat(ethers.formatUnits(supply, dec));
      // 用DexScreener价格或已缓存的价格
      const price = parseFloat(dexData?.pairs?.[0]?.priceUsd || 0);
      if (price > 0) {
        mcap = price * supplyNum;
      } else {
        // 尝试OKX报价拿价格
        const ts = new Date().toISOString();
        const crypto = require('crypto');
        const qPath = `/api/v6/dex/aggregator/quote?chainIndex=${CHAIN_ID[chain]}&fromTokenAddress=${token}&toTokenAddress=${NATIVE[chain]}&amount=${(BigInt(10) ** BigInt(dec)).toString()}&slippagePercent=0.5`;
        const sign = crypto.createHmac('sha256', OKX_ENV.OKX_SECRET_KEY).update(ts + 'GET' + qPath).digest('base64');
        const resp = await fetchTimeout('https://www.okx.com' + qPath, { headers: {
          'OK-ACCESS-KEY': OKX_ENV.OKX_API_KEY, 'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': OKX_ENV.OKX_PASSPHRASE
        }});
        const qData = await resp.json();
        const unitPrice = parseFloat(qData?.data?.[0]?.dexRouterList?.[0]?.fromToken?.tokenUnitPrice || 0);
        if (unitPrice > 0) mcap = unitPrice * supplyNum;
      }
      if (mcap > 0) log('INFO', `📊 ${symbol}(${chain}) OKX反推市值: $${Math.round(mcap)}`);
    } catch(e) { /* 反推失败不拦，继续买入 */ }
  }
  
  if (mcap > 0 && mcap < minMcap) {
    log('INFO', `🚫 ${symbol}(${chain}) 市值$${Math.round(mcap)}<$${minMcap}，跳过`);
    return;
  }
  if (mcap > 0 && mcap > maxMcap) {
    log('INFO', `🚫 ${symbol}(${chain}) 市值$${Math.round(mcap)}>$${maxMcap/1e6}M，跳过`);
    return;
  }
  
  // 内盘检测（暂时关闭，数据显示pump地址币反而赚钱）
  // const topPair = dexData?.pairs?.[0];
  // const dexId = (topPair?.dexId || '').toLowerCase();
  // const liquidity = parseFloat(topPair?.liquidity?.usd || 0);
  
  // 通过审计 → 买入（用降权+空投过滤后的真实SM列表）
  const bestRank = realConfirmWallets.length > 0
    ? Math.min(...realConfirmWallets.map(addr => {
        const w = rankedWallets.find(rw => rw.address === addr || rw.address?.toLowerCase() === addr?.toLowerCase());
        return w?.rank || 999;
      }))
    : 999;
  const confirmWallets = [...new Set(realConfirmWallets)];
  // 提取每个SM的钱包→金额映射（只算猎手+哨兵，观察不算）
  let smWalletAmounts = {};
  for (const s of (pendingSignals[token] || [])) {
    if (s.smBuyAmountUsd > 0 && (s.walletStatus === 'hunter' || s.walletStatus === 'scout')) {
      smWalletAmounts[s.wallet] = s.smBuyAmountUsd;
    }
  }
  const smBuyAmounts = Object.values(smWalletAmounts).sort((a, b) => a - b);
  const smTotalUsd = smBuyAmounts.reduce((a, b) => a + b, 0);
  log('INFO', `✅ ${symbol}(${chain}) 通过审计! 真实猎手=${realHunters} 哨兵=${realScouts} 最高#${bestRank}${smTotalUsd > 0 ? ` SM累计$${Math.round(smTotalUsd)}` : ''}`);
  // savedSignals removed - 龙虾检查不再特殊处理余额=0有买入信号的情况
  // pendingSignals在买入成功后再删（防买入失败丢信号）
  // 提前标记boughtTokens（防另一个handleSignal并发通过检查→重复买入）
  if (boughtTokens.has(token)) { log('INFO', `${symbol} 已在买入中，跳过`); return; }
  boughtTokens.add(token);
  saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
  
  // Bug fix: 买入前再次检查SM是否还持有（防龙虾问题：SM已卖我们才买）
  let holdingHuntersOuter = null, holdingScoutsOuter = null;
  try {
    const price = parseFloat(dexData?.pairs?.[0]?.priceUsd || 0);
    if (price > 0) {
      let stillHolding = 0;
      const holdingWallets = []; // 记录还持有的SM钱包
      const checkWallets = confirmWallets.slice(0, 5);
      
      let queryFailed = 0;
      if (chain === 'solana') {
        for (const smWallet of checkWallets) {
          const cachedSolBal2 = getCachedSolBalance(smWallet, token);
          if (cachedSolBal2 !== undefined) {
            if (cachedSolBal2 * price >= 1) { stillHolding++; holdingWallets.push(smWallet); }
            else {
              // 余额=0，查是DEX卖出还是转仓
              const action = await checkSolSellOrTransfer(smWallet, token);
              if (action === 'transferred') {
                stillHolding++; holdingWallets.push(smWallet);
                log('INFO', `📎 龙虾检查: ${smWallet.slice(0,10)} 余额=0但转到普通钱包（转仓），算持有`);
              } else {
                log('INFO', `🦞 龙虾检查: ${smWallet.slice(0,10)} 余额=0，${action === 'sold' ? 'DEX卖出' : '无法判断'}，不算持有`);
              }
            }
            continue;
          }
          let ok = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const bal2 = await getSolTokenBalance(smWallet, token);
              setCachedSolBalance(smWallet, token, bal2);
              if (bal2 * price >= 1) { stillHolding++; holdingWallets.push(smWallet); }
              else {
                const action = await checkSolSellOrTransfer(smWallet, token);
                if (action === 'transferred') {
                  stillHolding++; holdingWallets.push(smWallet);
                  log('INFO', `📎 龙虾检查: ${smWallet.slice(0,10)} 余额=0但转到普通钱包（转仓），算持有`);
                } else {
                  log('INFO', `🦞 龙虾检查: ${smWallet.slice(0,10)} 余额=0，${action === 'sold' ? 'DEX卖出' : '无法判断'}，不算持有`);
                }
              }
              ok = true;
              break;
            } catch {
              if (attempt === 1) await new Promise(r => setTimeout(r, 500));
            }
          }
          if (!ok) { queryFailed++; log('WARN', `⚠️ 龙虾检查: ${smWallet.slice(0,10)} SOL余额查询失败，不计入`); await notifyTelegram(`⚠️ 龙虾检查: ${smWallet.slice(0,10)} SOL余额查询失败 ${symbol}(${chain})`); }
        }
      } else {
        // EVM: Multicall3一次查完
        try {
          const balMap = await batchBalanceOf(chain, token, checkWallets);
          // Multicall未返回的再查一次
          const missed = checkWallets.filter(w => !balMap.has(w.toLowerCase()));
          if (missed.length > 0) {
            const provider = chain === 'bsc' ? bscProvider : baseProvider;
            for (const w of missed) {
              try {
                const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
                const [bal, dec] = await Promise.all([erc20.balanceOf(w), erc20.decimals().catch(() => 18)]);
                balMap.set(w.toLowerCase(), { bal, balNum: parseFloat(ethers.formatUnits(bal, dec)) });
              } catch {}
            }
          }
          for (const smWallet of checkWallets) {
            const info = balMap.get(smWallet.toLowerCase());
            if (!info) { queryFailed++; log('WARN', `⚠️ 龙虾检查: ${smWallet.slice(0,10)} EVM余额3次查询失败，不计入`); await notifyTelegram(`⚠️ 龙虾检查: ${smWallet.slice(0,10)} EVM余额3次查询失败 ${symbol}(${chain})`); continue; }
            if (info.balNum * price >= 1) { stillHolding++; holdingWallets.push(smWallet); }
            else {
              const action = await checkEvmSellOrTransfer(chain, smWallet, token);
              if (action === 'transferred') {
                stillHolding++; holdingWallets.push(smWallet);
                log('INFO', `📎 龙虾检查: ${smWallet.slice(0,10)} 余额=0但转到EOA（转仓），算持有`);
              } else {
                log('INFO', `🦞 龙虾检查: ${smWallet.slice(0,10)} 余额=0，${action === 'sold' ? 'DEX卖出' : '无法判断'}，不算持有`);
              }
            }
          }
        } catch(e) {
          log('WARN', `⚠️ 龙虾检查Multicall整体失败: ${e.message?.slice(0,40)}，全部不计入`);
          await notifyTelegram(`⚠️ 龙虾检查Multicall整体失败 ${symbol}(${chain}): ${e.message?.slice(0,40)}`);
          queryFailed = checkWallets.length;
        }
      }
      // 如果全部查询失败（RPC挂了），保守处理：继续买入（不能因为RPC问题错过已确认的信号）
      if (queryFailed === checkWallets.length) {
        log('WARN', `⚠️ 龙虾检查全部查询失败，跳过龙虾检查继续买入`);
        stillHolding = checkWallets.length;
        holdingWallets.push(...checkWallets);
      }
      
      if (stillHolding === 0) {
        log('WARN', `🚫 ${symbol}(${chain}) SM已全部卖出，取消买入`);
        boughtTokens.delete(token);
        saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
        return;
      }
      // 只累计还持有的SM的金额
      const filteredAmounts = {};
      for (const w of holdingWallets) {
        if (smWalletAmounts[w]) filteredAmounts[w] = smWalletAmounts[w];
      }
      smWalletAmounts = filteredAmounts;
      
      // 重新算确认数（只算还持有的SM）
      let holdingHunters = 0, holdingScouts = 0;
      for (const w of holdingWallets) {
        const wLower = w.toLowerCase();
        const info = rankedWallets.find(rw => rw.address === w || rw.address?.toLowerCase() === wLower);
        if (info?.status === 'hunter') holdingHunters++;
        else if (info?.status === 'scout') holdingScouts++;
      }
      holdingHuntersOuter = holdingHunters;
      holdingScoutsOuter = holdingScouts;
      const minH = chain === 'bsc' ? 3 : 2;
      const altH = chain === 'bsc' ? 2 : 1;
      const altS = chain === 'bsc' ? 3 : 2;
      const passConfirm = holdingHunters >= minH || (holdingHunters >= altH && holdingScouts >= altS);
      if (!passConfirm) {
        log('WARN', `🚫 ${symbol}(${chain}) 剔除已卖SM后猎手=${holdingHunters}哨兵=${holdingScouts}，不够门槛，取消买入`);
        boughtTokens.delete(token);
        saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
        return;
      }
      realHunters = holdingHunters;
      log('INFO', `✅ ${symbol} SM仍持有(${stillHolding}/${checkWallets.length}) 猎手=${holdingHunters}哨兵=${holdingScouts}，执行买入`);
    }
  } catch(e) { log('WARN', `买前SM检查异常: ${e.message?.slice(0,40)}，继续买入`); }
  
  const finalScouts = holdingScoutsOuter !== null ? holdingScoutsOuter : realScouts;
  await executeBuy(chain, token, symbol, realHunters, confirmWallets, smWalletAmounts, finalScouts);
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
async function executeBuy(chain, tokenAddress, symbol, confirmCount, confirmWallets = [], smWalletAmounts = {}, watchCount = 0) {
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
    return await _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets, smWalletAmounts, watchCount);
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

async function _executeBuyInner(chain, tokenAddress, symbol, confirmCount, confirmWallets, smWalletAmounts = {}, watchCount = 0) {
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
    
    // 动态仓位：信号质量分层（猎手数×SM累计金额）
    const smTotal = Object.values(smWalletAmounts).reduce((a, b) => a + b, 0);
    if (smTotal < 500) {
      log('INFO', `🚫 ${symbol}(${chain}) SM累计$${Math.round(smTotal)}<$500，跳过`);
      return;
    }
    // S级: ≥3猎手 或 2猎手+≥3哨兵，SM≥$1500 → $160
    // A级: ≥2猎手+≥2哨兵 且 SM≥$500，或 ≥2猎手 且 SM≥$1000 → $120
    // B级: ≥2猎手 且 SM≥$500 → $80
    // 1猎手+哨兵不买（信号太弱）— 但1猎手+2哨兵在SOL/Base可以买
    const minHunters = chain === 'bsc' ? 3 : 2;
    const altHunters = chain === 'bsc' ? 2 : 1;
    const altScouts = chain === 'bsc' ? 3 : 2;
    if (!(confirmCount >= minHunters || (confirmCount >= altHunters && watchCount >= altScouts))) {
      log('INFO', `🚫 ${symbol}(${chain}) 猎手=${confirmCount}哨兵=${watchCount}，不够门槛，跳过`);
      return;
    }
    if ((confirmCount >= 3 || (confirmCount >= 2 && watchCount >= 3)) && smTotal >= 1500) {
      size = 160;
    } else if ((confirmCount >= 2 && watchCount >= 2 && smTotal >= 500) || (confirmCount >= 2 && smTotal >= 1000)) {
      size = 120;
    } else {
      size = 80;
    }
    const grade = size >= 160 ? 'S' : size >= 120 ? 'A' : 'B';
    log('INFO', `📊 ${symbol} ${grade}级信号 仓位$${size} (猎手${confirmCount} SM累计$${Math.round(smTotal)})`);
    
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
    await notifyTelegram(`❌ 价格转换失败 ${symbol}(${chain}): ${e.message?.slice(0,80)}\n信号已丢失，请检查代码!`);
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
          // 查token余额（三次重试，兼容Token-2022）
          for (let _try = 0; _try < 3 && buyAmount === 0; _try++) {
            try {
              if (_try > 0) await sleep(2000);
              buyAmount = await getSolTokenBalance(require('./dex_trader.js').getWalletAddress('solana'), tokenAddress);
            } catch(e) { if (_try < 2) log('WARN', `查SOL余额第${_try+1}次失败: ${e.message?.slice(0,40)}`); }
          }
          // fallback: 查不到余额，延长重试（RPC同步慢）
          if (buyAmount === 0) {
            for (let _retry = 0; _retry < 5 && buyAmount === 0; _retry++) {
              await sleep(3000); // 每次多等3秒
              try {
                buyAmount = await getSolTokenBalance(require('./dex_trader.js').getWalletAddress('solana'), tokenAddress);
              } catch {}
            }
            // 最终fallback: 用OKX报价估算
            if (buyAmount === 0) {
              try {
                const qPath = `/api/v6/dex/aggregator/quote?chainIndex=${CHAIN_ID[chain]}&fromTokenAddress=${tokenAddress}&toTokenAddress=${NATIVE[chain]}&amount=1000000000&slippagePercent=1`;
                const qRes = await okxGet(qPath);
                if (qRes?.data?.[0]?.toTokenAmount) {
                  buyPrice = parseFloat(qRes.data[0].fromTokenUsdPrice || 0);
                }
              } catch {}
              if (buyPrice > 0) {
                buyAmount = size / buyPrice;
                log('WARN', `⚠️ ${symbol} 余额15次查询全返回0，用OKX报价估算: ${buyAmount.toFixed(0)}`);
              } else {
                log('ERROR', `❌ ${symbol} 买入后无法确认余额和价格！需手动检查 token=${tokenAddress}`);
              }
            }
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
      
      const smTotalAtBuy = Object.values(smWalletAmounts).reduce((a, b) => a + b, 0);
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
        smTotalUsd: Math.round(smTotalAtBuy), // SM累计持有金额
      };
      // 存钱包库里所有曾买过该token的SM（用于卖出比例计算）
      const allSMForToken = (pendingSignals[tokenAddress] || []).map(s => s.wallet).filter(Boolean);
      const uniqueAllSM = [...new Set([...confirmWallets, ...allSMForToken])];
      positions[tokenAddress].allSMWallets = uniqueAllSM;
      boughtTokens.add(tokenAddress);
      saveJSON(POSITIONS_FILE, positions);
      saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]); // 持久化防重启重复买
      // 买入成功，清掉pendingSignals
      delete pendingSignals[tokenAddress];
      savePendingSignals();
      
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
      
      // 记录交易日志
      const smTotal = Object.values(smWalletAmounts).reduce((a, b) => a + b, 0);
      logTrade({
        type: 'BUY', time: new Date().toISOString(), chain, symbol, token: tokenAddress,
        costUsd: size, amount: buyAmount, price: buyPrice, tx: result.txHash || '',
        hunters: confirmCount, scouts: confirmWallets.length - confirmCount,
        smTotalUsd: Math.round(smTotal),
        smWallets: Object.entries(smWalletAmounts).map(([w, a]) => ({ wallet: w.slice(0, 10), usd: Math.round(a) })),
      });
      
      // 延迟10秒回填真实余额（异步，不阻塞主流程）
      if (chain === 'solana') {
        const _ta = tokenAddress, _sym = symbol;
        setTimeout(async () => {
          try {
            const realBal = await getSolTokenBalance(require('./dex_trader.js').getWalletAddress('solana'), _ta);
            if (realBal > 0 && positions[_ta]) {
              const old = positions[_ta].buyAmount;
              positions[_ta].buyAmount = realBal;
              positions[_ta].buyAmountRaw = realBal;
              saveJSON(POSITIONS_FILE, positions);
              if (Math.abs(realBal - old) / Math.max(old, 1) > 0.01) {
                log('INFO', `📝 ${_sym} 余额回填: ${old.toFixed?.(0) || old} → ${realBal} (真实值)`);
              }
            }
          } catch {}
        }, 10000);
      }
      
      // 通知（附带猎手排名）
      const hunterRanks = confirmWallets.map(addr => {
        const w = rankedWallets.find(rw => (rw.address || '').toLowerCase() === addr.toLowerCase());
        return w && w.status === 'hunter' ? `${w.chain === 'bsc' ? 'BSC' : w.chain === 'base' ? 'Base' : 'SOL'}猎手#${w.rank}` : null;
      }).filter(Boolean);
      const rankLine = hunterRanks.length > 0 ? `\n🏹 ${hunterRanks.join(' ')}` : '';

      // 异步补扫钱包库：找出所有持有该token的SM，更新allSMWallets（卖出比例分母）
      const _tokenAddr = tokenAddress, _chain = chain, _sym2 = symbol;
      setTimeout(async () => {
        try {
          const samChainSMs = rankedWallets.filter(w => w.chain === _chain);
          const foundSMs = [];
          if (_chain === 'solana') {
            for (const w of samChainSMs) {
              try {
                const bal = await getSolTokenBalance(w.address, _tokenAddr);
                if (bal > 0) foundSMs.push(w.address);
              } catch {}
              await new Promise(r => setTimeout(r, 100)); // 防RPC限速
            }
          } else {
            // EVM: 用Multicall批量查
            const addrs = samChainSMs.map(w => w.address);
            const balMap = await batchBalanceOf(_chain, _tokenAddr, addrs);
            for (const w of samChainSMs) {
              const info = balMap.get(w.address.toLowerCase());
              if (info && info.bal > 0n) foundSMs.push(w.address);
            }
          }
          if (positions[_tokenAddr] && foundSMs.length > 0) {
            const existing = positions[_tokenAddr].allSMWallets || positions[_tokenAddr].confirmWallets || [];
            const merged = [...new Set([...existing, ...foundSMs])];
            positions[_tokenAddr].allSMWallets = merged;
            saveJSON(POSITIONS_FILE, positions);
            log('INFO', `📎 ${_sym2} 补扫钱包库: ${foundSMs.length}个SM持有，总跟踪${merged.length}个`);
          }
        } catch(e) { log('WARN', `补扫钱包库异常: ${e.message?.slice(0,50)}`); }
      }, 20000); // 买入20秒后补扫（等链上同步）
      const smLine = smTotalAtBuy > 0 ? `\n💎 SM累计持有$${Math.round(smTotalAtBuy)}` : '';
      await notifyTelegram(`🟢 冲狗买入 ${symbol}(${chain})\n💰 $${size} | 猎手${confirmCount}+哨兵${confirmWallets.length - confirmCount}${rankLine}${smLine}\n🔗 ${result.txHash || ''}`);
      
      // symbol为?时延迟重查DexScreener更新
      if (symbol === '?') {
        const _token = token, _chain = chain;
        setTimeout(async () => {
          try {
            const r = await fetchTimeout(`https://api.dexscreener.com/latest/dex/tokens/${_token}`);
            const d = await r.json();
            const newSymbol = d?.pairs?.[0]?.baseToken?.symbol;
            if (newSymbol && positions[_token]) {
              positions[_token].symbol = newSymbol;
              saveJSON(POSITIONS_FILE, positions);
              log('INFO', `📝 ${_token.slice(0,10)} symbol更新: ? → ${newSymbol}`);
              await notifyTelegram(`📝 刚才买的?币是 ${newSymbol}`);
            }
          } catch {}
        }, 15000);
      }
      // 交易已发送但确认超时→可能已上链，查余额确认
      log('WARN', `⚠️ ${symbol} 确认超时，查链上余额...`);
      await sleep(5000);
      let actualAmount = 0;
      try {
        const trader2 = require('./dex_trader.js');
        if (chain === 'solana') {
          actualAmount = await getSolTokenBalance(trader2.getWalletAddress('solana'), tokenAddress);
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
        // 不发重复通知（第一条已发过）
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
  const SLIPPAGE_STEPS = [500, 2500, 5000]; // 5% → 25% → 50%
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const trader = require('./dex_trader.js');
      const slippageBps = SLIPPAGE_STEPS[attempt - 1] || 5000;
      if (attempt > 1) log('INFO', `🔄 重试卖出 ${pos.symbol}(${pos.chain}) 第${attempt}次(slippage ${slippageBps/100}%)...`);
      // ratio<1时部分卖出：查链上余额×ratio，ratio≥0.99全卖
      let result;
      if (ratio < 0.99) {
        // 查链上余额算部分数量
        let partialAmount;
        try {
          if (pos.chain === 'solana') {
            let onChainBal = 0n;
            const seenAccounts = new Set();
            for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
              try {
                const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
                  trader.getWalletAddress('solana'), { mint: tokenAddress }, { encoding: 'jsonParsed', programId }
                ]);
                for (const a of (balData.result?.value || [])) {
                  const pubkey = a.pubkey;
                  if (seenAccounts.has(pubkey)) continue; // 去重！防止双programId返回同一账户
                  seenAccounts.add(pubkey);
                  onChainBal += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || '0');
                }
              } catch {}
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
          log('WARN', `查余额失败: ${e.message}`);
          partialAmount = undefined;
        }
        // 链上余额=0时用positions估算值，绝不默认全卖
        if (!partialAmount || partialAmount === '0') {
          if (pos.buyAmount && pos.buyAmount > 0) {
            const estBal = BigInt(Math.floor(pos.buyAmount * (1 - (pos.soldRatio || 0))));
            partialAmount = (estBal * BigInt(Math.floor(ratio * 1000)) / 1000n).toString();
            log('WARN', `链上余额=0，用估算值: ${estBal} × ${(ratio*100).toFixed(0)}% = ${partialAmount}`);
          }
          if (!partialAmount || partialAmount === '0') {
            log('WARN', `无法计算部分卖出量，跳过（不全卖）`);
            return;
          }
        }
        result = await trader.sell(pos.chain, tokenAddress, partialAmount, slippageBps);
      } else {
        result = await trader.sell(pos.chain, tokenAddress, undefined, slippageBps);
      }
      
      if (result.success) {
        // 卖出后验证：等5秒查链上余额确认真的卖了（2秒太短RPC可能返回旧数据）
        try {
          await new Promise(r => setTimeout(r, 5000));
          const trader2 = require('./dex_trader.js');
          let postBal = -1;
          if (pos.chain === 'solana') {
            postBal = await getSolTokenBalance(trader2.getWalletAddress('solana'), tokenAddress);
          } else {
            const { ethers: eth2 } = require('ethers');
            const prov2 = pos.chain === 'bsc' ? bscProvider : baseProvider;
            const erc2 = new eth2.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], prov2);
            const b2 = await erc2.balanceOf(trader2.getWalletAddress('evm'));
            postBal = parseFloat(eth2.formatUnits(b2, 18));
          }
          const preBal = (pos.buyAmount || 0) * (1 - (pos.soldRatio || 0));
          if (postBal >= 0 && preBal > 0 && postBal >= preBal * 0.95) {
            // 余额几乎没变 → 假成功，继续重试（提高slippage）
            log('WARN', `⚠️ ${pos.symbol} 卖出tx成功但余额未减少(pre:${preBal.toFixed(0)} post:${postBal.toFixed(0)})，第${attempt}次假成功`);
            if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
            // 3次都假成功 → 尝试分批卖（一半一半）
            log('INFO', `🔄 ${pos.symbol} 3次假成功，尝试分批卖出...`);
            try {
              const trader3 = require('./dex_trader.js');
              let splitBal;
              if (pos.chain === 'solana') {
                const rawBal = await getSolTokenBalance(trader3.getWalletAddress('solana'), tokenAddress);
                const sellBal = ratio < 0.99 ? Math.floor(rawBal * ratio) : rawBal;
                splitBal = Math.floor(sellBal / 2);
              } else {
                // EVM: 查链上余额分半
                const { ethers: eth3 } = require('ethers');
                const prov3 = pos.chain === 'bsc' ? bscProvider : baseProvider;
                const erc3 = new eth3.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], prov3);
                const evmBal = await erc3.balanceOf(trader3.getWalletAddress('evm'));
                const sellBal = ratio < 0.99 ? (evmBal * BigInt(Math.round(ratio * 100)) / 100n) : evmBal;
                splitBal = (sellBal / 2n).toString();
              }
              if (splitBal && splitBal !== '0' && Number(splitBal) > 0) {
                // 分两批卖
                for (let i = 0; i < 2; i++) {
                  try {
                    let sr;
                    if (pos.chain === 'solana') {
                      sr = await trader3.solanaSell(tokenAddress, splitBal.toString(), 5000);
                    } else {
                      sr = await trader3.sell(pos.chain, tokenAddress, splitBal.toString(), 5000);
                    }
                    if (sr.success) log('INFO', `✅ ${pos.symbol} 分批第${i+1}次成功`);
                    else log('WARN', `❌ ${pos.symbol} 分批第${i+1}次失败: ${sr.error}`);
                  } catch(e) { log('WARN', `❌ ${pos.symbol} 分批第${i+1}次异常: ${e.message?.slice(0,50)}`); }
                  await new Promise(r => setTimeout(r, 3000));
                }
                // 分批后再查余额
                await new Promise(r => setTimeout(r, 3000));
                let finalBal = -1;
                if (pos.chain === 'solana') {
                  finalBal = await getSolTokenBalance(trader3.getWalletAddress('solana'), tokenAddress);
                } else {
                  const { ethers: eth4 } = require('ethers');
                  const prov4 = pos.chain === 'bsc' ? bscProvider : baseProvider;
                  const erc4 = new eth4.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], prov4);
                  const fb = await erc4.balanceOf(trader3.getWalletAddress('evm'));
                  finalBal = parseFloat(eth4.formatUnits(fb, 18));
                }
                if (finalBal >= 0 && finalBal < preBal * 0.1) {
                  log('INFO', `✅ ${pos.symbol} 分批卖出成功，余额${finalBal.toFixed(0)}`);
                  // 走正常卖出成功流程 — 不break，让下面的代码处理
                } else {
                  log('WARN', `⚠️ ${pos.symbol} 分批卖出后余额仍有${finalBal.toFixed(0)}，通知跑步哥`);
                  await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖出假成功+分批也没完全卖掉\n余额剩${finalBal.toFixed(0)}\n🔄 下轮巡检自动重试`);
                  break;
                }
              } else {
                await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 3次卖出假成功\n余额未减少(${postBal.toFixed(0)}/${preBal.toFixed(0)})\n🔄 下轮巡检自动重试`);
                break;
              }
            } catch(e) {
              log('WARN', `分批卖出异常: ${e.message?.slice(0,80)}`);
              await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖出假成功+分批异常\n🔄 下轮巡检自动重试`);
              break;
            }
          }
        } catch(e) { log('WARN', `卖后验证异常: ${e.message?.slice(0,50)}`); }
        // 估算卖出收益（卖出数量×当前价格）
        try {
          // Bug fix: ratio是相对剩余的比例，换算成实际卖出数量
          const remaining = (pos.buyAmount || 0) * (1 - (pos.soldRatio || 0));
          const sellAmount = ratio < 0.99 ? remaining * ratio : remaining;
          // Bug fix: 用_dexCache而不是dexScreenerCache
          const dexData = _dexCache[tokenAddress]?.data || await (async()=>{
            try { return await (await fetchTimeout('https://api.dexscreener.com/latest/dex/tokens/'+tokenAddress,{headers:{'User-Agent':'Mozilla/5.0'}})).json(); } catch{return null;}
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
          recordTradeHistory(tokenAddress, pos);
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
        
        // 记录交易日志
        try {
          const curPrice = parseFloat((await dexScreenerGet(tokenAddress))?.pairs?.[0]?.priceUsd || 0);
          const revenueUsd = ratio >= 0.99
            ? (pos.buyAmount * curPrice)
            : (pos.buyAmount * ratio * curPrice);
          const remainCostUsd = pos.buyCost * (1 - (pos.soldRatio || 0)); // 剩余部分的成本
          const thisCostUsd = ratio >= 0.99 ? remainCostUsd : remainCostUsd * ratio; // 本次卖出对应的成本
          logTrade({
            type: 'SELL', time: new Date().toISOString(), chain: pos.chain, symbol: pos.symbol, token: tokenAddress,
            ratio, reason, revenueUsd: Math.round(revenueUsd * 100) / 100,
            costUsd: pos.buyCost, soldRatio: pos.soldRatio || 0,
            buyPrice: pos.buyPrice, sellPrice: curPrice,
            pnlUsd: Math.round((revenueUsd - thisCostUsd) * 100) / 100,
            holdMinutes: Math.round((Date.now() - pos.buyTime) / 60000),
            tx: result.txHash || '',
          });
        } catch {}
        
        // 实时查SM持仓金额
        let smLiveUsd = 0;
        try {
          const smWallets = pos.confirmWallets || [];
          if (smWallets.length > 0) {
            const dexD = await dexScreenerGet(tokenAddress).catch(() => null);
            const smPrice = parseFloat(dexD?.pairs?.[0]?.priceUsd || 0);
            if (smPrice > 0 && pos.chain === 'solana') {
              for (const w of smWallets) {
                try { smLiveUsd += (await getSolTokenBalance(w, tokenAddress)) * smPrice; } catch {}
              }
            } else if (smPrice > 0) {
              // EVM: Multicall批量查
              const prov = pos.chain === 'bsc' ? bscProvider : baseProvider;
              try {
                const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
                const erc20 = new ethers.Contract(tokenAddress, iface, prov);
                const dec = await erc20.decimals().catch(() => 18);
                for (const w of smWallets) {
                  try { smLiveUsd += parseFloat(ethers.formatUnits(await erc20.balanceOf(w), dec)) * smPrice; } catch {}
                }
              } catch {}
            }
          }
        } catch {}
        const smInfo = smLiveUsd >= 1 ? `\n💎 SM实时持有$${Math.round(smLiveUsd)}` : (pos.smTotalUsd ? `\n💎 SM已清仓(买入时$${pos.smTotalUsd})` : '');
        await notifyTelegram(`🔴 冲狗卖出 ${pos.symbol}(${pos.chain}) ${pctStr}\n📉 原因: ${reason}${smInfo}\n🔗 ${result.txHash || ''}`);
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
        // 3次递增slippage都失败 → 尝试分批卖
        const splitOk = await _trySplitSell(pos, tokenAddress, ratio);
        if (!splitOk) {
          positions[tokenAddress].unsellable = true;
          positions[tokenAddress].unsellableReason = result?.error?.substring?.(0, 200) || 'sell failed';
          positions[tokenAddress].unsellableSince = Date.now();
          saveJSON(POSITIONS_FILE, positions);
          log('WARN', `🚫 ${pos.symbol}(${pos.chain}) 3次+分批全失败，标记unsellable`);
          await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖不出!\n❌ 3次+分批全失败: ${result?.error || 'unknown'}\n🔄 下轮巡检自动重试`);
        }
      }
    } catch(e) {
      log('ERROR', `卖出异常 ${pos.symbol}(第${attempt}次): ${e.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      if (attempt >= MAX_RETRIES && positions[tokenAddress]) {
        const splitOk = await _trySplitSell(pos, tokenAddress, ratio);
        if (!splitOk) {
          positions[tokenAddress].unsellable = true;
          positions[tokenAddress].unsellableReason = e.message?.substring(0, 200);
          positions[tokenAddress].unsellableSince = Date.now();
          saveJSON(POSITIONS_FILE, positions);
          log('WARN', `🚫 ${pos.symbol}(${pos.chain}) 3次+分批全失败，标记unsellable`);
          await notifyTelegram(`⚠️ ${pos.symbol}(${pos.chain}) 卖不出!\n❌ 3次+分批全失败: ${e.message?.substring(0, 100)}\n🔄 下轮巡检自动重试`);
        }
      }
    }
  }
}

// 分批卖出：分两半用50% slippage卖
// sellRatio: 要卖的比例(0-1)，默认1=全卖
async function _trySplitSell(pos, tokenAddress, sellRatio = 1) {
  log('INFO', `🔄 ${pos.symbol} 尝试分批卖出...`);
  try {
    const trader = require('./dex_trader.js');
    let rawBal;
    if (pos.chain === 'solana') {
      const balNum = await getSolTokenBalance(trader.getWalletAddress('solana'), tokenAddress);
      if (balNum <= 0) return false;
      // 需要raw balance
      const balData = await rpcPost(getSolRpc(), 'getTokenAccountsByOwner', [
        trader.getWalletAddress('solana'), { mint: tokenAddress }, { encoding: 'jsonParsed' }
      ]);
      let raw = 0n;
      for (const a of (balData.result?.value || [])) raw += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || '0');
      if (raw <= 0n) return false;
      // 按sellRatio只卖对应比例，不是全部
      const sellTotal = sellRatio < 0.99 ? (raw * BigInt(Math.round(sellRatio * 100)) / 100n) : raw;
      const half = (sellTotal / 2n).toString();
      let ok = 0;
      for (let i = 0; i < 2; i++) {
        try {
          const r = await trader.solanaSell(tokenAddress, half, 5000);
          if (r.success) { ok++; log('INFO', `✅ ${pos.symbol} 分批第${i+1}次成功`); }
          else log('WARN', `❌ ${pos.symbol} 分批第${i+1}次: ${r.error}`);
        } catch(e) { log('WARN', `❌ ${pos.symbol} 分批第${i+1}次异常: ${e.message?.slice(0,40)}`); }
        await new Promise(r => setTimeout(r, 3000));
      }
      if (ok > 0) {
        log('INFO', `✅ ${pos.symbol} 分批卖出${ok}/2成功`);
        // 分批卖出后清仓（大概率全卖完了）
        if (positions[tokenAddress]) {
          const holdMin = Math.round((Date.now()-(pos.buyTime||0))/60000);
          try {
            logTrade({ type: 'SELL', time: new Date().toISOString(), chain: pos.chain, symbol: pos.symbol,
              token: tokenAddress, ratio: 1, reason: '分批卖出', costUsd: pos.buyCost||0,
              soldRatio: pos.soldRatio||0, buyPrice: pos.buyPrice, holdMinutes: holdMin });
          } catch {}
          await notifyTelegram(`🔴 冲狗卖出 ${pos.symbol}(${pos.chain}) | 分批清仓 | 买入$${Math.round(pos.buyCost||0)} | 持有${holdMin}分钟`);
          recordTradeHistory(tokenAddress, pos);
          delete positions[tokenAddress];
          delete sellTracker[tokenAddress];
          delete transferTracker[tokenAddress];
          boughtTokens.delete(tokenAddress);
          saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
          saveJSON(POSITIONS_FILE, positions);
        }
        return true;
      }
    } else {
      const { ethers: e2 } = require('ethers');
      const prov = pos.chain === 'bsc' ? bscProvider : baseProvider;
      const erc = new e2.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], prov);
      const bal = await erc.balanceOf(trader.getWalletAddress('evm'));
      if (bal <= 0n) return false;
      const half = (bal / 2n).toString();
      let ok = 0;
      for (let i = 0; i < 2; i++) {
        try {
          const r = await trader.sell(pos.chain, tokenAddress, half, 5000);
          if (r.success) { ok++; log('INFO', `✅ ${pos.symbol} 分批第${i+1}次成功`); }
          else log('WARN', `❌ ${pos.symbol} 分批第${i+1}次: ${r.error}`);
        } catch(e2) { log('WARN', `❌ ${pos.symbol} 分批第${i+1}次异常: ${e2.message?.slice(0,40)}`); }
        await new Promise(r => setTimeout(r, 3000));
      }
      if (ok > 0) {
        if (positions[tokenAddress]) {
          try {
            logTrade({ type: 'SELL', time: new Date().toISOString(), chain: pos.chain, symbol: pos.symbol,
              token: tokenAddress, ratio: 1, reason: '分批卖出(EVM)', costUsd: pos.buyCost||0,
              soldRatio: pos.soldRatio||0, buyPrice: pos.buyPrice, holdMinutes: Math.round((Date.now()-(pos.buyTime||0))/60000) });
          } catch {}
          recordTradeHistory(tokenAddress, pos);
          delete positions[tokenAddress];
          delete sellTracker[tokenAddress];
          delete transferTracker[tokenAddress];
          boughtTokens.delete(tokenAddress);
          saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
          saveJSON(POSITIONS_FILE, positions);
        }
        return true;
      }
    }
  } catch(e) { log('WARN', `分批卖出异常: ${e.message?.slice(0,60)}`); }
  return false;
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
                  const onChainBal = await getSolTokenBalance(trader.getWalletAddress('solana'), tokenAddr);
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
            // Bug fix: 买入后60秒内不检查余额清仓（RPC可能还没同步）
            const buyAge = pos.buyTime ? (Date.now() - new Date(pos.buyTime).getTime()) : Infinity;
            if (pos.buyAmount > 0 && buyAge > 60000) { // 检查链上余额是否=0（手动卖出/部分卖出全卖了）
              try {
                const trader = require('./dex_trader.js');
                let ourBal = -1;
                if (pos.chain === 'solana') {
                  ourBal = await getSolTokenBalance(trader.getWalletAddress('solana'), tokenAddr);
                } else {
                  const { ethers } = require('ethers');
                  const provider = pos.chain === 'bsc' ? bscProvider : baseProvider;
                  const erc20 = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider);
                  const bal = await erc20.balanceOf(trader.getWalletAddress('evm'));
                  ourBal = bal.toString() === '0' ? 0 : 1;
                }
                // 新买入5分钟内不做余额=0清仓（RPC可能还没同步）
                const buyAge = Date.now() - (pos.buyTime || 0);
                if (ourBal === 0 && buyAge > 300000) {
                  // 二次确认：等3秒换RPC再查一次，防止单次RPC故障误清仓
                  if (!pos._zeroBalCount) pos._zeroBalCount = 0;
                  pos._zeroBalCount++;
                  if (pos._zeroBalCount < 3) {
                    log('INFO', `⚠️ ${pos.symbol}(${pos.chain}) 链上余额=0 第${pos._zeroBalCount}次，等下轮确认`);
                    saveJSON(POSITIONS_FILE, positions);
                    continue;
                  }
                  log('INFO', `🧹 ${pos.symbol}(${pos.chain}) 链上余额=0连续${pos._zeroBalCount}次确认，清仓`);
                  const finalRevenue = pos.sellRevenue || 0;
                  const finalPnl = finalRevenue - (pos.busCost || pos.buyCost || 0);
                  log('INFO', `📊 ${pos.symbol} 最终PnL: 成本${pos.busCost||pos.buyCost||0} 回收${finalRevenue.toFixed(2)} 盈亏${finalPnl.toFixed(2)}`);
                  recordTradeHistory(tokenAddr, pos);
                  recordTradeHistory(tokenAddr, pos);
            delete positions[tokenAddr];
                  boughtTokens.delete(tokenAddr);
                  saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
                  saveJSON(POSITIONS_FILE, positions);
                  continue;
                }
              } catch(e) {} // RPC失败不处理，下轮重试
            } else if (pos._zeroBalCount) {
              // 余额查询正常（>0或跳过），重置归零计数
              delete pos._zeroBalCount;
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
        if (!pos._lastSmCheck) pos._lastSmCheck = 0;
        const smCheckInterval = 30000; // 三链统一30秒
        if (pos.confirmWallets && (Date.now() - pos._lastSmCheck >= smCheckInterval)) {
          pos._lastSmCheck = Date.now();
          try {
            // 用allSMWallets（所有曾买过该token的SM）做巡检，不只是confirmWallets
            const smWalletList = pos.allSMWallets || pos.confirmWallets;
            // 过滤已确认卖出的SM
            const pendingSM = smWalletList.filter(w => !sellTracker[tokenAddr]?.some(s => s.wallet === w));
            
            if (pos.chain === 'solana') {
              // SOL: 逐个查（没有Multicall），走缓存
              for (const smWallet of pendingSM) {
                const cachedSolBal = getCachedSolBalance(smWallet, tokenAddr);
                let bal;
                if (cachedSolBal !== undefined) {
                  bal = cachedSolBal;
                } else {
                  bal = await getSolTokenBalance(smWallet, tokenAddr);
                  setCachedSolBalance(smWallet, tokenAddr, bal);
                }
                const balValue = bal * (pos.currentPrice || 0);
                if (bal === 0 || (bal > 0 && balValue < 0.01 && pos.currentPrice > 0)) {
                  if (bal > 0) log('INFO', `🧹 SM ${smWallet.slice(0,10)} ${pos.symbol} 灰尘余额${bal.toFixed(2)}≈$${balValue.toFixed(4)}，视为已卖`);
                  const check = await checkSolTransferTarget(tokenAddr, smWallet);
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
            } else {
              // EVM: Multicall3批量查所有SM余额（1次RPC搞定）
              let balMap = await batchBalanceOf(pos.chain, tokenAddr, pendingSM);
              // 查不到的逐个重试
              const missed = pendingSM.filter(w => !balMap.has(w.toLowerCase()));
              if (missed.length > 0) {
                const prov = pos.chain === 'bsc' ? bscProvider : baseProvider;
                for (const w of missed) {
                  try {
                    const c = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], prov);
                    const [bal, dec] = await Promise.all([c.balanceOf(w), c.decimals().catch(() => 18)]);
                    balMap.set(w.toLowerCase(), { bal, balNum: parseFloat(ethers.formatUnits(bal, dec)) });
                  } catch {}
                }
              }
              for (const smWallet of pendingSM) {
                const info = balMap.get(smWallet.toLowerCase());
                if (!info) continue; // 二次重试仍失败，下轮再来
                const { bal, balNum } = info;
                const balValue = balNum * (pos.currentPrice || 0);
                const isDust = bal === 0n || (balValue < 0.01 && pos.currentPrice > 0 && balNum > 0);
                if (isDust) {
                  if (bal !== 0n) log('INFO', `🧹 SM ${smWallet.slice(0,10)} ${pos.symbol} EVM灰尘余额≈$${balValue.toFixed(4)}，视为已卖`);
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
          const pendingTransfers = Object.entries(transferTracker[tokenAddr])
            .filter(([smW]) => !sellTracker[tokenAddr]?.some(s => s.wallet === smW));
          
          if (pendingTransfers.length > 0) {
            if (pos.chain === 'solana') {
              // SOL: 逐个查，走缓存
              for (const [smWallet, info] of pendingTransfers) {
                try {
                  const sub = info.subWallet;
                  const cachedSubBal = getCachedSolBalance(sub, tokenAddr);
                  let bal;
                  if (cachedSubBal !== undefined) {
                    bal = cachedSubBal;
                  } else {
                    bal = await getSolTokenBalance(sub, tokenAddr);
                    setCachedSolBalance(sub, tokenAddr, bal);
                  }
                  if (bal === 0) {
                    log('INFO', `🔴 小号 ${sub.slice(0,10)}... 已清仓 ${pos.symbol}(${pos.chain}) — SM${smWallet.slice(0,10)}的小号也卖了`);
                    if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                    sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'sub-patrol' });
                    saveSellTracker(tokenAddr);
                  }
                } catch {}
              }
            } else {
              // EVM: Multicall3批量查所有小号余额
              const subWallets = pendingTransfers.map(([, info]) => info.subWallet);
              const subMap = await batchBalanceOf(pos.chain, tokenAddr, subWallets);
              for (const [smWallet, info] of pendingTransfers) {
                const subInfo = subMap.get(info.subWallet.toLowerCase());
                if (!subInfo) continue;
                if (subInfo.bal === 0n) {
                  log('INFO', `🔴 小号 ${info.subWallet.slice(0,10)}... 已清仓 ${pos.symbol}(${pos.chain}) — SM${smWallet.slice(0,10)}的小号也卖了`);
                  if (!sellTracker[tokenAddr]) sellTracker[tokenAddr] = [];
                  sellTracker[tokenAddr].push({ wallet: smWallet, time: Date.now(), source: 'sub-patrol' });
                  saveSellTracker(tokenAddr);
                }
              }
            }
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
              await executeSell(tokenAddr, `止盈回本(${multiple.toFixed(1)}x)`, Math.min(toSell / (1 - alreadySold), 0.99));
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
        // 新买入5分钟内不做归零判定（RPC/DexScreener数据可能不准）
        const buyAge2 = Date.now() - (pos.buyTime || 0);
        if (buyAge2 < 300000) { /* 跳过归零检查 */ }
        else if (pos.buyPrice > 0 && pos.currentPrice > 0) {
          const dropPct = ((pos.buyPrice - pos.currentPrice) / pos.buyPrice) * 100;
          let remaining = (pos.buyAmount || 0) * (1 - (pos.soldRatio || 0));
          let absValue = remaining * pos.currentPrice;
          // 如果记录的amount=0或absValue=0，去链上核实真实余额再判定
          if ((remaining <= 0 || absValue < 0.01) && pos.chain === 'solana') {
            try {
              const realBal = await getSolTokenBalance(require('./dex_trader.js').getWalletAddress('solana'), tokenAddr);
              if (realBal > 0) {
                log('INFO', `🔍 ${pos.symbol} 链上余额${realBal.toFixed(0)}(记录=0)，修正`);
                pos.buyAmount = realBal; pos.buyAmountRaw = realBal;
                remaining = realBal * (1 - (pos.soldRatio || 0));
                absValue = remaining * pos.currentPrice;
                saveJSON(POSITIONS_FILE, positions);
              }
            } catch {}
          }
          if (dropPct >= 99 || (absValue < 0.01 && pos.buyCost > 1)) {
            const reason = absValue < 0.01 ? `价值$${absValue.toExponential(1)}归零` : `跌${dropPct.toFixed(0)}%归零`;
            log('INFO', `💀 ${pos.symbol}(${pos.chain}) ${reason}，清仓`);
            recordTradeHistory(tokenAddr, pos);
            delete positions[tokenAddr];
            delete sellTracker[tokenAddr];
            delete transferTracker[tokenAddr];
            boughtTokens.delete(tokenAddr);
            saveJSON(BOUGHT_TOKENS_FILE, [...boughtTokens]);
            saveJSON(POSITIONS_FILE, positions);
            await notifyTelegram(`💀 v8归零 ${pos.symbol}(${pos.chain}) ${reason} 成本$${pos.buyCost||0}${pos.smTotalUsd ? ` SM买入时$${pos.smTotalUsd}(已归零)` : ''}`);
            continue;
          }
        }

        const sells = sellTracker[tokenAddr] || [];
        const uniqueSellers = new Set(sells.map(s => s.wallet)).size;
        const totalConfirm = (pos.allSMWallets || pos.confirmWallets || []).length || pos.confirmCount || 2;
        const sellRatio = uniqueSellers / totalConfirm; // SM卖出比例
        
        if (sellRatio >= CONFIG.sellThreshold) {
          // 我们的卖出比例 = SM卖出比例
          const ourSellRatio = Math.min(sellRatio, 1.0);
          if (ourSellRatio >= 0.99) {
            await executeSell(tokenAddr, `SM全部卖出(${uniqueSellers}/${totalConfirm})`);
          } else {
            // 部分卖出
            const alreadySold = pos.soldRatio || 0;
            const toSell = ourSellRatio - alreadySold;
            if (toSell > 0.05 && alreadySold < 0.95) { // 至少卖5%，且剩余>5%才部分卖（否则全卖）
              const ratio = Math.min(toSell / (1 - alreadySold), 0.99); // 安全帽防Infinity
              const beforeSell = Object.keys(positions).length;
              await executeSell(tokenAddr, `跟卖${(ourSellRatio*100).toFixed(0)}%(${uniqueSellers}/${totalConfirm}SM卖出)`, ratio);
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
  console.log('⚡ 第8代冲狗引擎');
  console.log('  数据源: 币安PnL Rank');
  console.log('  监控: SOL WebSocket + BSC/Base 5s轮询');
  console.log('  过滤: 多钱包确认 + 合约审计 + 流动性');
  
  // 加载状态
  positions = loadJSON(POSITIONS_FILE, {});
  
  // Bug fix: buyPrice=0时用buyCost/buyAmount回填
  for (const [k, pos] of Object.entries(positions)) {
    if ((!pos.buyPrice || pos.buyPrice === 0) && pos.buyCost > 0 && pos.buyAmount > 0) {
      pos.buyPrice = pos.buyCost / pos.buyAmount;
      log('INFO', `📝 ${pos.symbol} buyPrice回填: ${pos.buyPrice}`);
    }
  }
  saveJSON(POSITIONS_FILE, positions);
  
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
  if (CONFIG.enabledChains.includes('solana')) setupSolanaMonitor();
  if (CONFIG.enabledChains.includes('bsc')) setupEvmWebSocket('bsc');
  if (CONFIG.enabledChains.includes('base')) setupEvmWebSocket('base');
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
      // 更新walletSet（只监控猎手+哨兵，观察级不监控省credits）
      let newBsc = 0, newBase = 0, newSol = 0;
      // 先清空旧set，重建只包含猎手+哨兵的
      bscWalletSet.clear(); baseWalletSet.clear(); solWalletSet.clear();
      for (const w of rankedWallets) {
        if (w.status !== 'hunter' && w.status !== 'scout') continue;
        if (w.chain === 'bsc') { bscWalletSet.add(w.address.toLowerCase()); }
        else if (w.chain === 'base') { baseWalletSet.add(w.address.toLowerCase()); }
        else if (w.chain === 'solana') { solWalletSet.add(w.address); }
      }
      // 检测变化并重连WS
      const needReconnect = true; // 升降级后WS订阅列表可能变化
      if (needReconnect) {
        log('INFO', `  🔌 排名刷新→重连WS(猎手+哨兵: SOL=${[...solWalletSet].length} BSC=${bscWalletSet.size} Base=${baseWalletSet.size})`);
        if (CONFIG.enabledChains.includes('solana')) setupOfficialSolWs();
        if (CONFIG.enabledChains.includes('bsc')) setupEvmWebSocket('bsc');
        if (CONFIG.enabledChains.includes('base')) setupEvmWebSocket('base');
      }
      log('INFO', `  排名更新: ${rankedWallets.length}个钱包 (库${Object.keys(walletDb).length}个)`);
    } catch(e) {
      log('ERROR', `排名刷新失败: ${e.message}`);
    }
  }, CONFIG.rankRefreshInterval);
  
  console.log('🟢 引擎运行中...');
  
  // 启动后扫描pendingSignals，已达门槛的重新触发审计
  setTimeout(async () => {
    for (const [token, sigs] of Object.entries(pendingSignals)) {
      if (boughtTokens.has(token)) continue;
      const chain = sigs[0]?.chain;
      let hunters = 0, scouts = 0;
      for (const s of sigs) {
        if (s.walletStatus === 'hunter') hunters++;
        else if (s.walletStatus === 'scout') scouts++;
      }
      let confirmed;
      if (chain === 'bsc') confirmed = hunters >= 3 || (hunters >= 2 && scouts >= 3);
      else confirmed = hunters >= 2 || (hunters >= 1 && scouts >= 2);
      if (confirmed) {
        log('INFO', `🔄 启动重审: ${token.slice(0,10)}(${chain}) 猎手=${hunters} 哨兵=${scouts}`);
        handleSignal({ token, chain, wallet: sigs[0].wallet, walletStatus: sigs[0].walletStatus, walletRank: sigs[0].walletRank, timestamp: sigs[0].timestamp, smBuyAmountUsd: sigs[0].smBuyAmountUsd });
        await new Promise(r => setTimeout(r, 2000)); // 间隔2秒防RPC限速
      }
    }
  }, 15000); // 启动15秒后开始（等WS初始化完成）
  
  // 内存管理
  if (global.gc) setInterval(() => global.gc(), 300000);
}

// 全局错误处理（防崩溃丢信号）
process.on('uncaughtException', (e) => { console.error(`[FATAL] 未捕获异常: ${e.message}\n${e.stack}`); });
process.on('unhandledRejection', (e) => { console.error(`[FATAL] 未处理Promise: ${e?.message || e}`); });

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
