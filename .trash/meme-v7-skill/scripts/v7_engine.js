/**
 * 土狗v7精简版 — OKX聪明钱信号跟单
 * 信号采集(onchainos CLI) → ≥3个SM买同一币 → 自动买入 → 止盈止损
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buy, sell } = require('./dex_trader');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
const { ethers } = require('ethers');

// ============ 钱包（从env读私钥） ============
let _wallet = null;
function getWallets() {
  if (_wallet) return _wallet;
  _wallet = {};
  if (process.env.SOL_PRIVATE_KEY) {
    const sk = bs58.decode(process.env.SOL_PRIVATE_KEY);
    _wallet.solana = { address: Keypair.fromSecretKey(sk).publicKey.toBase58(), secretKey: sk };
  }
  if (process.env.EVM_PRIVATE_KEY) {
    const w = new ethers.Wallet(process.env.EVM_PRIVATE_KEY);
    _wallet.evm = { address: w.address, privateKey: process.env.EVM_PRIVATE_KEY };
  }
  return _wallet;
}

// ============ 配置 ============
const CONFIG = {
  scanInterval: 60_000,
  chains: ['solana', 'bsc', 'base'],
  minSmartMoneyCount: 3,
  maxSoldPercent: 50,
  minHolders: 200,
  maxTop10Percent: 50,
  minMarketCapUsd: 10_000,
  maxMarketCapUsd: 10_000_000,
  positionSizeUsd: 10,
  maxPositions: 10,
  maxPerChain: 5,
  takeProfitPercent: 100,
  stopLossPercent: -50,
  trailingStopPercent: 30,
  dataDir: path.join(__dirname, 'data'),
};

const OKX_ENV = { ...process.env };

// ============ 状态 ============
let positions = [];
let seenSignals = {};
const DATA_FILE = path.join(CONFIG.dataDir, 'positions.json');
const LOG_FILE = path.join(CONFIG.dataDir, 'signals.jsonl');

// ============ 主循环 ============
async function main() {
  console.log(`🐕 土狗v7启动 | $${CONFIG.positionSizeUsd}/笔 | SM≥${CONFIG.minSmartMoneyCount}`);
  if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  try { positions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  console.log(`持仓: ${positions.filter(p => p.status === 'open').length}个`);

  while (true) {
    try { await scanSignals(); } catch (e) { console.error('扫描出错:', e.message); }
    try { await checkPositions(); } catch (e) { console.error('持仓检查出错:', e.message); }
    fs.writeFileSync(DATA_FILE, JSON.stringify(positions, null, 2));
    await sleep(CONFIG.scanInterval);
  }
}

// ============ 信号采集+过滤 ============
async function scanSignals() {
  const now = Date.now();
  const tokenMap = {};

  for (const chain of CONFIG.chains) {
    try {
      const raw = execSync(`onchainos market signal-list ${chain} --wallet-type "1"`,
        { env: OKX_ENV, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }).toString();
      for (const s of (JSON.parse(raw).data || [])) {
        const addr = s.token.tokenAddress;
        const key = `${chain}:${addr}`;
        if (!tokenMap[key]) {
          tokenMap[key] = {
            chain, address: addr, symbol: s.token.symbol, name: s.token.name,
            holders: parseInt(s.token.holders) || 0,
            marketCap: parseFloat(s.token.marketCapUsd) || 0,
            top10Percent: parseFloat(s.token.top10HolderPercent) || 0,
            wallets: new Set(), minSoldPercent: 100,
          };
        }
        const t = tokenMap[key];
        (s.triggerWalletAddress || '').split(',').filter(Boolean).forEach(w => t.wallets.add(w));
        t.minSoldPercent = Math.min(t.minSoldPercent, parseFloat(s.soldRatioPercent) || 0);
      }
    } catch (e) { console.error(`${chain}信号失败:`, e.message?.slice(0, 60)); }
  }

  const candidates = [];
  for (const [key, t] of Object.entries(tokenMap)) {
    if (seenSignals[key] && (now - seenSignals[key]) < 3600_000) continue;
    if (positions.find(p => p.chain === t.chain && p.address === t.address && p.status === 'open')) continue;
    if (t.wallets.size < CONFIG.minSmartMoneyCount) continue;
    if (t.minSoldPercent > CONFIG.maxSoldPercent) continue;
    if (t.holders < CONFIG.minHolders) continue;
    if (t.top10Percent > CONFIG.maxTop10Percent) continue;
    if (t.marketCap > 0 && t.marketCap < CONFIG.minMarketCapUsd) continue;
    if (t.marketCap > CONFIG.maxMarketCapUsd) continue;
    candidates.push(t);
    seenSignals[key] = now;
  }

  if (!candidates.length) return;
  candidates.sort((a, b) => b.wallets.size - a.wallets.size);
  console.log(`🎯 ${candidates.length}个候选:`);
  candidates.slice(0, 5).forEach(c =>
    console.log(`  ${c.symbol}(${c.chain}) SM=${c.wallets.size} MC=$${c.marketCap.toFixed(0)}`));

  for (const c of candidates) {
    if (positions.filter(p => p.status === 'open').length >= CONFIG.maxPositions) break;
    if (positions.filter(p => p.chain === c.chain && p.status === 'open').length >= CONFIG.maxPerChain) continue;
    await executeBuy(c);
  }
}

// ============ 买卖 ============
async function executeBuy(c) {
  try {
    const amount = await usdToNative(c.chain, CONFIG.positionSizeUsd);
    console.log(`🔵 买入 ${c.symbol}(${c.chain}) $${CONFIG.positionSizeUsd}...`);
    const r = await buy(c.chain, c.address, amount.toString());
    if (r.success) {
      positions.push({
        chain: c.chain, address: c.address, symbol: c.symbol,
        buyTxHash: r.txHash, buyTime: Date.now(), buyPriceUsd: CONFIG.positionSizeUsd,
        smartMoneyWallets: [...c.wallets], highWaterMark: CONFIG.positionSizeUsd, status: 'open',
      });
      log('BUY', c.symbol, c.chain, r.txHash);
      console.log(`  ✅ ${r.txHash.slice(0, 20)}...`);
    }
  } catch (e) { console.error(`  ❌ ${c.symbol} 买入失败:`, e.message.slice(0, 80)); }
}

async function executeSell(pos, reason) {
  try {
    console.log(`🔴 卖出 ${pos.symbol}(${pos.chain}) — ${reason}`);
    const r = await sell(pos.chain, pos.address);
    if (r.success) {
      pos.status = 'closed'; pos.sellTxHash = r.txHash; pos.sellTime = Date.now();
      pos.closeReason = reason; pos.finalPnl = pos.pnlPercent;
      log('SELL', pos.symbol, pos.chain, r.txHash, reason);
      console.log(`  ✅ ${r.txHash.slice(0, 20)}...`);
    }
  } catch (e) { console.error(`  ❌ 卖出失败:`, e.message.slice(0, 80)); }
}

// ============ 持仓管理 ============
async function checkPositions() {
  for (const pos of positions.filter(p => p.status === 'open')) {
    try {
      const val = await getPositionValue(pos);
      if (val === null) continue;
      const pnl = ((val - pos.buyPriceUsd) / pos.buyPriceUsd) * 100;
      pos.currentValueUsd = val; pos.pnlPercent = pnl;
      if (val > pos.highWaterMark) pos.highWaterMark = val;
      const dd = ((val - pos.highWaterMark) / pos.highWaterMark) * 100;

      if (pnl <= CONFIG.stopLossPercent) return executeSell(pos, `止损${pnl.toFixed(1)}%`);
      if (pnl >= CONFIG.takeProfitPercent && !pos.tookProfit) return executeSell(pos, `止盈${pnl.toFixed(1)}%`);
      if (pos.highWaterMark > pos.buyPriceUsd * 1.5 && dd <= -CONFIG.trailingStopPercent)
        return executeSell(pos, `追踪止盈 高$${pos.highWaterMark.toFixed(0)}→$${val.toFixed(0)}`);
    } catch {}
  }
}

// ============ 工具 ============
async function usdToNative(chain, usd) {
  const ids = { solana: 'solana', bsc: 'binancecoin', base: 'ethereum' };
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids[chain]}&vs_currencies=usd`);
  const price = (await r.json())[ids[chain]].usd;
  if (chain === 'solana') return Math.ceil((usd / price) * 1e9);
  return ethers.parseEther((usd / price).toFixed(18)).toString();
}

async function getPositionValue(pos) {
  try {
    const r = JSON.parse(execSync(`onchainos market token-price ${pos.chain} --token ${pos.address}`,
      { env: OKX_ENV, timeout: 10000, maxBuffer: 5 * 1024 * 1024 }).toString());
    if (!r.ok || !r.data?.[0]) return null;
    const price = parseFloat(r.data[0].price);
    const bal = await getTokenBalance(pos.chain, pos.address);
    if (!bal || bal === '0') return 0;
    return (parseFloat(bal) / Math.pow(10, parseInt(r.data[0].decimals) || 9)) * price;
  } catch { return null; }
}

async function getTokenBalance(chain, token) {
  try {
    const w = getWallets();
    if (chain === 'solana') {
      const { Connection, PublicKey } = require('@solana/web3.js');
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const conn = new Connection(process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com');
      const ata = await getAssociatedTokenAddress(new PublicKey(token), new PublicKey(w.solana.address));
      return (await conn.getTokenAccountBalance(ata).catch(() => null))?.value?.amount || '0';
    }
    const provider = new ethers.JsonRpcProvider(chain === 'bsc' ? 'https://bsc-dataseed1.binance.org' : 'https://mainnet.base.org');
    return (await new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider)
      .balanceOf(w.evm.address)).toString();
  } catch { return '0'; }
}

function log(action, symbol, chain, tx, reason) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ action, symbol, chain, tx, reason, time: new Date().toISOString() }) + '\n');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (require.main === module) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
module.exports = { CONFIG };
