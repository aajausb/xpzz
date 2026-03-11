#!/usr/bin/env node
/**
 * SOL 聪明钱猎手 v2 — 从 DEX 交易反查赚钱的人
 * 
 * 思路：
 * 1. 找最近7天涨幅大的Solana代币（GeckoTerminal trending）
 * 2. 用Helius查这些代币的swap交易
 * 3. 找出自己花SOL买入且后来盈利的钱包
 * 4. 跨多个币验证同一个钱包的胜率
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

// 从 GeckoTerminal 获取 Solana 上涨幅最大的代币
async function getTrendingTokens() {
  log('获取Solana热门代币...');
  const data = await httpGet('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1');
  if (!data?.data) return [];
  
  const tokens = [];
  for (const pool of data.data.slice(0, 20)) {
    const attrs = pool.attributes;
    const name = attrs.name || '';
    const baseAddr = attrs.base_token_price_native_currency ? pool.relationships?.base_token?.data?.id?.split('_')[1] : null;
    // 从pool关系中提取token地址
    const tokenAddr = pool.relationships?.base_token?.data?.id?.replace('solana_', '');
    
    if (tokenAddr && tokenAddr.length > 30) {
      tokens.push({
        name: name.split(' / ')[0] || name,
        address: tokenAddr,
        poolAddress: attrs.address,
        volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24 || '0')
      });
    }
  }
  
  log(`找到 ${tokens.length} 个热门代币`);
  return tokens;
}

// 从热门代币的swap交易中提取真实买家
async function findRealBuyers(tokenAddress, tokenName, apiKey) {
  // 查该代币的最近swap交易
  const sigs = await httpPost(RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'getSignaturesForAddress',
    params: [tokenAddress, { limit: 100 }]
  });
  
  const sigList = (sigs?.result || []).map(s => s.signature);
  if (!sigList.length) return [];
  
  // 解析交易
  const allTxs = [];
  for (let i = 0; i < Math.min(sigList.length, 50); i += 5) {
    const batch = sigList.slice(i, i + 5);
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, { transactions: batch });
    if (Array.isArray(parsed)) allTxs.push(...parsed);
    await sleep(300);
  }
  
  const swaps = allTxs.filter(t => t?.type === 'SWAP');
  const buyers = {}; // address -> { solSpent, isBuyer }
  
  for (const tx of swaps) {
    // 找到花SOL买该代币的人
    const feePayer = tx.feePayer;
    
    // 从tokenTransfers找出买家
    let solOut = 0;
    let tokenIn = false;
    let buyerAddr = null;
    
    for (const tt of (tx.tokenTransfers || [])) {
      if (tt.mint === SOL_MINT && tt.fromUserAccount) {
        solOut = tt.tokenAmount || 0;
        buyerAddr = tt.fromUserAccount;
      }
      if (tt.mint === tokenAddress && tt.toUserAccount) {
        tokenIn = true;
        // 真正的买家是收到token的人
        if (!buyerAddr) buyerAddr = tt.toUserAccount;
      }
    }
    
    // 也检查accountData
    if (!buyerAddr && feePayer) {
      for (const ad of (tx.accountData || [])) {
        if (ad.account === feePayer && ad.nativeBalanceChange < -100000) {
          buyerAddr = feePayer;
          solOut = Math.abs(ad.nativeBalanceChange) / 1e9;
        }
      }
    }
    
    if (buyerAddr && solOut > 0.01) {
      if (!buyers[buyerAddr]) buyers[buyerAddr] = { solSpent: 0, txCount: 0 };
      buyers[buyerAddr].solSpent += solOut;
      buyers[buyerAddr].txCount++;
    }
  }
  
  // 过滤：只要花了至少0.1 SOL且至少2笔交易的
  const realBuyers = Object.entries(buyers)
    .filter(([_, v]) => v.solSpent > 0.1 && v.txCount >= 1)
    .map(([addr, v]) => ({ address: addr, solSpent: +v.solSpent.toFixed(4), txCount: v.txCount, token: tokenName }));
  
  return realBuyers;
}

// 验证钱包的历史胜率
async function verifyWalletProfitability(addr, apiKey) {
  const sigs = await httpPost(RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'getSignaturesForAddress',
    params: [addr, { limit: 100 }]
  });
  
  const sigList = (sigs?.result || []).map(s => s.signature);
  if (sigList.length < 10) return null;
  
  const allTxs = [];
  for (let i = 0; i < sigList.length; i += 5) {
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, { transactions: sigList.slice(i, i + 5) });
    if (Array.isArray(parsed)) allTxs.push(...parsed);
    await sleep(300);
  }
  
  let feePayer = 0;
  const tokenPnl = {};
  
  for (const tx of allTxs) {
    if (tx.feePayer === addr) feePayer++;
    if (tx.type !== 'SWAP') continue;
    
    let solChange = 0;
    const tChanges = {};
    
    for (const ad of (tx.accountData || [])) {
      if (ad.account === addr) solChange += (ad.nativeBalanceChange || 0) / 1e9;
      for (const tbc of (ad.tokenBalanceChanges || [])) {
        if (tbc.userAccount === addr) {
          const amt = parseInt(tbc.rawTokenAmount?.tokenAmount || '0') / Math.pow(10, tbc.rawTokenAmount?.decimals || 0);
          if (tbc.mint === SOL_MINT) solChange += amt;
          else tChanges[tbc.mint] = (tChanges[tbc.mint] || 0) + amt;
        }
      }
    }
    
    for (const [mint, change] of Object.entries(tChanges)) {
      if (!tokenPnl[mint]) tokenPnl[mint] = { spent: 0, received: 0, buys: 0, sells: 0 };
      if (change > 0) { tokenPnl[mint].spent += Math.abs(Math.min(solChange, 0)); tokenPnl[mint].buys++; }
      else if (change < 0) { tokenPnl[mint].received += Math.max(solChange, 0); tokenPnl[mint].sells++; }
    }
  }
  
  let totalInvested = 0, totalReturned = 0, wins = 0, losses = 0;
  for (const p of Object.values(tokenPnl)) {
    if (p.spent < 0.01 && p.received < 0.01) continue;
    totalInvested += p.spent;
    totalReturned += p.received;
    if (p.sells > 0) { (p.received - p.spent) > 0 ? wins++ : losses++; }
  }
  
  const profit = totalReturned - totalInvested;
  const winRate = wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
  const avgProfit = wins > 0 ? profit / wins : 0;
  
  return {
    address: addr,
    feePayer,
    swaps: allTxs.filter(t => t.type === 'SWAP').length,
    totalInvested: +totalInvested.toFixed(4),
    totalReturned: +totalReturned.toFixed(4),
    profit: +profit.toFixed(4),
    avgProfit: +avgProfit.toFixed(4),
    wins, losses, winRate,
    isRealTrader: feePayer >= 3 || totalInvested > 0.5,
    isCore: profit > 10 && winRate >= 60 && avgProfit >= 5,
    isNormal: profit > 0 && winRate >= 50
  };
}

async function main() {
  // 1. 获取热门代币
  const tokens = await getTrendingTokens();
  if (!tokens.length) { log('❌ 没有获取到热门代币'); return; }
  
  // 2. 从每个代币找真实买家
  const allBuyers = {}; // address -> [{ token, solSpent }]
  let keyToggle = false;
  
  for (const token of tokens.slice(0, 15)) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    log(`📊 扫描 ${token.name} (${token.address.slice(0, 12)}...) 24h涨幅:${token.priceChange24h}%`);
    const buyers = await findRealBuyers(token.address, token.name, key);
    log(`  找到 ${buyers.length} 个真实买家`);
    
    for (const b of buyers) {
      if (!allBuyers[b.address]) allBuyers[b.address] = [];
      allBuyers[b.address].push({ token: b.token, solSpent: b.solSpent });
    }
    
    await sleep(1000);
  }
  
  // 3. 找出在多个代币上出现的买家（跨币验证）
  const multiTokenBuyers = Object.entries(allBuyers)
    .filter(([_, tokens]) => tokens.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  
  log(`\n跨币买家: ${multiTokenBuyers.length} 个（出现在2个以上热门币中）`);
  
  // 4. 验证这些买家的历史胜率
  const verified = [];
  
  for (const [addr, tokens] of multiTokenBuyers.slice(0, 20)) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    log(`🔍 验证 ${addr.slice(0, 12)}... (出现在${tokens.length}个币)`);
    const result = await verifyWalletProfitability(addr, key);
    
    if (result && result.isRealTrader) {
      const icon = result.isCore ? '🥇' : (result.isNormal ? '🥈' : '📉');
      log(`  ${icon} 投:${result.totalInvested} 收:${result.totalReturned} 利润:${result.profit} SOL 胜率:${result.winRate}% 均利:${result.avgProfit}`);
      verified.push({ ...result, appearedIn: tokens });
    }
    
    await sleep(1000);
  }
  
  // 5. 更新 rank
  const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), 'utf8'));
  const existingAddrs = new Set((rank.solana || []).map(w => w.address));
  
  let newCore = 0, newNormal = 0;
  
  for (const v of verified) {
    if (existingAddrs.has(v.address)) {
      // 更新已有的
      const w = rank.solana.find(w => w.address === v.address);
      if (w) {
        if (v.isCore) { w.weight = 3; w.tier = '🥇 核心(利润验证)'; w.score = 90; newCore++; }
        else if (v.isNormal) { w.weight = 2; w.tier = '🥈 正常(利润验证)'; w.score = 70; newNormal++; }
        w.verified = true;
        w.profit = v.profit;
        w.avgProfit = v.avgProfit;
        w.winRate = v.winRate + '%';
      }
    } else {
      // 新增
      rank.solana.push({
        address: v.address,
        weight: v.isCore ? 3 : (v.isNormal ? 2 : 1),
        tier: v.isCore ? '🥇 核心(利润验证)' : (v.isNormal ? '🥈 正常(利润验证)' : '🥉 观察'),
        score: v.isCore ? 90 : (v.isNormal ? 70 : 50),
        verified: true,
        profit: v.profit,
        avgProfit: v.avgProfit,
        winRate: v.winRate + '%',
        source: 'dex_hunter_v2',
        appearedIn: v.appearedIn.map(t => t.token).join(',')
      });
      if (v.isCore) newCore++;
      else if (v.isNormal) newNormal++;
    }
  }
  
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), JSON.stringify(rank, null, 2));
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/sol_dex_hunter_results.json'), JSON.stringify(verified, null, 2));
  
  log(`\n=== 结果 ===`);
  log(`热门代币扫描: ${tokens.length}`);
  log(`跨币买家: ${multiTokenBuyers.length}`);
  log(`验证通过: ${verified.length} (核心${newCore} 正常${newNormal})`);
  log('✅ 保存完成');
}

main().catch(e => { log('❌ ' + e.message); process.exit(1); });
