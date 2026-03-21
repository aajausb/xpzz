#!/usr/bin/env node
/**
 * SOL 聪明钱重建 v2 — 从热门币出发，找真实交易者
 * 
 * 逻辑：
 * 1. 找最近的热门代币（Jupiter trending + GeckoTerminal）
 * 2. 查每个代币的swap交易
 * 3. 从中筛选出自己花SOL买入的钱包（feePayer = 钱包本身）
 * 4. 追踪这些钱包的完整交易历史，算利润
 * 5. 盈利的保留为聪明钱
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_KEY2 = process.env.HELIUS_API_KEY_2;
const RPC = process.env.HELIUS_RPC_URL;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers: { 'Accept': 'application/json' }, timeout: 15000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function httpPost(url, data) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// 找最近热门SOL代币
async function findHotTokens() {
  const tokens = [];
  
  // GeckoTerminal Solana trending
  try {
    const data = await httpGet('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1');
    for (const pool of (data?.data || []).slice(0, 15)) {
      const addr = pool?.relationships?.base_token?.data?.id?.split('_')[1];
      const name = pool?.attributes?.name || '?';
      if (addr && addr !== SOL_MINT) tokens.push({ address: addr, name });
    }
  } catch(e) {}
  
  log(`找到 ${tokens.length} 个热门代币`);
  return tokens;
}

// 从代币的swap交易中找真实买家（自己付gas+自己花SOL的）
async function findRealBuyers(tokenMint, apiKey) {
  // 查代币最近的交易签名
  const sigResp = await httpPost(RPC, {
    jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
    params: [tokenMint, { limit: 200 }]
  });
  
  const sigs = (sigResp?.result || []).map(s => s.signature);
  if (sigs.length < 10) return [];
  
  // 批量解析
  const allTxs = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const batch = sigs.slice(i, i + 100);
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, { transactions: batch });
    if (Array.isArray(parsed)) allTxs.push(...parsed);
    await sleep(300);
  }
  
  // 找真实买家：feePayer本身发起swap + SOL减少
  const buyers = new Map(); // wallet -> { solSpent, buys }
  
  for (const tx of allTxs) {
    if (tx.type !== 'SWAP' || !tx.feePayer) continue;
    const wallet = tx.feePayer;
    
    // 该钱包的native SOL变化
    const walletData = tx.accountData?.find(a => a.account === wallet);
    const nativeChange = (walletData?.nativeBalanceChange || 0) / 1e9;
    
    // 查该钱包是否收到了目标代币
    let gotToken = false;
    for (const ad of (tx.accountData || [])) {
      for (const tbc of (ad.tokenBalanceChanges || [])) {
        if (tbc.userAccount === wallet && tbc.mint === tokenMint) {
          const amt = parseInt(tbc.rawTokenAmount?.tokenAmount || '0') / Math.pow(10, tbc.rawTokenAmount?.decimals || 0);
          if (amt > 0) gotToken = true;
        }
      }
    }
    
    // 也查tokenTransfers
    if (!gotToken) {
      gotToken = (tx.tokenTransfers || []).some(tt => tt.mint === tokenMint && tt.toUserAccount === wallet && (tt.tokenAmount || 0) > 0);
    }
    
    if (gotToken && nativeChange < -0.01) {
      // 真实买入：自己付gas + SOL减少 + 收到目标代币
      if (!buyers.has(wallet)) buyers.set(wallet, { solSpent: 0, buys: 0 });
      const b = buyers.get(wallet);
      b.solSpent += Math.abs(nativeChange);
      b.buys++;
    }
  }
  
  return [...buyers.entries()]
    .filter(([_, b]) => b.solSpent > 0.1) // 至少花了0.1 SOL
    .map(([addr, b]) => ({ address: addr, solSpent: +b.solSpent.toFixed(4), buys: b.buys }))
    .sort((a, b) => b.solSpent - a.solSpent);
}

// 分析单个钱包的历史盈利
async function analyzeWalletProfit(addr, apiKey) {
  const sigResp = await httpPost(RPC, {
    jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
    params: [addr, { limit: 100 }]
  });
  
  const sigs = (sigResp?.result || []).map(s => s.signature);
  if (sigs.length < 5) return null;
  
  const allTxs = [];
  for (let i = 0; i < sigs.length; i += 10) {
    const batch = sigs.slice(i, i + 10);
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, { transactions: batch });
    if (Array.isArray(parsed)) allTxs.push(...parsed);
    await sleep(200);
  }
  
  const swaps = allTxs.filter(t => t.type === 'SWAP' && t.feePayer === addr);
  
  // 每笔swap的SOL净变化（含gas）
  let totalSolChange = 0;
  let swapCount = 0;
  const tokensSeen = new Set();
  
  for (const tx of swaps) {
    const walletData = tx.accountData?.find(a => a.account === addr);
    const nativeChange = (walletData?.nativeBalanceChange || 0) / 1e9;
    
    // wSOL变化
    let wsolChange = 0;
    for (const ad of (tx.accountData || [])) {
      for (const tbc of (ad.tokenBalanceChanges || [])) {
        if (tbc.userAccount === addr && tbc.mint === SOL_MINT) {
          wsolChange += parseInt(tbc.rawTokenAmount?.tokenAmount || '0') / 1e9;
        }
        // 记录交易过的代币
        if (tbc.userAccount === addr && tbc.mint !== SOL_MINT) {
          tokensSeen.add(tbc.mint);
        }
      }
    }
    
    totalSolChange += nativeChange + wsolChange;
    swapCount++;
  }
  
  // totalSolChange > 0 = 赚了（SOL净流入），< 0 = 亏了
  return {
    address: addr,
    swapCount,
    totalTx: allTxs.length,
    solPnL: +totalSolChange.toFixed(4),
    uniqueTokens: tokensSeen.size,
    isActive: swapCount >= 5,
    isProfitable: totalSolChange > 0,
  };
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  log('🔍 SOL聪明钱重建 v2 — 从热门币找真实交易者');
  
  // 1. 找热门代币
  const tokens = await findHotTokens();
  if (tokens.length === 0) { log('❌ 没找到热门代币'); return; }
  
  // 2. 从每个代币找真实买家
  const allBuyers = new Map(); // address -> { tokens, totalSolSpent }
  let keyToggle = false;
  
  for (const token of tokens) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    log(`📊 扫描 ${token.name} (${token.address.slice(0,12)}...)`);
    const buyers = await findRealBuyers(token.address, key);
    
    for (const buyer of buyers.slice(0, 30)) { // 每个代币取top30买家
      if (!allBuyers.has(buyer.address)) {
        allBuyers.set(buyer.address, { tokens: [], totalSolSpent: 0 });
      }
      const b = allBuyers.get(buyer.address);
      b.tokens.push(token.name || token.address.slice(0, 8));
      b.totalSolSpent += buyer.solSpent;
    }
    
    log(`  找到 ${buyers.length} 个真实买家`);
    await sleep(500);
  }
  
  log(`\n总候选钱包: ${allBuyers.size}`);
  
  // 3. 筛选出现在2个以上代币的钱包（有品味的交易者）
  const candidates = [...allBuyers.entries()]
    .filter(([_, b]) => b.tokens.length >= 2)
    .sort((a, b) => b[1].tokens.length - a[1].tokens.length);
  
  log(`出现在≥2个热门币的: ${candidates.length} 个`);
  
  // 4. 深度分析每个候选者的盈利
  const results = [];
  
  for (const [addr, meta] of candidates.slice(0, 50)) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    const profit = await analyzeWalletProfit(addr, key);
    if (profit && profit.isActive) {
      profit.appearedInTokens = meta.tokens;
      profit.totalSolSpent = meta.totalSolSpent;
      results.push(profit);
      
      const icon = profit.isProfitable ? '💰' : '📉';
      log(`  ${icon} ${addr.slice(0,12)}... swap:${profit.swapCount} PnL:${profit.solPnL} SOL tokens:${meta.tokens.length}个`);
    }
    
    await sleep(600);
  }
  
  // 5. 保存结果 + 更新 rank
  results.sort((a, b) => b.solPnL - a.solPnL);
  
  const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), 'utf8'));
  const existingAddrs = new Set((rank.solana || []).map(w => w.address));
  
  let newCore = 0, newNormal = 0;
  
  for (const r of results) {
    const wallet = {
      address: r.address,
      verified: true,
      swapCount: r.swapCount,
      solPnL: r.solPnL,
      uniqueTokens: r.uniqueTokens,
      appearedIn: r.appearedInTokens.length,
    };
    
    if (r.isProfitable && r.solPnL > 1 && r.swapCount >= 10) {
      // 核心：盈利>1 SOL + 活跃度高
      wallet.weight = 3;
      wallet.tier = '🥇 核心(v2验证)';
      wallet.score = 90;
      newCore++;
    } else if (r.isProfitable && r.swapCount >= 5) {
      // 正常：有盈利 + 有一定活跃度
      wallet.weight = 2;
      wallet.tier = '🥈 正常(v2验证)';
      wallet.score = 70;
      newNormal++;
    } else {
      wallet.weight = 1;
      wallet.tier = '🥉 观察';
      wallet.score = 50;
    }
    
    if (existingAddrs.has(r.address)) {
      // 更新已有的
      const existing = rank.solana.find(w => w.address === r.address);
      if (existing) Object.assign(existing, wallet);
    } else {
      // 新增
      rank.solana.push(wallet);
    }
  }
  
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), JSON.stringify(rank, null, 2));
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/sol_real_traders.json'), JSON.stringify(results, null, 2));
  
  // 统计
  const solWallets = rank.solana;
  const coreCount = solWallets.filter(w => w.weight === 3).length;
  const normalCount = solWallets.filter(w => w.weight === 2).length;
  
  log(`\n=== 重建完成 ===`);
  log(`新增核心: ${newCore} 正常: ${newNormal}`);
  log(`SOL总计: 核心${coreCount} 正常${normalCount} 观察${solWallets.length - coreCount - normalCount}`);
  log(`盈利钱包: ${results.filter(r => r.isProfitable).length}/${results.length}`);
  log(`最高利润: ${results[0]?.solPnL || 0} SOL (${results[0]?.address?.slice(0,12) || '-'})`);
  log('✅ 保存到 smart_money_rank.json + sol_real_traders.json');
}

main().catch(e => { log(`❌ ${e.message}`); process.exit(1); });
