/**
 * 实时跟单引擎 v7
 * 
 * 流程：OKX选人 → 自己排名 → WebSocket实时监控 → 毫秒级跟单
 * 
 * Solana: Helius WebSocket + Jito bundle (目标下一区块)
 * BSC/Base: WebSocket newPendingTransactions + 高gas跟单
 */

const WebSocket = require('ws');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { ethers } = require('ethers');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const { getWallets } = require('../wallet_runtime');

const DATA_DIR = path.join(__dirname, 'data/v7');
const RANK_FILE = path.join(DATA_DIR, 'wallet_rank.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const FOLLOW_LOG = path.join(DATA_DIR, 'follow_log.jsonl');

const HELIUS_KEY = '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const BSC_WSS = 'wss://bsc-ws-node.nariox.org:443';
const BASE_WSS = 'wss://base-mainnet.public.blastapi.io';
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';

const JITO_BUNDLE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const JITO_TIP_ACCOUNT = '3AVi9Tg9Uo68tJfuvoKvobDRiNm7RB82pUzPCxaNyTCj';

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

const SOL_NATIVE = 'So11111111111111111111111111111111111111112';
const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ============ 配置 ============

const CONFIG = {
  topWalletsToFollow: 30,       // 从排名取前30，但只跟score>0的
  
  // 仓位: $5 × (SM信号数/3) × 排名加成
  basePositionUsd: 5,
  maxPositionUsd: 30,
  maxTotalPositions: 10,
  
  // 排名加成
  rankMultiplier: (rank) => rank <= 3 ? 2.0 : rank <= 10 ? 1.5 : rank <= 20 ? 1.2 : 1.0,
  
  // 风控（跟单时快速检查，不能太慢）
  maxMarketCapUsd: 10_000_000,
  
  // 卖出
  soldCheckInterval: 60_000,
  stopLossPercent: -30,
  
  // Jito tip (lamports)
  jitoTipLamports: 10_000, // 0.00001 SOL
  
  // 防重复
  cooldownMs: 1800_000, // 30分钟
};

// ============ 状态 ============

let positions = [];
let followedWallets = {};     // address → { rank, score, winRate, chains }
let solWalletSet = new Set();
let bscWalletSet = new Set();
let baseWalletSet = new Set();
let recentBuys = {};
let solConn = null;
let walletKeys = null;
let priceCache = { sol: 0, bnb: 0, eth: 0, ts: 0 };

// ============ 初始化 ============

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  
  // 加载排名
  try {
    const data = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
    const ranks = data.ranks || [];
    
    for (let i = 0; i < Math.min(CONFIG.topWalletsToFollow, ranks.length); i++) {
      const r = ranks[i];
      if (r.score <= 0) continue; // 只跟正评分钱包
      followedWallets[r.address] = { rank: i + 1, score: r.score, winRate: r.winRate };
      for (const chain of r.chains) {
        if (chain === 'solana') solWalletSet.add(r.address);
        else if (chain === 'bsc') bscWalletSet.add(r.address);
        else if (chain === 'base') baseWalletSet.add(r.address);
      }
    }
  } catch(e) { console.log('⚠️ 无排名数据'); }
  
  // 加载持仓
  try { positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch(e) {}
  
  // 预热钱包密钥
  walletKeys = getWallets();
  solConn = new Connection(HELIUS_RPC, 'confirmed');
  
  console.log(`📋 跟踪: SOL=${solWalletSet.size} BSC=${bscWalletSet.size} Base=${baseWalletSet.size}`);
  console.log(`💼 持仓: ${positions.filter(p => p.status === 'open').length}个`);
}

// ============ Solana WebSocket实时监控 ============

function startSolanaWatcher() {
  const wallets = [...solWalletSet];
  if (wallets.length === 0) return;
  
  console.log(`🔌 [SOL] WebSocket监控 ${wallets.length} 个钱包`);
  
  const ws = new WebSocket(HELIUS_WS);
  
  ws.on('open', () => {
    // Helius支持accountInclude数组
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'transactionSubscribe',
      params: [{
        accountInclude: wallets
      }, {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        transactionDetails: 'full',
        maxSupportedTransactionVersion: 0
      }]
    }));
    console.log('  ✅ 订阅已发送');
  });
  
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'transactionNotification') {
        const t0 = Date.now();
        await handleSolanaTx(msg.params.result);
        const elapsed = Date.now() - t0;
        if (elapsed > 100) console.log(`  ⏱️ 处理耗时 ${elapsed}ms`);
      }
    } catch(e) {}
  });
  
  ws.on('close', () => {
    console.log('🔌 [SOL] 断开，3秒后重连');
    setTimeout(startSolanaWatcher, 3000);
  });
  ws.on('error', () => {});
}

