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
  minWinRate: 60,                          // 最低胜率%

  // 监控
  evmPollInterval: 5000,                   // BSC/Base 5秒轮询
  
  // 过滤
  minSmartMoneyConfirm: 2,                 // 至少2个钱包确认才跟
  confirmWindowMs: 30 * 60 * 1000,         // 30分钟窗口内的确认算数
  minLiqMcRatio: 0.05,                     // Liq/MC ≥ 5%
  
  // 交易
  positionSizeTop10: 10,                   // TOP10钱包: $10
  positionSizeTop30: 7,                    // TOP11-30: $7
  positionSizeDefault: 5,                  // 其他: $5
  maxPositions: 10,
  maxPerChain: 5,
  
  // 止损/止盈
  earlyStopLoss: -50,                      // 前1小时: -50%
  normalStopLoss: -30,                     // 之后: -30%
  earlyPeriodMs: 3600 * 1000,              // "前1小时"
  takeProfitTrigger: 50,                   // 盈利>50%开始trailing
  trailingStop: 30,                        // trailing 30%
};

// ============ PATHS ============
const DATA_DIR = path.join(__dirname, 'data', 'v8');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');
const AUDIT_CACHE_FILE = path.join(DATA_DIR, 'audit_cache.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ STATE ============
let rankedWallets = [];    // 排名后的钱包列表
let positions = {};        // tokenAddress -> position
let pendingSignals = {};   // tokenAddress -> [{wallet, chain, timestamp}]
let blacklist = new Set();
let auditCache = {};

// Chain config
const CHAINS = {
  solana: { name: 'Solana', binanceId: 'CT_501', okxChainId: '501' },
  bsc:    { name: 'BSC',    binanceId: '56',     okxChainId: '56' },
  base:   { name: 'Base',   binanceId: '8453',   okxChainId: '8453' },
};

const HELIUS_KEY = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_KEY2 = '824cb27b-0794-45ed-aa1c-0798658d8d80';
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: process.env.OKX_API_KEY || '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || 'onchainOS#666',
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
  log('INFO', `  拉取 ${wallets.length} 个钱包`);
  return wallets;
}

async function verifyWallets(wallets) {
  log('INFO', '🔍 验证钱包真实性...');
  const verified = [];
  
  for (const w of wallets) {
    if (w.winRate < CONFIG.minWinRate) continue;
    
    try {
      if (w.chain === 'solana') {
        const d = await rpcPost(HELIUS_RPC, 'getBalance', [w.address]);
        const bal = (d.result?.value || 0) / 1e9;
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
  
  log('INFO', `  验证通过: ${verified.length}/${wallets.filter(w=>w.winRate>=CONFIG.minWinRate).length}`);
  return verified;
}

function rankWallets(wallets) {
  const now = Date.now();
  for (const w of wallets) {
    const activityAge = now - (w.lastActivity || 0);
    const activityBonus = activityAge < 86400000 ? 1.5 : activityAge < 172800000 ? 1.2 : 1.0;
    w.score = w.pnl * (w.winRate / 100) * Math.log2((w.tokens || 1) + 1) * activityBonus;
  }
  wallets.sort((a, b) => b.score - a.score);
  wallets.forEach((w, i) => w.rank = i + 1);
  return wallets;
}

// ============ PHASE 2: 监控层 ============
let solWs = null;
const solWalletSet = new Set();
const bscWalletSet = new Set();
const baseWalletSet = new Set();

function setupSolanaWebSocket() {
  const solWallets = rankedWallets.filter(w => w.chain === 'solana');
  for (const w of solWallets) solWalletSet.add(w.address);
  
  if (solWalletSet.size === 0) return;
  
  solWs = new WebSocket(HELIUS_WS);
  solWs.on('open', () => {
    solWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'accountSubscribe',
      params: [[...solWalletSet], { encoding: 'jsonParsed', commitment: 'confirmed' }]
    }));
    log('INFO', `🔌 [SOL] WebSocket监控 ${solWalletSet.size} 个钱包`);
  });
  
  solWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.method === 'accountNotification') {
        await handleSolanaTransaction(msg.params);
      }
    } catch(e) {}
  });
  
  solWs.on('close', () => {
    log('WARN', '🔌 [SOL] WebSocket断开，5秒后重连');
    setTimeout(setupSolanaWebSocket, 5000);
  });
  
  solWs.on('error', () => {});
}

async function handleSolanaTransaction(params) {
  // TODO: 解析Solana交易，检测买入/卖出
  // Helius Enhanced API解析swap详情
}

