/**
 * 土狗v7 - OKX聪明钱信号跟单系统
 * 
 * 架构：
 * 1. 信号采集：定时拉OKX signal-list三链聪明钱买入信号
 * 2. 过滤：多个聪明钱买同一币 + 流动性/持仓检查
 * 3. 风控：蜜罐检测 + 已卖出比例 + top10持仓
 * 4. 执行：dex_trader自动买入
 * 5. 持仓管理：止盈止损 + 聪明钱卖出跟卖
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buy, sell } = require('./dex_trader');

// ============ 配置 ============

const CONFIG = {
  // 扫描间隔（毫秒）
  scanInterval: 60_000,  // 1分钟
  
  // 持仓检查间隔
  positionCheckInterval: 30_000,  // 30秒
  
  // 三链
  chains: ['solana', 'bsc', 'base'],
  chainMap: { solana: '501', bsc: '56', base: '8453' },
  
  // === 信号过滤 ===
  minSmartMoneyCount: 3,      // 最少3个聪明钱买入
  maxSoldPercent: 50,          // 聪明钱已卖出不超过50%（还在持有）
  minHolders: 200,             // 最少持有者
  maxTop10Percent: 50,         // top10持仓不超过50%
  minMarketCapUsd: 10_000,     // 最小市值$10k
  maxMarketCapUsd: 10_000_000, // 最大市值$10M（太大的没空间）
  
  // === 仓位管理 ===
  positionSizeUsd: 10,         // 每笔$10（起步阶段）
  maxPositions: 10,            // 最多同时持仓10个
  maxPerChain: 5,              // 单链最多5个
  
  // === 止盈止损 ===
  takeProfitPercent: 100,      // 翻倍止盈50%仓位
  stopLossPercent: -50,        // 亏50%止损
  trailingStopPercent: 30,     // 回撤30%从最高点止盈
  
  // === 文件路径 ===
  dataDir: path.join(__dirname, 'data/v7'),
  signalLog: 'signals.jsonl',
  positionsFile: 'positions.json',
  smartMoneyDb: 'smart_money_rank.json',
  blacklistFile: 'blacklist.json',
};

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

// ============ 状态 ============

let positions = [];      // 当前持仓
let seenSignals = {};    // 已处理的信号（防重复）
let smartMoneyRank = {}; // 聪明钱动态排名
let blacklist = new Set(); // 黑名单token

// ============ 核心循环 ============

async function main() {
  console.log('🐕 土狗v7启动 — OKX聪明钱跟单系统');
  console.log(`配置: $${CONFIG.positionSizeUsd}/笔, 最多${CONFIG.maxPositions}仓, SM≥${CONFIG.minSmartMoneyCount}`);
  
  // 初始化
  ensureDir(CONFIG.dataDir);
  loadState();
  
  // 主循环
  while (true) {
    try {
      await scanSignals();
    } catch (e) {
      console.error('扫描出错:', e.message);
    }
    
    try {
      await checkPositions();
    } catch (e) {
      console.error('持仓检查出错:', e.message);
    }
    
    saveState();
    await sleep(CONFIG.scanInterval);
  }
}

// ============ 信号采集 ============

async function scanSignals() {
  const now = Date.now();
  let allSignals = [];
  
  for (const chain of CONFIG.chains) {
    try {
      const cmd = `onchainos market signal-list ${chain} --wallet-type "1"`;
      const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
      const signals = result.data || [];
      
      for (const s of signals) {
        s._chain = chain;
        allSignals.push(s);
      }
    } catch (e) {
      console.error(`${chain}信号获取失败:`, e.message?.slice(0, 60));
    }
  }
  
  console.log(`[${new Date().toLocaleTimeString()}] 信号: ${allSignals.length}条`);
  
  // 按token聚合（同一币可能有多条信号）
  const tokenMap = {};
  for (const s of allSignals) {
    const addr = s.token.tokenAddress;
    const key = `${s._chain}:${addr}`;
    
    if (!tokenMap[key]) {
      tokenMap[key] = {
        chain: s._chain,
        address: addr,
        symbol: s.token.symbol,
        name: s.token.name,
        holders: parseInt(s.token.holders) || 0,
        marketCap: parseFloat(s.token.marketCapUsd) || 0,
        top10Percent: parseFloat(s.token.top10HolderPercent) || 0,
        wallets: new Set(),
        totalAmountUsd: 0,
        minSoldPercent: 100,
        signals: [],
      };
    }
    
    const t = tokenMap[key];
    // 提取钱包地址
    const wallets = (s.triggerWalletAddress || '').split(',').filter(Boolean);
    wallets.forEach(w => t.wallets.add(w));
    t.totalAmountUsd += parseFloat(s.amountUsd) || 0;
    t.minSoldPercent = Math.min(t.minSoldPercent, parseFloat(s.soldRatioPercent) || 0);
    t.signals.push(s);
  }
  
  // 过滤出可操作信号
  const candidates = [];
  for (const [key, t] of Object.entries(tokenMap)) {
    // 去重：已经处理过或已持仓
    if (seenSignals[key] && (now - seenSignals[key]) < 3600_000) continue;
    if (positions.find(p => p.chain === t.chain && p.address === t.address)) continue;
    if (blacklist.has(t.address)) continue;
    
    // 过滤条件
    if (t.wallets.size < CONFIG.minSmartMoneyCount) continue;
    if (t.minSoldPercent > CONFIG.maxSoldPercent) continue;
    if (t.holders < CONFIG.minHolders) continue;
    if (t.top10Percent > CONFIG.maxTop10Percent) continue;
    if (t.marketCap > 0 && t.marketCap < CONFIG.minMarketCapUsd) continue;
    if (t.marketCap > CONFIG.maxMarketCapUsd) continue;
    
    // 记录聪明钱排名
    for (const w of t.wallets) {
      if (!smartMoneyRank[w]) smartMoneyRank[w] = { count: 0, chains: new Set(), firstSeen: now };
      smartMoneyRank[w].count++;
      smartMoneyRank[w].chains.add(t.chain);
      smartMoneyRank[w].lastSeen = now;
    }
    
    candidates.push(t);
    seenSignals[key] = now;
  }
  
  if (candidates.length === 0) return;
  
  // 按聪明钱数量排序
  candidates.sort((a, b) => b.wallets.size - a.wallets.size);
  
  console.log(`🎯 发现${candidates.length}个候选:`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  ${c.symbol} (${c.chain}) SM=${c.wallets.size} MC=$${c.marketCap.toFixed(0)} H=${c.holders} sold=${c.minSoldPercent}%`);
  }
  
  // 执行买入
  for (const c of candidates) {
    if (positions.length >= CONFIG.maxPositions) {
      console.log('⚠️ 仓位已满');
      break;
    }
    
    const chainPositions = positions.filter(p => p.chain === c.chain).length;
    if (chainPositions >= CONFIG.maxPerChain) continue;
    
    await executeBuy(c);
  }
}

// ============ 买入执行 ============

async function executeBuy(candidate) {
  const { chain, address, symbol } = candidate;
  
  // 计算买入金额（native token数量）
  let amount;
  try {
    amount = await usdToNative(chain, CONFIG.positionSizeUsd);
  } catch (e) {
    console.error(`${symbol} 价格转换失败:`, e.message);
    return;
  }
  
  console.log(`🔵 买入 ${symbol} (${chain}) $${CONFIG.positionSizeUsd}...`);
  
  try {
    const result = await buy(chain, address, amount.toString());
    
    if (result.success) {
      const position = {
        chain,
        address,
        symbol,
        name: candidate.name,
        buyTxHash: result.txHash,
        buyTime: Date.now(),
        buyPriceUsd: CONFIG.positionSizeUsd,
        smartMoneyCount: candidate.wallets.size,
        smartMoneyWallets: [...candidate.wallets],
        highWaterMark: CONFIG.positionSizeUsd,
        status: 'open',
      };
      
      positions.push(position);
      logSignal('BUY', position);
      console.log(`  ✅ 买入成功: ${result.txHash.slice(0, 20)}...`);
    } else {
      console.log(`  ⚠️ 买入未确认: ${result.txHash}`);
    }
  } catch (e) {
    console.error(`  ❌ 买入失败: ${e.message.slice(0, 80)}`);
    // 连续失败的token加黑名单
    blacklist.add(address);
  }
}

// ============ 持仓管理 ============

async function checkPositions() {
  if (positions.length === 0) return;
  
  for (const pos of positions) {
    if (pos.status !== 'open') continue;
    
    try {
      // 获取当前价值
      const currentValueUsd = await getPositionValue(pos);
      if (currentValueUsd === null) continue;
      
      const pnlPercent = ((currentValueUsd - pos.buyPriceUsd) / pos.buyPriceUsd) * 100;
      pos.currentValueUsd = currentValueUsd;
      pos.pnlPercent = pnlPercent;
      
      // 更新最高水位
      if (currentValueUsd > pos.highWaterMark) {
        pos.highWaterMark = currentValueUsd;
      }
      
      // 回撤计算
      const drawdownFromHigh = ((currentValueUsd - pos.highWaterMark) / pos.highWaterMark) * 100;
      
      let shouldSell = false;
      let reason = '';
      
      // 止损
      if (pnlPercent <= CONFIG.stopLossPercent) {
        shouldSell = true;
        reason = `止损 ${pnlPercent.toFixed(1)}%`;
      }
      
      // 翻倍止盈（卖50%）
      if (pnlPercent >= CONFIG.takeProfitPercent && !pos.tookProfit) {
        // TODO: 部分卖出
        shouldSell = true;
        reason = `止盈 ${pnlPercent.toFixed(1)}%`;
      }
      
      // 追踪止盈（从最高点回撤30%）
      if (pos.highWaterMark > pos.buyPriceUsd * 1.5 && drawdownFromHigh <= -CONFIG.trailingStopPercent) {
        shouldSell = true;
        reason = `追踪止盈 高点$${pos.highWaterMark.toFixed(2)} 当前$${currentValueUsd.toFixed(2)}`;
      }
      
      if (shouldSell) {
        await executeSell(pos, reason);
      }
    } catch (e) {
      // 获取价值失败不影响其他持仓
    }
  }
}

async function executeSell(pos, reason) {
  console.log(`🔴 卖出 ${pos.symbol} (${pos.chain}) — ${reason}`);
  
  try {
    // 获取token余额
    const tokenBalance = await getTokenBalance(pos.chain, pos.address);
    if (!tokenBalance || tokenBalance === '0') {
      pos.status = 'closed';
      pos.closeReason = 'no_balance';
      return;
    }
    
    const result = await sell(pos.chain, pos.address, tokenBalance);
    
    if (result.success) {
      pos.status = 'closed';
      pos.sellTxHash = result.txHash;
      pos.sellTime = Date.now();
      pos.closeReason = reason;
      pos.finalPnlPercent = pos.pnlPercent;
      logSignal('SELL', pos);
      console.log(`  ✅ 卖出成功: ${result.txHash.slice(0, 20)}...`);
    }
  } catch (e) {
    console.error(`  ❌ 卖出失败: ${e.message.slice(0, 80)}`);
  }
}

// ============ 价格/余额查询 ============

async function usdToNative(chain, usd) {
  if (chain === 'solana') {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    return Math.ceil((usd / data.solana.usd) * 1e9); // lamports
  } else if (chain === 'bsc') {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
    const data = await res.json();
    return BigInt(Math.ceil((usd / data.binancecoin.usd) * 1e18)).toString(); // wei
  } else if (chain === 'base') {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    return BigInt(Math.ceil((usd / data.ethereum.usd) * 1e18)).toString(); // wei
  }
}

async function getPositionValue(pos) {
  try {
    // 用OKX查token当前价格
    const cmd = `onchainos market token-price ${pos.chain} --token ${pos.address}`;
    const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 10000, maxBuffer: 5*1024*1024 }).toString());
    if (!result.ok || !result.data?.[0]) return null;
    
    const price = parseFloat(result.data[0].price);
    const balance = await getTokenBalance(pos.chain, pos.address);
    if (!balance || balance === '0') return 0;
    
    const decimals = parseInt(result.data[0].decimals) || 9;
    const tokenAmount = parseFloat(balance) / Math.pow(10, decimals);
    return tokenAmount * price;
  } catch (e) {
    return null;
  }
}

async function getTokenBalance(chain, tokenAddress) {
  try {
    if (chain === 'solana') {
      const { Connection, PublicKey } = require('@solana/web3.js');
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const { getWallets } = require('../wallet_runtime');
      const w = getWallets();
      const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d'}`);
      const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), new PublicKey(w.solana.address));
      const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
      return bal?.value?.amount || '0';
    } else {
      const { ethers } = require('ethers');
      const { getWallets } = require('../wallet_runtime');
      const w = getWallets();
      const rpc = chain === 'bsc' ? 'https://bsc-dataseed1.binance.org' : 'https://mainnet.base.org';
      const provider = new ethers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
      const bal = await contract.balanceOf(w.evm.address);
      return bal.toString();
    }
  } catch (e) {
    return '0';
  }
}

// ============ 工具函数 ============

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  try {
    const posFile = path.join(CONFIG.dataDir, CONFIG.positionsFile);
    if (fs.existsSync(posFile)) positions = JSON.parse(fs.readFileSync(posFile, 'utf8'));
  } catch (e) {}
  
  try {
    const smFile = path.join(CONFIG.dataDir, CONFIG.smartMoneyDb);
    if (fs.existsSync(smFile)) {
      const raw = JSON.parse(fs.readFileSync(smFile, 'utf8'));
      smartMoneyRank = raw;
      // 恢复Set
      for (const [k, v] of Object.entries(smartMoneyRank)) {
        v.chains = new Set(v.chains || []);
      }
    }
  } catch (e) {}
  
  try {
    const blFile = path.join(CONFIG.dataDir, CONFIG.blacklistFile);
    if (fs.existsSync(blFile)) blacklist = new Set(JSON.parse(fs.readFileSync(blFile, 'utf8')));
  } catch (e) {}
  
  console.log(`状态加载: ${positions.filter(p=>p.status==='open').length}个持仓, ${Object.keys(smartMoneyRank).length}个聪明钱, ${blacklist.size}个黑名单`);
}

function saveState() {
  const posFile = path.join(CONFIG.dataDir, CONFIG.positionsFile);
  fs.writeFileSync(posFile, JSON.stringify(positions, null, 2));
  
  // smartMoneyRank里的Set转Array
  const smForSave = {};
  for (const [k, v] of Object.entries(smartMoneyRank)) {
    smForSave[k] = { ...v, chains: [...(v.chains || [])] };
  }
  fs.writeFileSync(path.join(CONFIG.dataDir, CONFIG.smartMoneyDb), JSON.stringify(smForSave, null, 2));
  fs.writeFileSync(path.join(CONFIG.dataDir, CONFIG.blacklistFile), JSON.stringify([...blacklist]));
}

function logSignal(action, data) {
  const line = JSON.stringify({ action, time: new Date().toISOString(), ...data }) + '\n';
  fs.appendFileSync(path.join(CONFIG.dataDir, CONFIG.signalLog), line);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 启动 ============

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

module.exports = { scanSignals, checkPositions, CONFIG };
