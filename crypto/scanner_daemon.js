#!/usr/bin/env node
/**
 * 三链扫描+聪明钱WebSocket监听 - 24/7后台服务
 * 
 * Solana: Helius WebSocket + OKX onchainos
 * BSC: publicnode WebSocket + OKX onchainos  
 * Base: publicnode WebSocket + GeckoTerminal
 */

const WebSocket = require('ws');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const ONCHAINOS = path.join(process.env.HOME, '.local/bin/onchainos');
const LOG_FILE = path.join(WORKSPACE, 'crypto', 'scanner.log');
const NOTIFY_FILE = path.join(WORKSPACE, 'crypto', 'notifications.jsonl');
const STRATEGY_HP = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'strategy_横盘.json'), 'utf8'));
const STRATEGY_SM = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'strategy_聪明钱跟单.json'), 'utf8'));

// WebSocket 节点
const WS_ENDPOINTS = {
  solana: 'wss://mainnet.helius-rpc.com/?api-key=5c5d615e-ba81-4f40-b6a7-dfa9a460839e',
  bsc: 'wss://bsc.publicnode.com',
  base: 'wss://base.publicnode.com'
};

// 状态
let smartMoneyWallets = new Set();
let baitBlacklist = new Set(); // 钓鱼钱包黑名单
const recentSignals = new Map(); // 防重复通知
const activePositions = new Set(); // 当前持仓代币地址（防重复买入）
const wsConnections = {};
let stats = { started: new Date().toISOString(), signals: 0, scans: 0, wsEvents: 0 };

// 加载已有持仓
try {
  const pos = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'positions.json'), 'utf8'));
  for (const p of (pos.active || [])) activePositions.add(p.token);
} catch(e) {}

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function notify(msg) {
  try {
    fs.appendFileSync(NOTIFY_FILE, JSON.stringify({ time: new Date().toISOString(), message: msg }) + '\n');
  } catch(e) {}
  log(`📢 ${msg}`);
  stats.signals++;
}

// ============ 聪明钱列表更新（私有列表，不依赖OKX）============
// Solana聪明钱历史记录（用于衰退机制）
let solSmartMoneyHistory = new Map(); // address -> { score, missCount, lastSeen }
const SOL_HISTORY_PATH = path.join(WORKSPACE, 'crypto', 'sol_smart_money_history.json');
try {
  const h = JSON.parse(fs.readFileSync(SOL_HISTORY_PATH, 'utf8'));
  for (const [k, v] of Object.entries(h)) solSmartMoneyHistory.set(k, v);
} catch(e) {}

function updateSmartMoney() {
  try {
    const newSet = new Set();
    const thisRoundAddrs = new Set(); // 本轮从API拿到的地址
    
    // 1. 加载Solana私有聪明钱（永不删除）
    try {
      const solData = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'solana_private_smart_money.json'), 'utf8'));
      for (const w of (solData.wallets || [])) {
        if (w.address && w.address.length > 30) {
          newSet.add(w.address);
          thisRoundAddrs.add(w.address);
        }
      }
      log(`  Solana私有聪明钱: ${solData.wallets?.length || 0}个`);
    } catch(e) {}
    
    // 2. 加载BSC/Base聪明钱
    try {
      const evmData = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'evm_smart_money.json'), 'utf8'));
      log(`  BSC聪明钱: ${evmData.bsc?.length || 0}个 | Base聪明钱: ${evmData.base?.length || 0}个`);
    } catch(e) {}
    
    // 3. OKX作为补充候选（二次筛选后才加入）
    try {
      const result = execSync(
        `cd ${WORKSPACE} && ${ONCHAINOS} market signal-list solana --wallet-type "1" --min-amount-usd 500 2>/dev/null`,
        { timeout: 20000 }
      ).toString();
      const data = JSON.parse(result);
      if (data.ok && data.data) {
        for (const s of data.data) {
          (s.triggerWalletAddress || '').split(',').forEach(a => {
            const t = a.trim();
            if (t.length > 30) {
              newSet.add(t);
              thisRoundAddrs.add(t);
            }
          });
        }
      }
    } catch(e) {}
    
    // 4. ★ 衰退机制：保留历史高分但本轮缺席的钱包
    for (const [addr, record] of solSmartMoneyHistory) {
      if (thisRoundAddrs.has(addr)) {
        // 本轮在榜 → 重置缺席，加分
        record.missCount = 0;
        record.score = (record.score || 0) + 0.5;
        record.lastSeen = Date.now();
      } else {
        // 本轮缺席
        record.missCount = (record.missCount || 0) + 1;
        const maxMiss = record.score >= 3 ? 10 : record.score >= 2 ? 6 : record.score >= 1 ? 3 : 1;
        if (record.missCount <= maxMiss) {
          newSet.add(addr); // 还在容忍期，保留
        }
        // 超过容忍 → 不加入，自然淘汰
      }
    }
    
    // 5. 更新历史记录（新出现的钱包加入历史）
    for (const addr of thisRoundAddrs) {
      if (!solSmartMoneyHistory.has(addr)) {
        solSmartMoneyHistory.set(addr, { score: 1, missCount: 0, lastSeen: Date.now() });
      }
    }
    
    // 清理太久没出现的（超过30天）
    const now = Date.now();
    for (const [addr, r] of solSmartMoneyHistory) {
      if (now - (r.lastSeen || 0) > 30 * 24 * 3600000) solSmartMoneyHistory.delete(addr);
    }
    
    // 保存历史
    try {
      const obj = {};
      for (const [k, v] of solSmartMoneyHistory) obj[k] = v;
      fs.writeFileSync(SOL_HISTORY_PATH, JSON.stringify(obj));
    } catch(e) {}
    
    smartMoneyWallets = newSet;
    
    // 加载钓鱼黑名单，从聪明钱中剔除
    try {
      const bl = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'bait_blacklist.json'), 'utf8'));
      baitBlacklist = new Set([...(bl.confirmed || []), ...(bl.suspect || [])]);
      let removed = 0;
      for (const bait of baitBlacklist) {
        if (smartMoneyWallets.delete(bait)) removed++;
      }
      if (removed > 0) log(`🚫 过滤掉 ${removed} 个钓鱼钱包，剩余 ${smartMoneyWallets.size} 个`);
    } catch(e) {} // 黑名单不存在时忽略
    
    log(`🔄 聪明钱列表更新: ${smartMoneyWallets.size}个地址`);
  } catch(e) {
    log(`❌ 聪明钱列表更新失败: ${e.message}`);
  }
}

