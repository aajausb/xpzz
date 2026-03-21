#!/usr/bin/env node
/**
 * SOL 聪明钱重建 — 只找真实交易者
 * 标准：
 * 1. 自己作为feePayer发起swap交易
 * 2. 自己花SOL买币
 * 3. 有盈利记录（卖出>买入）
 * 
 * 数据源：Helius parseTransactions
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
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function analyzeWallet(addr, apiKey) {
  // 1. 获取最近交易签名
  const sigs = await httpPost(RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'getSignaturesForAddress',
    params: [addr, { limit: 100 }]
  });
  
  const sigList = (sigs?.result || []).map(s => s.signature);
  if (sigList.length < 5) return null; // 交易太少不要
  
  // 2. 解析交易（每批5个，避免限流）
  const allTxs = [];
  for (let i = 0; i < sigList.length; i += 5) {
    const batch = sigList.slice(i, i + 5);
    const parsed = await httpPost(`https://api.helius.xyz/v0/transactions?api-key=${apiKey}`, { transactions: batch });
    if (Array.isArray(parsed)) allTxs.push(...parsed);
    await sleep(500);
  }
  
  // 3. 分析swap交易
  let asFeePayerCount = 0;
  const tokenPnl = {}; // mint -> { solIn, solOut }
  
  for (const tx of allTxs) {
    if (tx.feePayer === addr) asFeePayerCount++;
    if (tx.type !== 'SWAP') continue;
    
    // 用 accountData 追踪余额变化（最准确）
    let solChange = 0;
    const tokenChanges = {};
    
    for (const ad of (tx.accountData || [])) {
      if (ad.account === addr) {
        solChange += (ad.nativeBalanceChange || 0) / 1e9;
      }
      for (const tbc of (ad.tokenBalanceChanges || [])) {
        if (tbc.userAccount === addr) {
          const amount = parseInt(tbc.rawTokenAmount?.tokenAmount || '0') / Math.pow(10, tbc.rawTokenAmount?.decimals || 0);
          const mint = tbc.mint;
          if (mint === SOL_MINT) {
            solChange += amount;
          } else {
            tokenChanges[mint] = (tokenChanges[mint] || 0) + amount;
          }
        }
      }
    }
    
    // 判断买卖方向
    // 注意：很多钱包通过合约/机器人(Jupiter/Bonkbot/Trojan)买入
    // feePayer可能不是自己，但SOL确实从该钱包流出
    for (const [mint, change] of Object.entries(tokenChanges)) {
      if (!tokenPnl[mint]) tokenPnl[mint] = { solSpent: 0, solReceived: 0, buys: 0, sells: 0 };
      if (change > 0) {
        // 买入：token增加
        // SOL消耗来自 nativeBalanceChange 或 wSOL tokenBalanceChange
        const spent = Math.abs(Math.min(solChange, 0));
        tokenPnl[mint].solSpent += spent;
        tokenPnl[mint].buys++;
      } else if (change < 0) {
        // 卖出：token减少
        const received = Math.max(solChange, 0);
        tokenPnl[mint].solReceived += received;
        tokenPnl[mint].sells++;
      }
    }
  }
  
  // 4. 计算总利润
  let totalInvested = 0, totalReturned = 0, wins = 0, losses = 0;
  const tokenResults = [];
  
  for (const [mint, pnl] of Object.entries(tokenPnl)) {
    if (pnl.solSpent < 0.01 && pnl.solReceived < 0.01) continue;
    const profit = pnl.solReceived - pnl.solSpent;
    totalInvested += pnl.solSpent;
    totalReturned += pnl.solReceived;
    if (pnl.sells > 0) { profit > 0 ? wins++ : losses++; }
    tokenResults.push({ mint, invested: pnl.solSpent, returned: pnl.solReceived, profit, buys: pnl.buys, sells: pnl.sells });
  }
  
  tokenResults.sort((a, b) => b.profit - a.profit);
  const totalProfit = totalReturned - totalInvested;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) : 0;
  
  return {
    address: addr,
    txCount: allTxs.length,
    swapCount: allTxs.filter(t => t.type === 'SWAP').length,
    asFeePayerCount,
    totalInvested: +totalInvested.toFixed(4),
    totalReturned: +totalReturned.toFixed(4),
    totalProfit: +totalProfit.toFixed(4),
    roi: totalInvested > 0 ? +((totalProfit / totalInvested) * 100).toFixed(0) : 0,
    wins, losses,
    winRate: +(winRate * 100).toFixed(0),
    // 真实交易者判定：
    // 1. 自己作为feePayer（直接交易）
    // 2. 或通过合约/机器人交易但自己花了SOL（nativeBalanceChange < 0）
    isRealTrader: (asFeePayerCount >= 3 || totalInvested > 0.5),
    isProfitable: totalProfit > 0 && winRate >= 0.5,
    topTokens: tokenResults.slice(0, 5).map(t => ({
      mint: t.mint.slice(0, 12) + '...',
      profit: +t.profit.toFixed(4),
      roi: t.invested > 0 ? +((t.profit / t.invested) * 100).toFixed(0) : 0
    }))
  };
}

async function main() {
  const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), 'utf8'));
  const solWallets = rank.solana || [];
  
  log(`开始验证 SOL 钱包 (总${solWallets.length}个)`);
  
  const results = [];
  let keyToggle = false;
  let checked = 0;
  
  // 先查所有正常+观察钱包
  const toCheck = solWallets.filter(w => w.weight <= 2).slice(0, 50); // 先查50个（API限流）
  
  for (const w of toCheck) {
    const key = keyToggle ? HELIUS_KEY2 : HELIUS_KEY;
    keyToggle = !keyToggle;
    
    const r = await analyzeWallet(w.address, key);
    checked++;
    
    if (r && r.isRealTrader) {
      const label = r.isProfitable ? '💰' : '📉';
      log(`${label} ${r.address.slice(0,12)}... feePayer:${r.asFeePayerCount} 投:${r.totalInvested} 收:${r.totalReturned} 利润:${r.totalProfit} SOL ROI:${r.roi}% 胜:${r.winRate}%`);
      results.push(r);
    }
    
    if (checked % 10 === 0) {
      log(`进度: ${checked}/${toCheck.length} 找到真实交易者: ${results.length}`);
    }
    
    await sleep(500);
  }
  
  // 按利润排序
  results.sort((a, b) => b.totalProfit - a.totalProfit);
  
  log(`\n=== 结果 ===`);
  log(`检查: ${checked} 真实交易者: ${results.length}`);
  log(`盈利的: ${results.filter(r => r.isProfitable).length}`);
  
  // 更新 rank
  const addrToResult = {};
  for (const r of results) addrToResult[r.address] = r;
  
  let newCore = 0, newNormal = 0;
  for (const w of rank.solana) {
    const r = addrToResult[w.address];
    if (!r) continue;
    
    const avgProfit = (r.wins > 0) ? (r.totalProfit / r.wins) : 0;
    
    if (r.isProfitable && r.winRate >= 60 && r.totalProfit > 10 && avgProfit >= 5) {
      // 核心：胜率≥60% + 总利润>10 SOL + 平均单笔盈利≥5 SOL
      w.weight = 3;
      w.tier = '🥇 核心(已验证)';
      w.score = 90;
      w.verified = true;
      w.profit = r.totalProfit;
      w.avgProfit = +avgProfit.toFixed(2);
      w.roi = r.roi;
      w.winRate = r.winRate + '%';
      newCore++;
    } else if (r.isRealTrader && r.totalProfit > 0) {
      // 正常：真实交易者 + 有盈利
      w.weight = 2;
      w.tier = '🥈 正常(已验证)';
      w.score = 70;
      w.verified = true;
      w.profit = r.totalProfit;
      w.winRate = r.winRate + '%';
      newNormal++;
    }
  }
  
  log(`新核心: ${newCore} 新正常: ${newNormal}`);
  
  // 保存
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/smart_money_rank.json'), JSON.stringify(rank, null, 2));
  fs.writeFileSync(path.join(WORKSPACE, 'crypto/sol_wallet_analysis.json'), JSON.stringify(results, null, 2));
  
  log('✅ 保存完成');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
