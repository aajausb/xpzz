#!/usr/bin/env node
/**
 * 实时钓鱼检测 - 跟单前最后一道防线
 * 
 * 在跟单前检查：
 * 1. 钱包是否有dump pattern（频繁买入后立刻全卖）
 * 2. 是否突然改变风格（大币→超小币）
 * 3. 是否在短时间内大量买入不同币（撒网钓鱼特征）
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const BEHAVIOR_PATH = path.join(WORKSPACE, 'crypto', 'wallet_behavior.json');

let behavior = {};
// behavior[address] = {
//   recentBuys: [{mint, time, mcap}],  // 最近20笔买入
//   recentSells: [{mint, time, holdTime}],  // 最近20笔卖出
//   avgHoldTime: 0,  // 平均持有时间(ms)
//   avgMcap: 0,  // 平均买入市值
//   dumpCount: 0,  // 买了立刻卖的次数
//   diverseBuyCount: 0,  // 1小时内买不同币的数量
// }

function load() {
  try { behavior = JSON.parse(fs.readFileSync(BEHAVIOR_PATH, 'utf8')); } catch(e) { behavior = {}; }
}

function save() {
  try { fs.writeFileSync(BEHAVIOR_PATH, JSON.stringify(behavior, null, 2)); } catch(e) {}
}

function getWallet(addr) {
  if (!behavior[addr]) {
    behavior[addr] = { recentBuys: [], recentSells: [], avgHoldTime: 0, avgMcap: 0, dumpCount: 0, diverseBuyCount: 0 };
  }
  return behavior[addr];
}

/**
 * 记录买入行为
 */
function recordBuy(address, mint, mcap = 0) {
  const w = getWallet(address);
  w.recentBuys.push({ mint, time: Date.now(), mcap });
  if (w.recentBuys.length > 20) w.recentBuys.shift();
  
  // 更新平均市值
  const mcaps = w.recentBuys.filter(b => b.mcap > 0).map(b => b.mcap);
  if (mcaps.length > 0) w.avgMcap = mcaps.reduce((a, b) => a + b, 0) / mcaps.length;
  
  save();
}

/**
 * 记录卖出行为
 */
function recordSell(address, mint) {
  const w = getWallet(address);
  
  // 找到对应的买入记录算持有时间
  const buyRecord = w.recentBuys.find(b => b.mint === mint);
  const holdTime = buyRecord ? Date.now() - buyRecord.time : 0;
  
  w.recentSells.push({ mint, time: Date.now(), holdTime });
  if (w.recentSells.length > 20) w.recentSells.shift();
  
  // 持有<2分钟 = dump
  if (holdTime > 0 && holdTime < 2 * 60 * 1000) {
    w.dumpCount++;
  }
  
  // 更新平均持有时间
  const holds = w.recentSells.filter(s => s.holdTime > 0).map(s => s.holdTime);
  if (holds.length > 0) w.avgHoldTime = holds.reduce((a, b) => a + b, 0) / holds.length;
  
  save();
}

/**
 * 跟单前检查 - 返回 {safe: boolean, reason: string}
 */
function preTradeCheck(address, tokenMint, tokenMcap = 0) {
  const w = getWallet(address);
  const now = Date.now();
  const reasons = [];
  
  // 检查1: dump pattern - 最近5笔卖出中有3笔以上持有<5分钟
  const recentSells = w.recentSells.filter(s => now - s.time < 24 * 3600000); // 24小时内
  const quickDumps = recentSells.filter(s => s.holdTime > 0 && s.holdTime < 5 * 60 * 1000);
  if (quickDumps.length >= 3) {
    reasons.push(`dump模式: 24h内${quickDumps.length}次快速卖出(<5分钟)`);
  }
  
  // 检查2: 突然改变风格 - 平时买市值>$100K的币，突然买<$10K的
  if (w.avgMcap > 100000 && tokenMcap > 0 && tokenMcap < 10000) {
    reasons.push(`风格突变: 平时买$${(w.avgMcap/1000).toFixed(0)}K，突然买$${(tokenMcap/1000).toFixed(0)}K`);
  }
  
  // 检查3: 撒网钓鱼 - 1小时内买了超过5个不同的币
  const recentBuys1h = w.recentBuys.filter(b => now - b.time < 60 * 60 * 1000);
  const uniqueMints1h = new Set(recentBuys1h.map(b => b.mint));
  if (uniqueMints1h.size >= 5) {
    reasons.push(`撒网嫌疑: 1小时内买了${uniqueMints1h.size}个不同币`);
  }
  
  // 检查4: 累计dump次数太多
  if (w.dumpCount >= 5) {
    reasons.push(`累计dump ${w.dumpCount}次`);
  }
  
  // 检查5: 平均持有时间<10分钟（排除刚开始没数据的）
  if (w.recentSells.length >= 3 && w.avgHoldTime > 0 && w.avgHoldTime < 10 * 60 * 1000) {
    reasons.push(`平均持有${(w.avgHoldTime/60000).toFixed(1)}分钟，疑似短线割韭菜`);
  }
  
  // 检查6: 高频交易 - 12小时内超过9笔买入 = 机器人/套利bot
  const buys12h = w.recentBuys.filter(b => now - b.time < 12 * 3600000);
  if (buys12h.length >= 9) {
    reasons.push(`高频bot: 12h内${buys12h.length}笔买入`);
  }
  
  // 检查7: 极短间隔交易 - 连续3笔买入间隔<30秒 = 机器人
  const sortedBuys = w.recentBuys.filter(b => now - b.time < 3600000).sort((a,b) => a.time - b.time);
  let fastCount = 0;
  for (let i = 1; i < sortedBuys.length; i++) {
    if (sortedBuys[i].time - sortedBuys[i-1].time < 30000) fastCount++;
  }
  if (fastCount >= 3) {
    reasons.push(`机器人特征: ${fastCount}次间隔<30秒的连续买入`);
  }
  
  if (reasons.length > 0) {
    return { safe: false, reason: reasons.join('; ') };
  }
  
  return { safe: true, reason: '' };
}

load();

module.exports = { recordBuy, recordSell, preTradeCheck, load, save };