// ============ 聪明钱跟单检查 ============
function checkSmartMoneySignals() {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market signal-list solana --wallet-type "1" --min-amount-usd 500 2>/dev/null`,
      { timeout: 20000 }
    ).toString();
    const data = JSON.parse(result);
    if (!data.ok || !data.data) return;

    const follow = STRATEGY_SM;
    if (!follow) return;

    for (const signal of data.data) {
      const t = signal.token;
      const addr = t.tokenAddress;
      if (recentSignals.has(addr)) continue;

      const mcap = parseFloat(t.marketCapUsd || 0);
      const soldRatio = parseFloat(signal.soldRatioPercent || 100);
      const walletCount = parseInt(signal.triggerWalletCount || 0);
      const top10 = parseFloat(t.top10HolderPercent || 100);
      const holders = parseInt(t.holders || 0);

      const conds = follow['筛选条件'] || {};
      if (mcap > (conds.max_market_cap_usd || 1000000)) continue;
      if (soldRatio > (conds.max_sold_ratio_pct || 30)) continue;
      if (walletCount < (conds.min_smart_wallets || 3)) continue;
      if (top10 > (conds.max_top10_holder_pct || 40)) continue;

      // OKX API信号不区分核心/观察，只作为观察信号，不触发自动买入
      // 实际买入只走WebSocket路径（有权重系统，核心≥2才跟）
      notify(`👀 [SOL] 聪明钱观察（OKX信号）\n${t.symbol} (${t.name})\n市值: $${mcap.toLocaleString()}\n聪明钱: ${walletCount}个\n已卖出: ${soldRatio}%\n持币人: ${holders}\nTop10: ${top10}%\n地址: ${addr}`);
      recentSignals.set(addr, Date.now());
    }
  } catch(e) {
    // 限速导致失败，忽略
  }
}

// ============ 横盘扫描（三条链）============
function scanConsolidation() {
  log('🔍 开始横盘扫描...');
  stats.scans++;

  // Solana
  scanChainOKX('solana');
  // BSC  
  setTimeout(() => scanChainOKX('bsc'), 5000);
  // Base
  setTimeout(() => scanChainGecko(), 10000);
}

function scanChainOKX(chain) {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market memepump-tokens ${chain} --stage MIGRATED 2>/dev/null`,
      { timeout: 20000 }
    ).toString();
    const data = JSON.parse(result);
    if (!data.ok || !data.data) return;

    const now = Date.now();
    const candidates = [];

    for (const t of data.data) {
      const mcap = parseFloat(t.market?.marketCapUsd || 0);
      const created = parseFloat(t.createdTimestamp || 0);
      const ageDays = created ? (now - created) / 86400000 : 999;
      const holders = parseInt(t.tags?.totalHolders || 0);
      const insiders = parseFloat(t.tags?.insidersPercent || 0);
      const bundlers = parseFloat(t.tags?.bundlersPercent || 0);
      const snipers = parseFloat(t.tags?.snipersPercent || 0);
      const dev = parseFloat(t.tags?.devHoldingsPercent || 0);

      const vol24h = parseFloat(t.market?.volumeUsd24h || t.market?.volumeUsd1h * 24 || 0);

      if (mcap > 2000000 || mcap < 50000) continue; // 模式四允许到$2M
      // 成交量不限制
      if (ageDays > 14) continue;
      if (holders < 100) continue;
      if (insiders > 10 || snipers > 30 || dev > 30) continue;
      if (bundlers > 5) continue;

      candidates.push({ symbol: t.symbol, address: t.tokenAddress, mcap, ageDays, holders });
    }

    // 查K线判断横盘（冲高回落后底部横住，4H和1H都要满足）
    for (const c of candidates.slice(0, 5)) {
      try {
        let pass4H = false, pass1H = false;
        let vol4H = 999, vol1H = 999;
        let isPostDump = false;

        // 查4H K线（多拉一些看冲高回落）
        try {
          const kResult4H = execSync(
            `cd ${WORKSPACE} && ${ONCHAINOS} market kline ${c.address} --chain ${chain} --bar 4H --limit 12 2>/dev/null`,
            { timeout: 10000 }
          ).toString();
          const kData4H = JSON.parse(kResult4H);
          if (kData4H.ok && kData4H.data && kData4H.data.length >= 6) {
            const allHighs = kData4H.data.map(k => parseFloat(k[2]));
            const allTimePeak = Math.max(...allHighs);
            
            // 最近4根判断横盘
            const last = kData4H.data.slice(-4);
            const highs = last.map(k => parseFloat(k[2]));
            const lows = last.map(k => parseFloat(k[3]));
            const maxH = Math.max(...highs), minL = Math.min(...lows);
            const mid = (maxH + minL) / 2;
            vol4H = mid > 0 ? (maxH - minL) / mid * 100 : 999;
            
            // 当前价格从历史高点回落>50%
            const currentPrice = parseFloat(kData4H.data[kData4H.data.length-1][4]);
            if (allTimePeak > 0 && currentPrice < allTimePeak * 0.6) {
              isPostDump = true;
            }
            
            // 不再创新低：最近2根低点 >= 之前2根低点
            if (last.length >= 4) {
              const recentLow = Math.min(parseFloat(last[2][3]), parseFloat(last[3][3]));
              const prevLow = Math.min(parseFloat(last[0][3]), parseFloat(last[1][3]));
              if (recentLow < prevLow * 0.95) isPostDump = false; // 还在创新低，不算横盘
            }
            
            if (vol4H < 30) pass4H = true;
          }
        } catch(e) {}

        // 查1H K线
        try {
          const kResult1H = execSync(
            `cd ${WORKSPACE} && ${ONCHAINOS} market kline ${c.address} --chain ${chain} --bar 1H --limit 8 2>/dev/null`,
            { timeout: 10000 }
          ).toString();
          const kData1H = JSON.parse(kResult1H);
          if (kData1H.ok && kData1H.data && kData1H.data.length >= 6) {
            const last6 = kData1H.data.slice(-6);
            const highs = last6.map(k => parseFloat(k[2]));
            const lows = last6.map(k => parseFloat(k[3]));
            const maxH = Math.max(...highs), minL = Math.min(...lows);
            const mid = (maxH + minL) / 2;
            vol1H = mid > 0 ? (maxH - minL) / mid * 100 : 999;
            if (vol1H < 30) pass1H = true;
          }
        } catch(e) {}

        // 模式一：冲高回落后底部横住
        // 模式二：底部抬升型（震荡上行）
        let isRising = false;
        try {
          const kAll = execSync(
            `cd ${WORKSPACE} && ${ONCHAINOS} market kline ${c.address} --chain ${chain} --bar 4H --limit 12 2>/dev/null`,
            { timeout: 10000 }
          ).toString();
          const kDataAll = JSON.parse(kAll);
          if (kDataAll.ok && kDataAll.data && kDataAll.data.length >= 6) {
            const d = kDataAll.data;
            const len = d.length;
            // 分前半段和后半段，看低点是否抬升
            const half = Math.floor(len / 2);
            const firstHalfLows = d.slice(0, half).map(k => parseFloat(k[3]));
            const secondHalfLows = d.slice(half).map(k => parseFloat(k[3]));
            const firstMin = Math.min(...firstHalfLows);
            const secondMin = Math.min(...secondHalfLows);
            // 后半段低点比前半段高20%以上 = 底部抬升
            if (secondMin > firstMin * 1.2 && firstMin > 0) {
              isRising = true;
            }
          }
        } catch(e) {}

        // 模式三：W底（双底不破前低）
        let isWBottom = false;
        try {
          const kAll2 = execSync(
            `cd ${WORKSPACE} && ${ONCHAINOS} market kline ${c.address} --chain ${chain} --bar 1H --limit 24 2>/dev/null`,
            { timeout: 10000 }
          ).toString();
          const kW = JSON.parse(kAll2);
          if (kW.ok && kW.data && kW.data.length >= 12) {
            const lows = kW.data.map(k => parseFloat(k[3]));
            const highs = kW.data.map(k => parseFloat(k[2]));
            
            // 找两个低谷：把K线分三段，找第一段和第三段的最低点
            const third = Math.floor(lows.length / 3);
            const seg1Lows = lows.slice(0, third);
            const seg2Highs = highs.slice(third, third * 2);
            const seg3Lows = lows.slice(third * 2);
            
            const low1 = Math.min(...seg1Lows);
            const mid_high = Math.max(...seg2Highs);
            const low2 = Math.min(...seg3Lows);
            
            // W底条件：
            // 1. 两个低点接近（差距<20%）
            // 2. 中间有反弹（反弹高点比两个低点高>30%）
            // 3. 第二个低点不破第一个（low2 >= low1 * 0.95）
            if (low1 > 0 && low2 > 0) {
              const lowDiff = Math.abs(low2 - low1) / low1;
              const bounce = (mid_high - low1) / low1;
              if (lowDiff < 0.2 && bounce > 0.3 && low2 >= low1 * 0.95) {
                isWBottom = true;
              }
            }
          }
        } catch(e) {}

        // 模式四：腰部横盘（冲高回落到中间位置横住）
        let isMidConsolidation = false;
        try {
          if (klines4H && klines4H.data && klines4H.data.length >= 6) {
            const k = klines4H.data;
            const allHighs = k.map(x => parseFloat(x[2]));
            const allLows = k.map(x => parseFloat(x[3]));
            const allCloses = k.map(x => parseFloat(x[4]));
            
            const ath = Math.max(...allHighs); // 历史最高
            const atl = Math.min(...allLows);  // 历史最低
            const range = ath - atl;
            
            if (range > 0 && atl > 0) {
              // 当前价格在30-60%回撤位（腰部）
              const currentPrice = allCloses[allCloses.length - 1];
              const retraceRatio = (ath - currentPrice) / range;
              
              // 最近3根K线波动率<30%（在腰部横住了）
              const recent = allCloses.slice(-3);
              const recentMax = Math.max(...recent);
              const recentMin = Math.min(...recent);
              const recentVol = recentMin > 0 ? (recentMax - recentMin) / recentMin * 100 : 999;
              
              // 条件：回撤30-60% + 最近波动<30% + 从低点涨过至少100%
              if (retraceRatio >= 0.3 && retraceRatio <= 0.6 && recentVol < 30 && ath / atl > 2) {
                isMidConsolidation = true;
              }
            }
          }
        } catch(e) {}

        const matched = (pass4H && pass1H && isPostDump) || (isRising && pass1H) || (isWBottom && pass1H) || (isMidConsolidation && pass1H);
        const pattern = (pass4H && pass1H && isPostDump) ? '冲高回落后底部横住' 
          : isWBottom ? 'W底双底确认' 
          : isMidConsolidation ? '腰部横盘（等二次拉升）'
          : '底部抬升震荡上行';

        if (matched) {
            const key = `${chain}:${c.address}`;
            if (!recentSignals.has(key)) {
              // 横盘确认，但不直接发买入信号，加入观察列表等内幕/聪明钱加仓
              notify(`👀 [${chain.toUpperCase()}] 横盘观察!\n${pattern}\n${c.symbol}\n市值: $${c.mcap.toLocaleString()}\n4H波动: ${vol4H.toFixed(1)}% | 1H波动: ${vol1H.toFixed(1)}%\n持币人: ${c.holders}\n上线: ${c.ageDays.toFixed(1)}天\n⏳ 等待聪明钱/内幕加仓...\n地址: ${c.address}`);
              recentSignals.set(key, Date.now());
              
              // 加入横盘观察列表，等聪明钱买入时交叉验证
              if (!global.consolidationWatchlist) global.consolidationWatchlist = new Map();
              global.consolidationWatchlist.set(c.address, {
                symbol: c.symbol, chain, mcap: c.mcap, holders: c.holders,
                pattern, addedAt: Date.now()
              });
            }
        }
      } catch(e) {}
    }

    if (candidates.length > 0) {
      log(`[${chain.toUpperCase()}] 初筛 ${candidates.length} 个候选`);
    }
  } catch(e) {
    log(`[${chain.toUpperCase()}] 扫描失败: ${e.message}`);
  }
}

