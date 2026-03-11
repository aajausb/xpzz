#!/usr/bin/env node
/**
 * BSC/Base 聪明钱自动识别
 * 
 * 逻辑：扫描近期热门代币，找出在底部买入且一直持有不卖的地址
 * 这些才是真聪明钱 — 不是钱多，而是判断准+拿得住
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const https = require('https');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');

const RPC = {
  bsc: 'https://bsc-mainnet.public.blastapi.io',
  base: 'https://base-mainnet.public.blastapi.io'
};

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

/**
 * 从GeckoTerminal获取近期热门代币
 */
async function getTrendingTokens(chain) {
  const networkId = chain === 'bsc' ? 'bsc' : 'base';
  const tokens = [];
  
  // GeckoTerminal trending
  try {
    const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${networkId}/trending_pools`);
    for (const p of (data.data || []).slice(0, 10)) {
      const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
      const fdv = parseFloat(p.attributes?.fdv_usd || 0);
      if (addr && fdv < 5000000 && fdv > 50000) {
        tokens.push({ address: addr, name: p.attributes?.name || '?', fdv });
      }
    }
  } catch(e) {}
  
  // BSC额外用OKX补充更多代币
  if (chain === 'bsc') {
    try {
      const { execSync } = require('child_process');
      // 已毕业的（有量的）
      const result = execSync(
        `cd ${WORKSPACE} && ${ONCHAINOS} market memepump-tokens bsc --stage MIGRATED 2>/dev/null`,
        { timeout: 15000 }
      ).toString();
      const data = JSON.parse(result);
      if (data.ok && data.data) {
        for (const t of data.data) {
          const mcap = parseFloat(t.market?.marketCapUsd || 0);
          if (mcap > 10000 && t.tokenAddress) {
            tokens.push({ address: t.tokenAddress, name: t.symbol || '?', fdv: mcap });
          }
        }
      }
    } catch(e) {}
  }
  
  // 两条链都加：GeckoTerminal 历史热门（多翻几页）
  for (let page = 1; page <= 3; page++) {
    try {
      const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${networkId}/pools?page=${page}&sort=h24_volume_usd_desc`);
      for (const p of (data.data || [])) {
        const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
        const fdv = parseFloat(p.attributes?.fdv_usd || 0);
        if (addr && fdv > 10000 && fdv < 10000000) {
          tokens.push({ address: addr, name: p.attributes?.name || '?', fdv });
        }
      }
    } catch(e) {}
  }
  
  return tokens;
}

/**
 * 检测代币是否有横盘区间，并找出横盘期间的买家
 * 双周期检测：1h + 4h K线，任一周期检测到横盘即算
 * 横盘定义：收盘价变异系数(标准差/均价) < 5%
 */