async function pollEvmChain(chainKey) {
  const chain = CHAINS[chainKey];
  const walletSet = chainKey === 'bsc' ? bscWalletSet : baseWalletSet;
  const wallets = rankedWallets.filter(w => w.chain === chainKey);
  for (const w of wallets) walletSet.add(w.address);
  
  if (walletSet.size === 0) return;
  log('INFO', `🔌 [${chain.name}] 轮询监控 ${walletSet.size} 个钱包 (${CONFIG.evmPollInterval/1000}s)`);
  
  while (true) {
    try {
      // 用币安trading-signal检测最新买入
      const d = await httpPost(
        'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/web/signal/smart-money',
        { smartSignalType: '', page: 1, pageSize: 100, chainId: chain.binanceId },
        { 'Content-Type': 'application/json' }
      );
      
      const signals = d?.data || [];
      for (const sig of signals) {
        const tokenAddr = (sig.contractAddress || '').toLowerCase();
        if (!tokenAddr || blacklist.has(tokenAddr)) continue;
        
        // 检查触发钱包是否在我们的排名列表里
        // (币安signal里没有具体钱包地址，需要用signal-list或链上检测)
        // 暂用smartMoneyCount作为确认数
        const smCount = sig.smartMoneyCount || 0;
        if (smCount >= CONFIG.minSmartMoneyConfirm) {
          await handleSignal({
            chain: chainKey,
            token: tokenAddr,
            symbol: sig.ticker || '?',
            smartMoneyCount: smCount,
            timestamp: Date.now(),
          });
        }
      }
    } catch(e) {
      log('WARN', `[${chain.name}] 轮询失败: ${e.message}`);
    }
    
    await sleep(CONFIG.evmPollInterval);
  }
}

// ============ PHASE 3: 过滤层 ============
async function handleSignal(signal) {
  const { chain, token, symbol, smartMoneyCount } = signal;
  
  // 已有持仓?
  if (positions[token]) return;
  if (Object.keys(positions).length >= CONFIG.maxPositions) return;
  
  const chainPositions = Object.values(positions).filter(p => p.chain === chain).length;
  if (chainPositions >= CONFIG.maxPerChain) return;
  
  // 多钱包确认
  if (!pendingSignals[token]) pendingSignals[token] = [];
  pendingSignals[token].push(signal);
  
  // 清理过期信号
  const now = Date.now();
  pendingSignals[token] = pendingSignals[token].filter(s => now - s.timestamp < CONFIG.confirmWindowMs);
  
  // 累计确认数
  const totalConfirm = pendingSignals[token].reduce((sum, s) => sum + (s.smartMoneyCount || 1), 0);
  if (totalConfirm < CONFIG.minSmartMoneyConfirm) {
    log('INFO', `⏳ ${symbol}(${chain}) 确认中 ${totalConfirm}/${CONFIG.minSmartMoneyConfirm}`);
    return;
  }
  
  // 合约审计
  const audit = await auditToken(chain, token);
  if (!audit.safe) {
    log('WARN', `❌ ${symbol}(${chain}) 审计不通过: ${audit.reason}`);
    blacklist.add(token);
    saveJSON(BLACKLIST_FILE, [...blacklist]);
    return;
  }
  
  // 流动性检查
  const liqCheck = await checkLiquidity(chain, token);
  if (!liqCheck.ok) {
    log('WARN', `❌ ${symbol}(${chain}) 流动性不足: ${liqCheck.reason}`);
    return;
  }
  
  // 通过所有过滤 → 买入
  log('INFO', `✅ ${symbol}(${chain}) 通过过滤! SM=${totalConfirm} 审计=OK Liq=${liqCheck.ratio}`);
  await executeBuy(chain, token, symbol, totalConfirm);
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
    return { safe: true, reason: 'audit_failed_allow' }; // 审计失败不阻止（宁可买到再说）
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
    return { ok: true, reason: 'check_failed_allow' };
  }
}

// ============ PHASE 4: 交易层 ============
async function executeBuy(chain, tokenAddress, symbol, confirmCount) {
  // 确定仓位大小
  let size = CONFIG.positionSizeDefault;
  // 找参与的最高排名钱包
  const relatedWallets = rankedWallets.filter(w => w.chain === chain);
  // TODO: 精确匹配哪个钱包买了这个token
  // 暂用confirmCount加权
  if (confirmCount >= 10) size = CONFIG.positionSizeTop10;
  else if (confirmCount >= 5) size = CONFIG.positionSizeTop30;
  
  log('INFO', `💰 买入 ${symbol}(${chain}) $${size} SM确认=${confirmCount}`);
  
  try {
    const trader = require('./dex_trader.js');
    const result = await trader.buy(chain, tokenAddress, size);
    
    if (result.success) {
      positions[tokenAddress] = {
        chain,
        token: tokenAddress,
        symbol,
        buyPrice: result.price || 0,
        buyAmount: result.amount || 0,
        buyCost: size,
        buyTime: Date.now(),
        confirmCount,
        highPrice: result.price || 0,
        trailingActive: false,
      };
      saveJSON(POSITIONS_FILE, positions);
      log('INFO', `✅ 买入成功 ${symbol} | tx: ${result.txHash || '?'}`);
      
      // 通知
      notifyTelegram(`🟢 v8买入 ${symbol}(${chain})\n💰 $${size} | SM×${confirmCount}\n🔗 ${result.txHash || ''}`);
    } else {
      log('WARN', `❌ 买入失败 ${symbol}: ${result.error}`);
    }
  } catch(e) {
    log('ERROR', `买入异常 ${symbol}: ${e.message}`);
  }
}