function scanChainGecko() {
  const options = {
    hostname: 'api.geckoterminal.com',
    path: '/api/v2/networks/base/trending_pools',
    headers: { 'Accept': 'application/json' }
  };

  https.get(options, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        let count = 0;
        for (const p of (data.data || [])) {
          const attr = p.attributes || {};
          const fdv = parseFloat(attr.fdv_usd || 0);
          if (fdv > 1000000 || fdv < 5000) continue;
          count++;
        }
        if (count > 0) log(`[BASE] GeckoTerminal 初筛 ${count} 个候选`);
      } catch(e) {}
    });
  }).on('error', () => {});
}

// ============ WebSocket 监听 ============
function connectWS(chain) {
  const url = WS_ENDPOINTS[chain];
  if (!url) return;

  const ws = new WebSocket(url);
  wsConnections[chain] = ws;

  ws.on('open', () => {
    log(`🟢 [${chain.toUpperCase()}] WebSocket已连接`);

    if (chain === 'solana') {
      // 用transactionSubscribe直接监听聪明钱的交易（毫秒级）
      const addrs = [...smartMoneyWallets];
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 420,
        method: 'transactionSubscribe',
        params: [{
          accountInclude: addrs
        }, {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0
        }]
      }));
      log(`👁️ [SOL] transactionSubscribe监听 ${addrs.length} 个聪明钱（秒级跟单）`);
    } else {
      // BSC/Base: 订阅pending交易（mempool backrunning）
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_subscribe',
        params: ['newPendingTransactions']
      }));
      // 同时订阅新区块（用于确认）
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'eth_subscribe',
        params: ['newHeads']
      }));
      log(`👁️ [${chain.toUpperCase()}] 监听Mempool+新区块（backrunning模式）`);
    }
  });

  ws.on('message', (data) => {
    stats.wsEvents++;
    try {
      const msg = JSON.parse(data.toString());
      
      // Solana: 解析聪明钱的实际交易
      if (chain === 'solana' && msg.method === 'transactionNotification') {
        const tx = msg.params?.result;
        if (tx) {
          parseSmartMoneyTx(tx);
        }
      }
      
      // BSC/Base: 解析pending交易（mempool）
      if ((chain === 'bsc' || chain === 'base') && msg.params?.result && typeof msg.params.result === 'string') {
        const txHash = msg.params.result;
        // 异步获取交易详情并检查是否是聪明钱
        parseEVMPendingTx(chain, txHash).catch(() => {});
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    log(`🔴 [${chain.toUpperCase()}] WebSocket断开，10秒后重连`);
    setTimeout(() => connectWS(chain), 10000);
  });

  ws.on('error', (err) => {
    log(`❌ [${chain.toUpperCase()}] WS错误: ${err.message}`);
  });
}

// ============ 解析聪明钱交易（秒级跟单）============
const smartMoneyBuys = new Map(); // token -> { wallets: Set, firstSeen: timestamp }

function parseSmartMoneyTx(tx) {
  try {
    const sig = tx.signature;
    const accounts = tx.transaction?.message?.accountKeys || [];
    const instructions = tx.transaction?.message?.instructions || [];
    const meta = tx.meta;
    
    if (!meta || meta.err) return; // 交易失败跳过
    
    // 找到哪个聪明钱发起的
    const signer = accounts[0]?.pubkey || accounts[0];
    if (!signer || !smartMoneyWallets.has(signer)) return;
    if (baitBlacklist.has(signer)) return; // 钓鱼钱包跳过
    
    // 盈亏跟踪器
    let smTracker;
    try { smTracker = require('./smart_money_tracker.js'); } catch(e) {}
    
    // 如果tracker说不应该跟这个钱包，跳过
    if (smTracker && !smTracker.shouldFollow(signer)) return;
    
    // 检查token余额变化，找到买入的币
    const preTokens = (meta.preTokenBalances || []);
    const postTokens = (meta.postTokenBalances || []);
    
    for (const post of postTokens) {
      const mint = post.mint;
      if (!mint) continue;
      
      const pre = preTokens.find(p => p.mint === mint && p.owner === post.owner);
      const preBal = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
      const postBal = parseFloat(post.uiTokenAmount?.uiAmount || 0);
      
      // token余额增加 = 买入
      if (postBal > preBal && postBal - preBal > 0) {
        // 记录这个聪明钱买了这个币
        if (!smartMoneyBuys.has(mint)) {
          smartMoneyBuys.set(mint, { wallets: new Set(), firstSeen: Date.now() });
        }
        const record = smartMoneyBuys.get(mint);
        record.wallets.add(signer);
        
        log(`⚡ 聪明钱 ${signer.slice(0,8)}... 买入 ${mint.slice(0,8)}... (已有${record.wallets.size}个聪明钱)`);
        if (smTracker) smTracker.recordTrade(signer, mint.slice(0,8), 'buy');
        
        // 实时钓鱼检测
        let phishCheck;
        try {
          const detector = require('./realtime_phishing_detector.js');
          detector.recordBuy(signer, mint, 0);
          phishCheck = detector.preTradeCheck(signer, mint, 0);
        } catch(e) { phishCheck = { safe: true }; }
        
        if (!phishCheck.safe) {
          log(`🚨 钓鱼拦截 ${signer.slice(0,8)}...: ${phishCheck.reason}`);
          continue; // 跳过这个信号
        }
        
        // 检查是否在横盘观察列表中 → 横盘+聪明钱加仓 = 买入信号！
        const watchlist = global.consolidationWatchlist || new Map();
        if (watchlist.has(mint)) {
          const info = watchlist.get(mint);
          if (activePositions.has(mint)) { log(`⏭️ ${mint.slice(0,8)} 已持仓，跳过`); }
          else {
          const key = `hp_buy:${mint}`;
          if (!recentSignals.has(key)) {
            notify(`🔥🔥 [${info.chain.toUpperCase()}] 横盘+聪明钱买入=买入!\n${info.symbol}\n横盘模式: ${info.pattern}\n市值: $${info.mcap.toLocaleString()}\n聪明钱: ${record.wallets.size}个在买\n持币人: ${info.holders}\n地址: ${mint}`);
            recentSignals.set(key, Date.now());
            activePositions.add(mint);
          }
          }
        }
        
        // 聪明钱跟单策略：只跟核心+正常钱包
        // 权重：🥇核心=3, 🥈正常=2, 🥉观察=0（不参与）, ❌暂停=0
        if (Date.now() - record.firstSeen < 3600000) {
          let consensusWeight = 0;
          let coreCount = 0;
          let normalCount = 0;
          try {
            const ranker = require('./smart_money_ranker.js');
            for (const w of record.wallets) {
              const weight = ranker.getWeight(w);
              if (weight >= 3) { coreCount++; consensusWeight += weight; }
              else if (weight >= 2) { normalCount++; consensusWeight += weight; }
              // 观察(weight=1)不计入权重
            }
          } catch(e) {
            consensusWeight = 0; // ranker加载失败就不跟
          }
          
          // 至少1个核心 + 总权重≥5 才触发
          if (consensusWeight >= 5 && coreCount >= 1) {
            if (activePositions.has(mint)) { log(`⏭️ ${mint.slice(0,8)} 已持仓，跳过跟单`); }
            else {
            const key = `sm_follow:${mint}`;
            if (!recentSignals.has(key)) {
              notify(`🎯⚡ [SOL] 聪明钱共识跟单!\n代币: ${mint}\n共识度: ${consensusWeight}分 (🥇核心${coreCount}+🥈正常${normalCount})\n聪明钱数: ${record.wallets.size}个\n检测延迟: ${((Date.now() - record.firstSeen) / 1000).toFixed(0)}秒\n钱包: ${[...record.wallets].map(w => w.slice(0,8)+'...').join(', ')}`);
              recentSignals.set(key, Date.now());
              activePositions.add(mint);
            }
            }
          }
        }
      }
      
      // token余额减少 = 卖出 → 检查是否需要跟卖
      if (postBal < preBal && preBal - postBal > 0) {
        // 只关注核心+正常钱包的卖出，观察钱包忽略
        let sellerTier = 'watch';
        try {
          const ranker = require('./smart_money_ranker.js');
          const weight = ranker.getWeight(signer);
          if (weight >= 3) sellerTier = 'core';
          else if (weight >= 2) sellerTier = 'normal';
        } catch(e) {}
        
        if (sellerTier === 'watch') continue; // 观察钱包卖出不管
        
        // 检查这个token是否是我们持仓的
        if (activePositions.has(mint)) {
          const sellPct = postBal === 0 ? 100 : Math.round((1 - postBal / preBal) * 100);
          const tierEmoji = sellerTier === 'core' ? '🥇核心' : '🥈正常';
          log(`🏃 ${tierEmoji}聪明钱 ${signer.slice(0,8)}... 卖出 ${mint.slice(0,8)}... (${sellPct}%)`);
          
          const key = `sm_sell:${mint}:${signer}`;
          if (!recentSignals.has(key)) {
            notify(`🏃💨 [SOL] 聪明钱卖出!\n代币: ${mint}\n钱包: ${signer.slice(0,12)}...\n等级: ${tierEmoji}\n卖出比例: ${sellPct}%\n${postBal === 0 ? '⚠️ 全部清仓!' : '部分卖出'}`);
            recentSignals.set(key, Date.now());
          }
          
          if (smTracker) smTracker.recordTrade(signer, mint.slice(0,8), 'sell');
        }
      }
    }
  } catch(e) {
    // 解析失败忽略
  }
}

// ============ EVM Mempool Backrunning ============
const evmSmartMoneySet = { bsc: new Set(), base: new Set() };
const pendingTxCache = new Set(); // 防重复
const RPC_URLS = {
  bsc: 'https://bsc-dataseed2.binance.org',
  base: 'https://mainnet.base.org'
};

// 加载EVM聪明钱地址集合
function loadEVMSmartMoney() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'evm_smart_money.json'), 'utf8'));
    evmSmartMoneySet.bsc = new Set((data.bsc || []).map(w => w.address?.toLowerCase()));
    evmSmartMoneySet.base = new Set((data.base || []).map(w => w.address?.toLowerCase()));
    log(`📋 EVM聪明钱加载: BSC ${evmSmartMoneySet.bsc.size}个 Base ${evmSmartMoneySet.base.size}个`);
  } catch(e) {}
}
loadEVMSmartMoney();
// 每次EVM更新后重新加载
setInterval(loadEVMSmartMoney, 10 * 60 * 1000);

