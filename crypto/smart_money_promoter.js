#!/usr/bin/env node
/**
 * 聪明钱自动升降级
 * 
 * 追踪所有聪明钱的实时表现，达标自动升核心，拉胯自动降级
 * 三条链通用逻辑
 * 
 * 升级条件（正常→核心）：
 *   - 近30天胜率 ≥ 70%
 *   - 至少5笔完成交易
 *   - 平均盈利 > 50%
 * 
 * 降级条件（核心→正常）：
 *   - 近30天胜率 < 50%
 *   - 或连续3笔亏损
 * 
 * 新钱包发现：
 *   - 从链上热门代币的早期买入者中筛选
 *   - 连续3个币都赚钱的 → 直接加入正常
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const RANK_FILE = path.join(WORKSPACE, 'crypto', 'smart_money_rank.json');
const TRACK_FILE = path.join(WORKSPACE, 'crypto', 'sm_performance.json');

// 加载追踪数据
function loadPerformance() {
  try { return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8')); }
  catch(e) { return {}; }
}

function savePerformance(data) {
  fs.writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2));
}

function loadRank() {
  try { return JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); }
  catch(e) { return { solana: [], bsc: [], base: [] }; }
}

function saveRank(data) {
  fs.writeFileSync(RANK_FILE, JSON.stringify(data, null, 2));
}

/**
 * 记录一笔交易结果
 */
function recordTrade(chain, address, token, action, pnlPct) {
  const perf = loadPerformance();
  const key = `${chain}:${address}`;
  
  if (!perf[key]) {
    perf[key] = { chain, address, trades: [], wins: 0, losses: 0, totalPnl: 0, lastUpdate: null };
  }
  
  const record = perf[key];
  record.trades.push({
    token,
    action,
    pnlPct,
    time: new Date().toISOString()
  });
  
  // 只保留最近30天的交易
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  record.trades = record.trades.filter(t => new Date(t.time).getTime() > thirtyDaysAgo);
  
  // 重新计算统计
  const completedTrades = record.trades.filter(t => t.action === 'sell' && t.pnlPct !== undefined);
  record.wins = completedTrades.filter(t => t.pnlPct > 0).length;
  record.losses = completedTrades.filter(t => t.pnlPct <= 0).length;
  record.totalPnl = completedTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0);
  record.lastUpdate = new Date().toISOString();
  
  savePerformance(perf);
  return record;
}

/**
 * 检查升降级
 */
function checkPromotions() {
  const perf = loadPerformance();
  const rank = loadRank();
  let changes = [];
  
  for (const [key, record] of Object.entries(perf)) {
    const { chain, address } = record;
    const completedTrades = record.trades.filter(t => t.action === 'sell' && t.pnlPct !== undefined);
    const totalTrades = completedTrades.length;
    if (totalTrades < 3) continue; // 至少3笔才评估
    
    const winRate = totalTrades > 0 ? record.wins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? record.totalPnl / totalTrades : 0;
    
    // 找到当前等级
    const chainWallets = rank[chain] || [];
    const wallet = chainWallets.find(w => w.address === address);
    if (!wallet) continue;
    
    const currentTier = wallet.tier || '';
    
    // 升级条件：正常→核心
    if (currentTier.includes('正常') && totalTrades >= 5 && winRate >= 0.7 && avgPnl > 50) {
      wallet.tier = '🥇 核心';
      wallet.weight = 3;
      wallet.score = Math.min(100, Math.round(winRate * 100));
      wallet.promotedAt = new Date().toISOString();
      wallet.promotionReason = `胜率${(winRate*100).toFixed(0)}% ${totalTrades}笔 均利${avgPnl.toFixed(0)}%`;
      changes.push({ chain, address: address.slice(0, 12), from: '正常', to: '核心', reason: wallet.promotionReason });
    }
    
    // 降级条件：核心→正常
    if (currentTier.includes('核心') && !wallet.locked) {
      // 最近3笔连续亏损
      const last3 = completedTrades.slice(-3);
      const consecutive3Loss = last3.length >= 3 && last3.every(t => t.pnlPct <= 0);
      
      if ((totalTrades >= 5 && winRate < 0.5) || consecutive3Loss) {
        wallet.tier = '🥈 正常';
        wallet.weight = 2;
        wallet.demotedAt = new Date().toISOString();
        wallet.demotionReason = consecutive3Loss ? '连续3笔亏损' : `胜率${(winRate*100).toFixed(0)}%低于50%`;
        changes.push({ chain, address: address.slice(0, 12), from: '核心', to: '正常', reason: wallet.demotionReason });
      }
    }
    
    // 淘汰条件：正常→观察
    if (currentTier.includes('正常') && totalTrades >= 5 && winRate < 0.3) {
      wallet.tier = '🥉 观察';
      wallet.weight = 1;
      changes.push({ chain, address: address.slice(0, 12), from: '正常', to: '观察', reason: `胜率${(winRate*100).toFixed(0)}%过低` });
    }
  }
  
  if (changes.length > 0) {
    saveRank(rank);
  }
  
  return changes;
}

/**
 * 从链上发现新的潜在聪明钱
 * 扫描热门代币的早期买入者，找连续赚钱的新地址
 */
async function discoverNewSmartMoney(chain) {
  const rank = loadRank();
  const existingAddrs = new Set((rank[chain] || []).map(w => w.address));
  const perf = loadPerformance();
  let discovered = [];
  
  // 从 sm_performance 里找不在列表中但表现好的地址
  for (const [key, record] of Object.entries(perf)) {
    if (!key.startsWith(chain + ':')) continue;
    if (existingAddrs.has(record.address)) continue;
    
    const completedTrades = record.trades.filter(t => t.action === 'sell' && t.pnlPct !== undefined);
    if (completedTrades.length < 3) continue;
    
    const winRate = record.wins / completedTrades.length;
    if (winRate >= 0.6 && completedTrades.length >= 3) {
      // 新发现的聪明钱，加入正常
      rank[chain] = rank[chain] || [];
      rank[chain].push({
        address: record.address,
        score: Math.round(winRate * 100),
        weight: 2,
        tier: '🥈 正常',
        source: 'auto_discover',
        discoveredAt: new Date().toISOString(),
        reason: `${completedTrades.length}笔胜率${(winRate*100).toFixed(0)}%`
      });
      discovered.push({ address: record.address.slice(0, 12), winRate: (winRate*100).toFixed(0) + '%', trades: completedTrades.length });
    }
  }
  
  if (discovered.length > 0) {
    saveRank(rank);
  }
  
  return discovered;
}

module.exports = { recordTrade, checkPromotions, discoverNewSmartMoney };

// 直接运行时执行检查
if (require.main === module) {
  const changes = checkPromotions();
  if (changes.length > 0) {
    console.log('升降级变动:');
    for (const c of changes) {
      console.log(`  [${c.chain}] ${c.address}... ${c.from} → ${c.to} (${c.reason})`);
    }
  } else {
    console.log('无升降级变动');
  }
  
  (async () => {
    for (const chain of ['solana', 'bsc', 'base']) {
      const discovered = await discoverNewSmartMoney(chain);
      if (discovered.length > 0) {
        console.log(`[${chain}] 发现新聪明钱:`, discovered);
      }
    }
  })();
}