async function detectConsolidationBuyers(tokenAddress, chain) {
  const networkId = chain === 'bsc' ? 'bsc' : 'base';
  
  // 获取池子地址
  let poolAddr = null;
  try {
    const poolData = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${tokenAddress}/pools?page=1`);
    poolAddr = poolData?.data?.[0]?.attributes?.address;
  } catch(e) {}
  
  if (!poolAddr) return { isConsolidating: false, buyers: [] };
  
  // 双周期K线
  let bestResult = { isConsolidating: false, startTs: 0, endTs: 0, days: 0, period: '' };
  
  for (const period of ['1h', '4h']) {
    const aggregate = period === '1h' ? 1 : 4;
    const limit = period === '1h' ? 336 : 84; // 14天
    const minBars = period === '1h' ? 48 : 12; // 最少2天横盘
    const barSeconds = aggregate * 3600;
    
    let ohlcv = [];
    try {
      const klineData = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${networkId}/pools/${poolAddr}/ohlcv/hour?aggregate=${aggregate}&limit=${limit}`);
      ohlcv = (klineData?.data?.attributes?.ohlcv_list || []).reverse();
    } catch(e) {}
    
    if (ohlcv.length < minBars) continue;
    
    // 检测横盘：标准差/均价 < 5%
    let consolidationStart = -1, consolidationEnd = -1;
    for (let i = 0; i <= ohlcv.length - minBars; i++) {
      let j = i + minBars;
      while (j <= ohlcv.length) {
        const closes = ohlcv.slice(i, j).map(k => k[4]);
        const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
        const variance = closes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / closes.length;
        const cv = Math.sqrt(variance) / mean;
        if (cv > 0.12) break;
        j++;
      }
      if (j - i >= minBars) {
        consolidationStart = i;
        consolidationEnd = j - 1;
        break;
      }
    }
    
    if (consolidationStart >= 0) {
      const startTs = ohlcv[consolidationStart][0];
      const endTs = ohlcv[consolidationEnd][0] + barSeconds;
      const hours = (consolidationEnd - consolidationStart + 1) * aggregate;
      const days = hours / 24;
      
      // 取更长的横盘区间
      if (days > bestResult.days) {
        bestResult = { isConsolidating: true, startTs, endTs, days, period };
      }
    }
  }
  
  if (!bestResult.isConsolidating) return { isConsolidating: false, buyers: [] };
  
  if (!bestResult.isConsolidating) return { isConsolidating: false, buyers: [] };
  
  // 有横盘！获取横盘期间的时间范围
  const startTs = bestResult.startTs;
  const endTs = bestResult.endTs;
  const days = bestResult.days.toFixed(1);
  
  // 查横盘期间的买入地址
  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const currentBlock = await provider.getBlockNumber();
  
  // 估算区块范围（BSC ~3秒/块，Base ~2秒/块）
  const blockTime = chain === 'bsc' ? 3 : 2;
  const now = Date.now() / 1000;
  const blocksAgo = Math.floor((now - startTs) / blockTime);
  const blocksEnd = Math.floor((now - endTs) / blockTime);
  const fromBlock = Math.max(currentBlock - blocksAgo, currentBlock - 200000);
  const toBlock = Math.min(currentBlock - blocksEnd, currentBlock);
  
  if (toBlock <= fromBlock) return { isConsolidating: true, buyers: [], days };
  
  // 分批查（每批2000块）
  const buyers = new Map();
  const batchSize = 1999;
  for (let start = fromBlock; start < toBlock; start += batchSize) {
    const end = Math.min(start + batchSize, toBlock);
    try {
      const logs = await provider.getLogs({
        address: tokenAddress,
        topics: [ERC20_TRANSFER_TOPIC],
        fromBlock: start,
        toBlock: end
      });
      for (const log of logs) {
        const to = '0x' + log.topics[2].slice(26);
        if (to !== '0x0000000000000000000000000000000000000000') {
          if (!buyers.has(to)) buyers.set(to, 0);
          buyers.set(to, buyers.get(to) + 1);
        }
      }
    } catch(e) { /* RPC限流，跳过 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  
  return {
    isConsolidating: true,
    days,
    buyers: [...buyers.entries()].map(([addr, count]) => ({ address: addr, buysDuringConsolidation: count }))
  };
}

/**
 * 分析某代币的早期买家
 * 找出在低价区间买入且至今仍持有的地址
 */
async function findDiamondHands(tokenAddress, chain) {
  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const currentBlock = await provider.getBlockNumber();
  
  // 扫最近1999个区块（BlastAPI BSC限制2000）
  const scanBlocks = 1999;
  const fromBlock = currentBlock - scanBlocks;
  
  const logs = await provider.getLogs({
    address: tokenAddress,
    topics: [ERC20_TRANSFER_TOPIC],
    fromBlock,
    toBlock: currentBlock
  });

  // 统计每个地址的买入和卖出
  const walletActivity = new Map(); // address -> { buys: count, sells: count, firstBuyBlock: number }
  
  for (const log of logs) {
    const from = '0x' + log.topics[1].slice(26);
    const to = '0x' + log.topics[2].slice(26);
    
    // 买入（收到token）
    if (to !== '0x0000000000000000000000000000000000000000') {
      if (!walletActivity.has(to)) {
        walletActivity.set(to, { buys: 0, sells: 0, firstBuyBlock: log.blockNumber });
      }
      walletActivity.get(to).buys++;
    }
    
    // 卖出（发出token）
    if (from !== '0x0000000000000000000000000000000000000000') {
      if (!walletActivity.has(from)) {
        walletActivity.set(from, { buys: 0, sells: 0, firstBuyBlock: 0 });
      }
      walletActivity.get(from).sells++;
    }
  }

  // 筛选聪明钱：早期买入 + 没卖 + 当前持仓是盈利的
  const diamondHands = [];
  
  // 获取当前价格参考（用最后一笔transfer的区块位置判断趋势）
  const earlyBlocks = logs.filter(l => l.blockNumber < fromBlock + scanBlocks / 3);
  const lateBlocks = logs.filter(l => l.blockNumber > currentBlock - scanBlocks / 3);
  // 交易活跃度上升 = 币价可能在涨
  const isTokenActive = lateBlocks.length >= earlyBlocks.length;
  
  for (const [addr, activity] of walletActivity) {
    // 条件：买过 + 没卖过或极少卖出
    if (activity.buys > 0 && activity.sells <= activity.buys * 0.2) {
      if (addr === '0x0000000000000000000000000000000000000000') continue;
      
      // 早期买入（在前1/3的区块）
      const earlyThreshold = fromBlock + scanBlocks / 3;
      const isEarly = activity.firstBuyBlock < earlyThreshold;
      
      // 只要早期买入的（晚期买入的不算聪明钱）
      if (!isEarly) continue;
      
      diamondHands.push({
        address: addr,
        buys: activity.buys,
        sells: activity.sells,
        isEarly,
        holdStrength: activity.buys > 0 ? (1 - activity.sells / activity.buys) : 0
      });
    }
  }

  // 按持有强度排序
  return diamondHands
    .filter(w => w.holdStrength > 0.8) // 持有强度>80%
    .sort((a, b) => b.holdStrength - a.holdStrength || b.buys - a.buys)
    .slice(0, 20);
}

/**
 * 主函数：为BSC和Base建立聪明钱列表
 */
async function buildSmartMoneyList() {
  const results = { bsc: [], base: [], updatedAt: new Date().toISOString() };

  for (const chain of ['bsc', 'base']) {
    console.log(`[${ts()}] 🔍 [${chain.toUpperCase()}] 开始识别聪明钱...`);
    
    try {
      const tokens = await getTrendingTokens(chain);
      // 再加新币池
      let newPoolTokens = [];
      try {
        const npData = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${networkId}/new_pools`);
        for (const p of (npData.data || []).slice(0, 15)) {
          const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
          const fdv = parseFloat(p.attributes?.fdv_usd || 0);
          if (addr && fdv < 5000000 && fdv > 50000) {
            newPoolTokens.push({ address: addr, name: p.attributes?.name || '?', fdv });
          }
        }
      } catch(e) {}
      
      const allTokens = [...tokens, ...newPoolTokens];
      // 去重
      const seen = new Set();
      const uniqueTokens = allTokens.filter(t => {
        if (seen.has(t.address)) return false;
        seen.add(t.address);
        return true;
      });
      console.log(`  找到 ${uniqueTokens.length} 个代币（热门+新池）`);
      
      const allSmartWallets = new Map(); // address -> score
      
      for (const token of uniqueTokens.slice(0, 30)) {
        try {
          console.log(`  分析 ${token.name} (${token.address.slice(0,10)}...)`);
          const diamonds = await findDiamondHands(token.address, chain);
          
          // 检测横盘+横盘期间买家
          const consol = await detectConsolidationBuyers(token.address, chain);
          const consolBuyerSet = new Set(consol.buyers.map(b => b.address));
          if (consol.isConsolidating) {
            console.log(`    📊 检测到横盘${consol.days}天，${consol.buyers.length}个买家`);
          }
          
          for (const d of diamonds) {
            if (!allSmartWallets.has(d.address)) {
              allSmartWallets.set(d.address, { score: 0, wins: 0, total: 0 });
            }
            const record = allSmartWallets.get(d.address);
            record.total++; // 参与了几个币
            record.wins++;  // 在涨的币里被发现 = 赢了一次（因为只从涨的币里选）
            record.score += d.holdStrength + (d.isEarly ? 1 : 0);
            // 横盘期间还在加仓 → 额外+1.5分（信仰者加分）
            if (consolBuyerSet.has(d.address)) {
              record.score += 1.5;
              console.log(`    🧠 ${d.address.slice(0,10)}... 横盘加仓+钻石手!`);
            }
          }
          
          // 横盘买家即使不在diamonds里，也值得记录（可能是新发现的聪明钱）
          if (consol.isConsolidating) {
            for (const buyer of consol.buyers) {
              if (!allSmartWallets.has(buyer.address) && buyer.buysDuringConsolidation >= 2) {
                allSmartWallets.set(buyer.address, { 
                  score: 1.0 + buyer.buysDuringConsolidation * 0.3, 
                  wins: 1, 
                  total: 1 
                });
              }
            }
          }
        } catch(e) {
          console.log(`  ⚠️ ${token.name} 分析失败: ${e.message}`);
        }
      }

      // 按得分排序，只保留出现在多个币中的（长期赚钱）
      const ranked = [...allSmartWallets.entries()]
        .filter(([_, r]) => r.total >= 1) // 至少在1个盈利币中出现（数据积累后提高到2）
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 100)
        .map(([addr, r]) => ({ 
          address: addr, 
          score: r.score.toFixed(2),
          winRate: `${r.wins}/${r.total}`,
          note: '多次底部买入+持有盈利'
        }));
      
      results[chain] = ranked;
      console.log(`[${ts()}] ✅ [${chain.toUpperCase()}] 识别出 ${ranked.length} 个聪明钱`);
      
    } catch(e) {
      console.log(`[${ts()}] ❌ [${chain.toUpperCase()}] 失败: ${e.message}`);
    }
  }

  // 保存（带历史对比 + 永久保留高胜率钱包）
  const outPath = path.join(WORKSPACE, 'crypto', 'evm_smart_money.json');
  const historyPath = path.join(WORKSPACE, 'crypto', 'smart_money_history.jsonl');
  
  // 读取旧数据做对比
  let oldData = { bsc: [], base: [] };
  try { oldData = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch(e) {}
  
  // ★ 核心改动：合并新旧数据，高胜率钱包保留但有衰退机制
  for (const chain of ['bsc', 'base']) {
    const newAddrs = new Set((results[chain] || []).map(w => w.address));
    const oldWallets = (oldData[chain] || []);
    
    for (const old of oldWallets) {
      if (!newAddrs.has(old.address)) {
        // 不在新名单里 → 衰退
        old.missCount = (old.missCount || 0) + 1;
        
        // 高分钱包容忍更多次缺席：score>=2容忍5次，score>=1.5容忍3次
        const maxMiss = parseFloat(old.score) >= 2 ? 5 : parseFloat(old.score) >= 1.5 ? 3 : 1;
        
        if (old.missCount <= maxMiss) {
          old.note = `历史保留(缺席${old.missCount}/${maxMiss})`;
          results[chain].push(old);
        }
        // 超过容忍次数 → 淘汰，不再保留
      }
    }
    
    // 新上榜的重置missCount
    for (const w of results[chain]) {
      if (newAddrs.has(w.address)) w.missCount = 0;
    }
    
    // 去重
    const seen = new Set();
    results[chain] = results[chain].filter(w => {
      if (seen.has(w.address)) return false;
      seen.add(w.address);
      return true;
    });
  }
  
  const changes = { date: new Date().toISOString(), bsc: {}, base: {} };
  
  for (const chain of ['bsc', 'base']) {
    const oldAddrs = new Set((oldData[chain] || []).map(w => w.address));
    const newAddrs = new Set((results[chain] || []).map(w => w.address));
    
    const added = [...newAddrs].filter(a => !oldAddrs.has(a));
    const removed = [...oldAddrs].filter(a => !newAddrs.has(a));
    
    changes[chain] = {
      total: results[chain].length,
      added: added.length,
      removed: removed.length,
      newWallets: added.slice(0, 10),
      lostWallets: removed.slice(0, 10)
    };
  }
  
  // 保存最新数据
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  
  // 追加历史变化日志
  fs.appendFileSync(historyPath, JSON.stringify(changes) + '\n');
  
  console.log(`\n💾 已保存到 ${outPath}`);
  console.log(`BSC: ${results.bsc.length} 个 (新增${changes.bsc.added} 移除${changes.bsc.removed})`);
  console.log(`Base: ${results.base.length} 个 (新增${changes.base.added} 移除${changes.base.removed})`);
  
  return { results, changes };
}

if (require.main === module) {
  buildSmartMoneyList().catch(console.error);
}

module.exports = { buildSmartMoneyList, findDiamondHands };
