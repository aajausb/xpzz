/**
 * DEX交易模块 v2 - 三链统一买卖（直接调OKX DEX API）
 * SOL: OKX聚合器 + 三级RPC fallback
 * BSC/Base: OKX聚合器 + 私有RPC防夹 + approve缓存
 */
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { ethers } = require('ethers');
const { getWallets } = require('../wallet_runtime');
const crypto = require('crypto');
const fetch = require('node-fetch');
const bs58 = require('bs58');

// ============ 配置 ============
const SOL_RPCS = [
  "https://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/",
  "https://shy-practical-bird.solana-mainnet.quiknode.pro/3c58be160716ec5df2d95aa0710baede37f182a5/",
  "https://api.mainnet-beta.solana.com",
];
const BSC_RPC = 'https://smart-snowy-patina.bsc.quiknode.pro/4ef7626a956d23dd691755d8f81d3b4489072098/';
const BASE_RPC = 'https://green-polished-glitter.base-mainnet.quiknode.pro/e2d252d6fc15ae83fa0369621e55fc847b63c0e1/';
const BSC_PRIVATE_RPC = BSC_RPC;
const BASE_PRIVATE_RPC = BASE_RPC;

const OKX_API_KEY = process.env.OKX_API_KEY || '';
const OKX_SECRET = process.env.OKX_SECRET_KEY || '';
const OKX_PASS = process.env.OKX_PASSPHRASE || '';

const NATIVE = {
  solana: '11111111111111111111111111111111',
  bsc: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  base: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
};
const CHAIN_ID = { solana: '501', bsc: '56', base: '8453' };

// ============ SOL RPC管理 ============
let solRpcIdx = 0;
const solRpcCooldown = new Array(SOL_RPCS.length).fill(0);

function getSolRpc() {
  const now = Date.now();
  for (let i = 0; i < SOL_RPCS.length; i++) {
    const idx = (solRpcIdx + i) % SOL_RPCS.length;
    if (now >= solRpcCooldown[idx]) {
      solRpcIdx = (idx + 1) % SOL_RPCS.length; // 轮转
      return { url: SOL_RPCS[idx], idx };
    }
  }
  return { url: SOL_RPCS[SOL_RPCS.length - 1], idx: SOL_RPCS.length - 1 };
}

function markSolRpcDown(idx) {
  solRpcCooldown[idx] = Date.now() + 600000;
  solRpcIdx = (idx + 1) % SOL_RPCS.length;
  console.log(`[dex_trader] ⚠️ SOL RPC #${idx} down，切到 #${solRpcIdx}`);
}

function getSolConn() {
  const rpc = getSolRpc();
  return { conn: new Connection(rpc.url, { commitment: 'confirmed', disableRetryOnRateLimit: true }), rpcIdx: rpc.idx };
}

// ============ EVM Provider单例 ============
const _providers = {};
function getProvider(chain) {
  const k = chain === 'bsc' ? BSC_RPC : BASE_RPC;
  if (!_providers[k]) _providers[k] = new ethers.JsonRpcProvider(k);
  return _providers[k];
}
function getPrivateProvider(chain) {
  const k = chain === 'bsc' ? BSC_PRIVATE_RPC : BASE_PRIVATE_RPC;
  const pk = 'p_' + k;
  if (!_providers[pk]) _providers[pk] = new ethers.JsonRpcProvider(k);
  return _providers[pk];
}

// approve缓存
const _approvedTokens = new Set();

// ============ OKX API ============
function okxSign(ts, method, path) {
  return crypto.createHmac('sha256', OKX_SECRET).update(ts + method + path).digest('base64');
}

