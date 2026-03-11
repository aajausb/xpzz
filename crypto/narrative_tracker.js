#!/usr/bin/env node
/**
 * 叙事追踪 - 监控加密货币热点趋势
 * 
 * 数据源：
 * 1. CoinGecko 热门搜索
 * 2. GeckoTerminal 热门池子提取关键词
 * 3. OKX 热门代币
 * 
 * 输出：当前热点叙事关键词列表
 */

const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const ONCHAINOS = path.join(process.env.HOME, '.local/bin/onchainos');
const NARRATIVES_FILE = path.join(WORKSPACE, 'crypto', 'hot_narratives.json');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const opts = typeof url === 'string' ? url : url;
    https.get(opts, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * 从CoinGecko获取热门搜索
 */
async function getCoinGeckoTrending() {
  try {
    const data = await fetchJSON('https://api.coingecko.com/api/v3/search/trending');
    const coins = (data.coins || []).map(c => ({
      name: c.item.name,
      symbol: c.item.symbol,
      mcap_rank: c.item.market_cap_rank
    }));
    return coins;
  } catch(e) {
    return [];
  }
}

/**
 * 从GeckoTerminal获取三链热门池
 */
async function getGeckoTerminalTrending() {
  const chains = ['solana', 'bsc', 'base'];
  const trending = [];
  
  for (const chain of chains) {
    try {
      const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${chain}/trending_pools`);
      for (const p of (data.data || []).slice(0, 5)) {
        const name = p.attributes?.name || '';
        trending.push({ chain, name, fdv: p.attributes?.fdv_usd || 0 });
      }
    } catch(e) {}
  }
  return trending;
}

/**
 * 从OKX获取热门代币
 */
function getOKXTrending() {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market memepump-tokens solana --stage MIGRATED 2>/dev/null`,
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(result);
    if (!data.ok) return [];
    
    // 按1h交易量排序取前10
    return data.data
      .sort((a, b) => parseFloat(b.market?.volumeUsd1h || 0) - parseFloat(a.market?.volumeUsd1h || 0))
      .slice(0, 10)
      .map(t => ({
        symbol: t.symbol,
        name: t.name || t.symbol,
        vol1h: parseFloat(t.market?.volumeUsd1h || 0),
        mcap: parseFloat(t.market?.marketCapUsd || 0)
      }));
  } catch(e) {
    return [];
  }
}

/**
 * 提取关键词/叙事
 */
function extractNarratives(coinGecko, geckoTerminal, okx) {
  const keywords = new Map(); // keyword -> count
  
  // 常见叙事关键词
  const narrativePatterns = [
    { pattern: /ai|artificial|intelligence|agent|gpt|llm|neural/i, narrative: 'AI' },
    { pattern: /meme|pepe|doge|shib|cat|dog|frog|wojak/i, narrative: 'Meme' },
    { pattern: /rwa|real.?world|tokeniz/i, narrative: 'RWA' },
    { pattern: /depin|decentralized.?physical|iot|sensor/i, narrative: 'DePIN' },
    { pattern: /game|gaming|play|metaverse|nft/i, narrative: 'GameFi' },
    { pattern: /defi|swap|lend|yield|stake|liquid/i, narrative: 'DeFi' },
    { pattern: /layer.?2|l2|rollup|zk|optimis/i, narrative: 'L2' },
    { pattern: /btc|bitcoin|ordinal|inscription|brc/i, narrative: 'BTC生态' },
    { pattern: /sol|solana/i, narrative: 'Solana生态' },
    { pattern: /trump|politic|election|president/i, narrative: '政治' },
    { pattern: /elon|musk|tesla|spacex|x\.com/i, narrative: 'Elon系' },
    { pattern: /oil|energy|war|crisis|military/i, narrative: '地缘政治' },
    { pattern: /chinese|china|中国|春节|lunar/i, narrative: '中国概念' },
  ];

  // 分析所有代币名称
  const allNames = [
    ...coinGecko.map(c => c.name + ' ' + c.symbol),
    ...geckoTerminal.map(t => t.name),
    ...okx.map(t => t.name + ' ' + t.symbol)
  ];

  for (const name of allNames) {
    for (const { pattern, narrative } of narrativePatterns) {
      if (pattern.test(name)) {
        keywords.set(narrative, (keywords.get(narrative) || 0) + 1);
      }
    }
  }

  // 排序，出现次数多的排前面
  return [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([narrative, count]) => ({ narrative, count }));
}

/**
 * 主函数：更新热点叙事
 */
async function updateNarratives() {
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 🔥 更新热点叙事...`);

  const [coinGecko, geckoTerminal, okx] = await Promise.all([
    getCoinGeckoTrending(),
    getGeckoTerminalTrending(),
    Promise.resolve(getOKXTrending())
  ]);

  console.log(`  CoinGecko热门: ${coinGecko.length}个`);
  console.log(`  GeckoTerminal热门: ${geckoTerminal.length}个`);
  console.log(`  OKX热门: ${okx.length}个`);

  const narratives = extractNarratives(coinGecko, geckoTerminal, okx);

  const result = {
    updated_at: new Date().toISOString(),
    hot_narratives: narratives,
    trending_coins: {
      coingecko: coinGecko.slice(0, 5),
      okx_top_volume: okx.slice(0, 5),
      geckoterminal: geckoTerminal.slice(0, 5)
    }
  };

  fs.writeFileSync(NARRATIVES_FILE, JSON.stringify(result, null, 2));

  console.log(`\n📊 当前热点叙事:`);
  for (const n of narratives) {
    console.log(`  🔸 ${n.narrative} (${n.count}次提及)`);
  }

  if (coinGecko.length > 0) {
    console.log(`\n🏆 CoinGecko热搜:`);
    for (const c of coinGecko.slice(0, 5)) {
      console.log(`  ${c.symbol} - ${c.name}`);
    }
  }

  return result;
}

// === CLI模式 ===
if (require.main === module) {
  updateNarratives().then(() => {
    console.log('\n✅ 叙事追踪更新完成');
  }).catch(err => {
    console.error('更新失败:', err.message);
  });
}

module.exports = { updateNarratives, extractNarratives };