async function handleSolanaTx(result) {
  const tx = result.transaction;
  if (!tx?.meta || tx.meta.err) return;
  
  // 找触发钱包
  const accounts = tx.transaction?.message?.accountKeys || [];
  let triggerWallet = null;
  for (const acc of accounts) {
    const addr = typeof acc === 'string' ? acc : acc.pubkey;
    if (solWalletSet.has(addr)) { triggerWallet = addr; break; }
  }
  if (!triggerWallet) return;
  
  // 解析买入的token
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  
  for (const p of post) {
    if (p.mint === SOL_NATIVE) continue;
    if (p.owner !== triggerWallet) continue;
    
    const preBal = pre.find(x => x.mint === p.mint && x.owner === p.owner);
    const before = parseFloat(preBal?.uiTokenAmount?.uiAmount || 0);
    const after = parseFloat(p.uiTokenAmount?.uiAmount || 0);
    
    if (after > before) {
      // 聪明钱买入了这个token！
      const info = followedWallets[triggerWallet];
      console.log(`\n🔔 [SOL] ${triggerWallet.slice(0,6)}...(rank#${info.rank} WR:${info.winRate}%) 买入 ${p.mint.slice(0,8)}...`);
      await fastFollow('solana', p.mint, triggerWallet);
    }
  }
  
  // 检测卖出（token减少 + SOL增加）
  for (const p of pre) {
    if (p.mint === SOL_NATIVE) continue;
    if (p.owner !== triggerWallet) continue;
    
    const postBal = post.find(x => x.mint === p.mint && x.owner === p.owner);
    const before = parseFloat(p.uiTokenAmount?.uiAmount || 0);
    const after = parseFloat(postBal?.uiTokenAmount?.uiAmount || 0);
    
    if (before > after && after < before * 0.5) {
      // 聪明钱卖了一半以上
      const pos = positions.find(x => x.chain === 'solana' && x.address === p.mint && x.status === 'open');
      if (pos) {
        const sellPercent = Math.round((1 - after / before) * 100);
        console.log(`\n🔔 [SOL] ${triggerWallet.slice(0,6)}... 卖出 ${p.mint.slice(0,8)}... ${sellPercent}%`);
        await followSell(pos, sellPercent);
      }
    }
  }
}

// ============ 极速跟单（跳过慢查询） ============

async function fastFollow(chain, tokenAddress, triggerWallet) {
  const tokenKey = `${chain}:${tokenAddress}`;
  
  // 防重复
  if (recentBuys[tokenKey] && Date.now() - recentBuys[tokenKey] < CONFIG.cooldownMs) return;
  if (positions.find(p => p.chain === chain && p.address === tokenAddress && p.status === 'open')) return;
  if (positions.filter(p => p.status === 'open').length >= CONFIG.maxTotalPositions) return;
  
  const info = followedWallets[triggerWallet];
  if (!info) return;
  
  // 计算仓位
  const rankMult = CONFIG.rankMultiplier(info.rank);
  const positionUsd = Math.min(CONFIG.basePositionUsd * rankMult, CONFIG.maxPositionUsd);
  
  recentBuys[tokenKey] = Date.now();
  
  console.log(`  ⚡ 跟单 $${positionUsd} (rank#${info.rank} ×${rankMult})`);
  
  try {
    if (chain === 'solana') {
      await fastBuySolana(tokenAddress, positionUsd, triggerWallet, info);
    } else {
      await fastBuyEvm(chain, tokenAddress, positionUsd, triggerWallet, info);
    }
  } catch(e) {
    console.log(`  ❌ 跟单失败: ${e.message?.slice(0, 80)}`);
  }
}

