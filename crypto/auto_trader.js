#!/usr/bin/env node
/**
 * 自动交易执行器 - Solana链
 * 
 * 监听scanner_daemon的信号 → 自动通过OKX DEX执行交易
 * 包含：买入、止盈（翻倍出本金）、止损（跟聪明钱）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
const ONCHAINOS = '/root/.local/bin/onchainos';
const NOTIFY_FILE = path.join(WORKSPACE, 'crypto', 'notifications.jsonl');
const POSITIONS_FILE = path.join(WORKSPACE, 'crypto', 'positions.json');
const TRADE_LOG = path.join(WORKSPACE, 'crypto', 'trade_log.jsonl');
const WALLET = 'jLVNxrQ6QX8neHx8bFeEvcTgRed4e4YXiePpfcPHosK';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const BUY_AMOUNT_SOL = 0.5;

// ============ 真实签名交易模块 ============
const { getSolanaKeypair } = require('./solana_signer');
const { Connection, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const { NATIVE_MINT, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
let solanaConn = null;
let cachedKeypair = null; // 预热密钥缓存

function getConn() {
  if (!solanaConn) solanaConn = new Connection(HELIUS_RPC, 'confirmed');
  return solanaConn;
}

// 预热密钥（启动时调用一次，缓存在内存）
function warmupKeypair() {
  if (!cachedKeypair) {
    cachedKeypair = getSolanaKeypair();
    log('🔑 密钥预热完成');
  }
  return cachedKeypair;
}

function getKeypair() {
  if (cachedKeypair) return cachedKeypair;
  return getSolanaKeypair();
}

/**
 * 确保 wSOL ATA 存在且有足够余额
 */
async function ensureWSOL(amountLamports) {
  const kp = getKeypair();
  const conn = getConn();
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
    
    let needCreate = false;
    let currentBalance = 0n;
    try {
      const acc = await getAccount(conn, wsolAta);
      currentBalance = acc.amount;
    } catch(e) {
      needCreate = true;
    }
    
    const needed = BigInt(amountLamports);
    if (currentBalance >= needed && !needCreate) return; // 够了
    
    const tx = new Transaction();
    if (needCreate) {
      tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, wsolAta, kp.publicKey, NATIVE_MINT));
    }
    
    // 转入差额
    const topUp = needed - currentBalance + 10000000n; // 多转 0.01 SOL buffer
    tx.add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAta, lamports: Number(topUp) }),
      createSyncNativeInstruction(wsolAta)
    );
    
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    
    const txHash = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(txHash, 'confirmed');
    log(`💧 wSOL补充: ${Number(topUp)/1e9} SOL → wSOL ATA`);
}

/**
 * 真实链上 swap: 获取报价 → 签名 → 发送 → 确认
 */
async function realSwap(fromToken, toToken, amount, slippage = 10) {
  const conn = getConn();
  
  // Step 1: onchainos 获取交易数据
  const swapResult = JSON.parse(execSync(
    `${ONCHAINOS} swap swap --chain solana --from ${fromToken} --to ${toToken} --amount ${amount} --slippage ${slippage} --wallet ${WALLET}`,
    { encoding: 'utf8', timeout: 15000 }
  ));
  
  if (!swapResult.ok || !swapResult.data?.[0]) {
    return { ok: false, error: swapResult.error || 'No swap data' };
  }
  
  const routerResult = swapResult.data[0].routerResult;
  const txData = swapResult.data[0].tx.data;
  
  // 安全检查：价格影响过大
  if (Math.abs(parseFloat(routerResult.priceImpactPercent || 0)) > 15) {
    return { ok: false, error: `Price impact too high: ${routerResult.priceImpactPercent}%` };
  }
  
  // Step 2: 签名
  const txBuffer = Buffer.from(bs58.decode(txData));
  const vtx = VersionedTransaction.deserialize(txBuffer);
  const kp = getKeypair();
  vtx.sign([kp]);
  
  // Step 3: 发送
  const txHash = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
  
  // Step 4: 等待确认（最多20秒）
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await conn.getSignatureStatus(txHash);
    if (status.value) {
      if (status.value.err) {
        return { ok: false, txHash, error: JSON.stringify(status.value.err) };
      }
      if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
        return { 
          ok: true, txHash, 
          fromAmount: routerResult.fromTokenAmount,
          toAmount: routerResult.toTokenAmount,
          fromSymbol: routerResult.fromToken.tokenSymbol,
          toSymbol: routerResult.toToken.tokenSymbol,
          priceImpact: routerResult.priceImpactPercent,
          method: 'okx_dex_signed'
        };
      }
    }
  }
  
  return { ok: true, txHash, status: 'pending', method: 'okx_dex_signed' };
}

// BSC/Base 模拟模式
const SIM_MODE = { bsc: true, base: true }; // true=模拟, false=实盘
const simBalance = {
  bsc: { USD: 100, positions: [] },
  base: { USD: 100, positions: [] }
};
const SIM_STATE_FILE = path.join(WORKSPACE, 'crypto', 'sim_evm_state.json');

function loadSimState() {
  try {
    const d = JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8'));
    if (d.bsc) simBalance.bsc = d.bsc;
    if (d.base) simBalance.base = d.base;
  } catch(e) {}
}
function saveSimState() {
  try { fs.writeFileSync(SIM_STATE_FILE, JSON.stringify(simBalance, null, 2)); } catch(e) {}
}
loadSimState();

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
function log(msg) { 
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(WORKSPACE, 'crypto', 'trader.log'), line + '\n'); } catch(e) {}
}

