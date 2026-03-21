#!/usr/bin/env node
/**
 * 聪明钱动态排名系统
 * 
 * 综合评分维度：
 * 1. 胜率（最近10笔）
 * 2. 平均收益率
 * 3. 持有时间（钻石手加分）
 * 4. 活跃度（太久没动减分）
 * 5. 历史识别次数（多次被识别=稳定）
 * 6. 钓鱼/异常行为扣分
 * 
 * 输出：三条链各自的排名 + 综合跟单权重
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const RANK_PATH = path.join(WORKSPACE, 'crypto', 'smart_money_rank.json');
const TRACKER_PATH = path.join(WORKSPACE, 'crypto', 'smart_money_tracker.json');
const SOL_SM_PATH = path.join(WORKSPACE, 'crypto', 'solana_private_smart_money.json');
const EVM_SM_PATH = path.join(WORKSPACE, 'crypto', 'evm_smart_money.json');
const SOL_HISTORY_PATH = path.join(WORKSPACE, 'crypto', 'sol_smart_money_history.json');

let rankings = { solana: [], bsc: [], base: [], updatedAt: null };

/**
 * 计算单个钱包的综合得分
 */
function calcScore(address, chain, trackerData, identifyData) {
  let score = 50; // 基础分50
  const tracker = trackerData[address] || {};
  const trades = tracker.trades || [];
  const sells = trades.filter(t => t.action === 'sell');
  
  // 1. 胜率 (最多+30分)
  // 优先用实时tracker数据，没有就用识别时的历史战绩
  let winRate = 0;
  let hasData = false;
  
  if (sells.length >= 2) {
    // 有实时交易数据
    const wins = sells.filter(t => t.pnlPct > 0).length;
    winRate = wins / sells.length;
    hasData = true;
  } else if (identifyData.winRate) {
    // 用识别时的历史战绩（格式："2/2" 或 "1/1"）
    const parts = String(identifyData.winRate).split('/');
    if (parts.length === 2) {
      const wins = parseInt(parts[0]);
      const total = parseInt(parts[1]);
      if (total > 0) { winRate = wins / total; hasData = true; }
    }
  }
  if (hasData) score += winRate * 30;
  
  // 2. 平均收益率 (最多+20分)
  if (sells.length > 0) {
    const avgPnl = sells.reduce((s, t) => s + (t.pnlPct || 0), 0) / sells.length;
    score += Math.min(20, Math.max(-20, avgPnl / 5)); // 每5%收益=1分，上限20
  }
  
  // 3. 钻石手加分 (最多+15分)
  const avgHold = tracker.avgHoldTime || 0;
  if (avgHold > 4 * 3600000) score += 15;       // >4小时
  else if (avgHold > 1 * 3600000) score += 10;   // >1小时
  else if (avgHold > 30 * 60000) score += 5;     // >30分钟
  else if (avgHold > 0 && avgHold < 5 * 60000) score -= 10; // <5分钟扣分
  
  // 4. 活跃度（高胜率钱包不扣分）
  const lastTrade = trades.length > 0 ? trades[trades.length - 1].time : 0;
  const hoursSinceLastTrade = lastTrade ? (Date.now() - lastTrade) / 3600000 : 999;
  const isHighWinRate = sells.length >= 2 && sells.filter(t => t.pnlPct > 0).length / sells.length >= 0.7;
  
  if (!isHighWinRate) {
    // 普通钱包：3天不动扣10分
    if (hoursSinceLastTrade > 72) score -= 10;
  }
  // 高胜率钱包：不管多久不动都不扣分
  if (hoursSinceLastTrade < 1) score += 5;    // 1小时内活跃 +5
  
  // 5. 被识别次数/得分（多个币上赚钱=更可靠）
  const identifyScore = parseFloat(identifyData.score || 0);
  score += Math.min(15, identifyScore * 3); // 每1分=3分排名，上限15
  
  // 额外：赢的币数量加分
  const winCount = identifyData.winRate ? parseInt(String(identifyData.winRate).split('/')[0]) || 0 : 0;
  if (winCount >= 3) score += 5;  // 3个以上币都赚=+5
  
  // 6. 异常行为扣分
  if (tracker.status === 'watch') score -= 15;
  if (tracker.status === 'removed') score -= 50;
  if (tracker.dumpCount >= 3) score -= 10;
  const streak = tracker.streak || 0;
  if (streak <= -3) score -= 10; // 连亏3次 -10
  
  // 7. 私有/手动锁定钱包：不加分，跟其他一样靠实力说话
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * 根据得分计算跟单权重
 * 得分>80: 权重3（核心跟单）
 * 得分60-80: 权重2（正常跟单）
 * 得分40-60: 权重1（观察跟单）
 * 得分<40: 权重0（不跟）
 */
function scoreToWeight(score) {
  if (score >= 80) return 3;
  if (score >= 60) return 2;
  if (score >= 40) return 1;
  return 0;
}

function scoreTier(score) {
  if (score >= 80) return '🥇 核心';
  if (score >= 60) return '🥈 正常';
  if (score >= 40) return '🥉 观察';
  return '❌ 暂停';
}

/**
 * 更新所有排名
 */
function updateRankings() {
  // 加载旧排名（保护已有权重不降级）
  let oldRankings = {};
  try { oldRankings = JSON.parse(fs.readFileSync(RANK_PATH, 'utf8')); } catch(e) {}
  
  // 构建旧权重映射
  const oldWeightMap = {};
  for (const chain of ['solana', 'bsc', 'base']) {
    const list = Array.isArray(oldRankings[chain]) ? oldRankings[chain] : [];
    for (const w of list) {
      oldWeightMap[`${chain}:${w.address}`] = w.weight || 0;
    }
  }
  
  // 加载数据
  let tracker = {};
  try { tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8')); } catch(e) {}
  
  let solWallets = [];
  try {
    const d = JSON.parse(fs.readFileSync(SOL_SM_PATH, 'utf8'));
    solWallets = d.wallets || [];
  } catch(e) {}
  
  let evmData = { bsc: [], base: [] };
  try { evmData = JSON.parse(fs.readFileSync(EVM_SM_PATH, 'utf8')); } catch(e) {}
  
  let solHistory = {};
  try { solHistory = JSON.parse(fs.readFileSync(SOL_HISTORY_PATH, 'utf8')); } catch(e) {}
  
  // Solana排名 — 合并私有列表 + 历史识别的所有钱包
  const allSolAddrs = new Set();
  const solWalletMap = {};
  for (const w of solWallets) { allSolAddrs.add(w.address); solWalletMap[w.address] = w; }
  for (const addr of Object.keys(solHistory)) { allSolAddrs.add(addr); }
  
  rankings.solana = [...allSolAddrs].map(addr => {
    const w = solWalletMap[addr] || {};
    const histData = solHistory[addr] || {};
    const identifyData = { score: w.score || histData.score || 0, source: w.source, locked: w.locked, winRate: w.winRate };
    const score = calcScore(addr, 'solana', tracker, identifyData);
    const oldWeight = oldWeightMap[`solana:${addr}`] || 0;
    const newWeight = scoreToWeight(score);
    // 保护：不自动降级，降级由 promoter 负责
    const finalWeight = Math.max(newWeight, oldWeight);
    return {
      address: addr,
      score: finalWeight > newWeight ? (finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score) : score,
      weight: finalWeight,
      tier: scoreTier(finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score),
      winRate: w.winRate || getWinRate(tracker[addr]),
      source: w.source || 'auto'
    };
  }).sort((a, b) => b.score - a.score);
  
  // BSC排名
  rankings.bsc = (evmData.bsc || []).map(w => {
    const identifyData = { score: w.score || 0, winRate: w.winRate };
    const score = calcScore(w.address, 'bsc', tracker, identifyData);
    const oldWeight = oldWeightMap[`bsc:${w.address}`] || 0;
    const newWeight = scoreToWeight(score);
    const finalWeight = Math.max(newWeight, oldWeight);
    return {
      address: w.address,
      score: finalWeight > newWeight ? (finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score) : score,
      weight: finalWeight,
      tier: scoreTier(finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score)
    };
  }).sort((a, b) => b.score - a.score);
  
  // Base排名
  rankings.base = (evmData.base || []).map(w => {
    const identifyData = { score: w.score || 0, winRate: w.winRate };
    const score = calcScore(w.address, 'base', tracker, identifyData);
    const oldWeight = oldWeightMap[`base:${w.address}`] || 0;
    const newWeight = scoreToWeight(score);
    const finalWeight = Math.max(newWeight, oldWeight);
    return {
      address: w.address,
      score: finalWeight > newWeight ? (finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score) : score,
      weight: finalWeight,
      tier: scoreTier(finalWeight === 3 ? 90 : finalWeight === 2 ? 70 : score)
    };
  }).sort((a, b) => b.score - a.score);
  
  rankings.updatedAt = new Date().toISOString();
  
  // 保存
  try { fs.writeFileSync(RANK_PATH, JSON.stringify(rankings, null, 2)); } catch(e) {}
  
  return rankings;
}

function getWinRate(record) {
  if (!record || !record.totalTrades) return '-';
  return `${(record.winCount / record.totalTrades * 100).toFixed(0)}%`;
}

/**
 * 获取某地址的跟单权重
 */
function getWeight(address) {
  for (const chain of ['solana', 'bsc', 'base']) {
    const found = rankings[chain].find(w => w.address === address);
    if (found) return found.weight;
  }
  return 1; // 默认权重1
}

/**
 * 获取排名摘要
 */
function getSummary() {
  const summary = {};
  for (const chain of ['solana', 'bsc', 'base']) {
    const list = rankings[chain] || [];
    summary[chain] = {
      total: list.length,
      core: list.filter(w => w.weight === 3).length,
      normal: list.filter(w => w.weight === 2).length,
      watch: list.filter(w => w.weight === 1).length,
      paused: list.filter(w => w.weight === 0).length,
      top3: list.slice(0, 3).map(w => `${w.address.slice(0,6)}...(${w.score}分)`)
    };
  }
  return summary;
}

// 启动时加载
try { rankings = JSON.parse(fs.readFileSync(RANK_PATH, 'utf8')); } catch(e) {}

module.exports = { updateRankings, getWeight, getSummary, scoreToWeight, rankings };
