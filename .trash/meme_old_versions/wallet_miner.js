#!/usr/bin/env node
/**
 * Wallet Miner v1
 * 
 * 核心思路：从已经涨过的种子币中，找到早期低位买入并赚了钱的钱包
 * 这些钱包就是聪明钱，跟踪它们的下一步操作
 * 
 * 步骤：
 * 1. 读取种子币列表
 * 2. 对每个种子币：查早期交易者（Solana用Helius，EVM用Transfer事件）
 * 3. 筛选出赚钱的钱包
 * 4. 跨币验证：在多个种子币中都赚了的 = 真聪明钱
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const fs = require('fs');
const path = require('path');

// === Config ===
const DATA_DIR = path.join(__dirname, 'data');
const LOG_DIR = path.join(__dirname, 'logs');
const RESULTS_FILE = path.join(DATA_DIR, 'mined_wallets.json');

const HELIUS_KEYS = [
  process.env.HELIUS_API_KEY || '',
  process.env.HELIUS_API_KEY_2 || '',
].filter(Boolean);
let heliusIdx = 0;
function nextHeliusKey() { return HELIUS_KEYS[heliusIdx++ % HELIUS_KEYS.length]; }

const EVM_RPCS = {
  bsc: 'https://bsc-mainnet.public.blastapi.io',
  base: 'https://base-mainnet.public.blastapi.io',
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// === 种子币 ===
const SEEDS = [
  {
    name: 'PENGUIN', chain: 'solana',
    mint: '8Jx8AAHj86wbQgUTjGuj6GTTL5Ps3cqxKRTvpaJApump',
    note: '7444x, 速通币, 01/16创建',
  },
  {
    name: 'Punch', chain: 'solana',
    mint: 'NV2RYH954cTJ3ckFUpvfqaQXU4ARqqDH3562nFSpump',
    note: '3060x, 02/05创建',
  },
  {
    name: '龙虾', chain: 'bsc',
    mint: '0xeCCBb861c0dda7eFd964010085488b69317e4444',
    note: '574x慢涨, 02/27创建',
  },
  {
    name: 'MOLT', chain: 'base',
    mint: '0xB695559b26BB2c9703ef1935c37AeaE9526bab07',
    note: '3655x, 01/28创建',
  },
];

// === Logger ===
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `miner_${ts.slice(0, 10)}.log`), line + '\n');
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === SOL价格 ===
let solPrice = 130;
async function updateSolPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d.solana?.usd) solPrice = d.solana.usd;
    log('INFO', `SOL: $${solPrice}`);
  } catch {}
}

// === ETH/BNB价格 ===
let ethPrice = 2000, bnbPrice = 600;
async function updateEvmPrices() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd');
    const d = await r.json();
    if (d.ethereum?.usd) ethPrice = d.ethereum.usd;
    if (d.binancecoin?.usd) bnbPrice = d.binancecoin.usd;
    log('INFO', `ETH: $${ethPrice}, BNB: $${bnbPrice}`);
  } catch {}
}

// ============================================================
// Solana: 用 Helius 查某个token的早期买家
// ============================================================
async function mineSolanaWallets(seed) {
  log('INFO', `\n🔍 挖掘 [SOL] ${seed.name} (${seed.mint.slice(0, 16)}...)`);
  
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2fvD2EcfY6hVckvyCuuP1CETn';
  const stables = new Set([SOL_MINT, USDC, USDT]);
  
  // Step 1: 拿token的前20大持有者
  log('INFO', `  查top持有者...`);
  const { Connection, PublicKey } = require('@solana/web3.js');
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${nextHeliusKey()}`, 'confirmed');
  
  let holders = [];
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(seed.mint));
    for (const acc of largest.value) {
      try {
        const info = await conn.getParsedAccountInfo(new PublicKey(acc.address));
        const owner = info.value?.data?.parsed?.info?.owner;
        if (owner) {
          const amt = parseInt(acc.amount) / Math.pow(10, acc.decimals || 6);
          holders.push({ wallet: owner, amount: amt });
        }
      } catch {}
    }
    // 排除LP池（持仓极大的）
    holders = holders.filter(h => h.amount < 1e9);
    log('INFO', `  ${holders.length} 个持有者（排除LP后）`);
  } catch (e) {
    log('WARN', `  持有者查询失败: ${e.message?.slice(0, 60)}`);
  }
  
  // Step 2: 用Helius查token的早期交易（通过signatures API查mint的交易历史）
  log('INFO', `  查早期交易者...`);
  let earlyTraders = new Map(); // wallet → { buySol, sellSol, buys, sells }
  
  // 从最早的交易开始查（用before参数翻页到最早）
  // 或者直接查每个holder的交易历史
  
  // 方案：查每个top holder在这个token上的盈亏
  for (const holder of holders) {
    const wallet = holder.wallet;
    
    // 拉这个钱包的交易，筛出跟目标token相关的
    let allTxs = [];
    let beforeSig;
    
    for (let batch = 0; batch < 10; batch++) {
      let url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${nextHeliusKey()}&limit=100`;
      if (beforeSig) url += `&before=${beforeSig}`;
      try {
        const r = await fetch(url);
        if (!r.ok) break;
        const txs = await r.json();
        if (!Array.isArray(txs) || txs.length === 0) break;
        allTxs.push(...txs);
        beforeSig = txs[txs.length - 1].signature;
        if (txs.length < 100) break;
      } catch { break; }
      await sleep(200);
    }
    
    // 筛出跟目标token相关的交易
    let totalSolSpent = 0, totalSolReceived = 0;
    let buyCount = 0, sellCount = 0;
    let firstBuyTime = null, lastSellTime = null;
    
    for (const tx of allTxs) {
      const transfers = tx.tokenTransfers || [];
      const hasTarget = transfers.some(tt => tt.mint === seed.mint);
      if (!hasTarget) continue;
      
      let tokenIn = 0, tokenOut = 0;
      let solIn = 0, solOut = 0;
      
      for (const tt of transfers) {
        if (tt.mint === seed.mint) {
          if (tt.toUserAccount === wallet) tokenIn += (tt.tokenAmount || 0);
          if (tt.fromUserAccount === wallet) tokenOut += (tt.tokenAmount || 0);
        }
        if (tt.mint === SOL_MINT || stables.has(tt.mint)) {
          const amt = tt.mint === SOL_MINT ? (tt.tokenAmount || 0) : (tt.tokenAmount || 0) / solPrice;
          if (tt.fromUserAccount === wallet) solOut += amt;
          if (tt.toUserAccount === wallet) solIn += amt;
        }
      }
      for (const nt of (tx.nativeTransfers || [])) {
        if (nt.fromUserAccount === wallet) solOut += (nt.amount || 0) / 1e9;
        if (nt.toUserAccount === wallet) solIn += (nt.amount || 0) / 1e9;
      }
      
      if (tokenIn > tokenOut) {
        // 买入
        buyCount++;
        totalSolSpent += solOut;
        if (!firstBuyTime) firstBuyTime = tx.timestamp;
      } else if (tokenOut > tokenIn) {
        // 卖出
        sellCount++;
        totalSolReceived += solIn;
        lastSellTime = tx.timestamp;
      }
    }
    
    const profitSol = totalSolReceived - totalSolSpent;
    const profitUsd = profitSol * solPrice;
    const costUsd = totalSolSpent * solPrice;
    
    if (buyCount > 0) {
      earlyTraders.set(wallet, {
        profitUsd: Math.round(profitUsd),
        costUsd: Math.round(costUsd),
        buyCount,
        sellCount,
        firstBuyTime,
        multiplier: totalSolSpent > 0 ? (totalSolReceived / totalSolSpent) : 0,
        stillHolding: sellCount === 0 || holder.amount > 0,
        holdingAmount: holder.amount,
      });
      
      const status = sellCount > 0 
        ? `利润$${Math.round(profitUsd)} (${(totalSolReceived/totalSolSpent).toFixed(1)}x)` 
        : `持仓中(成本$${Math.round(costUsd)})`;
      log('INFO', `  💰 ${wallet.slice(0, 12)}... buy:${buyCount} sell:${sellCount} ${status}`);
    }
    
    await sleep(500);
  }
  
  // Step 3: 查这些赚钱钱包在其他token上的交易（跨币验证）
  const profitable = [...earlyTraders.entries()]
    .filter(([, v]) => v.profitUsd > 500 || v.costUsd > 500)
    .sort((a, b) => b[1].profitUsd - a[1].profitUsd);
  
  log('INFO', `  ${seed.name}: ${profitable.length}/${earlyTraders.size} 个有效钱包 (利润>$500或成本>$500)`);
  
  return profitable.map(([wallet, data]) => ({
    wallet,
    chain: 'solana',
    seedToken: seed.name,
    seedMint: seed.mint,
    ...data,
  }));
}

// ============================================================
// EVM: 用Transfer事件查早期买家
// ============================================================
async function mineEvmWallets(seed) {
  log('INFO', `\n🔍 挖掘 [${seed.chain.toUpperCase()}] ${seed.name} (${seed.mint.slice(0, 16)}...)`);
  
  const rpc = EVM_RPCS[seed.chain];
  if (!rpc) { log('WARN', `无RPC: ${seed.chain}`); return []; }
  
  const nativePrice = seed.chain === 'bsc' ? bnbPrice : ethPrice;
  
  // Step 1: 获取当前区块
  const blockRes = await fetch(rpc, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', method:'eth_blockNumber', id:1})
  }).then(r => r.json());
  const latest = parseInt(blockRes.result, 16);
  
  // Step 2: 查所有Transfer事件（尽可能多的区块）
  log('INFO', `  查Transfer事件 (latest block: ${latest})...`);
  let allEvents = [];
  const batchSize = 5000;
  const batches = 40; // 覆盖更多区块
  
  for (let i = 0; i < batches; i++) {
    const to = latest - i * batchSize;
    const from = to - batchSize + 1;
    if (from < 0) break;
    try {
      const r = await fetch(rpc, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc:'2.0', method:'eth_getLogs', params:[{
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          address: seed.mint,
          topics: [TRANSFER_TOPIC]
        }], id: 1})
      }).then(r => r.json());
      if (r.result) allEvents.push(...r.result);
      if (r.error) {
        log('WARN', `  batch ${i}: ${r.error.message?.slice(0, 60)}`);
        break;
      }
    } catch (e) {
      log('WARN', `  batch ${i}: ${e.message?.slice(0, 40)}`);
    }
    await sleep(200);
    
    if (i % 10 === 9) {
      log('INFO', `  已查 ${i+1}/${batches} 批, ${allEvents.length} events`);
    }
  }
  
  log('INFO', `  总计 ${allEvents.length} transfer events`);
  
  // Step 3: 统计每个地址的买卖
  const zero = '0x' + '0'.repeat(40);
  const activity = {};
  
  for (const evt of allEvents) {
    const t = evt.topics;
    if (t.length < 3) continue;
    const fr = '0x' + t[1].slice(-40).toLowerCase();
    const to = '0x' + t[2].slice(-40).toLowerCase();
    const val = BigInt(evt.data || '0x0');
    const block = parseInt(evt.blockNumber, 16);
    
    if (fr !== zero) {
      if (!activity[fr]) activity[fr] = {buyVal: 0n, sellVal: 0n, buys:0, sells:0, firstBlock: block, lastBlock: block};
      activity[fr].sells++;
      activity[fr].sellVal += val;
      activity[fr].lastBlock = Math.max(activity[fr].lastBlock, block);
    }
    if (to !== zero) {
      if (!activity[to]) activity[to] = {buyVal: 0n, sellVal: 0n, buys:0, sells:0, firstBlock: block, lastBlock: block};
      activity[to].buys++;
      activity[to].buyVal += val;
      if (!activity[to].firstBlock || block < activity[to].firstBlock) activity[to].firstBlock = block;
    }
  }
  
  // Step 4: 筛选——买了又卖的，或者大量买入的
  const wallets = Object.entries(activity)
    .filter(([addr, v]) => {
      // 排除router（交易次数太高）
      if (v.buys + v.sells > 1000) return false;
      // 排除零地址
      if (addr === zero) return false;
      // 有买入行为
      if (v.buys < 1) return false;
      // 排除只有1次小额交易的
      return true;
    })
    .map(([addr, v]) => ({
      wallet: addr,
      chain: seed.chain,
      seedToken: seed.name,
      seedMint: seed.mint,
      buys: v.buys,
      sells: v.sells,
      netTokens: Number((v.buyVal - v.sellVal) / (10n ** 18n)),
      soldRatio: v.buyVal > 0n ? Number(v.sellVal * 100n / v.buyVal) : 0,
      firstBlock: v.firstBlock,
      stillHolding: v.buyVal > v.sellVal,
    }))
    .sort((a, b) => b.sells - a.sells || b.buys - a.buys)
    .slice(0, 50); // top 50
  
  log('INFO', `  ${seed.name}: ${wallets.length} 个活跃钱包`);
  for (const w of wallets.slice(0, 10)) {
    const status = w.sells > 0 ? `卖了${w.soldRatio}%` : '持仓中';
    log('INFO', `  💰 ${w.wallet.slice(0, 12)}... buy:${w.buys} sell:${w.sells} ${status}`);
  }
  
  return wallets;
}

// ============================================================
// 跨币验证
// ============================================================
function crossValidate(allWallets) {
  // 按钱包地址分组
  const byWallet = {};
  for (const w of allWallets) {
    const key = w.wallet.toLowerCase();
    if (!byWallet[key]) byWallet[key] = { wallet: w.wallet, chain: w.chain, seeds: [] };
    byWallet[key].seeds.push({
      token: w.seedToken,
      mint: w.seedMint,
      profitUsd: w.profitUsd || 0,
      costUsd: w.costUsd || 0,
      buys: w.buys || w.buyCount || 0,
      sells: w.sells || w.sellCount || 0,
      stillHolding: w.stillHolding,
    });
  }
  
  // 在多个种子币中出现的 = 跨币验证通过
  const crossValidated = Object.values(byWallet)
    .filter(w => w.seeds.length >= 2)
    .sort((a, b) => b.seeds.length - a.seeds.length);
  
  log('INFO', `\n🎯 跨币验证结果:`);
  log('INFO', `  总钱包: ${Object.keys(byWallet).length}`);
  log('INFO', `  跨币(≥2): ${crossValidated.length}`);
  
  for (const w of crossValidated.slice(0, 20)) {
    const tokens = w.seeds.map(s => s.token).join(', ');
    const totalProfit = w.seeds.reduce((a, s) => a + (s.profitUsd || 0), 0);
    log('INFO', `  ⭐ ${w.wallet.slice(0, 16)}... [${w.chain}] 出现在: ${tokens} 总利润: $${totalProfit}`);
  }
  
  return { all: Object.values(byWallet), crossValidated };
}

// === Utils ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Main ===
async function main() {
  log('INFO', '=== Wallet Miner v1 启动 ===');
  log('INFO', `种子币: ${SEEDS.length} 个`);
  
  await updateSolPrice();
  await updateEvmPrices();
  
  const allWallets = [];
  
  for (const seed of SEEDS) {
    try {
      let wallets;
      if (seed.chain === 'solana') {
        wallets = await mineSolanaWallets(seed);
      } else {
        wallets = await mineEvmWallets(seed);
      }
      allWallets.push(...wallets);
      log('INFO', `  ${seed.name} 完成: ${wallets.length} 个钱包`);
    } catch (e) {
      log('ERROR', `  ${seed.name} 失败: ${e.message}`);
    }
    
    await sleep(2000);
  }
  
  // 跨币验证
  const results = crossValidate(allWallets);
  
  // 保存结果
  saveJSON(RESULTS_FILE, {
    minedAt: new Date().toISOString(),
    seeds: SEEDS.map(s => ({ name: s.name, chain: s.chain, mint: s.mint })),
    totalWallets: results.all.length,
    crossValidated: results.crossValidated.length,
    wallets: results.all,
    crossValidatedWallets: results.crossValidated,
  });
  
  log('INFO', `\n✅ 完成! 结果保存到 ${RESULTS_FILE}`);
  log('INFO', `总钱包: ${results.all.length} | 跨币验证: ${results.crossValidated.length}`);
}

main().catch(e => { log('FATAL', e.message); process.exit(1); });