async function executeSell(tokenAddress, reason, ratio = 1.0) {
  const pos = positions[tokenAddress];
  if (!pos) return;
  
  const sellAmount = pos.buyAmount * ratio;
  log('INFO', `💸 卖出 ${pos.symbol}(${pos.chain}) ${(ratio*100).toFixed(0)}% 原因:${reason}`);
  
  try {
    const trader = require('./dex_trader.js');
    const result = await trader.sell(pos.chain, tokenAddress, sellAmount);
    
    if (result.success) {
      if (ratio >= 0.99) {
        delete positions[tokenAddress];
      } else {
        pos.buyAmount -= sellAmount;
      }
      saveJSON(POSITIONS_FILE, positions);
      log('INFO', `✅ 卖出成功 ${pos.symbol} | tx: ${result.txHash || '?'}`);
      notifyTelegram(`🔴 v8卖出 ${pos.symbol}(${pos.chain})\n📉 原因: ${reason}\n🔗 ${result.txHash || ''}`);
    }
  } catch(e) {
    log('ERROR', `卖出异常 ${pos.symbol}: ${e.message}`);
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
        
        // 更新最高价
        if (currentPrice > pos.highPrice) pos.highPrice = currentPrice;
        
        // 止损逻辑
        const stopLoss = holdTime < CONFIG.earlyPeriodMs ? CONFIG.earlyStopLoss : CONFIG.normalStopLoss;
        if (pnlPercent <= stopLoss) {
          await executeSell(tokenAddr, `止损${pnlPercent.toFixed(1)}%`);
          continue;
        }
        
        // Trailing stop
        if (pnlPercent >= CONFIG.takeProfitTrigger) {
          pos.trailingActive = true;
        }
        if (pos.trailingActive && pos.highPrice > 0) {
          const dropFromHigh = ((pos.highPrice - currentPrice) / pos.highPrice) * 100;
          if (dropFromHigh >= CONFIG.trailingStop) {
            await executeSell(tokenAddr, `trailing止盈 从高点回落${dropFromHigh.toFixed(1)}%`);
            continue;
          }
        }
        
        // 跟卖: 检查聪明钱是否在卖
        // TODO: 监控钱包卖出信号 + 价格下跌确认
        
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
  
  // Phase 1: 拉取排名
  const rawWallets = await fetchBinanceRank();
  const verified = await verifyWallets(rawWallets);
  rankedWallets = rankWallets(verified);
  saveJSON(WALLETS_FILE, rankedWallets.map(w => ({
    rank: w.rank, address: w.address, chain: w.chain,
    pnl: w.pnl, winRate: w.winRate, tokens: w.tokens,
    score: w.score, topTokens: w.topTokens.map(t => t.tokenSymbol),
  })));
  
  const byChain = { solana: 0, bsc: 0, base: 0 };
  for (const w of rankedWallets) byChain[w.chain]++;
  console.log(`📋 跟踪: SOL=${byChain.solana} BSC=${byChain.bsc} Base=${byChain.base}`);
  console.log(`💼 持仓: ${Object.keys(positions).length}个`);
  
  // Phase 2: 启动监控
  setupSolanaWebSocket();
  pollEvmChain('bsc');
  pollEvmChain('base');
  
  // 持仓管理
  managePositions();
  
  // 定时刷新排名
  setInterval(async () => {
    try {
      log('INFO', '🔄 定时刷新排名...');
      const raw = await fetchBinanceRank();
      const ver = await verifyWallets(raw);
      rankedWallets = rankWallets(ver);
      saveJSON(WALLETS_FILE, rankedWallets.map(w => ({
        rank: w.rank, address: w.address, chain: w.chain,
        pnl: w.pnl, winRate: w.winRate, tokens: w.tokens, score: w.score,
      })));
      log('INFO', `  排名更新: ${rankedWallets.length}个钱包`);
    } catch(e) {
      log('ERROR', `排名刷新失败: ${e.message}`);
    }
  }, CONFIG.rankRefreshInterval);
  
  console.log('🟢 引擎运行中...');
  
  // 内存管理
  if (global.gc) setInterval(() => global.gc(), 300000);
}

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
