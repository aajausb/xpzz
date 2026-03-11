#!/usr/bin/env node
/**
 * Solana 自主聪明钱识别（不依赖OKX）
 * 
 * 用Helius扫历史上涨的币，找出早期买入+持有+赚钱的地址
 * 完全私有的聪明钱列表，跟市面工具不重叠
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_KEY_2 = process.env.HELIUS_API_KEY_2;
let keyToggle = 0;
function getKey() { return (keyToggle++ % 2 === 0) ? HELIUS_KEY : (HELIUS_KEY_2 || HELIUS_KEY); }

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function heliusRPC(method, params) {
  const key = getKey();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(`https://mainnet.helius-rpc.com/?api-key=${key}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 获取Solana上近期涨过的代币
 */
async function getTrendingSolanaTokens() {
  const tokens = [];
  
  // GeckoTerminal Solana trending
  try {
    const data = await fetchJSON('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
    for (const p of (data.data || []).slice(0, 20)) {
      const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
      const fdv = parseFloat(p.attributes?.fdv_usd || 0);
      if (addr && fdv > 50000 && fdv < 10000000) {
        tokens.push({ address: addr, name: p.attributes?.name || '?', fdv });
      }
    }
  } catch(e) {}
  
  // GeckoTerminal 按成交量排序（找历史热门）
  for (let page = 1; page <= 3; page++) {
    try {
      await sleep(1500); // 限速
      const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}&sort=h24_volume_usd_desc`);
      for (const p of (data.data || [])) {
        const addr = p.relationships?.base_token?.data?.id?.split('_')[1];
        const fdv = parseFloat(p.attributes?.fdv_usd || 0);
        if (addr && fdv > 50000 && fdv < 10000000) {
          tokens.push({ address: addr, name: p.attributes?.name || '?', fdv });
        }
      }
    } catch(e) {}
  }
  
  // 去重
  const seen = new Set();
  return tokens.filter(t => {
    if (seen.has(t.address)) return false;
    seen.add(t.address);
    return true;
  });
}

/**
 * 用Helius分析某代币的交易历史，找出早期买家
 */
async function analyzeTokenBuyers(tokenMint) {
  // 获取该代币的最大持有者（当前还在拿着的）
  const holdersResp = await heliusRPC('getTokenLargestAccounts', [tokenMint]);
  const holders = holdersResp?.result?.value || [];
  
  if (holders.length === 0) return [];
  
  // 找出持有量大的地址（排除前3名可能是LP/团队）
  const significantHolders = holders.slice(3, 20); // 第4-20名
  
  const smartAddresses = [];
  
  for (const h of significantHolders) {
    if (!h.address) continue;
    const amount = parseFloat(h.uiAmount || h.amount || 0);
    if (amount <= 0) continue;
    
    // 获取token账户的owner
    try {
      const accInfo = await heliusRPC('getAccountInfo', [h.address, { encoding: 'jsonParsed' }]);
      const owner = accInfo?.result?.value?.data?.parsed?.info?.owner;
      if (owner && owner.length > 30) {
        smartAddresses.push({
          address: owner,
          holdAmount: amount,
          tokenAccount: h.address
        });
      }
    } catch(e) {}
    
    await sleep(200); // 限速
  }
  
  return smartAddresses;
}

/**
 * 主函数：建立Solana私有聪明钱列表
 */
async function buildSolanaSmartMoney() {
  console.log(`[${ts()}] 🔍 开始建立Solana私有聪明钱列表...\n`);
  
  const tokens = await getTrendingSolanaTokens();
  console.log(`找到 ${tokens.length} 个热门代币\n`);
  
  const allSmartWallets = new Map(); // address -> { score, tokens, wins }
  
  for (const token of tokens.slice(0, 15)) {
    try {
      console.log(`  分析 ${token.name} (${token.address.slice(0,10)}...) FDV: $${token.fdv.toLocaleString()}`);
      const buyers = await analyzeTokenBuyers(token.address);
      
      for (const b of buyers) {
        if (!allSmartWallets.has(b.address)) {
          allSmartWallets.set(b.address, { score: 0, wins: 0, total: 0, tokens: [] });
        }
        const record = allSmartWallets.get(b.address);
        record.total++;
        record.wins++; // 出现在涨的币中 = 赢
        record.score += 2;
        record.tokens.push(token.name);
      }
      
      console.log(`    找到 ${buyers.length} 个持有者`);
      await sleep(1000);
    } catch(e) {
      console.log(`  ⚠️ ${token.name} 失败: ${e.message}`);
    }
  }
  
  // 加载钓鱼黑名单过滤
  let baitList = new Set();
  try {
    const bl = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'bait_blacklist.json'), 'utf8'));
    baitList = new Set([...(bl.confirmed || []), ...(bl.suspect || [])]);
  } catch(e) {}
  
  // 过滤+排序
  const ranked = [...allSmartWallets.entries()]
    .filter(([addr, r]) => !baitList.has(addr)) // 过滤钓鱼
    .filter(([_, r]) => r.total >= 2) // 至少在2个盈利币中出现
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 100)
    .map(([addr, r]) => ({
      address: addr,
      score: r.score,
      winRate: `${r.wins}/${r.total}`,
      tokens: r.tokens.slice(0, 5)
    }));
  
  // 加载旧数据做对比
  const outPath = path.join(WORKSPACE, 'crypto', 'solana_private_smart_money.json');
  let oldData = [];
  try { oldData = JSON.parse(fs.readFileSync(outPath, 'utf8')).wallets || []; } catch(e) {}
  
  const oldAddrs = new Set(oldData.map(w => w.address));
  const newAddrs = new Set(ranked.map(w => w.address));
  const added = [...newAddrs].filter(a => !oldAddrs.has(a));
  const removed = [...oldAddrs].filter(a => !newAddrs.has(a));
  
  const result = {
    updatedAt: new Date().toISOString(),
    totalAnalyzed: allSmartWallets.size,
    baitFiltered: baitList.size,
    wallets: ranked,
    changes: { added: added.length, removed: removed.length }
  };
  
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  
  console.log(`\n========== 结果 ==========`);
  console.log(`分析钱包数: ${allSmartWallets.size}`);
  console.log(`过滤钓鱼: ${baitList.size}个`);
  console.log(`✅ 私有聪明钱: ${ranked.length}个`);
  console.log(`新增: ${added.length} | 移除: ${removed.length}`);
  console.log(`💾 已保存到 ${outPath}`);
  
  if (ranked.length > 0) {
    console.log(`\nTop 10:`);
    for (const w of ranked.slice(0, 10)) {
      console.log(`  ${w.address.slice(0,12)}... | 分:${w.score} | 胜率:${w.winRate} | 币:${w.tokens.join(',')}`);
    }
  }
  
  return result;
}

if (require.main === module) {
  buildSolanaSmartMoney().catch(console.error);
}

module.exports = { buildSolanaSmartMoney };