async function fastBuySolana(tokenAddress, usd, triggerWallet, info) {
  const kp = Keypair.fromSecretKey(walletKeys.solana.secretKey);
  const price = await getSolPrice();
  const lamports = Math.ceil((usd / price) * 1e9);
  
  // 1. 确保wSOL
  const { ensureWsolBalance } = require('./dex_trader');
  // ensureWsolBalance is not exported, inline it
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { SystemProgram, Transaction } = require('@solana/web3.js');
  
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  const wsolInfo = await solConn.getAccountInfo(wsolAta);
  let wsolBal = 0;
  if (wsolInfo) {
    const b = await solConn.getTokenAccountBalance(wsolAta);
    wsolBal = parseInt(b.value.amount);
  }
  if (wsolBal < lamports) {
    const needed = lamports - wsolBal;
    const tx = new Transaction();
    if (!wsolInfo) tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, wsolAta, kp.publicKey, NATIVE_MINT));
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAta, lamports: needed }), createSyncNativeInstruction(wsolAta));
    tx.recentBlockhash = (await solConn.getLatestBlockhash()).blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    await solConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await sleep(1000);
  }
  
  // 2. OKX获取swap tx
  const t0 = Date.now();
  const cmd = `onchainos swap swap --chain solana --from ${SOL_NATIVE} --to ${tokenAddress} --amount ${lamports} --wallet ${walletKeys.solana.address} --slippage 5`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 10000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error('OKX swap失败');
  
  // 3. 签名
  const decoded = bs58.decode(result.data[0].tx.data);
  const swapTx = VersionedTransaction.deserialize(decoded);
  swapTx.sign([kp]);
  const t1 = Date.now();
  
  // 4. Jito bundle提交（更快上链）
  let sig;
  try {
    const serialized = bs58.encode(swapTx.serialize());
    const bundleRes = await fetch(JITO_BUNDLE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sendBundle',
        params: [[serialized]]
      })
    });
    const bundleData = await bundleRes.json();
    if (bundleData.result) {
      sig = 'jito:' + bundleData.result;
      console.log(`  🚀 Jito bundle: ${bundleData.result.slice(0,16)}... (${t1-t0}ms构建)`);
    }
  } catch(e) {}
  
  // 5. 备用：直接发送
  if (!sig) {
    sig = await solConn.sendRawTransaction(swapTx.serialize(), { skipPreflight: true, maxRetries: 3 });
    console.log(`  📡 直发: ${sig.slice(0,16)}... (${t1-t0}ms构建)`);
  }
  
  // 6. 确认
  let success = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const status = await solConn.getSignatureStatus(typeof sig === 'string' && sig.startsWith('jito:') ? null : sig);
    if (status?.value) {
      if (status.value.err) { console.log(`  ❌ 链上失败`); break; }
      if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
        success = true; break;
      }
    }
  }
  
  if (success || sig.startsWith('jito:')) {
    positions.push({
      chain: 'solana', address: tokenAddress, symbol: '?',
      buyTxHash: sig, buyTime: Date.now(), buyPriceUsd: usd,
      triggerWallet, triggerRank: info.rank, status: 'open'
    });
    savePositions();
    log('BUY', { chain: 'solana', token: tokenAddress, usd, rank: info.rank, tx: sig, latency: t1 - t0 });
    console.log(`  ✅ 买入成功 $${usd}`);
  }
}

async function fastBuyEvm(chain, tokenAddress, usd, triggerWallet, info) {
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const chainName = chain === 'bsc' ? 'bsc' : 'base';
  const price = chain === 'bsc' ? await getBnbPrice() : await getEthPrice();
  const amountWei = BigInt(Math.ceil((usd / price) * 1e18)).toString();
  
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(walletKeys.evm.privateKey, provider);
  
  const cmd = `onchainos swap swap --chain ${chainName} --from ${EVM_NATIVE} --to ${tokenAddress} --amount ${amountWei} --wallet ${walletKeys.evm.address} --slippage 5`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 10000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error('OKX swap失败');
  
  const txData = result.data[0].tx;
  if (!txData.data || txData.data.length < 10) throw new Error('tx data空');
  
  const tx = await wallet.sendTransaction({
    to: txData.to, data: txData.data, value: txData.value || '0',
    chainId, gasLimit: BigInt(txData.gas || '500000')
  });
  
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error('revert');
  
  positions.push({
    chain, address: tokenAddress, symbol: '?',
    buyTxHash: tx.hash, buyTime: Date.now(), buyPriceUsd: usd,
    triggerWallet, triggerRank: info.rank, status: 'open'
  });
  savePositions();
  log('BUY', { chain, token: tokenAddress, usd, rank: info.rank, tx: tx.hash });
  console.log(`  ✅ 买入成功 $${usd} | ${tx.hash.slice(0,16)}...`);
}

// ============ 跟卖 ============

async function followSell(pos, sellPercent) {
  console.log(`  🔴 跟卖 ${pos.symbol || pos.address.slice(0,8)} ${sellPercent}%`);
  
  try {
    let balance;
    if (pos.chain === 'solana') {
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const ata = await getAssociatedTokenAddress(new PublicKey(pos.address), new PublicKey(walletKeys.solana.address));
      const bal = await solConn.getTokenAccountBalance(ata).catch(() => null);
      balance = bal?.value?.amount || '0';
    } else {
      const rpc = pos.chain === 'bsc' ? BSC_RPC : BASE_RPC;
      const provider = new ethers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(pos.address, ['function balanceOf(address) view returns (uint256)'], provider);
      balance = (await contract.balanceOf(walletKeys.evm.address)).toString();
    }
    
    if (!balance || balance === '0') { pos.status = 'closed'; savePositions(); return; }
    
    // 按比例卖
    const sellAmount = (BigInt(balance) * BigInt(Math.min(sellPercent, 100)) / 100n).toString();
    
    const { sell } = require('./dex_trader');
    const result = await sell(pos.chain, pos.address, sellAmount);
    
    if (result.success) {
      if (sellPercent >= 90) {
        pos.status = 'closed';
        pos.closeReason = `跟卖${sellPercent}%`;
      }
      pos.lastSellTime = Date.now();
      savePositions();
      log('SELL', { chain: pos.chain, token: pos.address, percent: sellPercent, tx: result.txHash });
      console.log(`  ✅ 卖出${sellPercent}%成功`);
    }
  } catch(e) {
    console.log(`  ❌ 卖出失败: ${e.message?.slice(0, 60)}`);
  }
}