function notify(msg) {
  try { fs.appendFileSync(NOTIFY_FILE, JSON.stringify({ time: new Date().toISOString(), message: msg }) + '\n'); } catch(e) {}
  // 通过openclaw发送Telegram通知
  try {
    execSync(`openclaw send --channel telegram --to 877233818 "${msg.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, { timeout: 10000 });
  } catch(e) {}
  log(`📢 ${msg}`);
}

function logTrade(trade) {
  try { fs.appendFileSync(TRADE_LOG, JSON.stringify({ ...trade, time: new Date().toISOString() }) + '\n'); } catch(e) {}
}

// ============ 持仓管理 ============
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } 
  catch(e) { return { active: [], closed: [] }; }
}

function savePositions(pos) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(pos, null, 2));
}

// ============ 获取SOL余额 ============
async function getSOLBalance() {
  return new Promise((resolve) => {
    const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[WALLET]});
    const url = new URL(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve((JSON.parse(d).result?.value || 0) / 1e9); }
        catch(e) { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// ============ 获取代币价格（通过OKX） ============
function getTokenPrice(tokenAddress) {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market price ${tokenAddress} --chain solana 2>/dev/null`,
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(result);
    if (data.ok && data.data) return parseFloat(data.data.price || data.data.priceUsd || 0);
    return 0;
  } catch(e) { return 0; }
}

// ============ BSC/Base 模拟交易 ============
function simBuyEVM(chain, tokenAddress, reason, rawMsg) {
  const bal = simBalance[chain];
  const buyAmount = 10; // 每笔$10
  
  if (bal.USD < buyAmount) {
    log(`⏭️ [${chain.toUpperCase()}模拟] 余额不足: $${bal.USD.toFixed(2)}`);
    return;
  }
  
  // 检查是否已持仓
  if (bal.positions.find(p => p.token === tokenAddress)) {
    log(`⏭️ [${chain.toUpperCase()}模拟] 已持仓: ${tokenAddress.slice(0,12)}...`);
    return;
  }
  
  bal.USD -= buyAmount;
  bal.positions.push({
    token: tokenAddress,
    buyAmount,
    buyTime: new Date().toISOString(),
    reason,
    chain,
    simulated: true
  });
  
  saveSimState();
  logTrade({ action: 'SIM_BUY', chain, token: tokenAddress, amount: buyAmount, reason });
  notify(`🧪 [${chain.toUpperCase()}模拟] 买入!\n代币: ${tokenAddress.slice(0,12)}...\n金额: $${buyAmount}\n原因: ${reason}\n余额: $${bal.USD.toFixed(2)}`);
  log(`🧪 [${chain.toUpperCase()}模拟] 买入 ${tokenAddress.slice(0,12)}... $${buyAmount} | 余额: $${bal.USD.toFixed(2)}`);
}

// ============ EVM模拟卖出（按比例跟卖） ============
function simSellEVM(chain, tokenAddress, percent, reason) {
  const bal = simBalance[chain];
  const pos = bal.positions.find(p => p.token === tokenAddress);
  if (!pos) return;
  
  const sellAmount = pos.buyAmount * (percent / 100);
  pos.buyAmount -= sellAmount;
  bal.USD += sellAmount * (1 + (pos.pnlPct || 0) / 100); // 按当前盈亏比例回收
  
  log(`🧪 [${chain.toUpperCase()}模拟] 卖出${percent}% ${tokenAddress.slice(0,12)}... | $${sellAmount.toFixed(2)} | ${reason}`);
  
  if (pos.buyAmount <= 0.01) {
    bal.positions = bal.positions.filter(p => p.token !== tokenAddress);
    log(`🧪 [${chain.toUpperCase()}模拟] 清仓完毕: ${tokenAddress.slice(0,12)}...`);
  }
  
  saveSimState();
  logTrade({ action: 'SIM_SELL', chain, token: tokenAddress, percent, reason });
}

// ============ EVM模拟持仓监控（聪明钱比例跟卖） ============
async function monitorEVMPositions() {
  for (const chain of ['bsc', 'base']) {
    const bal = simBalance[chain];
    if (bal.positions.length === 0) continue;
    
    for (const p of bal.positions) {
      try {
        // 用DexScreener查当前价格
        const data = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${p.token}`);
        const pair = data?.pairs?.[0];
        if (!pair) continue;
        
        const currentMcap = pair.marketCap || pair.fdv || 0;
        const priceChange = pair.priceChange?.h1 || 0;
        p.currentMcap = currentMcap;
        p.pnlPct = priceChange;
        p.updatedAt = new Date().toISOString();
        
        // 读聪明钱持仓状态
        const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
        let holdings = {};
        try { holdings = JSON.parse(fs.readFileSync(smFile, 'utf8')); } catch(e) {}
        
        const record = holdings[p.token];
        if (record) {
          const originalCount = record.originalCount || 1;
          const currentCount = record.currentCount || 0;
          const exitRatio = 1 - (currentCount / originalCount);
          const alreadySold = p.smSoldPct || 0;
          
          if (exitRatio > alreadySold && exitRatio > 0.1) {
            const sellPct = Math.round((exitRatio - alreadySold) * 100);
            if (sellPct >= 10) {
              log(`🧪 [${chain.toUpperCase()}模拟] 聪明钱走了${Math.round(exitRatio*100)}% → 跟卖${sellPct}%`);
              simSellEVM(chain, p.token, sellPct, `聪明钱出走${Math.round(exitRatio*100)}%`);
              p.smSoldPct = exitRatio;
              
              if (currentCount === 0) {
                simSellEVM(chain, p.token, 100, '聪明钱全跑→清仓');
              }
            }
          }
        }
        
        // 翻倍出本金
        if (!p.halfSold && p.pnlPct >= 100) {
          simSellEVM(chain, p.token, 50, '翻倍出本金');
          p.halfSold = true;
        }
      } catch(e) {}
    }
  }
  saveSimState();
}

// ============ 合约安全检测（honeypot.is） ============
async function checkContractSafety(tokenAddress) {
  try {
    // 判断链类型（Solana地址是base58，EVM是0x开头）
    const isEVM = tokenAddress.startsWith('0x');
    
    if (isEVM) {
      // BSC=56, Base=8453
      const chainId = tokenAddress.length === 42 ? 56 : 8453; // 简化判断
      const resp = await httpGet(`https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chainID=${chainId}`);
      const data = JSON.parse(resp);
      
      const isHoneypot = data.honeypotResult?.isHoneypot;
      const buyTax = parseFloat(data.simulationResult?.buyTax || 0);
      const sellTax = parseFloat(data.simulationResult?.sellTax || 0);
      
      if (isHoneypot) return { ok: false, reason: '蜜罐! 无法卖出' };
      if (buyTax > 0) return { ok: false, reason: `买税${buyTax}%（只要0税）` };
      if (sellTax > 0) return { ok: false, reason: `卖税${sellTax}%（只要0税）` };
      
      return { ok: true, buyTax, sellTax };
    } else {
      // Solana: 暂时通过rugcheck.xyz检测
      try {
        const resp = await httpGet(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`);
        const data = JSON.parse(resp);
        if (data.score !== undefined && data.score < 300) {
          return { ok: false, reason: `RugCheck评分过低: ${data.score}` };
        }
        return { ok: true, buyTax: 0, sellTax: 0, rugScore: data.score };
      } catch(e) {
        // RugCheck不可用就放行，依赖聪明钱判断
        return { ok: true, buyTax: 0, sellTax: 0 };
      }
    }
  } catch(e) {
    // 检测失败不阻塞交易，记录日志
    log(`⚠️ 合约检测失败: ${e.message}，继续执行`);
    return { ok: true, buyTax: 0, sellTax: 0 };
  }
}



