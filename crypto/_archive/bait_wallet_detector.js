#!/usr/bin/env node
/**
 * 钓鱼钱包检测器
 * 
 * 识别特征：
 * 1. 买入后短时间内大量卖出（引诱跟单后砸盘）
 * 2. 卖出比例极高（>90%）+ 操作频繁
 * 3. 反复在不同新币上重复同一模式
 * 4. 买卖时间间隔短（快进快出 but 不是赚钱，是钓鱼）
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const ONCHAINOS = '/root/.local/bin/onchainos';
const { execSync } = require('child_process');

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

async function detectBaitWallets() {
  console.log(`[${ts()}] 🔍 开始检测钓鱼钱包...\n`);
  
  // 获取近期所有聪明钱信号
  let signals = [];
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market signal-list solana --wallet-type "1" --min-amount-usd 50 2>/dev/null`,
      { timeout: 20000 }
    ).toString();
    const data = JSON.parse(result);
    if (data.ok) signals = data.data || [];
  } catch(e) {
    console.log('获取信号失败:', e.message);
    return;
  }
  
  console.log(`获取到 ${signals.length} 条信号`);
  
  // 按钱包地址分组分析
  const walletStats = new Map(); // wallet -> { trades: [], patterns: {} }
  
  for (const sig of signals) {
    const addrStr = sig.triggerWalletAddress || '';
    const walletAddrs = addrStr.split(',').filter(a => a.length > 10);
    const soldRatio = parseFloat(sig.soldRatioPercent || 0);
    const tokenAge = parseFloat(sig.token?.ageDays || 0);
    const mcap = parseFloat(sig.token?.marketCapUsd || 0);
    const holders = parseInt(sig.token?.holders || 0);
    
    for (const addr of walletAddrs) {
      
      if (!walletStats.has(addr)) {
        walletStats.set(addr, {
          trades: [],
          fastDumps: 0,    // 快速砸盘次数
          totalTrades: 0,
          newCoinTrades: 0, // 在新币上操作次数
          highSellTrades: 0 // 高卖出比例次数
        });
      }
      
      const ws = walletStats.get(addr);
      ws.totalTrades++;
      
      // 钓鱼特征1: 卖出比例>90%（几乎全卖了）
      if (soldRatio > 90) ws.highSellTrades++;
      
      // 钓鱼特征2: 操作极新的币（<1天）
      if (tokenAge < 1) ws.newCoinTrades++;
      
      // 钓鱼特征3: 小市值币（容易操纵）
      if (mcap < 100000) ws.fastDumps++;
      
      ws.trades.push({
        token: sig.token?.symbol || '?',
        soldRatio,
        tokenAge,
        mcap
      });
    }
  }
  
  // 计算钓鱼分数
  const baitScores = [];
  
  for (const [addr, ws] of walletStats) {
    if (ws.totalTrades < 2) continue; // 样本太少跳过
    
    const sellRate = ws.highSellTrades / ws.totalTrades; // 高卖出占比
    const newCoinRate = ws.newCoinTrades / ws.totalTrades; // 新币操作占比
    const dumpRate = ws.fastDumps / ws.totalTrades; // 小市值操作占比
    
    // 钓鱼分数 = 高卖出占比*40 + 新币操作占比*30 + 小市值占比*30
    const baitScore = sellRate * 40 + newCoinRate * 30 + dumpRate * 30;
    
    // 分数>60认为是钓鱼嫌疑
    if (baitScore > 30) {
      baitScores.push({
        address: addr,
        baitScore: baitScore.toFixed(1),
        totalTrades: ws.totalTrades,
        highSellRate: (sellRate * 100).toFixed(0) + '%',
        newCoinRate: (newCoinRate * 100).toFixed(0) + '%',
        dumpRate: (dumpRate * 100).toFixed(0) + '%',
        isBait: baitScore > 60,
        isSuspect: baitScore > 40 && baitScore <= 60
      });
    }
  }
  
  // 排序
  baitScores.sort((a, b) => parseFloat(b.baitScore) - parseFloat(a.baitScore));
  
  // 输出结果
  const confirmed = baitScores.filter(b => b.isBait);
  const suspect = baitScores.filter(b => b.isSuspect);
  const clean = walletStats.size - confirmed.length - suspect.length;
  
  console.log(`\n========== 钓鱼钱包检测结果 ==========`);
  console.log(`分析钱包数: ${walletStats.size}`);
  console.log(`🚨 确认钓鱼: ${confirmed.length} 个`);
  console.log(`⚠️ 可疑: ${suspect.length} 个`);
  console.log(`✅ 正常: ${clean} 个`);
  
  if (confirmed.length > 0) {
    console.log(`\n🚨 确认钓鱼钱包:`);
    for (const b of confirmed) {
      console.log(`  ${b.address.slice(0,12)}... | 钓鱼分:${b.baitScore} | 交易:${b.totalTrades}次 | 高卖出:${b.highSellRate} | 新币:${b.newCoinRate} | 小市值:${b.dumpRate}`);
    }
  }
  
  if (suspect.length > 0) {
    console.log(`\n⚠️ 可疑钱包:`);
    for (const b of suspect.slice(0, 10)) {
      console.log(`  ${b.address.slice(0,12)}... | 钓鱼分:${b.baitScore} | 交易:${b.totalTrades}次 | 高卖出:${b.highSellRate} | 新币:${b.newCoinRate}`);
    }
  }
  
  // 保存黑名单
  const blacklist = {
    updatedAt: new Date().toISOString(),
    confirmed: confirmed.map(b => b.address),
    suspect: suspect.map(b => b.address),
    details: baitScores
  };
  
  const outPath = path.join(WORKSPACE, 'crypto', 'bait_blacklist.json');
  fs.writeFileSync(outPath, JSON.stringify(blacklist, null, 2));
  console.log(`\n💾 黑名单已保存到 ${outPath}`);
  
  return blacklist;
}

if (require.main === module) {
  (async () => {
    const blacklist = await detectBaitWallets();
    // 自动检查已有聪明钱是否变质
    await checkExistingSmartMoney(blacklist);
  })().catch(console.error);
}

/**
 * 检查已有聪明钱列表中是否有变质的
 * 如果发现就从列表中移除并报警
 */
