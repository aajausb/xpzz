/**
 * DEX交易模块 - 三链统一买卖（OKX聚合器）
 * Solana: OKX聚合器 + 自动wrap/unwrap wSOL
 * BSC/Base: OKX聚合器 + 自动approve
 */
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { ethers } = require('ethers');
const { getWallets } = require('../wallet_runtime');
const { execSync } = require('child_process');
const bs58 = require('bs58');

const SOL_RPC = 'https://api.mainnet-beta.solana.com';
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';

// 防夹RPC（私有交易，MEV bot看不到）
const JITO_BUNDLE_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const JITO_TIP_LAMPORTS = 1_000_000; // 0.001 SOL tip
const BSC_PRIVATE_RPC = 'https://bsc.rpc.blxrbdn.com'; // bloXroute私有交易
const BASE_PRIVATE_RPC = 'https://mainnet.base.org';      // Base MEV不严重，用公共RPC

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: process.env.OKX_API_KEY || '',
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || '',
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || ''
};

const NATIVE = {
  solana: 'So11111111111111111111111111111111111111112',
  bsc: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  base: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
};

// ============ Solana (OKX聚合器) ============

async function solanaBuy(tokenAddress, amountLamports, slippageBps = 500) {
  return solanaSwap(NATIVE.solana, tokenAddress, amountLamports, 'buy', slippageBps);
}

async function solanaSell(tokenAddress, amountRaw, slippageBps = 500) {
  return solanaSwap(tokenAddress, NATIVE.solana, amountRaw, 'sell', slippageBps);
}

async function solanaSwap(fromToken, toToken, amount, action, slippageBps = 500) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  // 交易用官方RPC
  const TRADE_RPC = 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(TRADE_RPC, { commitment: 'confirmed', disableRetryOnRateLimit: false });
  const slippage = (slippageBps / 100).toString();
  
  // 余额检查用key3（不跟引擎抢额度）
  if (fromToken === NATIVE.solana) {
    const checkConn = new Connection(SOL_RPC, 'confirmed');
    const solBal = await checkConn.getBalance(kp.publicKey);
    const needed = parseInt(amount);
    if (solBal < needed + 10000000) {
      throw new Error(`SOL余额不足: 需要${needed/1e9} SOL, 当前${solBal/1e9} SOL`);
    }
  }
  
  // 1. 获取swap交易数据
  const cmd = `onchainos swap swap --chain solana --from ${fromToken} --to ${toToken} --amount ${amount} --wallet ${w.solana.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(`OKX swap失败: ${result.error || JSON.stringify(result)}`);
  
  // 2. OKX返回base58编码的带空签名VersionedTransaction
  const decoded = bs58.decode(result.data[0].tx.data);
  const tx = VersionedTransaction.deserialize(decoded);
  tx.sign([kp]);
  
  // 3. 通过Jito Bundle发送（防夹+更快确认）
  let sig;
  try {
    sig = await sendViaJito(conn, kp, tx);
  } catch(e) {
    // Jito失败回退到普通发送
    console.log('[dex_trader] Jito失败,回退普通发送:', e.message);
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  }
  
  // 4. 确认（用blockhash超时，比轮询快）
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch(e) {
    // 确认超时不一定是失败，检查一次
    const status = await conn.getSignatureStatus(sig);
    if (status?.value?.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
    if (!status?.value) return { chain: 'solana', action, txHash: sig, success: false, note: '超时未确认' };
  }
  // 卖出后自动unwrap wSOL→SOL
  if (toToken === NATIVE.solana) {
    try { await unwrapWsol(conn, kp); } catch(e) {} 
  }
  return { chain: 'solana', action, txHash: sig, success: true, mev: 'jito' };
}

// ============ EVM (OKX聚合器) ============

async function evmBuy(chain, tokenAddress, amountWei, slippage = 3) {
  const chainName = chain === 'bsc' ? 'bsc' : 'base';
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  
  const cmd = `onchainos swap swap --chain ${chainName} --from ${NATIVE[chain]} --to ${tokenAddress} --amount ${amountWei} --wallet ${w.evm.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(`OKX swap失败: ${result.error || JSON.stringify(result)}`);
  
  const txData = result.data[0].tx;
  if (!txData.data || txData.data.length < 10) throw new Error('swap tx data为空');
  
  // 用私有RPC防夹（bloXroute for BSC, Flashbots for Base）
  const privateRpc = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const provider = new ethers.JsonRpcProvider(rpc);
  const privateProvider = new ethers.JsonRpcProvider(privateRpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, privateProvider);
  
  // gas溢价20%防止因gas不足revert
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 120n / 100n : undefined;
  const gasLimit = BigInt(txData.gas || '500000') * 120n / 100n;
  
  const txParams = {
    to: txData.to,
    data: txData.data,
    value: txData.value || '0',
    chainId,
    gasLimit,
    ...(gasPrice ? { gasPrice } : {})
  };
  
  let tx;
  try {
    tx = await privateWallet.sendTransaction(txParams);
  } catch(e) {
    console.log(`[dex_trader] 私有RPC失败(${chain}),回退:`, e.message?.slice(0, 60));
    tx = await wallet.sendTransaction(txParams);
  }
  
  // 异步确认（不阻塞返回）
  tx.wait().then(receipt => {
    if (receipt.status !== 1) console.error(`[dex_trader] ❌ ${chain} 买入revert: ${tx.hash}`);
    else console.log(`[dex_trader] ✅ ${chain} 买入确认 block=${receipt.blockNumber}`);
  }).catch(e => console.error(`[dex_trader] ❌ ${chain} 确认失败: ${e.message?.slice(0,80)}`));
  
  return { chain, action: 'buy', txHash: tx.hash, success: true, pending: true, mev: 'private' };
}