// Solana: 通过Jupiter + Jito Bundle防夹
async function solanaBuyAntiMEV(tokenAddress, amountSol) {
  const amountLamports = Math.floor(amountSol * 1e9);
  const SOL = 'So11111111111111111111111111111111111111112';
  
  try {
    // Step 1: Jupiter报价
    const quoteResp = await httpGet(`https://lite-api.jup.ag/v1/quote?inputMint=${SOL}&outputMint=${tokenAddress}&amount=${amountLamports}&slippageBps=500`);
    const quote = JSON.parse(quoteResp);
    if (!quote || quote.error) throw new Error('Jupiter报价失败: ' + (quote?.error || 'no data'));
    
    // Step 2: 构建swap交易（不广播）
    const swapResp = await httpPost('https://lite-api.jup.ag/v1/swap', JSON.stringify({
      quoteResponse: quote,
      userPublicKey: WALLET,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { jitoTipLamports: 1000000 } // 0.001 SOL Jito小费 = 防夹
    }));
    const swap = JSON.parse(swapResp);
    
    if (swap.swapTransaction) {
      // Step 3: 通过Jito Bundle发送（私密通道，不进公共mempool）
      const sendResp = await httpPost('https://mainnet.block-engine.jito.wtf/api/v1/transactions', 
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [swap.swapTransaction, { encoding: 'base64' }] })
      );
      const sendData = JSON.parse(sendResp);
      return { ok: true, txHash: sendData.result || 'jito_pending', method: 'jupiter+jito' };
    }
    
    throw new Error('No swapTransaction');
  } catch(e) {
    log(`⚠️ Jupiter+Jito失败(${e.message})，fallback到OKX DEX`);
    // Fallback: OKX DEX（也有一定防夹能力）
    return onchainsSwap('solana', SOL_MINT, tokenAddress, amountSol);
  }
}

// BSC: 通过私有mempool防夹
async function bscBuyAntiMEV(tokenAddress, amountBNB) {
  try {
    // 使用Flashbots Protect或BSC私有RPC
    // BSC的MEV Protect: 通过bloxroute或48club的私有RPC发送
    const tx = await buildEVMSwapTx('bsc', tokenAddress, amountBNB);
    
    // 发送到私有mempool（不广播到公共mempool）
    const privatePRCs = [
      'https://bsc-private.nodereal.io', // NodeReal私有
      'https://puissant-bsc.48.club',    // 48 Club MEV Protect
    ];
    
    for (const rpc of privatePRCs) {
      try {
        const resp = await httpPost(rpc, JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_sendRawTransaction',
          params: [tx.signedTx]
        }));
        const data = JSON.parse(resp);
        if (data.result) return { ok: true, txHash: data.result, method: 'bsc_private_mempool' };
      } catch(e) { continue; }
    }
    
    // Fallback: OKX DEX
    return onchainsSwap('bsc', 'native', tokenAddress, amountBNB);
  } catch(e) {
    log(`⚠️ BSC防夹失败: ${e.message}`);
    return onchainsSwap('bsc', 'native', tokenAddress, amountBNB);
  }
}

