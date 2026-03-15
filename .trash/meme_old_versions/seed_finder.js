#!/usr/bin/env node
/**
 * Seed Finder - 自动发现种子币
 * 
 * 核心逻辑：
 * 1. 扫三条链(Solana/BSC/Base)的热门池子
 * 2. 查每个币的K线，找出"拉过大倍数"的
 * 3. 排除捆绑盘/貔貅盘/死猫跳
 * 4. 自动加入种子库
 * 
 * 什么算好的种子币：
 * - 从低位涨了≥10x
 * - 当前还活着（MC≥$100k, Vol>$5k/天）
 * - 有真实社区（持有者多、流动性足）
 * - 不是捆绑盘（开盘区块没有异常集中买入）
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SEEDS_FILE = path.join(DATA_DIR, 'seed_tokens.json');
const LOG_DIR = path.join(__dirname, 'logs');

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `seed_finder_${ts.slice(0,10)}.log`), line + '\n');
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.status === 429) {
        log('WARN', `429 rate limit, waiting ${5 + i * 5}s...`);
        await sleep((5 + i * 5) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(2000);
    }
  }
}

// === 阶段1：找候选币 ===
async function findCandidates() {
  const candidates = new Map(); // mint → info
  
  // 来源1: DexScreener trending (token-boosts)
  log('INFO', '扫描 DexScreener boosts...');
  try {
    const boosts = await fetchJSON('https://api.dexscreener.com/token-boosts/top/v1');
    for (const b of (boosts || [])) {
      if (!['solana', 'bsc', 'base'].includes(b.chainId)) continue;
      candidates.set(b.tokenAddress, { mint: b.tokenAddress, chain: b.chainId, source: 'boost' });
    }
    log('INFO', `  boosts: ${candidates.size} tokens`);
  } catch (e) { log('WARN', `  boosts失败: ${e.message?.slice(0, 40)}`); }
  
  await sleep(1000);
  
  // 来源2: DexScreener profiles (有项目方的币)
  try {
    const profiles = await fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1');
    for (const p of (profiles || [])) {
      if (!['solana', 'bsc', 'base'].includes(p.chainId)) continue;
      if (!candidates.has(p.tokenAddress)) {
        candidates.set(p.tokenAddress, { mint: p.tokenAddress, chain: p.chainId, source: 'profile' });
      }
    }
    log('INFO', `  profiles后: ${candidates.size} tokens`);
  } catch (e) { log('WARN', `  profiles失败: ${e.message?.slice(0, 40)}`); }
  
  await sleep(1000);
  
  // 来源3: DexScreener搜索常见meme关键词
  const searchTerms = [
    'pump', 'moon', 'pepe', 'doge', 'cat', 'frog', 'ai', 'agent',
    'meme', 'lol', 'based', 'chad', 'wojak', 'ape', 'monkey',
    'dragon', 'shark', 'whale', 'wolf', 'bear', 'bull',
    'baby', 'mega', 'super', 'turbo', 'king', 'god',
    'ninja', 'pirate', 'wizard', 'punk',
    'punch', 'fight', 'war', 'chaos',
    'penguin', 'lobster', 'crab', 'shrimp',
    'sos', 'save', 'help', 'run',
  ];
  
  log('INFO', `搜索 ${searchTerms.length} 个关键词...`);
  let searchFound = 0;
  
  for (const q of searchTerms) {
    try {
      const d = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      for (const p of (d.pairs || [])) {
        const chain = p.chainId;
        if (!['solana', 'bsc', 'base'].includes(chain)) continue;
        const mint = p.baseToken?.address;
        if (!mint || candidates.has(mint)) continue;
        
        const mc = p.marketCap || p.fdv || 0;
        const vol = (p.volume?.h24) || 0;
        const liq = (p.liquidity?.usd) || 0;
        const created = p.pairCreatedAt || 0;
        const ageDays = created ? (Date.now() - created) / 86400000 : 0;
        
        // 基本门槛：MC>$100k, vol>$5k, age>3天, liq>$10k
        if (mc >= 100000 && vol >= 5000 && ageDays >= 3 && liq >= 10000) {
          candidates.set(mint, {
            mint, chain, source: 'search',
            name: p.baseToken?.name,
            symbol: p.baseToken?.symbol,
            mc, vol, liq, ageDays: Math.round(ageDays),
            pool: p.pairAddress,
          });
          searchFound++;
        }
      }
    } catch {}
    await sleep(300); // DexScreener限流
  }
  
  log('INFO', `  搜索新增: ${searchFound}, 总计: ${candidates.size}`);
  return [...candidates.values()];
}

// === 阶段2：查K线验证涨幅 ===
async function checkMultiplier(coin) {
  // 如果没有pool地址，先查
  let pool = coin.pool;
  let chain = coin.chain;
  
  if (!pool) {
    try {
      const d = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${coin.mint}`);
      const p = (d.pairs || []).find(p => p.chainId === chain);
      if (!p) return null;
      pool = p.pairAddress;
      coin.name = coin.name || p.baseToken?.name;
      coin.symbol = coin.symbol || p.baseToken?.symbol;
      coin.mc = coin.mc || p.marketCap || p.fdv;
      coin.liq = coin.liq || (p.liquidity?.usd);
      coin.vol = coin.vol || (p.volume?.h24);
      const created = p.pairCreatedAt;
      coin.ageDays = coin.ageDays || (created ? Math.round((Date.now() - created) / 86400000) : 0);
    } catch { return null; }
    await sleep(1500);
  }
  
  // 查日K线
  const geckoChain = chain === 'solana' ? 'solana' : chain === 'bsc' ? 'bsc' : 'base';
  try {
    const d = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${geckoChain}/pools/${pool}/ohlcv/day?aggregate=1&limit=60`);
    const ohlcv = d?.data?.attributes?.ohlcv_list;
    if (!ohlcv || ohlcv.length < 2) return null;
    
    const candles = ohlcv.slice().reverse(); // 时间正序
    const highs = candles.map(c => c[2]).filter(v => v > 0);
    const lows = candles.map(c => c[3]).filter(v => v > 0);
    const closes = candles.map(c => c[4]).filter(v => v > 0);
    const vols = candles.map(c => c[5]);
    
    if (highs.length < 2 || lows.length < 2) return null;
    
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const multiplier = minLow > 0 ? maxHigh / minLow : 0;
    
    // 当前价vs最低
    const currentClose = closes[closes.length - 1];
    const currentVsLow = minLow > 0 ? currentClose / minLow : 0;
    
    // 平均日成交量
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    
    // 最近3天成交量（判断是否还活着）
    const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, vols.length);
    
    return {
      multiplier: Math.round(multiplier),
      currentVsLow: Math.round(currentVsLow * 10) / 10,
      days: candles.length,
      avgVol: Math.round(avgVol),
      recentVol: Math.round(recentVol),
      maxHigh,
      minLow,
      currentClose,
    };
  } catch {
    return null;
  }
}

// === 阶段3：过滤 ===
function isGoodSeed(coin, kline) {
  if (!kline) return { pass: false, reason: 'no_kline' };
  
  // 必须涨过≥10x
  if (kline.multiplier < 10) return { pass: false, reason: `only_${kline.multiplier}x` };
  
  // 当前价格相对底部至少还有3x（不是已经完全归零的）
  if (kline.currentVsLow < 2) return { pass: false, reason: `current_only_${kline.currentVsLow}x_from_low` };
  
  // 最近3天有成交量（还活着）
  if (kline.recentVol < 5000) return { pass: false, reason: `dead_vol_${kline.recentVol}` };
  
  // MC太小的不要
  if ((coin.mc || 0) < 100000) return { pass: false, reason: `mc_too_small_${coin.mc}` };
  
  // 流动性太低的不要（可能是貔貅）
  if ((coin.liq || 0) < 10000) return { pass: false, reason: `low_liq_${coin.liq}` };
  
  return { pass: true };
}

// === Main ===
async function main() {
  log('INFO', '=== Seed Finder 启动 ===');
  
  // 加载已有种子
  const seeds = loadJSON(SEEDS_FILE, { tokens: [], lastScan: null });
  const existingMints = new Set(seeds.tokens.map(t => t.mint));
  log('INFO', `已有种子: ${seeds.tokens.length}`);
  
  // 1. 找候选
  const candidates = await findCandidates();
  log('INFO', `候选币: ${candidates.length}`);
  
  // 排除已有的
  const newCandidates = candidates.filter(c => !existingMints.has(c.mint));
  log('INFO', `新候选: ${newCandidates.length}`);
  
  // 2. 逐个查K线（GeckoTerminal限流严重，每次最多查20个）
  let checked = 0, added = 0;
  const maxCheck = 30;
  
  // 先按有详情的排前面（减少DexScreener查询）
  newCandidates.sort((a, b) => (b.pool ? 1 : 0) - (a.pool ? 1 : 0));
  
  for (const coin of newCandidates.slice(0, maxCheck)) {
    checked++;
    
    const kline = await checkMultiplier(coin);
    const result = isGoodSeed(coin, kline);
    
    if (result.pass) {
      added++;
      const newSeed = {
        name: coin.name || coin.symbol || '?',
        symbol: coin.symbol || '?',
        chain: coin.chain,
        mint: coin.mint,
        multiplier: kline.multiplier,
        mc: coin.mc,
        liq: coin.liq,
        ageDays: coin.ageDays,
        currentVsLow: kline.currentVsLow,
        avgVol: kline.avgVol,
        source: coin.source,
        addedAt: new Date().toISOString(),
      };
      seeds.tokens.push(newSeed);
      existingMints.add(coin.mint);
      log('INFO', `✅ [${coin.chain.toUpperCase()}] ${coin.name || coin.symbol} ${kline.multiplier}x (MC:$${(coin.mc||0).toLocaleString()}) — 加入种子库`);
    } else {
      if (kline) {
        log('INFO', `❌ [${coin.chain.toUpperCase()}] ${coin.name || coin.symbol || coin.mint.slice(0,12)} — ${result.reason}`);
      }
    }
    
    await sleep(2000); // GeckoTerminal限流
    
    if (checked % 10 === 0) {
      log('INFO', `进度: ${checked}/${Math.min(newCandidates.length, maxCheck)}, 新增: ${added}`);
    }
  }
  
  // 保存
  seeds.lastScan = new Date().toISOString();
  saveJSON(SEEDS_FILE, seeds);
  
  log('INFO', `\n=== 完成 ===`);
  log('INFO', `检查: ${checked} | 新增: ${added} | 总种子: ${seeds.tokens.length}`);
  
  // 打印所有种子
  log('INFO', `\n📋 种子库:`);
  for (const s of seeds.tokens) {
    log('INFO', `  [${s.chain?.toUpperCase()}] ${s.name} (${s.symbol}) ${s.multiplier}x MC:$${(s.mc||0).toLocaleString()} age:${s.ageDays}d`);
  }
}

main().catch(e => { log('FATAL', e.stack || e.message); process.exit(1); });
