/**
 * DEX交易模块 - 三链统一买卖
 * Solana: Raydium API + Helius RPC + 高priority fee
 * BSC/Base: OKX聚合器
 */
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { ethers } = require('ethers');
const { getWallets } = require('../wallet_runtime');
const { execSync } = require('child_process');
const crypto = require('crypto');
const bs58 = require('bs58');

const HELIUS_KEY = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';

const OKX_ENV = {
  ...process.env,
  OKX_API_KEY: '03f0b376-251c-4618-862e-ae92929e0416',
  OKX_SECRET_KEY: '652ECE8FF13210065B0851FFDA9191F7',
  OKX_PASSPHRASE: 'onchainOS#666'
};

const NATIVE = {
  solana: 'So11111111111111111111111111111111111111112',
  bsc: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  base: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
};

// ============ Solana (OKX聚合器) ============
// OKX Solana tx.data是base58编码的带空签名VersionedTransaction
// 需要bs58.decode → VersionedTransaction.deserialize → sign → send

async function solanaBuy(tokenAddress, amountLamports, slippageBps = 300) {
  return solanaSwap(NATIVE.solana, tokenAddress, amountLamports, 'buy', slippageBps);
}

async function solanaSell(tokenAddress, amountRaw, slippageBps = 300) {
  return solanaSwap(tokenAddress, NATIVE.solana, amountRaw, 'sell', slippageBps);
}

async function solanaSwap(fromToken, toToken, amount, action, slippageBps = 300) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  const conn = new Connection(HELIUS_RPC, 'confirmed');
  const slippage = (slippageBps / 100).toString();
  
  // 0. OKX合约要求wSOL ATA有余额，自动wrap（用户无感知）
  if (fromToken === NATIVE.solana) {
    await ensureWsolBalance(conn, kp, parseInt(amount));
  }
  
  // 1. 获取swap交易数据
  const cmd = `onchainos swap swap --chain solana --from ${fromToken} --to ${toToken} --amount ${amount} --wallet ${w.solana.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(result.error);
  
  // 2. OKX返回base58编码的带空签名VersionedTransaction
  const decoded = bs58.decode(result.data[0].tx.data);
  const tx = VersionedTransaction.deserialize(decoded);
  tx.sign([kp]);
  
  // 3. 发送
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  
  // 4. 轮询确认
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const status = await conn.getSignatureStatus(sig);
    if (status?.value) {
      if (status.value.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
        // 卖出后自动unwrap wSOL→SOL
        if (toToken === NATIVE.solana) {
          try { await unwrapWsol(conn, kp); } catch(e) { /* 忽略unwrap失败 */ }
        }
        return { chain: 'solana', action, txHash: sig, success: true };
      }
    }
  }
  return { chain: 'solana', action, txHash: sig, success: false, note: '超时未确认' };
}

// ============ EVM (OKX聚合器) ============

async function evmBuy(chain, tokenAddress, amountWei, slippage = 3) {
  const chainName = chain === 'bsc' ? 'bsc' : 'base';
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  
  const cmd = `onchainos swap swap --chain ${chainName} --from ${NATIVE[chain]} --to ${tokenAddress} --amount ${amountWei} --wallet 0xe00ca1d766f329eFfC05E704499f10dB1F14FD47 --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(result.error);
  
  const txData = result.data[0].tx;
  const w = getWallets();
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  
  const tx = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value || '0',
    chainId,
    gasLimit: BigInt(txData.gas || '500000')
  });
  
  const receipt = await tx.wait();
  return { chain, action: 'buy', txHash: tx.hash, success: receipt.status === 1, block: receipt.blockNumber };
}

async function evmSell(chain, tokenAddress, amountRaw, slippage = 3) {
  const chainName = chain === 'bsc' ? 'bsc' : 'base';
  const rpc = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  
  // 1. Approve (授权DEX合约使用token)
  try {
    const approveCmd = `onchainos swap approve --chain ${chainName} --token ${tokenAddress} --amount ${amountRaw}`;
    const ar = JSON.parse(execSync(approveCmd, { env: OKX_ENV, timeout: 10000 }).toString());
    if (ar.ok && ar.data?.[0]?.data && ar.data[0].data !== '0x') {
      const approveTx = await wallet.sendTransaction({
        to: tokenAddress,
        data: ar.data[0].data,
        value: 0,
        chainId,
        gasLimit: BigInt(ar.data[0].gasLimit || '100000')
      });
      await approveTx.wait();
      // 等2秒让nonce更新，避免swap nonce冲突
      await sleep(2000);
    }
  } catch(e) { /* 已approved或不需要 */ }
  
  // 2. Swap
  const cmd = `onchainos swap swap --chain ${chainName} --from ${tokenAddress} --to ${NATIVE[chain]} --amount ${amountRaw} --wallet ${w.evm.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(result.error);
  
  const txData = result.data[0].tx;
  if (!txData.data || txData.data.length < 10) throw new Error('swap tx data is empty');
  const tx = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value || '0',
    chainId,
    gasLimit: BigInt(txData.gas || '500000')
  });
  
  const receipt = await tx.wait();
  return { chain, action: 'sell', txHash: tx.hash, success: receipt.status === 1, block: receipt.blockNumber };
}

// ============ 统一接口 ============

async function buy(chain, tokenAddress, amountNative) {
  if (chain === 'solana') {
    return solanaBuy(tokenAddress, amountNative);
  } else {
    return evmBuy(chain, tokenAddress, amountNative);
  }
}

async function sell(chain, tokenAddress, amountRaw) {
  if (chain === 'solana') {
    return solanaSell(tokenAddress, amountRaw);
  } else {
    return evmSell(chain, tokenAddress, amountRaw);
  }
}

// ============ 辅助函数 ============

async function ensureWsolBalance(conn, kp, lamportsNeeded) {
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, NATIVE_MINT } = require('@solana/spl-token');
  const { SystemProgram, Transaction } = require('@solana/web3.js');
  
  const owner = kp.publicKey;
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  
  // 检查wSOL ATA是否存在
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

module.exports = { buy, sell, solanaBuy, solanaSell, evmBuy, evmSell };
