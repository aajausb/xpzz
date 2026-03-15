/**
 * DEX交易模块 - 三链统一买卖（直接调OKX DEX API，无CLI依赖）
 * Solana: OKX聚合器 + Jito Bundle防夹
 * BSC/Base: OKX聚合器 + 私有RPC防夹 + 自动approve max
 */
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { ethers } = require('ethers');
const { getWallets } = require('../wallet_runtime');
const crypto = require('crypto');
const fetch = require('node-fetch');
const bs58 = require('bs58');

// ============ 配置 ============
// SOL交易RPC：官方为主（快），PublicNode备用（不429）
// SOL交易专用RPC（跟引擎的官方RPC隔离，不互相抢）
const SOL_RPC = 'https://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/';
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';
const BSC_PRIVATE_RPC = 'https://bsc.rpc.blxrbdn.com';
const BASE_PRIVATE_RPC = 'https://mainnet.base.org';

const JITO_BUNDLE_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const JITO_TIP_LAMPORTS = 1_000_000;

const OKX_API_KEY = process.env.OKX_API_KEY || '';
const OKX_SECRET = process.env.OKX_SECRET_KEY || '';
const OKX_PASS = process.env.OKX_PASSPHRASE || '';

const NATIVE = {
  solana: '11111111111111111111111111111111',  // OKX V6用原生SOL地址（不是wSOL）
  bsc: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  base: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
};

const CHAIN_ID = { solana: '501', bsc: '56', base: '8453' };

// ============ OKX API 直接调用 ============

function okxSign(ts, method, path, body = '') {
  return crypto.createHmac('sha256', OKX_SECRET).update(ts + method + path + body).digest('base64');
}

async function okxGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = path + (qs ? '?' + qs : '');
  const ts = new Date().toISOString();
  const sig = okxSign(ts, 'GET', fullPath);
  const r = await fetch('https://web3.okx.com' + fullPath, {
    headers: {
      'OK-ACCESS-KEY': OKX_API_KEY,
      'OK-ACCESS-SIGN': sig,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': OKX_PASS,
      'OK-ACCESS-PROJECT': '',
    }
  });
  return r.json();
}

async function okxSwapQuote(chainId, from, to, amount, wallet, slippagePercent) {
  return okxGet('/api/v6/dex/aggregator/swap', {
    chainIndex: chainId, fromTokenAddress: from, toTokenAddress: to,
    amount, slippagePercent: slippagePercent.toString(),
    userWalletAddress: wallet
  });
}

async function okxApprove(chainId, tokenAddress, amount) {
  return okxGet('/api/v6/dex/aggregator/approve-transaction', {
    chainIndex: chainId, tokenContractAddress: tokenAddress, approveAmount: amount
  });
}

// ============ Solana ============

async function solanaBuy(tokenAddress, amountLamports, slippageBps = 500) {
  return solanaSwap(NATIVE.solana, tokenAddress, amountLamports, 'buy', slippageBps);
}

async function solanaSell(tokenAddress, amountRaw, slippageBps = 500) {
  return solanaSwap(tokenAddress, NATIVE.solana, amountRaw, 'sell', slippageBps);
}