// Base: 通过Flashbots Protect防夹
async function baseBuyAntiMEV(tokenAddress, amountETH) {
  try {
    const tx = await buildEVMSwapTx('base', tokenAddress, amountETH);
    
    // Flashbots Protect RPC（交易不进公共mempool）
    const resp = await httpPost('https://rpc.flashbots.net/fast', JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_sendRawTransaction',
      params: [tx.signedTx]
    }));
    const data = JSON.parse(resp);
    if (data.result) return { ok: true, txHash: data.result, method: 'flashbots_protect' };
    
    // Fallback: OKX DEX
    return onchainsSwap('base', 'native', tokenAddress, amountETH);
  } catch(e) {
    log(`⚠️ Base防夹失败: ${e.message}`);
    return onchainsSwap('base', 'native', tokenAddress, amountETH);
  }
}

// Fallback: onchainos DEX swap
function onchainsSwap(chain, fromToken, toToken, amount) {
  // onchainos swap amount 要求最小单位
  // SOL: 9位小数 (1 SOL = 1e9 lamports)
  // BNB/ETH: 18位小数 (1 ETH = 1e18 wei)
  const decimals = { solana: 9, bsc: 18, base: 18, ethereum: 18 };
  const dec = decimals[chain] || 18;
  const minAmount = BigInt(Math.round(amount * (10 ** dec))).toString();
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} swap swap \
        --chain ${chain} \
        --from ${fromToken} \
        --to ${toToken} \
        --amount ${minAmount} \
        --slippage 5 \
        --wallet ${WALLET} \
        2>/dev/null`,
      { timeout: 30000 }
    ).toString();
    const data = JSON.parse(result);
    return { ok: data.ok || !!data.data?.txHash, txHash: data.data?.txHash || 'pending', method: 'okx_dex' };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// HTTP helpers
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// 构建EVM swap交易（待签名）
async function buildEVMSwapTx(chain, tokenAddress, amount) {
  // TODO: 用ethers.js构建PancakeSwap/Uniswap交易并用私钥签名
  // 目前返回空，走fallback到onchainos
  return { signedTx: null };
}
async function executeBuy(tokenAddress, reason) {
  log(`🛒 准备买入: ${tokenAddress.slice(0,12)}... | ${BUY_AMOUNT_SOL} SOL | 原因: ${reason}`);
  
  // Step 0: 合约安全检测（防蜜罐）
  const safe = await checkContractSafety(tokenAddress);
  if (!safe.ok) {
    notify(`🚫 合约不安全，跳过!\n${tokenAddress.slice(0,12)}...\n原因: ${safe.reason}`);
    return false;
  }
  log(`🛡️ 合约安全: 买税${safe.buyTax}% 卖税${safe.sellTax}%`);
  
  // 检查余额
  const balance = await getSOLBalance();
  if (balance < BUY_AMOUNT_SOL + 0.05) { // 留0.05 SOL给gas+wSOL
    notify(`⚠️ 买入失败 - 余额不足\n需要: ${(BUY_AMOUNT_SOL + 0.05).toFixed(2)} SOL\n当前: ${balance.toFixed(4)} SOL`);
    return false;
  }
  
  // 检查是否已持仓
  const pos = loadPositions();
  if (pos.active.find(p => p.token === tokenAddress)) {
    log(`⏭️ 已持仓: ${tokenAddress.slice(0,12)}...`);
    return false;
  }
  
  try {
    // 确保 wSOL 余额充足
    const amountLamports = Math.floor(BUY_AMOUNT_SOL * 1e9);
    await ensureWSOL(amountLamports);
    
    // 真实链上交易：onchainos报价 → 签名 → 发送
    const result = await realSwap(SOL_MINT, tokenAddress, amountLamports.toString(), 10);
    
    if (result.ok) {
      const buyPrice = getTokenPrice(tokenAddress);
      const txHash = result.txHash || 'pending';
      
      pos.active.push({
        token: tokenAddress,
        buyPrice,
        amountSol: BUY_AMOUNT_SOL,
        buyTime: new Date().toISOString(),
        txHash,
        reason,
        status: 'holding',
        halfSold: false,
        highestPrice: buyPrice,
        smSoldPct: 0,
      });
      
      // 记录买入时聪明钱持仓数量
      try {
        const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
        let holdings = {};
        try { holdings = JSON.parse(fs.readFileSync(smFile, 'utf8')); } catch(e) {}
        const smMatch = reason.match(/聪明钱.*?(\d+)/);
        const smCount = smMatch ? parseInt(smMatch[1]) : 6;
        holdings[tokenAddress] = { originalCount: smCount, currentCount: smCount, buyTime: new Date().toISOString() };
        fs.writeFileSync(smFile, JSON.stringify(holdings, null, 2));
      } catch(e) {}
      savePositions(pos);
      
      logTrade({ action: 'BUY', token: tokenAddress, amountSol: BUY_AMOUNT_SOL, price: buyPrice, txHash, reason, method: result.method });
      notify(`✅ 买入成功!\n代币: ${tokenAddress.slice(0,12)}...\n金额: ${BUY_AMOUNT_SOL} SOL\n价格: $${buyPrice.toFixed(8)}\n原因: ${reason}\nTx: ${txHash}\nhttps://solscan.io/tx/${txHash}`);
      return true;
    } else {
      notify(`❌ 买入失败\n${tokenAddress.slice(0,12)}...\n${result.error || 'unknown'}`);
      return false;
    }
  } catch(e) {
    log(`❌ 买入异常: ${e.message}`);
    notify(`❌ 买入异常: ${tokenAddress.slice(0,12)}...\n${e.message}`);
    return false;
  }
}

