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
const MIN_FDV = 500_000;             // $500k（降低以覆盖更多币）
const MIN_VOL_24H = 50_000;         // $50k
const MAX_AGE_DAYS = 90; // 90天，30天内币太少
const MIN_PROFIT_PER_COIN = 500;    // 单币盈利≥$500（降低以覆盖小市值币）
const FINAL_MIN_COINS = 3;          // 至少3个币盈利（降低门槛，先积累）
const FINAL_MIN_AVG_PROFIT = 2000;  // 单币均利≥$2k
const FINAL_MIN_WIN_RATE = 0.6;     // 胜率≥60%
const SCAN_INTERVAL_MS = 60 * 1000; // 1分钟（Helius不限流，加快扫描）
const GECKO_DELAY_MS = 2000;        // GeckoTerminal请求间隔
const HELIUS_DELAY_MS = 200;        // Helius请求间隔（10万/天额度充裕）

// SOL价格缓存（每10分钟更新一次）
let cachedSolPrice = 88;
let solPriceUpdatedAt = 0;
async function getSolPrice() {
  if (Date.now() - solPriceUpdatedAt < 10 * 60 * 1000) return cachedSolPrice;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d.solana?.usd) {
      cachedSolPrice = d.solana.usd;
      solPriceUpdatedAt = Date.now();
      log('INFO', `SOL价格更新: $${cachedSolPrice}`);
    }
  } catch {}
  return cachedSolPrice;
}

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

  // 用mint地址去重
  const seenMints = new Set(candidates.coins.map(c => c.mint).filter(Boolean));

  function addCoin(symbol, mint, pool, fdv, vol, ageD) {
    if (!mint || seenMints.has(mint)) return;
    if (scannedSet.has(mint)) return;
    seenMints.add(mint);
    candidates.coins.push({ symbol, mint, pool, fdv, vol, ageD, addedAt: new Date().toISOString() });
  }

  // === 数据源1: DexScreener搜索 ===
  // 80+叙事关键词全覆盖（DexScreener不限流）
  const queries = [
    'trump', 'elon', 'doge', 'shib', 'pepe', 'wojak', 'chad', 'based',
    'ape', 'monkey', 'cat', 'dog', 'frog', 'bird', 'fish', 'bear', 'bull',
    'moon', 'rocket', 'diamond', 'gem', 'gold', 'silver',
    'ai', 'gpt', 'agent', 'bot', 'neural', 'quantum', 'cyber',
    'war', 'fight', 'punch', 'kill', 'dead', 'doom', 'chaos',
    'baby', 'mini', 'mega', 'super', 'ultra', 'hyper', 'turbo',
    'cash', 'money', 'rich', 'king', 'queen', 'lord', 'god',
    'meme', 'joke', 'lol', 'kek', 'cope', 'seethe',
    'sol', 'eth', 'btc', 'bnb', 'avax',
    'punk', 'pixel', 'nft', 'art', 'game',
    'china', 'japan', 'korea',
    'whale', 'shark', 'dragon', 'phoenix', 'wolf', 'lion', 'tiger',
    'ninja', 'samurai', 'pirate', 'wizard', 'knight',
    'pump solana', 'meme solana', 'ai solana', 'degen solana',
    'smith', 'sos', 'drone', 'shape', 'lobster', 'runner', 'afk', 'birb',
  ];
  for (const q of queries) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      for (const p of (d.pairs || [])) {
        if (p.chainId !== 'solana') continue;
        if ((p.fdv || 0) < MIN_FDV) continue;
        if ((p.volume?.h24 || 0) < MIN_VOL_24H) continue;
        if (!p.pairCreatedAt || p.pairCreatedAt < thirtyDaysAgo) continue;
        addCoin(p.baseToken?.symbol, p.baseToken?.address, p.pairAddress, p.fdv, p.volume?.h24, Math.round((Date.now() - p.pairCreatedAt) / 86400000));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  // === 数据源2: DexScreener token-boosts（热门推广） ===
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await r.json();
    for (const b of (boosts || [])) {
      if (b.chainId !== 'solana') continue;
      const addr = b.tokenAddress;
      if (!addr) continue;
      // 查详情
      try {
        const r2 = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
        const d2 = await r2.json();
        const p = (d2.pairs || []).find(p => p.chainId === 'solana' && (p.fdv || 0) >= MIN_FDV);
        if (p && p.pairCreatedAt && p.pairCreatedAt > thirtyDaysAgo && (p.volume?.h24 || 0) >= MIN_VOL_24H) {
          addCoin(p.baseToken?.symbol, addr, p.pairAddress, p.fdv, p.volume?.h24, Math.round((Date.now() - p.pairCreatedAt) / 86400000));
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}

  // === 数据源3: DexScreener token-profiles（最新） ===
  try {
    const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = await r.json();
    for (const p of (profiles || []).slice(0, 30)) {
      if (p.chainId !== 'solana') continue;
      const addr = p.tokenAddress;
      if (!addr || seenMints.has(addr)) continue;
      try {
        const r2 = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
        const d2 = await r2.json();
        const pair = (d2.pairs || []).find(p => p.chainId === 'solana' && (p.fdv || 0) >= MIN_FDV);
        if (pair && pair.pairCreatedAt && pair.pairCreatedAt > thirtyDaysAgo && (pair.volume?.h24 || 0) >= MIN_VOL_24H) {
          addCoin(pair.baseToken?.symbol, addr, pair.pairAddress, pair.fdv, pair.volume?.h24, Math.round((Date.now() - pair.pairCreatedAt) / 86400000));
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}

  // === 数据源4: 预存数据（CoinGecko + DexScreener批量） ===
  for (const file of ['coingecko_pumpfun.json', 'dexscreener_coins.json']) {
    try {
      const f = path.join(DATA_DIR, file);
      const coins = loadJSON(f, []);
      for (const c of coins) {
        const mint = c.mint || c.address;
        const mc = c.mc || c.fdv || c.market_cap || 0;
        if (mint && mc >= MIN_FDV) {
          addCoin(c.symbol, mint, c.pool || '', mc, c.vol || 0, c.ageD || 0);
        }
      }
    } catch {}
  }

  saveJSON(CANDIDATES_FILE, candidates);
  // 按mint去重scanned
  const pending = candidates.coins.filter(c => c.mint && !scannedSet.has(c.mint));
  log('INFO', `待扫描: ${pending.length}, 已扫描: ${scannedSet.size}, 总: ${candidates.coins.length}`);
  return candidates;
}

// ============ Step 2: Scan one coin (Helius版，无限流) ============
async function scanCoin(coin) {
  log('INFO', `扫描 ${coin.symbol} ($${(coin.fdv / 1e6).toFixed(1)}M, ${coin.ageD}d) mint:${(coin.mint || coin.pool).slice(0, 16)}`);

  const mint = coin.mint;
  if (!mint) {
    log('WARN', `  ${coin.symbol}: 没有mint地址，跳过`);
    return { winners: [], associations: {} };
  }
  const solPrice = await getSolPrice();
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  // 用Helius Address Transactions API拿SWAP交易
  let allTxs = [];
  let beforeSig;
  
  for (let batch = 0; batch < 10; batch++) { // 最多1000条
    let url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_KEY_2}&limit=100`;
    if (beforeSig) url += `&before=${beforeSig}`;
    
    try {
      const r = await fetch(url);
      if (!r.ok) { log('WARN', `Helius ${r.status}`); break; }
      const txs = await r.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      
      allTxs.push(...txs);
      beforeSig = txs[txs.length - 1].signature;
      
      if (txs.length < 100) break;
    } catch (e) {
      log('WARN', `Helius error: ${e.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, HELIUS_DELAY_MS));
  }

  log('INFO', `  ${coin.symbol}: ${allTxs.length} swaps via Helius`);

  // 按地址聚合所有涉及该token的活动
  const makers = new Map();
  let swapCount = 0;
  
  for (const tx of allTxs) {
    const transfers = tx.tokenTransfers || [];
    const hasTargetToken = transfers.some(tt => tt.mint === mint);
    if (!hasTargetToken) continue;
    
    swapCount++;
    
    // 找所有跟目标token有交互的地址（不只是feePayer）
    const involvedAddrs = new Set();
    for (const tt of transfers) {
      if (tt.mint === mint) {
        if (tt.toUserAccount) involvedAddrs.add(tt.toUserAccount);
        if (tt.fromUserAccount) involvedAddrs.add(tt.fromUserAccount);
      }
    }
    
    for (const addr of involvedAddrs) {
      let solSpent = 0, solReceived = 0;
      let tokenReceived = 0, tokenSent = 0;
      
      for (const tt of transfers) {
        if (tt.mint === SOL_MINT) {
          if (tt.fromUserAccount === addr) solSpent += (tt.tokenAmount || 0);
          if (tt.toUserAccount === addr) solReceived += (tt.tokenAmount || 0);
        } else if (tt.mint === mint) {
          if (tt.toUserAccount === addr) tokenReceived += (tt.tokenAmount || 0);
          if (tt.fromUserAccount === addr) tokenSent += (tt.tokenAmount || 0);
        }
      }
      
      for (const nt of (tx.nativeTransfers || [])) {
        if (nt.fromUserAccount === addr) solSpent += (nt.amount || 0) / 1e9;
        if (nt.toUserAccount === addr) solReceived += (nt.amount || 0) / 1e9;
      }
      
      const isSwap = tx.type === 'SWAP' || tx.source === 'PUMP_AMM' || tx.source === 'JUPITER' || tx.source === 'RAYDIUM';
      const isTransferIn = tokenReceived > 0 && tokenSent === 0 && !isSwap;
      const isSell = tokenSent > tokenReceived && (solReceived > 0 || isSwap);
      const isBuy = tokenReceived > tokenSent && (solSpent > 0 || isSwap);
      
      const solNet = solSpent - solReceived;
      const solUsd = solNet * solPrice;
      
      if (!makers.has(addr)) makers.set(addr, { buys: 0, sells: 0, buyVol: 0, sellVol: 0, transfersIn: 0 });
      const rec = makers.get(addr);
      
      if (isTransferIn) {
        rec.transfersIn++;
      } else if (isBuy) {
        rec.buys++;
        rec.buyVol += Math.abs(solUsd);
      } else if (isSell) {
        rec.sells++;
        rec.sellVol += Math.abs(solUsd);
      }
    }
  }
  
  log('INFO', `  ${coin.symbol}: ${swapCount} 涉及该token的交易 (共${allTxs.length}条)`);


  // 找盈利钱包
  const winners = [];
  for (const [addr, data] of makers) {
    // 跳过pool/program地址（它们不是真人）
    if (data.buys === 0 && data.sells === 0 && data.transfersIn === 0) continue;
    
    const profit = data.sellVol - data.buyVol;
    
    // 转入+卖出模式：有转入记录、有卖出、没有买入 → 分仓大号
    const isTransferSell = data.transfersIn > 0 && data.sells > 0 && data.buys === 0;
    
    if (profit >= MIN_PROFIT_PER_COIN || (isTransferSell && data.sellVol >= MIN_PROFIT_PER_COIN)) {
      winners.push({
        address: addr,
        profit: isTransferSell ? data.sellVol : profit, // 转入卖出的利润按卖出额算
        buys: data.buys,
        sells: data.sells,
        transfersIn: data.transfersIn,
        pattern: isTransferSell ? 'transfer_sell' : 'normal',
      });
    }
  }

  // === 关联分析：找分仓链（A买入→transfer给B→B卖出）===
  const links = []; // { from, to, amount, txSig }
  for (const tx of allTxs) {
    const transfers = tx.tokenTransfers || [];
    const isSwap = tx.type === 'SWAP' || tx.source === 'PUMP_AMM' || tx.source === 'JUPITER' || tx.source === 'RAYDIUM';
    if (isSwap) continue; // 只看TRANSFER类型
    
    for (const tt of transfers) {
      if (tt.mint !== mint) continue;
      if (!tt.fromUserAccount || !tt.toUserAccount) continue;
      if (tt.fromUserAccount === tt.toUserAccount) continue;
      if ((tt.tokenAmount || 0) <= 0) continue;
      
      links.push({
        from: tt.fromUserAccount,
        to: tt.toUserAccount,
        amount: tt.tokenAmount,
        feePayer: tx.feePayer, // 发起人
        time: tx.timestamp,
      });
    }
  }
  
  // 构建关联图：如果A transfer给B，且B之后卖出了，A和B可能是同一实体
  const associations = new Map(); // addr → Set of related addrs
  for (const link of links) {
    const receiver = link.to;
    const sender = link.from;
    const payer = link.feePayer;
    
    // 如果接收者有卖出记录，关联发送者/付费者
    const receiverData = makers.get(receiver);
    if (receiverData && receiverData.sells > 0) {
      // 关联 feePayer ↔ receiver
      if (payer && payer !== receiver) {
        if (!associations.has(payer)) associations.set(payer, new Set());
        if (!associations.has(receiver)) associations.set(receiver, new Set());
        associations.get(payer).add(receiver);
        associations.get(receiver).add(payer);
      }
      // 也关联 sender ↔ receiver（token account层面）
      if (sender && sender !== receiver) {
        if (!associations.has(sender)) associations.set(sender, new Set());
        if (!associations.has(receiver)) associations.set(receiver, new Set());
        associations.get(sender).add(receiver);
        associations.get(receiver).add(sender);
      }
    }
  }

  const transferSellCount = winners.filter(w => w.pattern === 'transfer_sell').length;
  const linkCount = associations.size > 0 ? [...associations.values()].reduce((a, s) => a + s.size, 0) / 2 : 0;
  log('INFO', `  ${coin.symbol}: ${makers.size} 地址, ${winners.length} 盈利>$${MIN_PROFIT_PER_COIN} (${transferSellCount}转入卖出, ${Math.round(linkCount)}关联对)`);
  
  return { winners, associations: Object.fromEntries([...associations].map(([k, v]) => [k, [...v]])) };
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

// ============ Step 4: Evaluate & promote (含关联合并) ============
async function evaluateWalletPool() {
  const pool = loadJSON(WALLET_POOL_FILE, { wallets: {}, associations: {} });
  const smartWallets = loadJSON(WALLETS_FILE, { wallets: [], lastScan: null });

  const existingAddrs = new Set(smartWallets.wallets.map(w => w.address));
  const existingEntities = new Set(smartWallets.wallets.map(w => w.entityId).filter(Boolean));
  let promoted = 0;

  // === 构建关联实体（Union-Find）===
  const parent = {};
  function find(x) { return parent[x] ? (parent[x] = find(parent[x])) : x; }
  function union(a, b) { parent[find(a)] = find(b); }
  
  for (const [addr, related] of Object.entries(pool.associations || {})) {
    for (const r of related) {
      union(addr, r);
    }
  }
  
  // 按实体分组
  const entities = new Map(); // rootAddr → [addr1, addr2, ...]
  for (const addr of Object.keys(pool.wallets)) {
    const root = find(addr);
    if (!entities.has(root)) entities.set(root, []);
    entities.get(root).push(addr);
  }
  
  log('INFO', `实体分析: ${entities.size} 个实体 (${Object.keys(pool.wallets).length} 个地址)`);
  const multiAddrEntities = [...entities.values()].filter(e => e.length > 1);
  if (multiAddrEntities.length > 0) {
    log('INFO', `  多地址实体: ${multiAddrEntities.length} 个 (最大: ${Math.max(...multiAddrEntities.map(e => e.length))}地址)`);
  }

  // === 评估每个实体 ===
  for (const [root, addrs] of entities) {
    // 如果实体已被评估过，跳过
    const entityId = addrs.sort().join('+').slice(0, 80);
    if (existingEntities.has(entityId)) continue;
    if (addrs.some(a => existingAddrs.has(a))) continue;

    // 合并所有地址的币种数据
    const mergedCoins = {};
    for (const addr of addrs) {
      const data = pool.wallets[addr];
      if (!data?.coins) continue;
      for (const [symbol, coinData] of Object.entries(data.coins)) {
        if (!mergedCoins[symbol]) {
          mergedCoins[symbol] = { profit: 0, buys: 0, sells: 0, transfersIn: 0 };
        }
        mergedCoins[symbol].profit += coinData.profit;
        mergedCoins[symbol].buys += coinData.buys || 0;
        mergedCoins[symbol].sells += coinData.sells || 0;
        mergedCoins[symbol].transfersIn += coinData.transfersIn || 0;
      }
    }

    const coins = Object.keys(mergedCoins);
    const profits = Object.values(mergedCoins).map(c => c.profit);
    const winningCoins = profits.filter(p => p > 0).length;
    const totalCoins = coins.length;
    const winRate = totalCoins > 0 ? winningCoins / totalCoins : 0;
    const avgProfit = profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

    // Check thresholds
    if (coins.length < FINAL_MIN_COINS) continue;
    if (avgProfit < FINAL_MIN_AVG_PROFIT) continue;
    if (winRate < FINAL_MIN_WIN_RATE) continue;

    // Bot check (查主地址)
    const mainAddr = addrs[0]; // 用第一个地址做bot检查
    log('INFO', `评估实体 ${mainAddr.slice(0, 16)}... (${addrs.length}地址) coins:${totalCoins} winRate:${(winRate * 100).toFixed(0)}% avgProfit:$${avgProfit.toFixed(0)}`);
    const botCheck = await isBot(mainAddr);
    await new Promise(r => setTimeout(r, 500));

    if (botCheck.isBot) {
      log('INFO', `  ❌ Bot: ${botCheck.reason}`);
      pool.wallets[mainAddr].isBot = true;
      continue;
    }

    // Promote!
    const totalProfit = profits.reduce((a, b) => a + b, 0);
    log('INFO', `  ✅ 聪明钱入库! ${addrs.length}地址, ${coins.join(',')} winRate:${(winRate * 100).toFixed(0)}% avgProfit:$${avgProfit.toFixed(0)} total:$${totalProfit.toFixed(0)}`);
    smartWallets.wallets.push({
      address: mainAddr,
      relatedAddresses: addrs.length > 1 ? addrs : undefined,
      entityId,
      chain: 'solana',
      label: addrs.length > 1 
        ? `sm_v4_entity_${addrs.length}addr_${coins.length}coins` 
        : `sm_v4_${coins.length}coins`,
      totalProfit: Math.round(totalProfit),
      avgProfit: Math.round(avgProfit),
      winRate: Math.round(winRate * 100),
      coins,
      coinsDetail: mergedCoins,
      source: 'scanner_v4',
      addedAt: new Date().toISOString(),
    });
    promoted++;
    for (const a of addrs) existingAddrs.add(a);
    existingEntities.add(entityId);
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
      const pending = candidates.coins.filter(c => c.mint && !scannedSet.has(c.mint));

      if (pending.length === 0) {
        log('INFO', '无待扫描币，等待下一轮发现...');
        await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
        continue;
      }

      // Step 2: Scan 3-5 coins per round (Helius无限流)
      const toScan = pending.slice(0, 5);
      const pool = loadJSON(WALLET_POOL_FILE, { wallets: {} });

      // 关联表：addr → Set of related addrs
      if (!pool.associations) pool.associations = {};
      
      for (const coin of toScan) {
        const result = await scanCoin(coin);
        const winners = result.winners || result; // 兼容
        const assoc = result.associations || {};

        for (const w of (Array.isArray(winners) ? winners : [])) {
          if (!pool.wallets[w.address]) {
            pool.wallets[w.address] = { coins: {}, firstSeen: new Date().toISOString() };
          }
          pool.wallets[w.address].coins[coin.symbol] = {
            profit: w.profit,
            buys: w.buys,
            sells: w.sells,
            transfersIn: w.transfersIn || 0,
            pattern: w.pattern || 'normal',
            pool: coin.pool,
          };
        }
        
        // 合并关联关系
        for (const [addr, related] of Object.entries(assoc)) {
          if (!pool.associations[addr]) pool.associations[addr] = [];
          for (const r of related) {
            if (!pool.associations[addr].includes(r)) pool.associations[addr].push(r);
          }
        }

        // Mark as scanned (by mint)
        if (!candidates.scanned) candidates.scanned = [];
        if (coin.mint) {
          candidates.scanned.push(coin.mint);
          scannedSet.add(coin.mint);
        }

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