// DEX Router地址（用于识别swap交易）
const DEX_ROUTERS = {
  bsc: new Set([
    '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2
    '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', // PancakeSwap V3
    '0x1b81d678ffb9c0263b24a97847620c99d213eb14', // PancakeSwap Universal
  ]),
  base: new Set([
    '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // Aerodrome
  ])
};

async function parseEVMPendingTx(chain, txHash) {
  // 防重复 + 限制缓存大小
  if (pendingTxCache.has(txHash)) return;
  pendingTxCache.add(txHash);
  if (pendingTxCache.size > 10000) {
    const arr = [...pendingTxCache];
    for (let i = 0; i < 5000; i++) pendingTxCache.delete(arr[i]);
  }
  
  try {
    // 获取pending交易详情
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_getTransactionByHash',
      params: [txHash]
    });
    
    const txData = await new Promise((resolve, reject) => {
      const url = new URL(RPC_URLS[chain]);
      const req = https.request({
        hostname: url.hostname, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 3000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d).result); }
          catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
    
    if (!txData || !txData.from) return;
    
    const from = txData.from.toLowerCase();
    const to = (txData.to || '').toLowerCase();
    
    // 检查是否是聪明钱发起的DEX交易
    if (!evmSmartMoneySet[chain].has(from)) return;
    if (baitBlacklist.has(from)) return;
    if (!DEX_ROUTERS[chain].has(to)) return;
    
    // 这是聪明钱的DEX swap交易！（还在mempool中）
    const input = txData.input || '';
    const value = parseInt(txData.value || '0', 16);
    const gasPrice = parseInt(txData.gasPrice || '0', 16);
    
    log(`🔥 [${chain.toUpperCase()}] Mempool捕获! 聪明钱 ${from.slice(0,10)}... → ${to.slice(0,10)}...`);
    log(`  Value: ${(value / 1e18).toFixed(4)} | Gas: ${(gasPrice / 1e9).toFixed(1)} Gwei`);
    
    // 尝试解析swap方向（简化：看input前4字节=function selector）
    const selector = input.slice(0, 10);
    // 常见swap selectors
    const swapSelectors = {
      '0x38ed1739': 'swapExactTokensForTokens',
      '0x8803dbee': 'swapTokensForExactTokens', 
      '0x7ff36ab5': 'swapExactETHForTokens',
      '0x18cbafe5': 'swapExactTokensForETH',
      '0x5ae401dc': 'multicall(deadline)',
      '0xac9650d8': 'multicall()',
      '0x04e45aaf': 'exactInputSingle',
      '0xb858183f': 'exactInput',
    };
    
    const swapType = swapSelectors[selector] || `unknown(${selector})`;
    
    // 如果是买入（ETH→Token），记录并准备backrun
    const isBuy = swapType.includes('ETHForTokens') || swapType.includes('exactInput') || value > 0;
    
    if (isBuy) {
      const nativeSymbol = chain === 'bsc' ? 'BNB' : 'ETH';
      const nativeAmount = (value / 1e18).toFixed(4);
      
      notify(`⚡🔥 [${chain.toUpperCase()}] Mempool捕获聪明钱买入!\n钱包: ${from.slice(0,10)}...\n方法: ${swapType}\n金额: ${nativeAmount} ${nativeSymbol}\nGas: ${(gasPrice/1e9).toFixed(1)} Gwei\n状态: PENDING（还没上链！）\nTx: ${txHash}`);
      
      // TODO: 在这里构建并发送backrun交易
      // 1. 解析出目标token地址
      // 2. 构建同样的swap交易（我们的钱包）
      // 3. 设置稍高的gas价格
      // 4. 立即发送到链上
    }
    
    // 如果是卖出，检查是否是我们持仓的币 → 聪明钱跑了
    if (!isBuy && swapType.includes('TokensForETH')) {
      notify(`🏃💨 [${chain.toUpperCase()}] 聪明钱卖出!\n钱包: ${from.slice(0,10)}...\n方法: ${swapType}\n状态: PENDING\n⚠️ 跟卖信号\nTx: ${txHash}`);
    }
    
  } catch(e) {
    // 静默失败
  }
}