// ============ 执行卖出（真实链上） ============
async function executeSell(tokenAddress, percent, reason) {
  log(`💰 卖出: ${tokenAddress.slice(0,12)}... | ${percent}% | ${reason}`);
  
  try {
    // 获取 token 余额
    const balResult = JSON.parse(execSync(
      `${ONCHAINOS} portfolio all-balances --address ${WALLET} --chains solana`,
      { encoding: 'utf8', timeout: 15000 }
    ));
    
    let tokenBalance = '0';
    if (balResult.ok && balResult.data?.[0]?.tokenAssets) {
      const token = balResult.data[0].tokenAssets.find(t => t.tokenContractAddress === tokenAddress);
      if (token) tokenBalance = token.rawBalance || '0';
    }
    
    if (tokenBalance === '0' || tokenBalance === '0') {
      log(`⚠️ 无持仓余额: ${tokenAddress.slice(0,12)}...`);
      return false;
    }
    
    // 计算卖出数量
    const sellAmount = percent >= 100 
      ? tokenBalance 
      : Math.floor(parseInt(tokenBalance) * percent / 100).toString();
    
    // 真实链上卖出
    const result = await realSwap(tokenAddress, SOL_MINT, sellAmount, 15);
    
    if (result.ok) {
      const txHash = result.txHash || 'pending';
      logTrade({ action: 'SELL', token: tokenAddress, percent, reason, txHash });
      notify(`💰 卖出${percent}%成功!\n代币: ${tokenAddress.slice(0,12)}...\n原因: ${reason}\nTx: ${txHash}\nhttps://solscan.io/tx/${txHash}`);
      
      // 更新持仓
      const pos = loadPositions();
      const idx = pos.active.findIndex(p => p.token === tokenAddress);
      if (idx >= 0) {
        if (percent >= 100) {
          const closed = pos.active.splice(idx, 1)[0];
          closed.closeTime = new Date().toISOString();
          closed.closeReason = reason;
          pos.closed.push(closed);
        } else if (percent === 50) {
          pos.active[idx].halfSold = true;
        }
        savePositions(pos);
      }
      return true;
    } else {
      log(`❌ 卖出失败: ${result.error}`);
      return false;
    }
  } catch(e) {
    log(`❌ 卖出异常: ${e.message}`);
    return false;
  }
}

// ============ 监控持仓（止盈 + 聪明钱比例跟卖） ============
async function monitorPositions() {
  const pos = loadPositions();
  if (pos.active.length === 0) return;
  
  for (const p of pos.active) {
    const currentPrice = getTokenPrice(p.token);
    if (currentPrice <= 0) continue;
    
    // 更新最高价
    if (currentPrice > (p.highestPrice || 0)) {
      p.highestPrice = currentPrice;
    }
    
    const pnl = p.buyPrice > 0 ? (currentPrice / p.buyPrice - 1) * 100 : 0;
    
    // 更新实时数据（供看板读取）
    p.currentPrice = currentPrice;
    p.pnlPct = pnl;
    p.updatedAt = new Date().toISOString();
    
    // 止盈：翻倍卖一半
    if (!p.halfSold && pnl >= 100) {
      log(`🎉 翻倍了! ${p.token.slice(0,12)}... PNL: ${pnl.toFixed(0)}%`);
      await executeSell(p.token, 50, '翻倍出本金');
      p.halfSold = true;
    }
    
    // 聪明钱比例跟卖（不管有没有翻倍，聪明钱跑就跟着跑）
    try {
      const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
      if (fs.existsSync(smFile)) {
        const holdings = JSON.parse(fs.readFileSync(smFile, 'utf8'));
        const record = holdings[p.token];
        if (record) {
          const originalCount = p.smCountAtBuy || record.originalCount || 1;
          const currentCount = record.currentCount || 0;
          const exitRatio = 1 - (currentCount / originalCount); // 走了多少比例
          const alreadySold = p.smSoldPct || 0; // 我们已经卖了多少
          
          if (exitRatio > alreadySold && exitRatio > 0.1) {
            // 聪明钱又走了一批，跟着卖对应比例
            const sellPct = Math.round((exitRatio - alreadySold) * 100);
            if (sellPct >= 10) {
              log(`🏃 聪明钱走了${Math.round(exitRatio*100)}% (${currentCount}/${originalCount}): ${p.token.slice(0,12)}... → 跟卖${sellPct}%`);
              await executeSell(p.token, sellPct, `聪明钱出走${Math.round(exitRatio*100)}%→跟卖`);
              p.smSoldPct = exitRatio;
              
              if (currentCount === 0) {
                log(`🚨 聪明钱全跑了: ${p.token.slice(0,12)}... → 清仓`);
                await executeSell(p.token, 100, '聪明钱全部清仓');
              }
            }
          }
        }
      }
    } catch(e) {
      log(`⚠️ 聪明钱跟卖检查失败: ${e.message}`);
    }
  }
  
  savePositions(pos);
}

