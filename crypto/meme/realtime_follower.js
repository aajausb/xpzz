/**
 * 实时跟单引擎 v7
 * 
 * Solana: Helius WebSocket订阅排名钱包交易
 * BSC/Base: 轮询排名钱包最近交易（WSS pending tx不可靠）
 * 
 * 检测到聪明钱swap → 解析token → 风控检查 → 自动跟单
 */

const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buy, sell } = require('./dex_trader');

const DATA_DIR = path.join(__dirname, 'data/v7');
const RANK_FILE = path.join(DATA_DIR, 'wallet_rank.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const FOLLOW_LOG = path.join(DATA_DIR, 'follow_log.jsonl');

const HELIUS_KEY = '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

// ============ 配置 ============

const CONFIG = {
  // 跟单钱包数量（排名前N）
  topWalletsToFollow: 30,
  
  // 仓位
  basePositionUsd: 5,          // 基础$5
  maxPositionUsd: 30,          // 单笔上限$30
  maxTotalPositions: 10,       // 最多10仓
  
  // SM数量加成
  smMultiplier: (smCount) => Math.min(smCount / 3, 3),  // 3个=1x, 9个=3x
  
  // 排名加成
  rankMultiplier: (rank) => rank <= 3 ? 1.5 : rank <= 10 ? 1.2 : 1.0,
  
  // 风控
  maxSoldPercent: 50,
  minHolders: 100,
  maxTop10Percent: 60,
  maxMarketCapUsd: 10_000_000,
  
  // 卖出跟随
  soldCheckInterval: 60_000,    // 1分钟检查聪明钱卖出情况
  stopLossPercent: -30,         // 亏30%止损（保底）
  
  // EVM轮询间隔
  evmPollInterval: 30_000,      // 30秒
};

// ============ 状态 ============

let positions = [];
let followedWallets = {};  // address → { rank, score, chain }
let recentBuys = {};       // tokenKey → timestamp (防重复)
let ws = null;

// ============ 初始化 ============

function loadRankedWallets() {
  try {
    const data = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
    const ranks = data.ranks || [];
    followedWallets = {};
    
    const solWallets = [];
    const bscWallets = [];
    const baseWallets = [];
    
    for (let i = 0; i < Math.min(CONFIG.topWalletsToFollow, ranks.length); i++) {
      const r = ranks[i];
      followedWallets[r.address] = { rank: i + 1, score: r.score, winRate: r.winRate, chains: r.chains };
      
      for (const chain of r.chains) {
        if (chain === 'solana') solWallets.push(r.address);
        else if (chain === 'bsc') bscWallets.push(r.address);
        else if (chain === 'base') baseWallets.push(r.address);
      }
    }
    
    console.log(`📋 跟踪钱包: SOL=${solWallets.length} BSC=${bscWallets.length} Base=${baseWallets.length}`);
    return { solWallets, bscWallets, baseWallets };
  } catch(e) {
    console.log('⚠️ 无排名数据，先运行 smart_money_ranker.js');
    return { solWallets: [], bscWallets: [], baseWallets: [] };
  }
}

function loadPositions() {
  try { positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch(e) { positions = []; }
}

function savePositions() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ============ Solana WebSocket实时监控 ============

function startSolanaWatcher(wallets) {
  if (wallets.length === 0) return;
  
  console.log(`🔌 Solana WebSocket: 监控${wallets.length}个钱包`);
  
  ws = new WebSocket(HELIUS_WS);
  
  ws.on('open', () => {
    // 分批订阅（每次最多10个地址）
    for (let i = 0; i < wallets.length; i += 10) {
      const batch = wallets.slice(i, i + 10);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'transactionSubscribe',
        params: [{
          accountInclude: batch
        }, {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0
        }]
      }));
    }
    console.log('  ✅ 订阅已发送');
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'transactionNotification') {
        await handleSolanaTransaction(msg.params.result);
      }
    } catch(e) {}
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket断开，5秒后重连');
    setTimeout(() => startSolanaWatcher(wallets), 5000);
  });
  
  ws.on('error', (e) => {
    console.log('WebSocket错误:', e.message?.slice(0, 60));
  });
}

