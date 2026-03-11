#!/usr/bin/env node
/**
 * Solana 聪明钱自动识别器
 * 
 * 逻辑：
 * 1. 从Jupiter/Birdeye找近期热门meme代币
 * 2. 用Helius查每个币的早期买家
 * 3. 筛出"底部买入+拿住不卖"的钻石手
 * 4. 多次出现在不同盈利币里 → 真聪明钱
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_KEY2 = process.env.HELIUS_API_KEY_2;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const OUT_PATH = path.join(WORKSPACE, 'crypto', 'solana_private_smart_money.json');

const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function httpGet(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, agent, timeout: 15000, headers: { 'Accept': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function httpPost(url, body) {
  return new Promise(resolve => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', agent, timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
}

// ============ 1. 找热门Solana meme代币 ============
async function getTrendingTokens() {
  const tokens = [];
  
  // Jupiter热门代币
  try {
    const d = await httpGet('https://api.jup.ag/tokens/v1/meme');
    if (Array.isArray(d)) {
      for (const t of d.slice(0, 30)) {
        if (t.address && t.address.endsWith('pump')) {
          tokens.push({ address: t.address, name: t.symbol || '?', source: 'jupiter' });
        }
      }
    }
  } catch(e) {}
  
  // Birdeye trending（公开API）
  try {
    const d = await httpGet('https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20');
    if (d?.data?.items) {
      for (const t of d.data.items) {
        if (t.address) tokens.push({ address: t.address, name: t.symbol || '?', source: 'birdeye' });
      }
    }
  } catch(e) {}
  
  // GeckoTerminal Solana热门池
  try {
    const d = await httpGet('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
    for (const p of (d?.data || []).slice(0, 20)) {
      const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
      const fdv = parseFloat(p.attributes?.fdv_usd || 0);
      if (addr && fdv > 10000 && fdv < 5000000) {
        tokens.push({ address: addr, name: p.attributes?.name || '?', source: 'gecko' });
      }
    }
  } catch(e) {}
  
  // GeckoTerminal多翻几页
  for (let page = 1; page <= 3; page++) {
    try {
      const d = await httpGet(`https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}&sort=h24_volume_usd_desc`);
      for (const p of (d?.data || [])) {
        const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
        const fdv = parseFloat(p.attributes?.fdv_usd || 0);
        if (addr && fdv > 5000 && fdv < 10000000) {
          tokens.push({ address: addr, name: p.attributes?.name || '?', source: 'gecko' });
        }
      }
    } catch(e) {}
  }
  
  // 去重
  const seen = new Set();
  return tokens.filter(t => { if (seen.has(t.address)) return false; seen.add(t.address); return true; });
}

// ============ 2. 用Helius分析某代币的早期买家 ============
async function findDiamondHands(tokenMint) {
  // 获取该代币最近的swap交易（用Helius ParsedTransactions）
  // 方法：查token的transfer签名，然后解析
  
  const sigResp = await httpPost(HELIUS_RPC, {
    jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
    params: [tokenMint, { limit: 200 }]
  });
  
  const sigs = (sigResp?.result || []).map(s => s.signature).filter(Boolean);
  if (sigs.length === 0) return [];
  
  // 用Helius Enhanced API解析交易（批量，每次100）
  const allParsed = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const batch = sigs.slice(i, i + 100);
    const key = i < 100 ? HELIUS_KEY : HELIUS_KEY2; // 轮换key
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
      transactions: batch
    });
    if (Array.isArray(parsed)) allParsed.push(...parsed);
    await new Promise(r => setTimeout(r, 200)); // 限流
  }
  
  // 分析：找出买入（swap进来token）且没卖出的地址
  const walletActivity = new Map(); // address -> { buys, sells, firstTime }
  
  for (const tx of allParsed) {
    if (!tx || tx.transactionError) continue;
    const type = tx.type;
    const ts = tx.timestamp || 0;
    
    // 分析tokenTransfers
    for (const transfer of (tx.tokenTransfers || [])) {
      if (transfer.mint !== tokenMint) continue;
      
      const to = transfer.toUserAccount;
      const from = transfer.fromUserAccount;
      
      if (to && to.length > 30) {
        if (!walletActivity.has(to)) walletActivity.set(to, { buys: 0, sells: 0, firstTime: ts });
        walletActivity.get(to).buys++;
        if (ts < walletActivity.get(to).firstTime) walletActivity.get(to).firstTime = ts;
      }
      if (from && from.length > 30) {
        if (!walletActivity.has(from)) walletActivity.set(from, { buys: 0, sells: 0, firstTime: ts });
        walletActivity.get(from).sells++;
      }
    }
    
    // 也看nativeTransfers判断swap方向
    if (type === 'SWAP' && tx.accountData) {
      const feePayer = tx.feePayer;
      if (feePayer) {
        // swap且有token流入 = 买入
        const gotToken = (tx.tokenTransfers || []).some(t => t.mint === tokenMint && t.toUserAccount === feePayer);
        const sentToken = (tx.tokenTransfers || []).some(t => t.mint === tokenMint && t.fromUserAccount === feePayer);
        if (gotToken && !walletActivity.has(feePayer)) {
          walletActivity.set(feePayer, { buys: 1, sells: 0, firstTime: ts });
        }
      }
    }
  }
  
  // 筛选：买多卖少 + 早期进场
  const allTimes = [...walletActivity.values()].map(w => w.firstTime).filter(t => t > 0).sort();
  const earlyThreshold = allTimes.length > 3 ? allTimes[Math.floor(allTimes.length * 0.33)] : Infinity;
  
  const diamonds = [];
  for (const [addr, act] of walletActivity) {
    if (act.buys === 0) continue;
    const holdStrength = 1 - act.sells / (act.buys + act.sells);
    if (holdStrength < 0.7) continue; // 至少70%持有
    const isEarly = act.firstTime <= earlyThreshold;
    
    // 过滤掉明显的DEX/程序地址
    if (addr.length < 32 || addr.length > 50) continue;
    
    diamonds.push({ address: addr, buys: act.buys, sells: act.sells, holdStrength, isEarly });
  }
  
  return diamonds
    .filter(d => d.holdStrength > 0.7)
    .sort((a, b) => (b.isEarly ? 1 : 0) - (a.isEarly ? 1 : 0) || b.holdStrength - a.holdStrength)
    .slice(0, 20);
}

// ============ 2.5 检测横盘+横盘期间买家（双周期：1h+4h）============
async function detectSolConsolidationBuyers(tokenMint) {
  // 获取池子地址
  let poolAddr = null;
  try {
    const poolData = await httpGet(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenMint}/pools?page=1`);
    poolAddr = poolData?.data?.[0]?.attributes?.address;
  } catch(e) {}
  
  if (!poolAddr) return { isConsolidating: false, buyers: [] };
  
  // 双周期检测
  let bestResult = { isConsolidating: false, startTs: 0, endTs: 0, days: 0, period: '' };
  
  for (const period of ['1h', '4h']) {
    const aggregate = period === '1h' ? 1 : 4;
    const limit = period === '1h' ? 336 : 84;
    const minBars = period === '1h' ? 48 : 12;
    const barSeconds = aggregate * 3600;
    
    let ohlcv = [];
    try {
      const klineData = await httpGet(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddr}/ohlcv/hour?aggregate=${aggregate}&limit=${limit}`);
      ohlcv = (klineData?.data?.attributes?.ohlcv_list || []).reverse();
    } catch(e) {}
    
    if (ohlcv.length < minBars) continue;
    
    let consolidationStart = -1, consolidationEnd = -1;
    for (let i = 0; i <= ohlcv.length - minBars; i++) {
      let j = i + minBars;
      while (j <= ohlcv.length) {
        const closes = ohlcv.slice(i, j).map(k => k[4]);
        const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
        const variance = closes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / closes.length;
        const cv = Math.sqrt(variance) / mean;
        if (cv > 0.12) break;
        j++;
      }
      if (j - i >= minBars) {
        consolidationStart = i;
        consolidationEnd = j - 1;
        break;
      }
    }
    
    if (consolidationStart >= 0) {
      const startTs = ohlcv[consolidationStart][0];
      const endTs = ohlcv[consolidationEnd][0] + barSeconds;
      const hours = (consolidationEnd - consolidationStart + 1) * aggregate;
      const days = hours / 24;
      if (days > bestResult.days) {
        bestResult = { isConsolidating: true, startTs, endTs, days, period };
      }
    }
  }
  
  if (!bestResult.isConsolidating) return { isConsolidating: false, buyers: [] };
  
  const startTs = bestResult.startTs;
  const endTs = bestResult.endTs;
  const days = bestResult.days.toFixed(1);
  
  // 用Helius查横盘期间的交易
  const sigResp = await httpPost(HELIUS_RPC, {
    jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
    params: [tokenMint, { limit: 500 }]
  });
  
  // 过滤横盘时间范围内的交易
  const consolSigs = (sigResp?.result || [])
    .filter(s => s.blockTime >= startTs && s.blockTime <= endTs)
    .map(s => s.signature);
  
  if (consolSigs.length === 0) return { isConsolidating: true, days, buyers: [] };
  
  // 解析交易找买家
  const buyers = new Map();
  for (let i = 0; i < consolSigs.length; i += 100) {
    const batch = consolSigs.slice(i, i + 100);
    const key = i < 100 ? HELIUS_KEY : HELIUS_KEY2;
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${key}`, { transactions: batch });
    if (!Array.isArray(parsed)) continue;
    
    for (const tx of parsed) {
      if (!tx || tx.transactionError) continue;
      for (const transfer of (tx.tokenTransfers || [])) {
        if (transfer.mint !== tokenMint) continue;
        const to = transfer.toUserAccount;
        if (to && to.length > 30) {
          buyers.set(to, (buyers.get(to) || 0) + 1);
        }
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  
  return {
    isConsolidating: true,
    days,
    buyers: [...buyers.entries()].map(([addr, count]) => ({ address: addr, buysDuringConsolidation: count }))
  };
}

// ============ 3. 主函数 ============
async function buildSolanaSmartMoney() {
  log('🔍 开始Solana聪明钱识别...');
  
  const tokens = await getTrendingTokens();
  log(`📋 找到 ${tokens.length} 个候选代币`);
  
  const allSmartWallets = new Map(); // address -> { score, wins, tokens }
  
  for (const token of tokens.slice(0, 25)) { // 最多分析25个
    try {
      log(`  分析 ${token.name} (${token.address.slice(0,8)}...)`);
      const diamonds = await findDiamondHands(token.address);
      
      // 检测横盘+横盘期间买家
      const consol = await detectSolConsolidationBuyers(token.address);
      const consolBuyerSet = new Set(consol.buyers.map(b => b.address));
      if (consol.isConsolidating) {
        log(`    📊 横盘${consol.days}天，${consol.buyers.length}个买家`);
      }
      
      for (const d of diamonds) {
        if (!allSmartWallets.has(d.address)) {
          allSmartWallets.set(d.address, { score: 0, wins: 0, tokens: [] });
        }
        const r = allSmartWallets.get(d.address);
        r.wins++;
        r.score += d.holdStrength + (d.isEarly ? 1 : 0);
        r.tokens.push(token.name);
        // 横盘期间还在加仓 → 额外+1.5分
        if (consolBuyerSet.has(d.address)) {
          r.score += 1.5;
          log(`    🧠 ${d.address.slice(0,12)}... 横盘加仓+钻石手!`);
        }
      }
      
      // 横盘买家即使不在diamonds里也记录
      if (consol.isConsolidating) {
        for (const buyer of consol.buyers) {
          if (!allSmartWallets.has(buyer.address) && buyer.buysDuringConsolidation >= 2) {
            allSmartWallets.set(buyer.address, {
              score: 1.0 + buyer.buysDuringConsolidation * 0.3,
              wins: 1,
              tokens: [token.name]
            });
          }
        }
      }
      
      await new Promise(r => setTimeout(r, 300)); // 限流
    } catch(e) {
      log(`  ⚠️ ${token.name} 失败: ${e.message}`);
    }
  }
  
  // 按得分排序
  const ranked = [...allSmartWallets.entries()]
    .filter(([_, r]) => r.score >= 1.5) // 至少在1个币中高分表现
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 50)
    .map(([addr, r]) => ({
      address: addr,
      score: r.score.toFixed(2),
      winRate: `${r.wins}币`,
      tokens: r.tokens.slice(0, 5).join(','),
      source: 'auto_identify',
      identifiedAt: new Date().toISOString()
    }));
  
  log(`✅ 识别出 ${ranked.length} 个Solana聪明钱`);
  
  // 合并到现有私有列表（保留手动锁定的）
  let existing = { wallets: [], updatedAt: '' };
  try { existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch(e) {}
  
  const lockedWallets = (existing.wallets || []).filter(w => w.source === 'manual' || w.locked);
  const newAddrs = new Set(ranked.map(w => w.address));
  const lockedAddrs = new Set(lockedWallets.map(w => w.address));
  
  // 保留锁定的 + 加入新识别的（去重）
  const merged = [...lockedWallets];
  for (const w of ranked) {
    if (!lockedAddrs.has(w.address)) merged.push(w);
  }
  
  // 历史高分保留（衰退机制）
  for (const old of (existing.wallets || [])) {
    if (!newAddrs.has(old.address) && !lockedAddrs.has(old.address)) {
      old.missCount = (old.missCount || 0) + 1;
      const maxMiss = parseFloat(old.score) >= 3 ? 5 : parseFloat(old.score) >= 2 ? 3 : 1;
      if (old.missCount <= maxMiss) {
        old.note = `缺席${old.missCount}/${maxMiss}`;
        merged.push(old);
      }
    }
  }
  // 在榜的重置缺席
  for (const w of merged) {
    if (newAddrs.has(w.address)) w.missCount = 0;
  }
  
  const output = { wallets: merged, updatedAt: new Date().toISOString(), autoCount: ranked.length, lockedCount: lockedWallets.length };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  
  log(`💾 保存: ${merged.length}个钱包 (自动${ranked.length} + 锁定${lockedWallets.length} + 历史保留)`);
  return output;
}

if (require.main === module) {
  buildSolanaSmartMoney().catch(console.error);
}

module.exports = { buildSolanaSmartMoney };