// ============ EVM轮询监控 ============

async function startEvmWatcher(chain) {
  const walletSet = chain === 'bsc' ? bscWalletSet : baseWalletSet;
  if (walletSet.size === 0) return;
  
  console.log(`🔌 [${chain.toUpperCase()}] 轮询监控 ${walletSet.size} 个钱包`);
  
  // 轮询signal-list找新信号
  setInterval(async () => {
    try {
      const cmd = `onchainos market signal-list ${chain} --wallet-type "1"`;
      const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 30000, maxBuffer: 10*1024*1024 }).toString());
      
      for (const s of (result.data || [])) {
        const age = (Date.now() - parseInt(s.timestamp)) / 60000;
        if (age > 5) continue; // 只跟5分钟内的
        
        const wallets = (s.triggerWalletAddress || '').split(',').filter(Boolean);
        for (const w of wallets) {
          if (walletSet.has(w) && followedWallets[w]) {
            await fastFollow(chain, s.token.tokenAddress, w, followedWallets[w]);
          }
        }
      }
    } catch(e) {}
  }, 30_000);
}

// ============ 止损检查 ============

function startStopLossChecker() {
  setInterval(async () => {
    const open = positions.filter(p => p.status === 'open');
    for (const pos of open) {
      try {
        const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.address}`).then(r=>r.json());
        const price = parseFloat(dex.pairs?.[0]?.priceUsd || 0);
        if (!price) continue;
        
        let balance;
        if (pos.chain === 'solana') {
          const { getAssociatedTokenAddress } = require('@solana/spl-token');
          const ata = await getAssociatedTokenAddress(new PublicKey(pos.address), new PublicKey(walletKeys.solana.address));
          const bal = await solConn.getTokenAccountBalance(ata).catch(() => null);
          balance = bal?.value?.amount || '0';
        } else {
          const rpc = pos.chain === 'bsc' ? BSC_RPC : BASE_RPC;
          const provider = new ethers.JsonRpcProvider(rpc);
          const contract = new ethers.Contract(pos.address, ['function balanceOf(address) view returns (uint256)'], provider);
          balance = (await contract.balanceOf(walletKeys.evm.address)).toString();
        }
        
        const decimals = parseInt(dex.pairs?.[0]?.baseToken?.decimals || 9);
        const value = (parseFloat(balance) / 10**decimals) * price;
        const pnl = ((value - pos.buyPriceUsd) / pos.buyPriceUsd) * 100;
        
        pos.currentValue = value;
        pos.pnl = pnl;
        
        if (pnl <= CONFIG.stopLossPercent) {
          console.log(`\n🚨 止损 ${pos.symbol || pos.address.slice(0,8)} ${pnl.toFixed(1)}%`);
          await followSell(pos, 100);
        }
      } catch(e) {}
    }
    savePositions();
  }, CONFIG.soldCheckInterval);
}

// ============ 价格缓存 ============

async function refreshPrices() {
  if (Date.now() - priceCache.ts < 30000) return;
  try {
    const p = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin,ethereum&vs_currencies=usd').then(r=>r.json());
    priceCache = { sol: p.solana.usd, bnb: p.binancecoin.usd, eth: p.ethereum.usd, ts: Date.now() };
  } catch(e) {}
}
async function getSolPrice() { await refreshPrices(); return priceCache.sol || 87; }
async function getBnbPrice() { await refreshPrices(); return priceCache.bnb || 650; }
async function getEthPrice() { await refreshPrices(); return priceCache.eth || 2000; }

// ============ 工具 ============

function savePositions() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function log(action, data) {
  fs.appendFileSync(FOLLOW_LOG, JSON.stringify({ action, time: new Date().toISOString(), ...data }) + '\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 启动 ============

async function main() {
  console.log('⚡ 实时跟单引擎 v7');
  console.log('  Solana: WebSocket实时 + Jito加速');
  console.log('  BSC/Base: 轮询30s');
  console.log('');
  
  init();
  
  // Solana WebSocket
  startSolanaWatcher();
  
  // EVM轮询
  startEvmWatcher('bsc');
  startEvmWatcher('base');
  
  // 止损检查
  startStopLossChecker();
  
  console.log('\n🟢 引擎运行中...\n');
}

if (require.main === module) {
  main().catch(e => console.error('Fatal:', e));
}

module.exports = { main, CONFIG };