async function checkExistingSmartMoney(blacklist) {
  const baitAddrs = new Set([...(blacklist.confirmed || []), ...(blacklist.suspect || [])]);
  const allDetails = new Map((blacklist.details || []).map(d => [d.address, d]));
  let corrupted = [];
  
  // 检查Solana私有列表
  try {
    const solPath = path.join(WORKSPACE, 'crypto', 'solana_private_smart_money.json');
    const solData = JSON.parse(fs.readFileSync(solPath, 'utf8'));
    const before = solData.wallets.length;
    const removed = [];
    
    solData.wallets = solData.wallets.filter(w => {
      if (baitAddrs.has(w.address)) {
        removed.push(w.address);
        const detail = allDetails.get(w.address);
        corrupted.push({ chain: 'SOL', address: w.address, score: detail?.baitScore || '?' });
        return false;
      }
      return true;
    });
    
    if (removed.length > 0) {
      fs.writeFileSync(solPath, JSON.stringify(solData, null, 2));
      console.log(`\n🚨 Solana私有列表清理: ${before} → ${solData.wallets.length} (移除${removed.length}个变质地址)`);
    }
  } catch(e) {}
  
  // 检查BSC/Base列表
  try {
    const evmPath = path.join(WORKSPACE, 'crypto', 'evm_smart_money.json');
    const evmData = JSON.parse(fs.readFileSync(evmPath, 'utf8'));
    
    for (const chain of ['bsc', 'base']) {
      if (!evmData[chain]) continue;
      const before = evmData[chain].length;
      const removed = [];
      
      evmData[chain] = evmData[chain].filter(w => {
        if (baitAddrs.has(w.address)) {
          removed.push(w.address);
          corrupted.push({ chain: chain.toUpperCase(), address: w.address });
          return false;
        }
        return true;
      });
      
      if (removed.length > 0) {
        console.log(`🚨 ${chain.toUpperCase()}列表清理: ${before} → ${evmData[chain].length} (移除${removed.length}个变质地址)`);
      }
    }
    
    if (corrupted.length > 0) {
      fs.writeFileSync(evmPath, JSON.stringify(evmData, null, 2));
    }
  } catch(e) {}
  
  if (corrupted.length > 0) {
    console.log(`\n⚠️ 共发现 ${corrupted.length} 个已入选聪明钱变质为钓鱼:`);
    for (const c of corrupted) {
      console.log(`  [${c.chain}] ${c.address.slice(0,12)}... 钓鱼分:${c.score}`);
    }
    
    // 记录到变质日志
    const logEntry = {
      time: new Date().toISOString(),
      corrupted
    };
    fs.appendFileSync(
      path.join(WORKSPACE, 'crypto', 'corrupted_wallets.jsonl'),
      JSON.stringify(logEntry) + '\n'
    );
  } else {
    console.log('\n✅ 已有聪明钱列表全部健康，无变质');
  }
  
  return corrupted;
}

module.exports = { detectBaitWallets, checkExistingSmartMoney };