async function okxGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = path + (qs ? '?' + qs : '');
  const ts = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const r = await fetch('https://web3.okx.com' + fullPath, {
    headers: {
      'OK-ACCESS-KEY': OKX_API_KEY,
      'OK-ACCESS-SIGN': okxSign(ts, 'GET', fullPath),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': OKX_PASS,
      'OK-ACCESS-PROJECT': '',
    },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  return r.json();
}

function okxSwapQuote(chainId, from, to, amount, wallet, slippagePct) {
  return okxGet('/api/v6/dex/aggregator/swap', {
    chainIndex: chainId, fromTokenAddress: from, toTokenAddress: to,
    amount, slippagePercent: slippagePct.toString(), userWalletAddress: wallet
  });
}

function okxApprove(chainId, tokenAddress, amount) {
  return okxGet('/api/v6/dex/aggregator/approve-transaction', {
    chainIndex: chainId, tokenContractAddress: tokenAddress, approveAmount: amount
  });
}

// ============ SOL 买卖 ============
async function solanaBuy(tokenAddress, amountLamports, slippageBps = 500) {
  return _solanaSwap(NATIVE.solana, tokenAddress, amountLamports, 'buy', slippageBps);
}

async function solanaSell(tokenAddress, amountRaw, slippageBps = 500) {
  return _solanaSwap(tokenAddress, NATIVE.solana, amountRaw, 'sell', slippageBps);
}

async function _solanaSwap(fromToken, toToken, amount, action, slippageBps) {
  const w = getWallets();
  const kp = Keypair.fromSecretKey(w.solana.secretKey);
  let { conn, rpcIdx } = getSolConn();

  // 1. OKX报价
  const quote = await okxSwapQuote(CHAIN_ID.solana, fromToken, toToken, amount.toString(), w.solana.address, slippageBps / 100);
  if (quote.code !== '0' || !quote.data?.[0]) {
    throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0, 100)}`);
  }

  // 2. 签名
  const decoded = bs58.decode(quote.data[0].tx.data);
  const tx = VersionedTransaction.deserialize(decoded);
  tx.sign([kp]);

  // 3. 发送（429自动切RPC）
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  } catch (e) {
    if (e.message?.includes('429') || e.message?.includes('Too Many')) {
      markSolRpcDown(rpcIdx);
      const r2 = getSolConn();
      conn = r2.conn;
      rpcIdx = r2.rpcIdx;
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    } else throw e;
  }

  // 4. 确认（429也自动切）
  try {
    const bh = await conn.getLatestBlockhash('confirmed');
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
    if (conf.value?.err) throw new Error(`交易失败: ${JSON.stringify(conf.value.err)}`);
  } catch (e) {
    if (e.message?.includes('交易失败')) throw e;
    // 429或超时 → 切RPC再查一次
    if (e.message?.includes('429') || e.message?.includes('Too Many')) {
      markSolRpcDown(rpcIdx);
      const r3 = getSolConn();
      conn = r3.conn;
    }
    try {
      const status = await conn.getSignatureStatus(sig);
      if (status?.value?.err) throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
      if (!status?.value?.confirmationStatus) {
        return { chain: 'solana', action, txHash: sig, success: false, error: 'SOL确认超时' };
      }
    } catch (e2) {
      // 查不到状态也当超时
      return { chain: 'solana', action, txHash: sig, success: false, error: 'SOL确认超时' };
    }
  }

  console.log(`[dex_trader] ✅ solana ${action}确认 sig=${sig.slice(0, 20)}`);
  return { chain: 'solana', action, txHash: sig, success: true };
}

// ============ EVM 买入 ============
async function evmBuy(chain, tokenAddress, amountWei, slippage = 3) {
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = getProvider(chain);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, getPrivateProvider(chain));

  // 报价 + gas 并行
  const [quote, feeData] = await Promise.all([
    okxSwapQuote(CHAIN_ID[chain], NATIVE[chain], tokenAddress, amountWei.toString(), w.evm.address, slippage),
    provider.getFeeData()
  ]);
  if (quote.code !== '0' || !quote.data?.[0]) throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0, 100)}`);

  const txData = quote.data[0].tx;
  if (!txData?.data || txData.data.length < 10) throw new Error('swap tx data为空');

  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 150n / 100n : undefined;
  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: w.evm.address, to: txData.to, data: txData.data, value: txData.value || '0' });
    gasLimit = est * 150n / 100n;
  } catch (e) {
    console.log(`[dex_trader] ⚠️ ${chain} estimateGas失败: ${e.message?.slice(0,60)}，用OKX gas×2`);
    gasLimit = BigInt(txData.gas || '500000') * 200n / 100n;
  }

  const txParams = { to: txData.to, data: txData.data, value: txData.value || '0', chainId, gasLimit, ...(gasPrice ? { gasPrice } : {}) };

  if (!txParams.data || txParams.data.length < 10) throw new Error(`txParams.data为空: to=${txParams.to}`);
  let tx;
  try { tx = await privateWallet.sendTransaction(txParams); }
  catch (e) {
    console.log(`[dex_trader] 私有RPC失败(${chain}):`, e.message?.slice(0, 40));
    tx = await wallet.sendTransaction(txParams);
  }

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) {
    console.error(`[dex_trader] ❌ ${chain} 买入revert: ${tx.hash}`);
    return { chain, action: 'buy', txHash: tx.hash, success: false, error: 'revert' };
  }
  console.log(`[dex_trader] ✅ ${chain} 买入确认 block=${receipt.blockNumber}`);
  return { chain, action: 'buy', txHash: tx.hash, success: true, mev: 'private' };
}