async function solanaSwap(fromToken, toToken, amount, action, slippageBps = 500) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  const conn = new Connection(SOL_RPC, { commitment: 'confirmed' });

  // 0. 尝试确保wSOL有余额（某些路由需要），失败不阻塞（meme币一般不需要）
  if (fromToken === NATIVE.solana) {
    try { await ensureWsolBalance(conn, kp, parseInt(amount)); }
    catch(e) { console.log('[dex_trader] wSOL wrap跳过:', e.message?.slice(0,50)); }
  }

  // 1. OKX报价（直接HTTP，~100ms）
  const quote = await okxSwapQuote(CHAIN_ID.solana, fromToken, toToken, amount.toString(), w.solana.address, slippageBps / 100);
  if (quote.code !== '0' || !quote.data?.[0]) throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0,100)}`);

  // 2. 签名
  const decoded = bs58.decode(quote.data[0].tx.data);
  const tx = VersionedTransaction.deserialize(decoded);
  tx.sign([kp]);

  // 3. 直接发送（OKX聚合器自带minReceiveAmount防夹，不需要Jito）
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });

  // 4. HTTP轮询确认
  let confirmed = false;
  for (let i = 0; i < 15; i++) {
    await sleep(800);
    try {
      const status = await conn.getSignatureStatus(sig);
      if (status?.value?.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
        confirmed = true;
        break;
      }
    } catch(e) { if (e.message?.includes('交易失败')) throw e; }
  }

  if (!confirmed) {
    return { chain: 'solana', action, txHash: sig, success: false, error: 'SOL确认超时12s' };
  }

  return { chain: 'solana', action, txHash: sig, success: true };
}

// ============ EVM (BSC/Base) ============

async function evmBuy(chain, tokenAddress, amountWei, slippage = 3) {
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = new ethers.JsonRpcProvider(rpc);
  const privateRpc = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const privateProvider = new ethers.JsonRpcProvider(privateRpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, privateProvider);

  // 报价 + gas 并行
  const [quote, feeData] = await Promise.all([
    okxSwapQuote(CHAIN_ID[chain], NATIVE[chain], tokenAddress, amountWei.toString(), w.evm.address, slippage),
    provider.getFeeData()
  ]);
  if (quote.code !== '0' || !quote.data?.[0]) throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0,100)}`);

  const txData = quote.data[0].tx;
  if (!txData?.data || txData.data.length < 10) throw new Error('swap tx data为空');

  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 150n / 100n : undefined;
  const gasLimit = BigInt(txData.gas || '500000') * 150n / 100n;
  const txParams = { to: txData.to, data: txData.data, value: txData.value || '0', chainId, gasLimit, ...(gasPrice ? { gasPrice } : {}) };

  let tx;
  try { tx = await privateWallet.sendTransaction(txParams); }
  catch(e) {
    console.log(`[dex_trader] 私有RPC失败(${chain}):`, e.message?.slice(0, 40));
    tx = await wallet.sendTransaction(txParams);
  }

  // 等确认（最多15秒），确认失败返回失败
  try {
    const receipt = await tx.wait(1);  // 等1个确认
    if (receipt.status !== 1) {
      console.error(`[dex_trader] ❌ ${chain} 买入revert: ${tx.hash}`);
      return { chain, action: 'buy', txHash: tx.hash, success: false, error: 'revert' };
    }
    console.log(`[dex_trader] ✅ ${chain} 买入确认 block=${receipt.blockNumber}`);
  } catch(e) {
    console.error(`[dex_trader] ❌ ${chain} 确认失败: ${e.message?.slice(0,60)}`);
    return { chain, action: 'buy', txHash: tx.hash, success: false, error: e.message?.slice(0,60) };
  }

  return { chain, action: 'buy', txHash: tx.hash, success: true, mev: 'private' };
}