async function handleSolanaTransaction(result) {
  const tx = result.transaction;
  if (!tx) return;
  
  // 检查是否是swap交易（有token转移）
  const meta = tx.meta;
  if (!meta || meta.err) return;
  
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];
  
  // 找出哪个钱包参与了
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  let triggerWallet = null;
  
  for (const key of accountKeys) {
    const addr = typeof key === 'string' ? key : key.pubkey;
    if (followedWallets[addr]) {
      triggerWallet = addr;
      break;
    }
  }
  
  if (!triggerWallet) return;
  
  // 解析买了什么token（post有余额增加的非SOL token）
  const boughtTokens = [];
  for (const post of postBalances) {
    const mint = post.mint;
    if (mint === 'So11111111111111111111111111111111111111112') continue; // 跳过SOL
    
    const pre = preBalances.find(p => p.mint === mint && p.owner === post.owner);
    const preBal = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
    const postBal = parseFloat(post.uiTokenAmount?.uiAmount || 0);
    
    if (postBal > preBal && post.owner === triggerWallet) {
      boughtTokens.push({
        mint,
        amount: postBal - preBal,
        decimals: post.uiTokenAmount?.decimals || 9
      });
    }
  }
  
  if (boughtTokens.length === 0) return;
  
  for (const token of boughtTokens) {
    const walletInfo = followedWallets[triggerWallet];
    console.log(`\n🔔 [SOL] ${triggerWallet.slice(0,8)}... (rank#${walletInfo.rank}) 买入 ${token.mint.slice(0,8)}...`);
    
    await tryFollow('solana', token.mint, triggerWallet, walletInfo);
  }
}

// ============ 跟单决策 ============