// 每小时清理旧的聪明钱买入记录
setInterval(() => {
  const now = Date.now();
  for (const [mint, record] of smartMoneyBuys) {
    if (now - record.firstSeen > 3600000) smartMoneyBuys.delete(mint);
  }
}, 3600000);


function cleanup() {
  const now = Date.now();
  for (const [key, time] of recentSignals) {
    if (now - time > 24 * 3600000) recentSignals.delete(key);
  }
}

// ============ 状态报告 ============
function statusReport() {
  const uptime = ((Date.now() - new Date(stats.started).getTime()) / 3600000).toFixed(1);
  log(`📊 状态: 运行${uptime}h | 信号${stats.signals}个 | 扫描${stats.scans}次 | WS事件${stats.wsEvents}个 | 聪明钱${smartMoneyWallets.size}个`);
  
  // 更新排名
  try {
    const ranker = require('./smart_money_ranker.js');
    ranker.updateRankings();
    const summary = ranker.getSummary();
    for (const chain of ['solana', 'bsc', 'base']) {
      const s = summary[chain];
      if (s.total > 0) log(`  📈 [${chain}] 排名: 🥇${s.core} 🥈${s.normal} 🥉${s.watch} ❌${s.paused}`);
    }
  } catch(e) {}
}

// ============ 启动 ============
log('🚀 三链扫描系统启动');
log('================================');

