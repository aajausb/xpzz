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

// ============ Solana (Raydium) ============

async function solanaBuy(tokenAddress, amountLamports, slippageBps = 300) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  const conn = new Connection(HELIUS_RPC, 'confirmed');
  
  // 1. 报价
  const quoteRes = await fetch(
    `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${NATIVE.solana}&outputMint=${tokenAddress}&amount=${amountLamports}&slippageBps=${slippageBps}&txVersion=V0`
  );
  const quote = await quoteRes.json();
  if (!quote.success) throw new Error(`报价失败: ${JSON.stringify(quote)}`);
  
  // 2. 获取priority fee
  const feeRes = await fetch(`https://transaction-v1.raydium.io/compute/priority-fee`);
  const feeData = await feeRes.json();
  const priorityFee = String(feeData?.data?.h || '1000000'); // 默认1M micro-lamports
  
  // 3. 构建交易
  const swapRes = await fetch('https://transaction-v1.raydium.io/transaction/swap-base-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: priorityFee,
      swapResponse: quote,
      txVersion: 'V0',
      wallet: w.solana.address,
      wrapSol: true,
      unwrapSol: false
    })
  });
  const swapData = await swapRes.json();
  if (!swapData.success) throw new Error(`Swap构建失败: ${JSON.stringify(swapData)}`);
  
  // 4. 签名发送
  const txBuf = Buffer.from(swapData.data[0].transaction, 'base64');
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
  tx.sign([kp]);
  
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  
  // 5. 轮询确认
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const status = await conn.getSignatureStatus(sig);
    if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
      if (status.value.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      return { chain: 'solana', action: 'buy', txHash: sig, success: true };
    }
  }
  return { chain: 'solana', action: 'buy', txHash: sig, success: false, note: '超时未确认' };
}

async function solanaSell(tokenAddress, amountRaw, slippageBps = 300) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  const conn = new Connection(HELIUS_RPC, 'confirmed');
  
  const quoteRes = await fetch(
    `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${tokenAddress}&outputMint=${NATIVE.solana}&amount=${amountRaw}&slippageBps=${slippageBps}&txVersion=V0`
  );
  const quote = await quoteRes.json();
  if (!quote.success) throw new Error(`报价失败: ${JSON.stringify(quote)}`);
  
  const feeRes = await fetch(`https://transaction-v1.raydium.io/compute/priority-fee`);
  const feeData = await feeRes.json();
  const priorityFee = String(feeData?.data?.h || '1000000');
  
  const swapRes = await fetch('https://transaction-v1.raydium.io/transaction/swap-base-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: priorityFee,
      swapResponse: quote,
      txVersion: 'V0',
      wallet: w.solana.address,
      wrapSol: false,
      unwrapSol: true
    })
  });
  const swapData = await swapRes.json();
  if (!swapData.success) throw new Error(`Swap构建失败: ${JSON.stringify(swapData)}`);
  
  const txBuf = Buffer.from(swapData.data[0].transaction, 'base64');
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
  tx.sign([kp]);
  
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const status = await conn.getSignatureStatus(sig);
    if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
      if (status.value.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      return { chain: 'solana', action: 'sell', txHash: sig, success: true };
    }
  }
  return { chain: 'solana', action: 'sell', txHash: sig, success: false, note: '超时未确认' };
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
      // approve的to是token合约地址，data里包含spender(DEX)和amount
      const approveTx = await wallet.sendTransaction({
        to: tokenAddress,
        data: ar.data[0].data,
        value: 0,
        chainId,
        gasLimit: BigInt(ar.data[0].gasLimit || '100000')
      });
      await approveTx.wait();
      console.log(`  Approve ✅ ${chainName}`);
    }
  } catch(e) { console.log(`  Approve skip: ${e.message?.slice(0,60)}`); }
  
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buy, sell, solanaBuy, solanaSell, evmBuy, evmSell };