// ============ EVM 卖出 ============
async function evmSell(chain, tokenAddress, amountRaw, slippage = 3) {
  const chainId = chain === 'bsc' ? 56 : 8453;
  const w = getWallets();
  const provider = getProvider(chain);
  const wallet = new ethers.Wallet(w.evm.privateKey, provider);
  const privateWallet = new ethers.Wallet(w.evm.privateKey, getPrivateProvider(chain));

  // approve（缓存过就跳过）
  const approveKey = `${chain}_${tokenAddress.toLowerCase()}`;
  if (!_approvedTokens.has(approveKey)) {
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
        const appTx = await erc20.approve(spender, ethers.MaxUint256);
        const appReceipt = await appTx.wait();
        if (appReceipt.status !== 1) throw new Error(`approve revert: ${appTx.hash}`);
        await sleep(1000); // nonce同步
      }
      _approvedTokens.add(approveKey);
    }
  }

  // 报价 + gas 并行
  const [feeData, quote] = await Promise.all([
    provider.getFeeData(),
    okxSwapQuote(CHAIN_ID[chain], tokenAddress, NATIVE[chain], amountRaw.toString(), w.evm.address, slippage)
  ]);
  if (quote.code !== '0' || !quote.data?.[0]) throw new Error(`OKX报价失败: ${quote.msg || JSON.stringify(quote).slice(0, 100)}`);

  const txData = quote.data[0].tx;
  if (!txData?.data || txData.data.length < 10) throw new Error('swap tx data为空');

  const gasPrice = feeData.gasPrice ? feeData.gasPrice * 150n / 100n : undefined;
  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: w.evm.address, to: txData.to, data: txData.data, value: txData.value || '0' });
    gasLimit = est * 150n / 100n;
  } catch (e) {
    console.log(`[dex_trader] ⚠️ ${chain} 卖出estimateGas失败: ${e.message?.slice(0,60)}，用OKX gas×2`);
    gasLimit = BigInt(txData.gas || '500000') * 200n / 100n;
  }

  const txParams = { to: txData.to, data: txData.data, value: txData.value || '0', chainId, gasLimit, ...(gasPrice ? { gasPrice } : {}) };

  if (!txParams.data || txParams.data.length < 10) throw new Error(`txParams.data为空: to=${txParams.to}`);
  let tx;
  try { tx = await privateWallet.sendTransaction(txParams); }
  catch (e) {
    console.log(`[dex_trader] 私有RPC卖出失败(${chain}):`, e.message?.slice(0, 40));
    tx = await wallet.sendTransaction(txParams);
  }

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) {
    console.error(`[dex_trader] ❌ ${chain} 卖出revert: ${tx.hash}`);
    return { chain, action: 'sell', txHash: tx.hash, success: false, error: 'revert' };
  }
  console.log(`[dex_trader] ✅ ${chain} 卖出确认 block=${receipt.blockNumber}`);
  return { chain, action: 'sell', txHash: tx.hash, success: true, mev: 'private' };
}

// ============ 统一接口 ============
async function buy(chain, tokenAddress, amountNative) {
  // 不在这里重试——v8_engine有自己的重试层
  if (chain === 'solana') return solanaBuy(tokenAddress, amountNative);
  return evmBuy(chain, tokenAddress, amountNative);
}

async function sell(chain, tokenAddress, amountRaw, slippageBps) {
  // 没传数量 → 查链上余额全卖
  if (!amountRaw) {
    amountRaw = await _getTokenBalance(chain, tokenAddress);
    if (!amountRaw || amountRaw === '0' || amountRaw === 0) {
      return { chain, action: 'sell', success: false, error: '余额为0' };
    }
    console.log(`[dex_trader] 自动查余额: ${amountRaw}`);
  }
  // 不在这里重试——v8_engine有自己的重试层
  if (chain === 'solana') return solanaSell(tokenAddress, amountRaw, slippageBps || 500);
  return evmSell(chain, tokenAddress, amountRaw, slippageBps ? slippageBps / 100 : 3);
}

// ============ 辅助 ============
async function _getTokenBalance(chain, tokenAddress) {
  if (chain === 'solana') {
    const { conn, rpcIdx } = getSolConn();
    const w = getWallets();
    const owner = new PublicKey(w.solana.address);
    const mint = new PublicKey(tokenAddress);
    try {
      // 查两个programId兼容Token-2022，去重防重复计数
      let total = 0n;
      const seenAccounts = new Set();
      for (const programId of [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
      ]) {
        try {
          const accts = await conn.getParsedTokenAccountsByOwner(owner, { mint }, { programId: new PublicKey(programId), commitment: 'confirmed' });
          for (const a of accts.value) {
            if (seenAccounts.has(a.pubkey)) continue;
            seenAccounts.add(a.pubkey);
            total += BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0');
          }
        } catch {}
      }
      return total.toString();
    } catch (e) {
      if (e.message?.includes('429')) {
        markSolRpcDown(rpcIdx);
        const { conn: conn2 } = getSolConn();
        let total = 0n;
        const seenAccounts = new Set();
        for (const programId of [
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
        ]) {
          try {
            const accts = await conn2.getParsedTokenAccountsByOwner(owner, { mint }, { programId: new PublicKey(programId) });
            for (const a of accts.value) {
              if (seenAccounts.has(a.pubkey)) continue;
              seenAccounts.add(a.pubkey);
              total += BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0');
            }
          } catch {}
        }
        return total.toString();
      }
      throw e;
    }
  } else {
    const provider = getProvider(chain);
    const w = getWallets();
    const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
    return (await erc20.balanceOf(w.evm.address)).toString();
  }
}


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getWalletAddress(chain) {
  const w = getWallets();
  return chain === 'solana' ? w.solana.address : w.evm.address;
}

module.exports = { buy, sell, solanaBuy, solanaSell, evmBuy, evmSell, getWalletAddress };