// 初始化
updateSmartMoney();

// 连接三条链WebSocket
for (const chain of ['solana', 'bsc', 'base']) {
  setTimeout(() => connectWS(chain), Math.random() * 3000);
}

// 定时任务
setInterval(updateSmartMoney, 10 * 60 * 1000);     // 10分钟更新聪明钱列表
// setInterval(checkSmartMoneySignals, 5 * 60 * 1000); // 已关闭：用自建WebSocket跟单替代
setInterval(scanConsolidation, 30 * 60 * 1000);     // 30分钟横盘扫描
setInterval(cleanup, 60 * 60 * 1000);               // 1小时清理
setInterval(statusReport, 30 * 60 * 1000);           // 30分钟状态报告

// BSC/Base聪明钱每2小时更新一次
async function updateEvmSmartMoney() {
  try {
    const { buildSmartMoneyList } = require('./evm_smart_money_builder.js');
    const { changes } = await buildSmartMoneyList();
    log(`🔄 EVM聪明钱更新: BSC ${changes.bsc.total}个(+${changes.bsc.added}/-${changes.bsc.removed}) Base ${changes.base.total}个(+${changes.base.added}/-${changes.base.removed})`);
  } catch(e) {
    log(`⚠️ EVM聪明钱更新失败: ${e.message}`);
  }
}
setInterval(updateEvmSmartMoney, 2 * 60 * 60 * 1000); // 2小时
setTimeout(updateEvmSmartMoney, 60000); // 启动1分钟后跑一次