async function evmSell(chain, tokenAddress, amountRaw, slippage = 3) {
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  const privateRpc = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const privateProvider = new ethers.JsonRpcProvider(privateRpc);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, privateProvider);

  // 1. 检查链上allowance（自己查，OKX API不查）
  const approveResult = await okxApprove(CHAIN_ID[chain], tokenAddress, amountRaw.toString());
  const spender = approveResult.data?.[0]?.dexContractAddress;
  
  if (spender) {
    const erc20 = new ethers.Contract(tokenAddress, [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)'
    ], wallet);
    const allowance = await erc20.allowance(wallet.address, spender);
    if (allowance < BigInt(amountRaw)) {
      console.log(`[dex_trader] ${chain} approve max to ${spender}...`);
      const approveTx = await erc20.approve(spender, ethers.MaxUint256);
      await approveTx.wait();
      await new Promise(r => setTimeout(r, 1000)); // 等nonce同步，防止swap revert
    }
  }

  // 2. gas + swap报价并行（approve之后再报价，确保nonce对）
  const [feeData, quote] = await Promise.all([
    provider.getFeeData(),
    okxSwapQuote(CHAIN_ID[chain], tokenAddress, NATIVE[chain], amountRaw.toString(), w.evm.address, slippage)
  ]);

  if (quote.code !== '0' || !quote.data?.[0]) throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0,100)}`);
  const txData = quote.data[0].tx;
  if (!txData?.data || txData.data.length < 10) throw new Error('swap tx data为空');

  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 150n / 100n : undefined;
  const gasLimit = BigInt(txData.gas || '500000') * 150n / 100n;
  const sellTxParams = { to: txData.to, data: txData.data, value: txData.value || '0', chainId, gasLimit, ...(gasPrice ? { gasPrice } : {}) };

  let tx;
  try { tx = await privateWallet.sendTransaction(sellTxParams); }
  catch(e) {
    console.log(`[dex_trader] 私有RPC卖出失败(${chain}):`, e.message?.slice(0, 40));
    tx = await wallet.sendTransaction(sellTxParams);
  }

  // 等确认
  try {
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) {
      console.error(`[dex_trader] ❌ ${chain} 卖出revert: ${tx.hash}`);
      return { chain, action: 'sell', txHash: tx.hash, success: false, error: 'revert' };
    }
    console.log(`[dex_trader] ✅ ${chain} 卖出确认 block=${receipt.blockNumber}`);
  } catch(e) {
    console.error(`[dex_trader] ❌ ${chain} 卖出确认失败: ${e.message?.slice(0,60)}`);
    return { chain, action: 'sell', txHash: tx.hash, success: false, error: e.message?.slice(0,60) };
  }

  return { chain, action: 'sell', txHash: tx.hash, success: true, mev: 'private' };
}

// ============ 统一接口 ============

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 3000];

async function withRetry(fn, label) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch(e) {
      if (i === MAX_RETRIES) throw e;
      console.log(`⚠️ ${label} 失败(第${i+1}次), ${RETRY_DELAYS[i]/1000}秒后重试: ${e.message}`);
      await sleep(RETRY_DELAYS[i]);
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

// Jito Bundle已移除 — OKX聚合器自带minReceiveAmount防夹保护

// ============ 辅助 ============

async function ensureWsolBalance(conn, kp, lamportsNeeded) {
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { SystemProgram, Transaction } = require('@solana/web3.js');
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  
  const tx = new Transaction();
  const info = await conn.getAccountInfo(wsolAta);
  
  if (!info) {
    tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, wsolAta, kp.publicKey, NATIVE_MINT));
  }
  
  // 检查wSOL余额
  let currentBalance = 0;
  if (info) {
    try {
      const bal = await conn.getTokenAccountBalance(wsolAta);
      currentBalance = parseInt(bal.value.amount);
    } catch(e) {}
  }
  
  const needed = lamportsNeeded - currentBalance;
  if (needed <= 0) return; // 够了
  
  console.log(`[dex_trader] wrap ${needed/1e9} SOL → wSOL`);
  tx.add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: wsolAta, lamports: needed }),
    createSyncNativeInstruction(wsolAta)
  );
  
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, 'confirmed');
}

async function unwrapWsol(conn, kp) {
  const { getAssociatedTokenAddress, createCloseAccountInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { Transaction } = require('@solana/web3.js');
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  if (!(await conn.getAccountInfo(wsolAta))) return;
  const tx = new Transaction().add(createCloseAccountInstruction(wsolAta, kp.publicKey, kp.publicKey));
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, 'confirmed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getWalletAddress(chain) {
  const w = getWallets();
  return chain === 'solana' ? w.solana.address : w.evm.address;
}

module.exports = { buy, sell, solanaBuy, solanaSell, evmBuy, evmSell, getWalletAddress };
