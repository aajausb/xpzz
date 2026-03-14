#!/usr/bin/env node
/**
 * Smart Money Scanner v4
 * 
 * 定时扫描器：每5分钟扫1-2个币，积累聪明钱数据
 * 
 * 链路：
 * 1. 筛币：GeckoTerminal trending → 30天内创建 + $1M+ FDV + $100k+ vol
 * 2. 筛钱包：GeckoTerminal trades API → 找盈利者
 * 3. 筛聪明钱：跨币≥2 + 单币均利≥$2k + 胜率≥60% + 非bot
 * 
 * 数据存储：
 * - data/scan_candidates.json — 待扫描的币列表
 * - data/scan_wallet_pool.json — 所有币的盈利钱包池
 * - data/smart_wallets.json — 最终聪明钱库
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_DIR = path.join(__dirname, 'logs');
const CANDIDATES_FILE = path.join(DATA_DIR, 'scan_candidates.json');
const WALLET_POOL_FILE = path.join(DATA_DIR, 'scan_wallet_pool.json');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');

const HELIUS_KEY_1 = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_KEY_2 = process.env.HELIUS_API_KEY_2 || '824cb27b-0794-45ed-aa1c-0798658d8d80';
const HELIUS_PARSE_URL = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY_2}`;

// ============ THRESHOLDS ============
const MIN_FDV = 1_000_000;          // $1M
const MIN_VOL_24H = 100_000;        // $100k
const MAX_AGE_DAYS = 30;
const MIN_PROFIT_PER_COIN = 300;    // 候选门槛（低，宁多勿漏）
const FINAL_MIN_COINS = 2;          // 至少2个币盈利
const FINAL_MIN_AVG_PROFIT = 2000;  // 单币均利≥$2k
const FINAL_MIN_WIN_RATE = 0.6;     // 胜率≥60%
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5分钟
const GECKO_DELAY_MS = 2000;        // GeckoTerminal请求间隔

// ============ Logger ============
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `scanner_${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

// ============ File helpers ============
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============ Fetch with retry ============
async function geckoFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429) {
      log('WARN', `429 限流，等待${5 * (i + 1)}秒...`);
      await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      continue;
    }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('Max retries exceeded');
}

// ============ Step 1: Discover coins ============
async function discoverCoins() {
  log('INFO', '发现新币...');
  const thirtyDaysAgo = Date.now() - MAX_AGE_DAYS * 86400000;
  const candidates = loadJSON(CANDIDATES_FILE, { coins: [], scanned: [] });
  const scannedSet = new Set(candidates.scanned || []);

  // GeckoTerminal trending pools
  for (let page = 1; page <= 5; page++) {
    try {
      const d = await geckoFetch(`https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`);
      for (const p of (d.data || [])) {
        const a = p.attributes;
        const fdv = parseFloat(a.fdv_usd || 0);
        const vol = parseFloat(a.volume_usd?.h24 || 0);
        const created = new Date(a.pool_created_at).getTime();
        const pool = a.address;

        if (fdv >= MIN_FDV && vol >= MIN_VOL_24H && created > thirtyDaysAgo && !scannedSet.has(pool)) {
          const existing = candidates.coins.find(c => c.pool === pool);
          if (!existing) {
            candidates.coins.push({
              symbol: a.name?.split(' / ')[0] || '?',
              pool,
              fdv,
              vol,
              ageD: Math.round((Date.now() - created) / 86400000),
              addedAt: new Date().toISOString(),
            });
          }
        }
      }
    } catch (e) {
      log('WARN', `Trending page ${page}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, GECKO_DELAY_MS));
  }

  // DexScreener supplement
  const queries = ['pump solana', 'meme solana', 'ai solana', 'war solana', 'dog solana', 'agent solana'];
  for (const q of queries) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      for (const p of (d.pairs || [])) {
        if (p.chainId !== 'solana') continue;
        if ((p.fdv || 0) < MIN_FDV) continue;
        if ((p.volume?.h24 || 0) < MIN_VOL_24H) continue;
        if (!p.pairCreatedAt || p.pairCreatedAt < thirtyDaysAgo) continue;
        if (scannedSet.has(p.pairAddress)) continue;

        const existing = candidates.coins.find(c => c.pool === p.pairAddress);
        if (!existing) {
          candidates.coins.push({
            symbol: p.baseToken?.symbol || '?',
            pool: p.pairAddress,
            fdv: p.fdv,
            vol: p.volume?.h24 || 0,
            ageD: Math.round((Date.now() - p.pairCreatedAt) / 86400000),
            addedAt: new Date().toISOString(),
          });
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  saveJSON(CANDIDATES_FILE, candidates);
  const pending = candidates.coins.filter(c => !scannedSet.has(c.pool));
  log('INFO', `待扫描: ${pending.length}, 已扫描: ${scannedSet.size}`);
  return candidates;
}

// ============ Step 2: Scan one coin ============
async function scanCoin(coin) {
  log('INFO', `扫描 ${coin.symbol} ($${(coin.fdv / 1e6).toFixed(1)}M, ${coin.ageD}d) pool:${coin.pool.slice(0, 16)}`);

  let trades = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const d = await geckoFetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${coin.pool}/trades?trade_volume_in_usd_greater_than=50&page=${page}`
      );
      const t = d.data || [];
      trades.push(...t);
      if (t.length < 200) break;
    } catch (e) {
      log('WARN', `Trades page ${page}: ${e.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, GECKO_DELAY_MS));
  }

  log('INFO', `  ${coin.symbol}: ${trades.length} trades`);

  // Aggregate by maker
  const makers = new Map();
  for (const t of trades) {
    const a = t.attributes;
    const maker = a.tx_from_address;
    if (!maker) continue;
    if (!makers.has(maker)) makers.set(maker, { buys: 0, sells: 0, buyVol: 0, sellVol: 0 });
    const rec = makers.get(maker);
    const vol = parseFloat(a.volume_in_usd || 0);
    if (a.kind === 'buy') { rec.buys++; rec.buyVol += vol; }
    else { rec.sells++; rec.sellVol += vol; }
  }

  // Find profitable wallets
  const winners = [];
  for (const [addr, data] of makers) {
    const profit = data.sellVol - data.buyVol;
    if (profit >= MIN_PROFIT_PER_COIN) {
      winners.push({ address: addr, profit, buys: data.buys, sells: data.sells });
    }
  }

  log('INFO', `  ${coin.symbol}: ${winners.length} winners (profit>$${MIN_PROFIT_PER_COIN})`);
  return winners;
}

// ============ Step 3: Bot detection ============
async function isBot(address) {
  try {
    const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY_1}`, 'confirmed');
    const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: 20 });

    if (sigs.length < 5) return { isBot: false, reason: 'too_few_sigs' };

    // Check trading frequency
    const times = sigs.map(s => s.blockTime).filter(Boolean).sort();
    let shortIntervals = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= 2) shortIntervals++;
    }

    if (shortIntervals > times.length * 0.7) {
      return { isBot: true, reason: `high_frequency: ${shortIntervals}/${times.length - 1}` };
    }

    // Check arb patterns via Helius
    const r = await fetch(HELIUS_PARSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs.slice(0, 10).map(s => s.signature) }),
    });
    const parsed = await r.json();
    if (!Array.isArray(parsed)) return { isBot: false, reason: 'parse_failed' };

    let swaps = 0, arbPatterns = 0;
    for (const tx of parsed) {
      if (tx.type !== 'SWAP') continue;
      swaps++;

      const mints = new Map();
      for (const tt of (tx.tokenTransfers || [])) {
        if (!tt.mint || tt.mint === 'So11111111111111111111111111111111111111112') continue;
        if (!mints.has(tt.mint)) mints.set(tt.mint, { in: 0, out: 0 });
        const m = mints.get(tt.mint);
        if (tt.toUserAccount === address) m.in += (tt.tokenAmount || 0);
        if (tt.fromUserAccount === address) m.out += (tt.tokenAmount || 0);
      }

      for (const [, flow] of mints) {
        if (flow.in > 0 && flow.out > 0) { arbPatterns++; break; }
      }
    }

    if (swaps > 0 && arbPatterns / swaps > 0.5) {
      return { isBot: true, reason: `arb_pattern: ${arbPatterns}/${swaps}` };
    }

    return { isBot: false, reason: 'human' };
  } catch (e) {
    return { isBot: false, reason: `error: ${e.message}` };
  }
}

// ============ Step 4: Evaluate & promote ============
async function evaluateWalletPool() {
  const pool = loadJSON(WALLET_POOL_FILE, { wallets: {} });
  const smartWallets = loadJSON(WALLETS_FILE, { wallets: [], lastScan: null });

  const existingAddrs = new Set(smartWallets.wallets.map(w => w.address));
  let promoted = 0;

  for (const [addr, data] of Object.entries(pool.wallets)) {
    if (existingAddrs.has(addr)) continue;

    const coins = Object.keys(data.coins);
    const profits = Object.values(data.coins).map(c => c.profit);
    const winningCoins = profits.filter(p => p > 0).length;
    const totalCoins = coins.length;
    const winRate = totalCoins > 0 ? winningCoins / totalCoins : 0;
    const avgProfit = profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

    // Check thresholds
    if (coins.length < FINAL_MIN_COINS) continue;
    if (avgProfit < FINAL_MIN_AVG_PROFIT) continue;
    if (winRate < FINAL_MIN_WIN_RATE) continue;

    // Bot check
    log('INFO', `评估 ${addr.slice(0, 16)}... coins:${totalCoins} winRate:${(winRate * 100).toFixed(0)}% avgProfit:$${avgProfit.toFixed(0)}`);
    const botCheck = await isBot(addr);
    await new Promise(r => setTimeout(r, 500));

    if (botCheck.isBot) {
      log('INFO', `  ❌ Bot: ${botCheck.reason}`);
      pool.wallets[addr].isBot = true;
      continue;
    }

    // Promote!
    log('INFO', `  ✅ 聪明钱入库! ${coins.join(',')} winRate:${(winRate * 100).toFixed(0)}% avgProfit:$${avgProfit.toFixed(0)}`);
    smartWallets.wallets.push({
      address: addr,
      chain: 'solana',
      label: `sm_v4_${coins.length}coins`,
      totalProfit: profits.reduce((a, b) => a + b, 0),
      avgProfit: Math.round(avgProfit),
      winRate: Math.round(winRate * 100),
      coins,
      coinsDetail: data.coins,
      source: 'scanner_v4',
      addedAt: new Date().toISOString(),
    });
    promoted++;
    existingAddrs.add(addr);
  }

  if (promoted > 0) {
    smartWallets.lastScan = new Date().toISOString();
    smartWallets.stats = {
      totalWallets: smartWallets.wallets.length,
      crossCoinWallets: smartWallets.wallets.filter(w => w.coins?.length >= 2).length,
    };
    saveJSON(WALLETS_FILE, smartWallets);
    log('INFO', `🎉 新增 ${promoted} 个聪明钱！总计: ${smartWallets.wallets.length}`);
  }

  saveJSON(WALLET_POOL_FILE, pool);
  return promoted;
}

// ============ Main loop ============
async function main() {
  log('INFO', '=== Smart Money Scanner v4 启动 ===');
  log('INFO', `标准: ≥${FINAL_MIN_COINS}币 + 均利≥$${FINAL_MIN_AVG_PROFIT} + 胜率≥${FINAL_MIN_WIN_RATE * 100}% + 非bot`);

  while (true) {
    try {
      // Step 1: Discover
      const candidates = await discoverCoins();
      const scannedSet = new Set(candidates.scanned || []);
      const pending = candidates.coins.filter(c => !scannedSet.has(c.pool));

      if (pending.length === 0) {
        log('INFO', '无待扫描币，等待下一轮发现...');
        await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
        continue;
      }

      // Step 2: Scan 1-2 coins
      const toScan = pending.slice(0, 2);
      const pool = loadJSON(WALLET_POOL_FILE, { wallets: {} });

      for (const coin of toScan) {
        const winners = await scanCoin(coin);

        for (const w of winners) {
          if (!pool.wallets[w.address]) {
            pool.wallets[w.address] = { coins: {}, firstSeen: new Date().toISOString() };
          }
          pool.wallets[w.address].coins[coin.symbol] = {
            profit: w.profit,
            buys: w.buys,
            sells: w.sells,
            pool: coin.pool,
          };
        }

        // Mark as scanned
        if (!candidates.scanned) candidates.scanned = [];
        candidates.scanned.push(coin.pool);
        scannedSet.add(coin.pool);

        saveJSON(CANDIDATES_FILE, candidates);
        saveJSON(WALLET_POOL_FILE, pool);

        await new Promise(r => setTimeout(r, 3000));
      }

      // Step 3: Evaluate
      const walletCount = Object.keys(pool.wallets).length;
      const multiCoin = Object.values(pool.wallets).filter(w => Object.keys(w.coins).length >= 2).length;
      log('INFO', `钱包池: ${walletCount} 个, 跨币: ${multiCoin} 个`);

      if (multiCoin > 0) {
        await evaluateWalletPool();
      }

    } catch (e) {
      log('ERROR', `Main loop: ${e.message}`);
    }

    log('INFO', `等待 ${SCAN_INTERVAL_MS / 1000}秒...`);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

// Graceful shutdown
process.on('SIGINT', () => { log('INFO', '收到SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', '收到SIGTERM'); process.exit(0); });

main().catch(e => { log('FATAL', e.message); process.exit(1); });