async function evmSell(chain, tokenAddress, amountRaw, slippage = 3) {
  const chainName = chain === 'bsc' ? 'bsc' : 'base';
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  
  // 1. Approve + gas预取（并行，不阻塞后续swap报价）
  const spenderAddr = '0x4409921Ae43a39a11D90F7B7F96cfd0B8093d9fC'; // OKX DEX Router
  const erc20 = new ethers.Contract(tokenAddress, [
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)'
  ], wallet);
  
  const [currentAllowance, feeData] = await Promise.all([
    erc20.allowance(wallet.address, spenderAddr),
    provider.getFeeData()
  ]);
  
  if (currentAllowance < BigInt(amountRaw)) {
    console.log(`[dex_trader] ${chain} approve: ${currentAllowance} < ${amountRaw}, approving max...`);
    const approveTx = await erc20.approve(spenderAddr, ethers.MaxUint256);
    await approveTx.wait();
    await sleep(1000);
  }
  
  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 120n / 100n : undefined;
  
  // 2. Swap报价→立即发送（最小化延迟）
  const cmd = `onchainos swap swap --chain ${chainName} --from ${tokenAddress} --to ${NATIVE[chain]} --amount ${amountRaw} --wallet ${w.evm.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(`OKX swap失败: ${result.error || JSON.stringify(result)}`);
  
  const txData = result.data[0].tx;
  if (!txData.data || txData.data.length < 10) throw new Error('swap tx data为空');
  const gasLimit = BigInt(txData.gas || '500000') * 120n / 100n;
  
  // 用私有RPC防夹
  const privateRpc = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const privateProvider = new ethers.JsonRpcProvider(privateRpc);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, privateProvider);

  const sellTxParams = { to: txData.to, data: txData.data, value: txData.value || '0', chainId, gasLimit, gasPrice };
  let tx;
  try {
    tx = await privateWallet.sendTransaction(sellTxParams);
  } catch(e) {
    console.log(`[dex_trader] 私有RPC卖出失败(${chain}),回退:`, e.message?.slice(0, 60));
    tx = await wallet.sendTransaction(sellTxParams);
  }
  
  // 异步确认
  tx.wait().then(receipt => {
    if (receipt.status !== 1) console.error(`[dex_trader] ❌ ${chain} 卖出revert: ${tx.hash}`);
    else console.log(`[dex_trader] ✅ ${chain} 卖出确认 block=${receipt.blockNumber}`);
  }).catch(e => console.error(`[dex_trader] ❌ ${chain} 卖出确认失败: ${e.message?.slice(0,80)}`));
  
  return { chain, action: 'sell', txHash: tx.hash, success: true, pending: true, mev: 'private' };
}

// ============ 统一接口 ============

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 3000]; // 快速重试（每次重新报价）

async function withRetry(fn, label) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch(e) {
      if (i === MAX_RETRIES) throw e;
      const delay = RETRY_DELAYS[i] || 6000;
      console.log(`⚠️ ${label} 失败(第${i+1}次), ${delay/1000}秒后重试: ${e.message}`);
      await sleep(delay);
    }
  }
}

async function buy(chain, tokenAddress, amountNative) {
  return withRetry(() => {
    if (chain === 'solana') return solanaBuy(tokenAddress, amountNative);
    return evmBuy(chain, tokenAddress, amountNative);
  }, `买入 ${chain} ${tokenAddress.slice(0,8)}`);
}

async function sell(chain, tokenAddress, amountRaw) {
  return withRetry(() => {
    if (chain === 'solana') return solanaSell(tokenAddress, amountRaw);
    return evmSell(chain, tokenAddress, amountRaw);
  }, `卖出 ${chain} ${tokenAddress.slice(0,8)}`);
}

// ============ Jito Bundle (SOL防夹) ============

async function sendViaJito(conn, kp, swapTx) {
  const fetch = require('node-fetch');
  const { SystemProgram, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
  
  // 获取tip account
  const tipRes = await fetch(JITO_BUNDLE_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] })
  });
  const tipData = await tipRes.json();
  const tipAccounts = tipData.result || [];
  if (tipAccounts.length === 0) throw new Error('无Jito tip accounts');
  const tipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
  
  // 创建tip交易
  const tipTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: tipAccount,
      lamports: JITO_TIP_LAMPORTS,
    })
  );
  tipTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tipTx.feePayer = kp.publicKey;
  tipTx.sign(kp);
  
  // 提交bundle: [swap交易, tip交易]
  const swapB64 = Buffer.from(swapTx.serialize()).toString('base64');
  const tipB64 = Buffer.from(tipTx.serialize()).toString('base64');
  
  const bundleRes = await fetch(JITO_BUNDLE_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendBundle',
      params: [[swapB64, tipB64]]
    })
  });
  const bundleData = await bundleRes.json();
  
  if (bundleData.error) throw new Error(`Jito bundle错误: ${bundleData.error.message || JSON.stringify(bundleData.error)}`);
  
  // 返回swap交易的signature
  const sig = bs58.encode(swapTx.signatures[0]);
  return sig;
}

// ============ 辅助函数 ============

async function ensureWsolBalance(conn, kp, lamportsNeeded) {
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { SystemProgram, Transaction } = require('@solana/web3.js');
  
  const owner = kp.publicKey;
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  
  const info = await conn.getAccountInfo(wsolAta);
  let currentBalance = 0;
  if (info) {
    const bal = await conn.getTokenAccountBalance(wsolAta);
    currentBalance = parseInt(bal.value.amount);
  }
  
  if (currentBalance >= lamportsNeeded) return; // 够了
  
  const needed = lamportsNeeded - currentBalance;
  const tx = new Transaction();
  
  if (!info) {
    tx.add(createAssociatedTokenAccountInstruction(owner, wsolAta, owner, NATIVE_MINT));
  }
  tx.add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: needed }),
    createSyncNativeInstruction(wsolAta)
  );
  
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = owner;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, 'confirmed');
}

async function unwrapWsol(conn, kp) {
  const { getAssociatedTokenAddress, createCloseAccountInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { Transaction } = require('@solana/web3.js');
  
  const owner = kp.publicKey;
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  const info = await conn.getAccountInfo(wsolAta);
  if (!info) return;
  
  // close wSOL ATA → SOL自动回到钱包
  const tx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, owner, owner)
  );
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = owner;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, 'confirmed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getWalletAddress(chain) {
  const w = getWallets();
  if (chain === 'solana') return w.solana.address;
  return w.evm.address;
}

module.exports = { buy, sell, solanaBuy, solanaSell, evmBuy, evmSell, getWalletAddress };