// ============ 同区块跟单（WebSocket实时监听聪明钱买入+卖出） ============
function startSmartMoneyWatcher() {
  const WebSocket = require('ws');
  
  // 加载核心聪明钱地址
  function getCoreSmartWallets() {
    try {
      const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'smart_money_rank.json'), 'utf8'));
      const core = (rank.solana || []).filter(w => w.tier && w.tier.includes('核心'));
      return new Map(core.map(w => [w.address, w]));
    } catch(e) { return new Map(); }
  }
  
  let coreWallets = getCoreSmartWallets();
  setInterval(() => { coreWallets = getCoreSmartWallets(); }, 300000); // 5分钟刷新
  
  let ws = null;
  let subId = null;
  
  function connectWS() {
    if (!HELIUS_KEY) { log('⚠️ 无Helius API Key，同区块跟单不可用'); return; }
    
    ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_2 || HELIUS_KEY}`);
    
    ws.on('open', () => {
      log(`⚡ 同区块跟单 WebSocket 已连接`);
      
      // 订阅所有核心聪明钱的交易（用 accountSubscribe 监听每个钱包）
      const walletAddrs = Array.from(coreWallets.keys());
      if (walletAddrs.length === 0) { log('⚠️ 无核心聪明钱地址'); return; }
      
      // 订阅核心聪明钱地址的账户变动（免费API）
      const addrsToWatch = walletAddrs.slice(0, 50);
      
      // 用 logsSubscribe 监听每个核心聪明钱
      for (const addr of addrsToWatch) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
          params: [{ mentions: [addr] }, { commitment: 'processed' }]
        }));
      }
      
      log(`👁️ 同区块监听 ${addrsToWatch.length} 个核心聪明钱`);
    });
    
    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        
        // 订阅确认
        if (msg.result !== undefined) return;
        
        if (!msg.params?.result?.value) return;
        
        const value = msg.params.result.value;
        const signature = value.signature;
        const logs = value.logs || [];
        const err = value.err;
        
        if (err) return; // 失败的交易跳过
        
        // 检查是否是 swap 交易
        const isSwap = logs.some(l => l.includes('Swap') || l.includes('swap') || l.includes('Instruction: SwapTo'));
        if (!isSwap) return;
        
        // 通过 Helius API 获取交易详情（解析出 token 变动）
        const conn = getConn();
        let txDetail;
        try {
          txDetail = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        } catch(e) { return; }
        
        if (!txDetail?.meta) return;
        
        const preBalances = txDetail.meta.preTokenBalances || [];
        const postBalances = txDetail.meta.postTokenBalances || [];
        const accountKeys = txDetail.transaction.message.accountKeys.map(k => k.pubkey?.toBase58 ? k.pubkey.toBase58() : k.pubkey || k);
        
        // 找涉及的聪明钱
        const smartAddr = accountKeys.find(k => coreWallets.has(k));
        if (!smartAddr) return;
        
        // 分析 token 流向
        const tokenChanges = {};
        for (const post of postBalances) {
          const owner = post.owner;
          if (owner !== smartAddr) continue;
          const mint = post.mint;
          if (mint === SOL_MINT || mint === 'So11111111111111111111111111111111111111112') continue;
          
          const postAmount = parseFloat(post.uiTokenAmount?.uiAmountString || '0');
          const pre = preBalances.find(p => p.owner === owner && p.mint === mint);
          const preAmount = pre ? parseFloat(pre.uiTokenAmount?.uiAmountString || '0') : 0;
          
          const delta = postAmount - preAmount;
          if (Math.abs(delta) > 0) {
            tokenChanges[mint] = { delta, postAmount, preAmount };
          }
        }
        
        // 处理买入信号
        for (const [tokenMint, change] of Object.entries(tokenChanges)) {
          if (change.delta > 0) {
            // ⚡ 聪明钱买入！同区块跟单
            log(`⚡⚡ 同区块检测: ${smartAddr.slice(0,8)}... 买入 ${tokenMint.slice(0,12)}... (${change.preAmount} → ${change.postAmount})`);
            
            // 检查是否已持仓
            const pos = loadPositions();
            if (pos.active.find(p => p.token === tokenMint)) {
              log(`⏭️ 已持仓，跳过: ${tokenMint.slice(0,12)}...`);
              continue;
            }
            
            // 统计同时买入的聪明钱数量和等级
            const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
            let holdings = {};
            try { holdings = JSON.parse(fs.readFileSync(smFile, 'utf8')); } catch(e) {}
            
            // 判断这个聪明钱的等级
            let walletTier = 'watch'; // 默认观察
            try {
              const rank = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', 'smart_money_rank.json'), 'utf8'));
              const found = (rank.solana || []).find(w => w.address === smartAddr);
              if (found && found.tier) {
                if (found.tier.includes('核心')) walletTier = 'core';
                else if (found.tier.includes('正常')) walletTier = 'normal';
              }
            } catch(e) {}
            
            if (!holdings[tokenMint]) {
              holdings[tokenMint] = { buyers: [], coreBuyers: [], normalBuyers: [], firstBuyAt: new Date().toISOString(), currentCount: 0 };
            }
            const h = holdings[tokenMint];
            if (!h.buyers) h.buyers = [];
            if (!h.coreBuyers) h.coreBuyers = [];
            if (!h.normalBuyers) h.normalBuyers = [];
            
            if (!h.buyers.includes(smartAddr)) {
              h.buyers.push(smartAddr);
              if (walletTier === 'core') h.coreBuyers.push(smartAddr);
              else if (walletTier === 'normal') h.normalBuyers.push(smartAddr);
              h.currentCount = h.buyers.length;
            }
            fs.writeFileSync(smFile, JSON.stringify(holdings, null, 2));
            
            const coreCount = h.coreBuyers.length;
            const normalCount = h.normalBuyers.length;
            const weight = coreCount * 3 + normalCount * 2; // 观察不计分
            
            // 至少1个核心 + 权重≥5 才跟单
            if (weight >= 5 && coreCount >= 1) {
              log(`🚀 权重${weight}分 (🥇${coreCount}+🥈${normalCount}) 买入 ${tokenMint.slice(0,12)}... → 同区块跟单!`);
              executeBuy(tokenMint, `同区块跟单(🥇${coreCount}核心+🥈${normalCount}正常)`);
            } else if (walletTier !== 'watch') {
              log(`👀 权重${weight}/5 (🥇${coreCount}+🥈${normalCount}) ${tokenMint.slice(0,12)}... (等更多核心/正常确认)`);
            }
          }
          
          if (change.delta < 0) {
            // ⚡ 聪明钱卖出！检查是否需要跟卖
            const pos = loadPositions();
            const myPos = pos.active.find(p => p.token === tokenMint);
            if (!myPos) continue;
            
            log(`⚡ 同区块检测: ${smartAddr.slice(0,8)}... 卖出 ${tokenMint.slice(0,12)}...`);
            
            // 更新聪明钱持仓数据
            const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
            let holdings = {};
            try { holdings = JSON.parse(fs.readFileSync(smFile, 'utf8')); } catch(e) {}
            
            if (holdings[tokenMint]) {
              holdings[tokenMint].currentCount = Math.max(0, (holdings[tokenMint].currentCount || 1) - 1);
              holdings[tokenMint].lastSellAt = new Date().toISOString();
              
              // 如果聪明钱全跑了 → 立刻清仓
              if (holdings[tokenMint].currentCount === 0) {
                log(`🚨⚡ 聪明钱全跑了! 同区块清仓: ${tokenMint.slice(0,12)}...`);
                executeSell(tokenMint, 100, '同区块跟卖-聪明钱全清');
              } else {
                // 按比例跟卖
                const original = holdings[tokenMint].originalCount || holdings[tokenMint].buyers?.length || 3;
                const current = holdings[tokenMint].currentCount;
                const exitRatio = 1 - (current / original);
                const alreadySold = myPos.smSoldPct || 0;
                const sellPct = Math.round((exitRatio - alreadySold) * 100);
                
                if (sellPct >= 15) {
                  log(`⚡ 聪明钱走了${Math.round(exitRatio*100)}% → 同区块跟卖${sellPct}%`);
                  executeSell(tokenMint, sellPct, `同区块跟卖${Math.round(exitRatio*100)}%`);
                }
              }
              
              fs.writeFileSync(smFile, JSON.stringify(holdings, null, 2));
            }
          }
        }
        
      } catch(e) {
        // 静默处理解析错误
      }
    });
    
    ws.on('close', () => {
      log('⚠️ 同区块WebSocket断开，5秒后重连...');
      setTimeout(connectWS, 5000);
    });
    ws.on('error', (e) => {
      log(`⚠️ 同区块WebSocket错误: ${e.message}`);
    });
  }
  
  connectWS();
}

// ============ 监听信号文件 ============
let lastSize = 0;
try { lastSize = fs.statSync(NOTIFY_FILE).size; } catch(e) {}

async function checkNewSignals() {
  try {
    const stat = fs.statSync(NOTIFY_FILE);
    if (stat.size <= lastSize) return;
    
    // 读取新增内容
    const fd = fs.openSync(NOTIFY_FILE, 'r');
    const buf = Buffer.alloc(stat.size - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;
    
    const newLines = buf.toString().trim().split('\n');
    for (const line of newLines) {
      try {
        const sig = JSON.parse(line);
        const msg = sig.message || '';
        
        // 判断是哪条链的信号
        const isBSC = msg.includes('[BSC]');
        const isBASE = msg.includes('[BASE]');
        const isSOL = msg.includes('[SOL]') || msg.includes('[SOLANA]');
        
        // 提取地址（统一用 "地址: XXX" 格式）
        const addrMatch = msg.match(/地址:\s*([A-Za-z0-9]+)/);
        const tokenAddr = addrMatch ? addrMatch[1] : null;
        
        // 横盘+聪明钱买入/加仓 = 买入信号
        if (msg.includes('横盘+聪明钱买入') || msg.includes('横盘+聪明钱加仓')) {
          if (tokenAddr) {
            if (isBSC || isBASE) {
              simBuyEVM(isBSC ? 'bsc' : 'base', tokenAddr, '横盘+聪明钱买入', msg);
            } else {
              executeBuy(tokenAddr, '横盘+聪明钱买入');
            }
          }
        } else if (msg.includes('横盘信号') || msg.includes('横盘观察')) {
          if (tokenAddr) {
            log(`👀 横盘信号观察: ${tokenAddr.slice(0,12)}... (等聪明钱买入/加仓确认)`);
          }
        }
        
        // 聪明钱共识跟单信号 → 直接买入（已经过权重筛选）
        // OKX观察信号（"聪明钱观察"）不触发买入
        if (msg.includes('聪明钱共识跟单')) {
          if (tokenAddr) {
            if (isBSC || isBASE) {
              simBuyEVM(isBSC ? 'bsc' : 'base', tokenAddr, '聪明钱共识跟单', msg);
            } else {
              executeBuy(tokenAddr, '聪明钱共识跟单');
            }
          } else {
            log(`⚠️ 聪明钱共识跟单信号但未找到地址: ${msg.slice(0,80)}`);
          }
        }
        
        // Mempool捕获信号（BSC/Base backrunning）
        if (msg.includes('Mempool捕获聪明钱买入')) {
          const addrMatch = msg.match(/Tx: (0x[a-fA-F0-9]+)/);
          const chain = isBSC ? 'bsc' : 'base';
          if (addrMatch && (isBSC || isBASE)) {
            log(`⚡ [${chain.toUpperCase()}] Mempool信号捕获，模拟跟单`);
          }
        }
        
        // ============ 聪明钱卖出信号 → 按权重跟卖 ============
        if (msg.includes('聪明钱卖出')) {
          if (tokenAddr) {
            const pos = loadPositions();
            const myPos = pos.active.find(p => p.token === tokenAddr);
            if (myPos) {
              // 判断卖出钱包的等级
              const isCoreExit = msg.includes('🥇核心');
              const isFullExit = msg.includes('全部清仓');
              
              // 读取该token的聪明钱持仓追踪
              const smFile = path.join(WORKSPACE, 'crypto', 'sm_holdings.json');
              let holdings = {};
              try { holdings = JSON.parse(fs.readFileSync(smFile, 'utf8')); } catch(e) {}
              const h = holdings[tokenAddr] || {};
              
              // 更新持仓追踪
              if (!h.exitedCore) h.exitedCore = 0;
              if (!h.exitedNormal) h.exitedNormal = 0;
              if (isCoreExit) h.exitedCore++;
              else h.exitedNormal++;
              
              const totalCore = (h.coreBuyers || []).length || 1;
              const totalNormal = (h.normalBuyers || []).length || 0;
              const remainCore = Math.max(0, totalCore - h.exitedCore);
              const remainNormal = Math.max(0, totalNormal - h.exitedNormal);
              
              // 买入时总权重
              const origWeight = totalCore * 3 + totalNormal * 2;
              // 当前剩余权重
              const currWeight = remainCore * 3 + remainNormal * 2;
              // 权重流失比例
              const weightLost = origWeight > 0 ? (1 - currWeight / origWeight) : 1;
              
              holdings[tokenAddr] = h;
              fs.writeFileSync(smFile, JSON.stringify(holdings, null, 2));
              
              // 决策
              if (remainCore === 0) {
                // 核心全跑了 → 直接清仓
                log(`🚨 核心全跑了! ${tokenAddr.slice(0,12)}... (🥇0剩余) → 清仓!`);
                await executeSell(tokenAddr, 100, '核心全清-立刻清仓');
              } else {
                // 按权重流失比例卖出
                const alreadySold = myPos.smSoldPct || 0;
                const targetSell = Math.round(weightLost * 100);
                const actualSell = Math.max(0, targetSell - Math.round(alreadySold * 100));
                
                if (actualSell >= 15) {
                  log(`🏃 权重流失${targetSell}% (🥇${remainCore}/${totalCore} 🥈${remainNormal}/${totalNormal}) → 跟卖${actualSell}%`);
                  await executeSell(tokenAddr, actualSell, `权重${targetSell}%流失-跟卖`);
                  myPos.smSoldPct = weightLost;
                  savePositions(pos);
                } else {
                  log(`👀 权重流失${targetSell}%，已卖${Math.round(alreadySold*100)}%，暂不操作`);
                }
              }
            }
          }
        }
        
      } catch(e) {}
    }
  } catch(e) {}
}

// ============ 主循环 ============
async function main() {
  log('🚀 自动交易器启动');
  warmupKeypair(); // 预热密钥
  
  const balance = await getSOLBalance();
  log(`💰 SOL余额: ${balance.toFixed(4)}`);
  log(`📋 每笔买入: ${BUY_AMOUNT_SOL} SOL`);
  
  const pos = loadPositions();
  log(`📊 当前持仓: ${pos.active.length}个`);
  
  // 文件监听（实时检测新信号，替代3秒轮询）
  fs.watchFile(NOTIFY_FILE, { interval: 500 }, () => { checkNewSignals(); });
  
  // 每30秒监控持仓（止盈止损兜底，主要走信号实时触发）
  setInterval(monitorPositions, 30 * 1000);
  setInterval(monitorEVMPositions, 3 * 60 * 1000); // EVM模拟持仓监控
  
  // 每30分钟报告状态
  setInterval(async () => {
    const bal = await getSOLBalance();
    const p = loadPositions();
    log(`📊 状态: SOL=${bal.toFixed(4)} | 持仓=${p.active.length}个 | 已关闭=${p.closed.length}个`);
  }, 30 * 60 * 1000);
  
  log('✅ 自动交易器就绪，等待信号...');
  // WebSocket跟单已合并到scanner_daemon，auto_trader只通过文件信号执行交易
}

main().catch(console.error);
