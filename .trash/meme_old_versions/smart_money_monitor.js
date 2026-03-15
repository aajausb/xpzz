#!/usr/bin/env node
/**
 * Smart Money Monitor v2
 * 
 * 监控聪明钱钱包的实时交易，发现新买入立即通知
 * 
 * 方法：Helius Enhanced TX API 轮询每个钱包最近交易
 * 
 * 信号类型：
 * - BUY：聪明钱主动SWAP买入 → 强信号
 * - SELL：聪明钱主动SWAP卖出 → 跟卖参考
 * - ACCUMULATE：同一个token多次买入 → 超强信号
 * 
 * 钓鱼/空投过滤：
 * - 只跟踪 type=SWAP 的交易（主动交易）
 * - 忽略 type=TRANSFER（被动收到，可能是钓鱼空投）
 * - 验证 feePayer 是钱包自己（自己发起的交易）
 * - 忽略 0 SOL 消耗的"买入"（假信号）
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

// Config
const HELIUS_KEY_1 = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_KEY_2 = process.env.HELIUS_API_KEY_2 || '824cb27b-0794-45ed-aa1c-0798658d8d80';
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'smart_wallets.json');
const STATE_FILE = path.join(DATA_DIR, 'monitor_state.json');
const LOG_DIR = path.join(__dirname, 'logs');

// Poll interval: 30 seconds for gold, 60 seconds for others
const GOLD_INTERVAL_MS = 30000;
const NORMAL_INTERVAL_MS = 60000;
const HELIUS_PARSE_URL = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY_2}`;

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Logger
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `monitor_${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

// Load state
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastSigs: {}, seenTxs: new Set() };
  }
}

function saveState(state) {
  // Convert Set to Array for JSON
  const toSave = {
    lastSigs: state.lastSigs,
    seenTxs: [...(state.seenTxs || [])].slice(-5000), // Keep last 5000
    lastRun: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
}

// Load wallets
function loadWallets() {
  const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
  return data.wallets.filter(w => w.chain === 'solana');
}

// Notify (console + file, TODO: Telegram)
async function notify(signal) {
  const emoji = signal.type === 'BUY' ? '🟢' : signal.type === 'SELL' ? '🔴' : '⭐';
  const tierEmoji = signal.walletTier === 'GOLD' ? '🏆' : '💎';
  
  const msg = [
    `${emoji} ${signal.type} Signal ${tierEmoji}`,
    `钱包: ${signal.wallet.slice(0, 12)}... (${signal.walletLabel})`,
    `Token: ${signal.tokenMint?.slice(0, 12)}...`,
    `方向: ${signal.type}`,
    `金额: ${signal.solAmount ? signal.solAmount.toFixed(2) + ' SOL' : '?'}`,
    `时间: ${signal.timestamp}`,
    signal.walletTier === 'GOLD' ? '⚡ GOLD级钱包，4币跨币盈利' : '',
  ].filter(Boolean).join('\n');
  
  log('SIGNAL', msg);
  
  // Save to signals file
  const signalsFile = path.join(DATA_DIR, 'signals.json');
  let signals = [];
  try { signals = JSON.parse(fs.readFileSync(signalsFile, 'utf8')); } catch {}
  signals.push({ ...signal, notifiedAt: new Date().toISOString() });
  // Keep last 200 signals
  if (signals.length > 200) signals = signals.slice(-200);
  fs.writeFileSync(signalsFile, JSON.stringify(signals, null, 2));
}

// Check one wallet for new transactions
async function checkWallet(wallet, state, conn) {
  const addr = wallet.address;
  const lastSig = state.lastSigs[addr];
  
  try {
    // Get recent signatures
    const opts = { limit: 20 };
    if (lastSig) opts.until = lastSig;
    
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), opts);
    
    if (sigs.length === 0) return;
    
    // Update last seen
    state.lastSigs[addr] = sigs[0].signature;
    
    // Filter out already-seen
    const seenSet = state.seenTxs;
    const newSigs = sigs.filter(s => !seenSet.has(s.signature));
    
    if (newSigs.length === 0) return;
    
    log('INFO', `${addr.slice(0, 12)}: ${newSigs.length} new txs`);
    
    // Parse with Helius
    const batchSize = 20;
    for (let i = 0; i < newSigs.length; i += batchSize) {
      const batch = newSigs.slice(i, i + batchSize);
      
      try {
        const r = await fetch(HELIUS_PARSE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactions: batch.map(s => s.signature) }),
        });
        
        const parsed = await r.json();
        if (!Array.isArray(parsed)) continue;
        
        for (const tx of parsed) {
          // ===== 钓鱼/空投过滤 =====
          // 1. 只处理SWAP（主动交易），忽略TRANSFER（被动收到）
          if (tx.type !== 'SWAP') {
            if (tx.type === 'TRANSFER') {
              log('DEBUG', `  忽略TRANSFER(可能是空投/钓鱼): ${tx.signature?.slice(0, 16)}`);
            }
            continue;
          }
          
          // 2. 验证feePayer是钱包自己（自己发起的交易）
          const feePayer = tx.feePayer;
          if (feePayer && feePayer !== addr) {
            log('WARN', `  ⚠️ feePayer不是钱包本人! feePayer=${feePayer.slice(0, 16)} wallet=${addr.slice(0, 16)} — 跳过（可能是钓鱼诱导）`);
            continue;
          }
          
          // Analyze swap direction
          let buyToken = null, sellToken = null;
          let solIn = 0, solOut = 0;
          
          for (const tt of (tx.tokenTransfers || [])) {
            if (tt.mint === SOL_MINT) continue;
            
            if (tt.toUserAccount === addr) {
              buyToken = tt.mint;
            } else if (tt.fromUserAccount === addr) {
              sellToken = tt.mint;
            }
          }
          
          // Track SOL movement
          for (const nt of (tx.nativeTransfers || [])) {
            if (nt.fromUserAccount === addr) solOut += nt.amount;
            if (nt.toUserAccount === addr) solIn += nt.amount;
          }
          
          const solAmount = Math.abs(solOut - solIn) / 1e9;
          
          // 3. 买入信号需要实际花费SOL（排除0成本假信号）
          if (buyToken && solOut <= 0) {
            log('WARN', `  ⚠️ 收到token但没花SOL — 可能是空投/钓鱼，跳过 mint=${buyToken.slice(0, 16)}`);
            continue;
          }
          
          const tier = wallet.coins?.length >= 4 ? 'GOLD' : 
                       wallet.coins?.length >= 2 ? 'CROSS' : 'SINGLE';
          
          if (buyToken) {
            await notify({
              type: 'BUY',
              wallet: addr,
              walletLabel: wallet.label,
              walletTier: tier,
              tokenMint: buyToken,
              solAmount,
              timestamp: new Date((tx.timestamp || 0) * 1000).toISOString(),
              txSig: tx.signature,
              verified: true, // 已通过钓鱼过滤
            });
          }
          
          if (sellToken) {
            await notify({
              type: 'SELL',
              wallet: addr,
              walletLabel: wallet.label,
              walletTier: tier,
              tokenMint: sellToken,
              solAmount,
              timestamp: new Date((tx.timestamp || 0) * 1000).toISOString(),
              txSig: tx.signature,
              verified: true,
            });
          }
        }
      } catch (e) {
        log('ERROR', `Parse error: ${e.message}`);
      }
      
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }
    
    // Mark as seen
    for (const s of newSigs) {
      seenSet.add(s.signature);
    }
    
  } catch (e) {
    log('ERROR', `Check ${addr.slice(0, 12)}: ${e.message}`);
  }
}

// Main loop
async function main() {
  log('INFO', '=== Smart Money Monitor v1 启动 ===');
  
  const wallets = loadWallets();
  log('INFO', `监控 ${wallets.length} 个Solana钱包`);
  
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY_1}`, 'confirmed');
  
  let state = loadState();
  if (Array.isArray(state.seenTxs)) {
    state.seenTxs = new Set(state.seenTxs);
  } else {
    state.seenTxs = new Set();
  }
  
  // Initial scan — set baseline (don't alert on existing txs)
  if (Object.keys(state.lastSigs).length === 0) {
    log('INFO', '首次运行，建立baseline...');
    for (const w of wallets) {
      try {
        const sigs = await conn.getSignaturesForAddress(new PublicKey(w.address), { limit: 1 });
        if (sigs.length > 0) {
          state.lastSigs[w.address] = sigs[0].signature;
          state.seenTxs.add(sigs[0].signature);
        }
      } catch (e) {
        log('WARN', `Baseline ${w.address.slice(0, 12)}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    saveState(state);
    log('INFO', 'Baseline完成');
  }
  
  // Poll loop
  while (true) {
    const startTime = Date.now();
    
    for (const w of wallets) {
      await checkWallet(w, state, conn);
      await new Promise(r => setTimeout(r, 300)); // Rate limit between wallets
    }
    
    saveState(state);
    
    const elapsed = Date.now() - startTime;
    const interval = NORMAL_INTERVAL_MS;
    const wait = Math.max(0, interval - elapsed);
    
    log('DEBUG', `轮询完成 (${(elapsed/1000).toFixed(1)}s), 等待${(wait/1000).toFixed(0)}s`);
    await new Promise(r => setTimeout(r, wait));
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => { log('INFO', '收到SIGINT，退出'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', '收到SIGTERM，退出'); process.exit(0); });

main().catch(e => { log('FATAL', e.message); process.exit(1); });