// Solana聪明钱每4小时自动识别
async function updateSolSmartMoney() {
  try {
    const { buildSolanaSmartMoney } = require('./sol_smart_money_builder.js');
    const result = await buildSolanaSmartMoney();
    log(`🔄 Solana聪明钱更新: ${result.wallets.length}个 (自动${result.autoCount} + 锁定${result.lockedCount})`);
  } catch(e) {
    log(`⚠️ Solana聪明钱识别失败: ${e.message}`);
  }
}
setInterval(updateSolSmartMoney, 4 * 60 * 60 * 1000); // 4小时
setTimeout(updateSolSmartMoney, 5 * 60 * 1000); // 启动5分钟后跑一次

// 钓鱼钱包检测每6小时更新
async function updateBaitBlacklist() {
  try {
    const { detectBaitWallets } = require('./bait_wallet_detector.js');
    const bl = await detectBaitWallets();
    baitBlacklist = new Set([...(bl.confirmed || []), ...(bl.suspect || [])]);
    log(`🚫 钓鱼黑名单更新: ${baitBlacklist.size}个地址`);
  } catch(e) {
    log(`⚠️ 钓鱼检测失败: ${e.message}`);
  }
}
setInterval(updateBaitBlacklist, 6 * 60 * 60 * 1000); // 6小时
setTimeout(updateBaitBlacklist, 30000); // 启动30秒后跑一次

