/**
 * 聪明钱动态排名系统
 * 
 * 数据源：OKX signal-list聪明钱信号
 * 排名维度：出现频次 × 信号币后续表现
 * 
 * 流程：
 * 1. 从signal-list收集所有聪明钱钱包地址
 * 2. 记录每个钱包参与的token + 记录时价格
 * 3. 定期回查token价格变化 → 计算钱包胜率和平均收益
 * 4. 动态排名
 */

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data/v7');
const RANK_FILE = path.join(DATA_DIR, 'wallet_rank.json');
const SIGNAL_HISTORY_FILE = path.join(DATA_DIR, 'signal_history.json');

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

const CHAINS = ['solana', 'bsc', 'base'];

// ============ 收集聪明钱信号 ============

async function collectSignals() {
  console.log('📡 收集聪明钱信号...');
  
  let signalHistory = loadJSON(SIGNAL_HISTORY_FILE, { signals: {}, wallets: {} });
  let newCount = 0;
  
  for (const chain of CHAINS) {
    let signals;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const cmd = `onchainos market signal-list ${chain} --wallet-type "1"`;
        const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 60000, maxBuffer: 10*1024*1024 }).toString());
        signals = result.data || [];
        break;
      } catch (e) {
        if (retry < 2) {
          console.log(`  ${chain} 第${retry+1}次失败，5秒后重试...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.log(`  ${chain} 3次均失败: ${e.message?.slice(0,60)}`);
        }
      }
    }
    if (!signals) continue;
    
    for (const s of signals) {
      const token = s.token;
      const tokenKey = `${chain}:${token.tokenAddress}`;
      const wallets = (s.triggerWalletAddress || '').split(',').filter(Boolean);
      const now = Date.now();
      
      // 记录信号（每个token只记录一次初始价格）
      if (!signalHistory.signals[tokenKey]) {
        signalHistory.signals[tokenKey] = {
          chain,
          address: token.tokenAddress,
          symbol: token.symbol,
          name: token.name,
          firstSeenPrice: parseFloat(s.price) || 0,
          firstSeenMC: parseFloat(token.marketCapUsd) || 0,
          firstSeen: now,
          wallets: [],
          priceChecks: []
        };
        newCount++;
      }
      
      // 追加钱包
      const existing = new Set(signalHistory.signals[tokenKey].wallets);
      for (const w of wallets) {
        if (!existing.has(w)) {
          signalHistory.signals[tokenKey].wallets.push(w);
          existing.add(w);
        }
        
        // 更新钱包统计
        if (!signalHistory.wallets[w]) {
          signalHistory.wallets[w] = {
            address: w,
            chains: [],
            tokens: [],
            firstSeen: now,
            signalCount: 0
          };
        }
        const wData = signalHistory.wallets[w];
        if (!wData.chains.includes(chain)) wData.chains.push(chain);
        if (!wData.tokens.find(t => t.key === tokenKey)) {
          wData.tokens.push({
            key: tokenKey,
            symbol: token.symbol,
            chain,
            entryPrice: parseFloat(s.price) || 0,
            entryMC: parseFloat(token.marketCapUsd) || 0,
            entryTime: now,
            soldPercent: parseFloat(s.soldRatioPercent) || 0
          });
          wData.signalCount++;
        }
      }
    }
  }
  
  saveJSON(SIGNAL_HISTORY_FILE, signalHistory);
  const totalWallets = Object.keys(signalHistory.wallets).length;
  const totalSignals = Object.keys(signalHistory.signals).length;
  console.log(`  新增${newCount}个信号 | 累计: ${totalSignals}个token, ${totalWallets}个钱包`);
  
  return signalHistory;
}

// ============ 回查价格，计算收益 ============

async function updatePriceAndRank() {
  let signalHistory = loadJSON(SIGNAL_HISTORY_FILE, { signals: {}, wallets: {} });
  const now = Date.now();
  
  console.log('💰 回查价格...');
  
  // 批量查价格（按chain分组）
  const tokensByChain = {};
  for (const [key, sig] of Object.entries(signalHistory.signals)) {
    if (!sig.firstSeenPrice || sig.firstSeenPrice === 0) continue;
    // 只查最近7天的
    if (now - sig.firstSeen > 7 * 86400_000) continue;
    
    if (!tokensByChain[sig.chain]) tokensByChain[sig.chain] = [];
    tokensByChain[sig.chain].push({ key, sig });
  }
  
  for (const [chain, tokens] of Object.entries(tokensByChain)) {
    for (const { key, sig } of tokens) {
      try {
        const cmd = `onchainos market price --chain ${chain} ${sig.address}`;
        const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 8000, maxBuffer: 5*1024*1024 }).toString());
        
        if (result.ok && result.data?.[0]) {
          const currentPrice = parseFloat(result.data[0].price) || 0;
          if (currentPrice > 0 && sig.firstSeenPrice > 0) {
            const change = ((currentPrice - sig.firstSeenPrice) / sig.firstSeenPrice) * 100;
            sig.currentPrice = currentPrice;
            sig.priceChange = change;
            sig.lastCheck = now;
            
            // 记录价格历史
            sig.priceChecks.push({ time: now, price: currentPrice, change });
            // 只保留最近10次
            if (sig.priceChecks.length > 10) sig.priceChecks = sig.priceChecks.slice(-10);
          }
        }
      } catch (e) {
        // 查价失败跳过
      }
      
      // 避免API限流
      await sleep(200);
    }
  }
  
  // ============ 过滤合约地址 ============
  
  console.log('🔍 过滤合约地址...');
  
  const contractCache = loadJSON(path.join(DATA_DIR, 'contract_cache.json'), {});
  const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
  const baseProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  
  let contractCount = 0;
  const evmWallets = Object.entries(signalHistory.wallets)
    .filter(([addr]) => addr.startsWith('0x'))
    .map(([addr]) => addr);
  
  for (const addr of evmWallets) {
    if (contractCache[addr] !== undefined) {
      if (contractCache[addr]) contractCount++;
      continue;
    }
    try {
      const chain = signalHistory.wallets[addr].chains.includes('base') ? 'base' : 'bsc';
      const provider = chain === 'base' ? baseProvider : bscProvider;
      const code = await provider.getCode(addr);
      contractCache[addr] = code !== '0x';
      if (contractCache[addr]) contractCount++;
      await sleep(100);
    } catch(e) {
      // 查不到先当EOA
      contractCache[addr] = false;
    }
  }
  
  saveJSON(path.join(DATA_DIR, 'contract_cache.json'), contractCache);
  console.log(`  EVM钱包${evmWallets.length}个, 合约${contractCount}个(已过滤)`);
  
  // ============ 计算钱包排名 ============
  
  console.log('📊 计算排名...');
  
  const walletRanks = [];
  
  for (const [addr, wData] of Object.entries(signalHistory.wallets)) {
    if (wData.tokens.length < 2) continue; // 至少参与2个token才有意义
    
    // 过滤合约地址（EVM链）
    if (addr.startsWith('0x') && contractCache[addr]) continue;
    
    // 过滤可疑钱包：如果只参与了sold=100%的token（可能是被钓鱼空投的）
    const allSold100 = wData.tokens.every(t => {
      return t.soldPercent >= 99;
    });
    if (allSold100 && wData.tokens.length <= 3) continue; // sold全满+token少=可疑
    
    let wins = 0;
    let losses = 0;
    let totalReturn = 0;
    let trackedTokens = 0;
    
    for (const t of wData.tokens) {
      const sig = signalHistory.signals[t.key];
      if (!sig || sig.priceChange === undefined) continue;
      
      trackedTokens++;
      const ret = sig.priceChange;
      totalReturn += ret;
      
      if (ret > 0) wins++;
      else losses++;
    }
    
    if (trackedTokens < 2) continue;
    
    const winRate = wins / trackedTokens * 100;
    const avgReturn = totalReturn / trackedTokens;
    
    // 综合评分 = 胜率权重 × 平均收益权重 × 信号数量加成
    const score = (winRate / 100) * Math.max(avgReturn, 0) * Math.log2(trackedTokens + 1);
    
    walletRanks.push({
      address: addr,
      chains: wData.chains,
      totalTokens: wData.tokens.length,
      trackedTokens,
      wins,
      losses,
      winRate: Math.round(winRate * 10) / 10,
      avgReturn: Math.round(avgReturn * 10) / 10,
      score: Math.round(score * 100) / 100,
      firstSeen: wData.firstSeen,
      topPicks: wData.tokens
        .map(t => {
          const sig = signalHistory.signals[t.key];
          return { symbol: t.symbol, chain: t.chain, change: sig?.priceChange };
        })
        .filter(t => t.change !== undefined)
        .sort((a, b) => (b.change || 0) - (a.change || 0))
        .slice(0, 5)
    });
  }
  
  // 按score排序
  walletRanks.sort((a, b) => b.score - a.score);
  
  saveJSON(RANK_FILE, { updated: now, ranks: walletRanks });
  saveJSON(SIGNAL_HISTORY_FILE, signalHistory);
  
  return walletRanks;
}

// ============ 打印排名 ============

function printRanks(ranks, top = 20) {
  const n = Math.min(top, ranks.length);
  console.log(`\n🏆 聪明钱排名 TOP ${n}`);
  console.log('─'.repeat(80));
  console.log('  #  钱包           链        胜率    均收益   Token数    评分');
  console.log('─'.repeat(80));
  
  for (let i = 0; i < n; i++) {
    const r = ranks[i];
    const addr = r.address.slice(0, 6) + '...' + r.address.slice(-4);
    const chains = r.chains.join('/');
    console.log(`  ${String(i+1).padStart(2)}  ${addr.padEnd(13)} ${chains.padEnd(9)} ${(r.winRate+'%').padStart(6)} ${(r.avgReturn.toFixed(1)+'%').padStart(8)} ${String(r.trackedTokens).padStart(7)} ${r.score.toFixed(2).padStart(8)}`);
    
    if (r.topPicks.length > 0) {
      const picks = r.topPicks.map(p => `${p.symbol}(${p.change > 0 ? '+' : ''}${(p.change||0).toFixed(0)}%)`).join(' ');
      console.log(`      └ ${picks}`);
    }
  }
  
  console.log('─'.repeat(80));
  console.log(`总计 ${ranks.length} 个有效钱包`);
}

// ============ 工具 ============

function loadJSON(file, defaultVal) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return defaultVal; }
}

function saveJSON(file, data) {
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 主函数 ============

async function run() {
  console.log('🧠 聪明钱排名系统启动\n');
  
  // 1. 收集信号
  await collectSignals();
  
  // 2. 回查价格 + 排名
  const ranks = await updatePriceAndRank();
  
  // 3. 打印
  printRanks(ranks);
  
  return ranks;
}

if (require.main === module) {
  run().catch(e => console.error('Fatal:', e));
}

module.exports = { collectSignals, updatePriceAndRank, printRanks, run };