async function tryFollow(chain, tokenAddress, walletAddress, walletInfo) {
  const tokenKey = `${chain}:${tokenAddress}`;
  
  // 防重复（30分钟内同一token不重复跟）
  if (recentBuys[tokenKey] && Date.now() - recentBuys[tokenKey] < 1800_000) return;
  
  // 已持仓不重复
  if (positions.find(p => p.chain === chain && p.address === tokenAddress && p.status === 'open')) return;
  
  // 仓位上限
  const openPositions = positions.filter(p => p.status === 'open');
  if (openPositions.length >= CONFIG.maxTotalPositions) return;
  
  // 查token信息做风控
  let tokenInfo;
  try {
    const cmd = `onchainos market signal-list ${chain} --wallet-type "1"`;
    const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 30000, maxBuffer: 10*1024*1024 }).toString());
    const signals = result.data || [];
    
    // 找这个token的信号
    const tokenSignals = signals.filter(s => s.token.tokenAddress === tokenAddress);
    if (tokenSignals.length > 0) {
      const s = tokenSignals[0];
      tokenInfo = {
        symbol: s.token.symbol,
        holders: parseInt(s.token.holders) || 0,
        marketCap: parseFloat(s.token.marketCapUsd) || 0,
        top10: parseFloat(s.token.top10HolderPercent) || 0,
        soldPercent: parseFloat(s.soldRatioPercent) || 0,
        smCount: parseInt(s.triggerWalletCount) || 1
      };
    }
  } catch(e) {}
  
  // 如果signal-list里没有，用DexScreener
  if (!tokenInfo) {
    try {
      const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`).then(r=>r.json());
      const pair = dex.pairs?.[0];
      if (pair) {
        tokenInfo = {
          symbol: pair.baseToken?.symbol || '?',
          holders: 0,
          marketCap: parseFloat(pair.marketCap || 0),
          top10: 0,
          soldPercent: 0,
          smCount: 1
        };
      }
    } catch(e) {}
  }
  
  if (!tokenInfo) {
    console.log('  ⏭️ 无法获取token信息，跳过');
    return;
  }
  
  // 风控检查
  if (tokenInfo.soldPercent > CONFIG.maxSoldPercent) {
    console.log(`  ⏭️ ${tokenInfo.symbol} 聪明钱已卖${tokenInfo.soldPercent}%，跳过`);
    return;
  }
  if (tokenInfo.marketCap > CONFIG.maxMarketCapUsd) {
    console.log(`  ⏭️ ${tokenInfo.symbol} MC $${(tokenInfo.marketCap/1e6).toFixed(1)}M 太大，跳过`);
    return;
  }
  
  // 计算仓位大小
  const smMult = CONFIG.smMultiplier(tokenInfo.smCount);
  const rankMult = CONFIG.rankMultiplier(walletInfo.rank);
  let positionUsd = Math.min(CONFIG.basePositionUsd * smMult * rankMult, CONFIG.maxPositionUsd);
  positionUsd = Math.round(positionUsd * 100) / 100;
  
  console.log(`  🎯 ${tokenInfo.symbol} | SM=${tokenInfo.smCount} rank#${walletInfo.rank} | $${positionUsd}`);
  
  // 执行买入
  try {
    const amount = await usdToNative(chain, positionUsd);
    const result = await buy(chain, tokenAddress, amount.toString());
    
    if (result.success) {
      const position = {
        chain,
        address: tokenAddress,
        symbol: tokenInfo.symbol,
        buyTxHash: result.txHash,
        buyTime: Date.now(),
        buyPriceUsd: positionUsd,
        triggerWallet: walletAddress,
        triggerRank: walletInfo.rank,
        smCount: tokenInfo.smCount,
        entrySoldPercent: tokenInfo.soldPercent,
        status: 'open'
      };
      positions.push(position);
      savePositions();
      recentBuys[tokenKey] = Date.now();
      
      log('BUY', { chain, symbol: tokenInfo.symbol, usd: positionUsd, rank: walletInfo.rank, tx: result.txHash });
      console.log(`  ✅ 买入成功 $${positionUsd} | ${result.txHash.slice(0,20)}...`);
    }
  } catch(e) {
    console.log(`  ❌ 买入失败: ${e.message?.slice(0, 60)}`);
  }
}

// ============ 卖出监控（跟聪明钱卖出比例） ============

async function checkSellSignals() {
  const openPositions = positions.filter(p => p.status === 'open');
  if (openPositions.length === 0) return;
  
  for (const pos of openPositions) {
    try {
      // 查当前signal-list中的soldPercent
      let currentSold = null;
      try {
        const cmd = `onchainos market signal-list ${pos.chain} --wallet-type "1"`;
        const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 30000, maxBuffer: 10*1024*1024 }).toString());
        const sig = (result.data || []).find(s => s.token.tokenAddress === pos.address);
        if (sig) currentSold = parseFloat(sig.soldRatioPercent);
      } catch(e) {}
      
      if (currentSold === null) continue;
      
      // 聪明钱卖出比例增加 → 跟卖
      const soldIncrease = currentSold - (pos.entrySoldPercent || 0);
      
      let sellPercent = 0;
      let reason = '';
      
      if (currentSold >= 80) {
        sellPercent = 100;
        reason = `聪明钱卖出${currentSold.toFixed(0)}%，全卖`;
      } else if (currentSold >= 60) {
        sellPercent = 60;
        reason = `聪明钱卖出${currentSold.toFixed(0)}%，卖60%`;
      } else if (currentSold >= 40 && soldIncrease >= 15) {
        sellPercent = 40;
        reason = `聪明钱加速卖出(+${soldIncrease.toFixed(0)}%)，卖40%`;
      }
      
      // 保底止损
      const currentValue = await getPositionValue(pos);
      if (currentValue !== null) {
        const pnl = ((currentValue - pos.buyPriceUsd) / pos.buyPriceUsd) * 100;
        if (pnl <= CONFIG.stopLossPercent) {
          sellPercent = 100;
          reason = `止损 ${pnl.toFixed(1)}%`;
        }
      }
      
      if (sellPercent > 0) {
        await executeSell(pos, sellPercent, reason);
      }
      
    } catch(e) {}
  }
}