// Solana私有聪明钱每4小时更新
async function updateSolanaPrivateSmartMoney() {
  try {
    const { buildSolanaSmartMoney } = require('./solana_smart_money_builder.js');
    const result = await buildSolanaSmartMoney();
    log(`🔄 Solana私有聪明钱更新: ${result.wallets.length}个`);
  } catch(e) {
    log(`⚠️ Solana私有聪明钱更新失败: ${e.message}`);
  }
}
setInterval(updateSolanaPrivateSmartMoney, 4 * 60 * 60 * 1000); // 4小时

// 立即跑一次扫描
setTimeout(scanConsolidation, 15000);

// 聪明钱升降级 + 新钱包发现（每1小时）
async function promotionCheck() {
  try {
    const { checkPromotions, discoverNewSmartMoney } = require('./smart_money_promoter.js');
    const changes = checkPromotions();
    if (changes.length > 0) {
      for (const c of changes) {
        log(`🔄 ${c.chain.toUpperCase()} ${c.address}... ${c.from}→${c.to} (${c.reason})`);
        notify(`🔄 聪明钱${c.from === '核心' ? '降级' : '升级'}!\n[${c.chain.toUpperCase()}] ${c.address}...\n${c.from} → ${c.to}\n原因: ${c.reason}`);
      }
    }
    
    for (const chain of ['solana', 'bsc', 'base']) {
      const discovered = await discoverNewSmartMoney(chain);
      if (discovered.length > 0) {
        log(`🆕 [${chain.toUpperCase()}] 发现${discovered.length}个新聪明钱`);
        notify(`🆕 [${chain.toUpperCase()}] 发现新聪明钱!\n${discovered.map(d => d.address + '... 胜率' + d.winRate).join('\n')}`);
      }
    }
  } catch(e) {
    log(`⚠️ 升降级检查失败: ${e.message}`);
  }
}
setInterval(promotionCheck, 60 * 60 * 1000); // 1小时
setTimeout(promotionCheck, 3 * 60 * 1000); // 启动3分钟后跑一次

log('✅ 系统就绪');
log('  - WebSocket: Solana/BSC/Base 毫秒级');
log('  - 聪明钱跟单: WebSocket实时');
log('  - 横盘扫描: 30分钟一轮');
log('  - 升降级检查: 1小时一轮');
log('================================');
