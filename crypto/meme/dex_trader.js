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

const HELIUS_KEY = process.env.HELIUS_API_KEY || '2504e0b9-253e-4cfc-a2ce-3721dce8538d';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const BSC_RPC = 'https://bsc-dataseed1.binance.org';
const BASE_RPC = 'https://mainnet.base.org';

// 防夹RPC（私有交易，MEV bot看不到）
const JITO_BUNDLE_API = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const JITO_TIP_LAMPORTS = 1_000_000; // 0.001 SOL tip
const BSC_PRIVATE_RPC = 'https://bsc.rpc.blxrbdn.com'; // bloXroute私有交易
const BASE_PRIVATE_RPC = 'https://rpc.flashbots.net';    // Flashbots Protect

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
  
  // 0. OKX合约要求wSOL ATA有余额，买入时自动wrap（用户无感知）
  if (fromToken === NATIVE.solana) {
    const solBal = await conn.getBalance(kp.publicKey);
    const needed = parseInt(amount);
    // 保留0.01 SOL作为gas（rent + priority fee）
    if (solBal < needed + 10000000) {
      throw new Error(`SOL余额不足: 需要${needed/1e9} SOL, 当前${solBal/1e9} SOL (需预留0.01 SOL gas)`);
    }
    await ensureWsolBalance(conn, kp, needed);
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
  
  // 4. 轮询确认
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const status = await conn.getSignatureStatus(sig);
    if (status?.value) {
      if (status.value.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
        // 卖出后自动unwrap wSOL→SOL
        if (toToken === NATIVE.solana) {
          try { await unwrapWsol(conn, kp); } catch(e) { /* unwrap失败不影响主流程 */ }
        }
        return { chain: 'solana', action, txHash: sig, success: true, mev: 'jito' };
      }
    }
  }
  return { chain: 'solana', action, txHash: sig, success: false, note: '超时未确认，查TX: ' + sig };
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
  
  let tx, receipt;
  try {
    // 通过私有RPC发送
    tx = await privateWallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      chainId,
      gasLimit: BigInt(txData.gas || '500000')
    });
    receipt = await tx.wait();
  } catch(e) {
    // 私有RPC失败回退普通RPC
    console.log(`[dex_trader] 私有RPC失败(${chain}),回退:`, e.message?.slice(0, 60));
    tx = await wallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      chainId,
      gasLimit: BigInt(txData.gas || '500000')
    });
    receipt = await tx.wait();
  }
  
  if (receipt.status !== 1) throw new Error(`交易revert: ${tx.hash}`);
  return { chain, action: 'buy', txHash: tx.hash, success: true, block: receipt.blockNumber, mev: 'private' };
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
      const approveReceipt = await approveTx.wait();
      if (approveReceipt.status !== 1) throw new Error('approve交易revert');
      // 等nonce同步
      await sleep(2000);
    }
  } catch(e) {
    // 如果是"已经approved"可以忽略，其他错误要抛出
    if (e.message?.includes('revert')) throw e;
  }
  
  // 2. Swap（approve之后再获取，确保nonce正确）
  const cmd = `onchainos swap swap --chain ${chainName} --from ${tokenAddress} --to ${NATIVE[chain]} --amount ${amountRaw} --wallet ${w.evm.address} --slippage ${slippage}`;
  const result = JSON.parse(execSync(cmd, { env: OKX_ENV, timeout: 15000, maxBuffer: 10*1024*1024 }).toString());
  if (!result.ok) throw new Error(`OKX swap失败: ${result.error || JSON.stringify(result)}`);
  
  const txData = result.data[0].tx;
  if (!txData.data || txData.data.length < 10) throw new Error('swap tx data为空');
  
  // 用私有RPC防夹
  const privateRpc = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const privateProvider = new ethers.JsonRpcProvider(privateRpc);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, privateProvider);
  
  let tx, receipt;
  try {
    tx = await privateWallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      chainId,
      gasLimit: BigInt(txData.gas || '500000')
    });
    receipt = await tx.wait();
  } catch(e) {
    console.log(`[dex_trader] 私有RPC卖出失败(${chain}),回退:`, e.message?.slice(0, 60));
    tx = await wallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      chainId,
      gasLimit: BigInt(txData.gas || '500000')
    });
    receipt = await tx.wait();
  }
  
  if (receipt.status !== 1) throw new Error(`交易revert: ${tx.hash}`);
  return { chain, action: 'sell', txHash: tx.hash, success: true, block: receipt.blockNumber, mev: 'private' };
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