async function executeSell(pos, sellPercent, reason) {
  console.log(`\n🔴 卖出 ${pos.symbol} (${pos.chain}) ${sellPercent}% — ${reason}`);
  
  try {
    const { getTokenBalance } = require('./smart_money_v7');
    let balance = await getTokenBalanceLocal(pos.chain, pos.address);
    if (!balance || balance === '0') {
      pos.status = 'closed';
      savePositions();
      return;
    }
    
    // 部分卖出
    if (sellPercent < 100) {
      balance = (BigInt(balance) * BigInt(sellPercent) / 100n).toString();
    }
    
    const result = await sell(pos.chain, pos.address, balance);
    if (result.success) {
      if (sellPercent >= 100) {
        pos.status = 'closed';
        pos.closeReason = reason;
      } else {
        pos.partialSells = (pos.partialSells || 0) + 1;
        pos.totalSoldPercent = (pos.totalSoldPercent || 0) + sellPercent;
      }
      pos.lastSellTime = Date.now();
      savePositions();
      log('SELL', { chain: pos.chain, symbol: pos.symbol, percent: sellPercent, reason, tx: result.txHash });
      console.log(`  ✅ 卖出${sellPercent}%成功`);
    }
  } catch(e) {
    console.log(`  ❌ 卖出失败: ${e.message?.slice(0, 60)}`);
  }
}

// ============ 辅助 ============

async function getTokenBalanceLocal(chain, tokenAddress) {
  try {
    if (chain === 'solana') {
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const { getWallets } = require('../wallet_runtime');
      const w = getWallets();
      const conn = new Connection(HELIUS_RPC);
      const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), new PublicKey(w.solana.address));
      const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
      return bal?.value?.amount || '0';
    } else {
      const { ethers } = require('ethers');
      const { getWallets } = require('../wallet_runtime');
      const w = getWallets();
      const rpc = chain === 'bsc' ? 'https://bsc-dataseed1.binance.org' : 'https://mainnet.base.org';
      const provider = new ethers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
      return (await contract.balanceOf(w.evm.address)).toString();
    }
  } catch(e) { return '0'; }
}

async function getPositionValue(pos) {
  try {
    const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.address}`).then(r=>r.json());
    const price = parseFloat(dex.pairs?.[0]?.priceUsd || 0);
    if (!price) return null;
    const balance = await getTokenBalanceLocal(pos.chain, pos.address);
    if (!balance || balance === '0') return 0;
    // 估算（需要知道decimals）
    const decimals = parseInt(dex.pairs?.[0]?.baseToken?.decimals || 18);
    return (parseFloat(balance) / 10**decimals) * price;
  } catch(e) { return null; }
}

async function usdToNative(chain, usd) {
  const prices = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin,ethereum&vs_currencies=usd').then(r=>r.json());
  if (chain === 'solana') return Math.ceil((usd / prices.solana.usd) * 1e9);
  if (chain === 'bsc') return BigInt(Math.ceil((usd / prices.binancecoin.usd) * 1e18)).toString();
  if (chain === 'base') return BigInt(Math.ceil((usd / prices.ethereum.usd) * 1e18)).toString();
}

function log(action, data) {
  const line = JSON.stringify({ action, time: new Date().toISOString(), ...data }) + '\n';
  fs.appendFileSync(FOLLOW_LOG, line);
}

// ============ 主函数 ============

async function main() {
  console.log('⚡ 实时跟单引擎启动');
  
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  loadPositions();
  
  const { solWallets, bscWallets, baseWallets } = loadRankedWallets();
  
  // Solana: WebSocket实时
  startSolanaWatcher(solWallets);
  
  // 卖出监控循环
  setInterval(async () => {
    try { await checkSellSignals(); } catch(e) {}
  }, CONFIG.soldCheckInterval);
  
  // EVM: 轮询signal-list新信号（暂时方案）
  setInterval(async () => {
    try {
      for (const chain of ['bsc', 'base']) {
        const cmd = `onchainos market signal-list ${chain} --wallet-type "1"`;
        const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 30000, maxBuffer: 10*1024*1024 }).toString());
        
        for (const s of (result.data || [])) {
          const wallets = (s.triggerWalletAddress || '').split(',').filter(Boolean);
          // 找排名钱包
          for (const w of wallets) {
            if (followedWallets[w]) {
              const age = (Date.now() - parseInt(s.timestamp)) / 60000;
              if (age < 10) { // 只跟10分钟内的
                await tryFollow(chain, s.token.tokenAddress, w, followedWallets[w]);
              }
            }
          }
        }
      }
    } catch(e) {}
  }, CONFIG.evmPollInterval);
  
  console.log('🟢 引擎运行中...');
}

if (require.main === module) {
  main().catch(e => console.error('Fatal:', e));
}

module.exports = { main, CONFIG };
