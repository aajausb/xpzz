#!/usr/bin/env node
/**
 * 聪明钱实时盈亏跟踪器
 * 
 * 功能：
 * 1. 记录每个聪明钱的每笔swap盈亏
 * 2. 区分"卖币"和"提现到交易所"
 * 3. 滚动评分：最近10次操作的胜率
 * 4. 连续亏损 → 观察列表 → 继续亏 → 移除
 * 
 * 被scanner_daemon.js调用
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const TRACKER_PATH = path.join(WORKSPACE, 'crypto', 'smart_money_tracker.json');

// 已知交易所热钱包（Solana）
const EXCHANGE_WALLETS = new Set([
  // Binance
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
  // OKX
  '5VCwKtCXgCDuQosQOVMX1tg3CC1L26YDpZ6N72prts1S',
  '6kJwcaNyGbpHE5bqYenGfGEByFQNvmPRYpqTzBmFJuJk',
  // Bybit
  'AC5RDfQFmDS1deWZos921JfqscXdByf6BKHAbXRM2gy3',
  // Bitget
  '24eevSoB7TR11veoDXzFCFjiQBPP8cdV5RLshETxqUBf',
]);

// 状态
let tracker = {};
// tracker[address] = {
//   trades: [{time, token, action, pnlPct, isExchangeTransfer}],  // 最近20笔
//   winCount: 0, lossCount: 0, totalTrades: 0,
//   streak: 0,  // 正=连赢, 负=连亏
//   status: 'active' | 'watch' | 'removed',
//   watchSince: null
// }

function load() {
  try { tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8')); } catch(e) { tracker = {}; }
}

function save() {
  try { fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2)); } catch(e) {}
}

function getRecord(address) {
  if (!tracker[address]) {
    tracker[address] = { trades: [], winCount: 0, lossCount: 0, totalTrades: 0, streak: 0, status: 'active', watchSince: null };
  }
  return tracker[address];
}

/**
 * 记录一笔聪明钱操作
 * @param {string} address - 钱包地址
 * @param {string} token - 代币名
 * @param {string} action - 'buy'|'sell'|'transfer'
 * @param {number} pnlPct - 盈亏百分比（卖出时才有意义）
 * @param {string} toAddress - 转账目标地址（判断是否转交易所）
 */
function recordTrade(address, token, action, pnlPct = 0, toAddress = '') {
  const record = getRecord(address);
  
  // 判断是否转到交易所
  const isExchangeTransfer = action === 'transfer' && EXCHANGE_WALLETS.has(toAddress);
  
  if (isExchangeTransfer) {
    // 转到交易所 → 不算盈亏，只记录
    record.trades.push({ time: Date.now(), token, action: 'exchange_transfer', pnlPct: 0, isExchangeTransfer: true });
    if (record.trades.length > 20) record.trades.shift();
    save();
    return { status: record.status, note: '提现到交易所，不计入盈亏' };
  }
  
  if (action === 'sell') {
    record.totalTrades++;
    const isWin = pnlPct > 0;
    
    if (isWin) {
      record.winCount++;
      record.streak = record.streak > 0 ? record.streak + 1 : 1;
    } else {
      record.lossCount++;
      record.streak = record.streak < 0 ? record.streak - 1 : -1;
    }
    
    record.trades.push({ time: Date.now(), token, action: 'sell', pnlPct, isExchangeTransfer: false });
    if (record.trades.length > 20) record.trades.shift();
    
    // 评估状态
    evaluateStatus(address);
    save();
    
    return { status: record.status, winRate: getWinRate(address), streak: record.streak };
  }
  
  // buy只记录，不评分
  if (action === 'buy') {
    record.trades.push({ time: Date.now(), token, action: 'buy', pnlPct: 0, isExchangeTransfer: false });
    if (record.trades.length > 20) record.trades.shift();
    save();
  }
  
  return { status: record.status };
}

/**
 * 评估钱包状态
 */
function evaluateStatus(address) {
  const record = tracker[address];
  if (!record) return;
  
  const recentSells = record.trades.filter(t => t.action === 'sell').slice(-10);
  const recentWins = recentSells.filter(t => t.pnlPct > 0).length;
  const recentLosses = recentSells.filter(t => t.pnlPct <= 0).length;
  
  if (record.status === 'active') {
    // 连亏3次 → 进观察
    if (record.streak <= -3) {
      record.status = 'watch';
      record.watchSince = Date.now();
      return;
    }
    // 最近10笔胜率<30% → 进观察
    if (recentSells.length >= 5 && recentWins / recentSells.length < 0.3) {
      record.status = 'watch';
      record.watchSince = Date.now();
      return;
    }
  }
  
  if (record.status === 'watch') {
    // 观察期内再亏2次 → 移除
    const watchTrades = record.trades.filter(t => t.action === 'sell' && t.time > record.watchSince);
    const watchLosses = watchTrades.filter(t => t.pnlPct <= 0).length;
    
    if (watchLosses >= 2) {
      record.status = 'removed';
      return;
    }
    
    // 观察期连赢3次 → 恢复
    if (record.streak >= 3) {
      record.status = 'active';
      record.watchSince = null;
      return;
    }
    
    // 观察期超过7天且胜率回升>50% → 恢复
    if (Date.now() - record.watchSince > 7 * 24 * 3600000) {
      if (recentSells.length > 0 && recentWins / recentSells.length > 0.5) {
        record.status = 'active';
        record.watchSince = null;
      }
    }
  }
}

/**
 * 获取钱包胜率
 */
function getWinRate(address) {
  const record = tracker[address];
  if (!record || record.totalTrades === 0) return '无数据';
  return `${(record.winCount / record.totalTrades * 100).toFixed(0)}% (${record.winCount}/${record.totalTrades})`;
}

/**
 * 获取所有被移除的钱包
 */
function getRemovedWallets() {
  return Object.entries(tracker).filter(([_, r]) => r.status === 'removed').map(([addr]) => addr);
}

/**
 * 获取观察中的钱包
 */
function getWatchList() {
  return Object.entries(tracker).filter(([_, r]) => r.status === 'watch').map(([addr, r]) => ({
    address: addr, winRate: getWinRate(addr), streak: r.streak, since: new Date(r.watchSince).toLocaleDateString()
  }));
}

/**
 * 是否应该跟单这个钱包
 */
function shouldFollow(address) {
  const record = tracker[address];
  if (!record) return true; // 新钱包默认跟
  return record.status === 'active'; // 只跟active的
}

// 启动时加载
load();

module.exports = { recordTrade, shouldFollow, getRemovedWallets, getWatchList, getWinRate, load, save };
