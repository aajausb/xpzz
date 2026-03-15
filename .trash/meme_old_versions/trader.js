// 交易执行 + 持仓管理
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const config = require('./config');
const log = require('./logger');
const notifier = require('./notifier');

const conn = new Connection(config.heliusRpc1, 'confirmed');

// 加载钱包
let wallet = null;
function getWallet() {
  if (!wallet) {
    const { getWallets } = require('../wallet_runtime');
    const wallets = getWallets();
    wallet = Keypair.fromSecretKey(wallets.solana.secretKey);
  }
  return wallet;
}

// 持仓数据
function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.positions, 'utf8'));
  } catch {
    return [];
  }
}

function savePositions(positions) {
  fs.writeFileSync(config.paths.positions, JSON.stringify(positions, null, 2));
}

function loadTradeHistory() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.tradeHistory, 'utf8'));
  } catch {
    return [];
  }
}

function saveTradeHistory(history) {
  fs.writeFileSync(config.paths.tradeHistory, JSON.stringify(history, null, 2));
}

function loadDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const stats = JSON.parse(fs.readFileSync(config.paths.dailyStats, 'utf8'));
    if (stats.date === today) return stats;
  } catch {}
  return { date: today, buys: 0, sells: 0, pnl: 0, trades: 0, losses: 0 };
}

function saveDailyStats(stats) {
  fs.writeFileSync(config.paths.dailyStats, JSON.stringify(stats, null, 2));
}

// Jupiter swap — 买入token
async function buyToken(mint, amountSol) {
  const kp = getWallet();
  
  // 检查资金管理限制
  const positions = loadPositions();
  if (positions.length >= config.trade.maxPositions) {
    log.warn('trader', `持仓已满 ${positions.length}/${config.trade.maxPositions}，跳过买入`);
    return null;
  }
  
  const dailyStats = loadDailyStats();
  if (dailyStats.losses >= config.risk.dailyLossLimit) {
    log.warn('trader', `日亏损已达 $${dailyStats.losses}，暂停买入`);
    await notifier.emergencyAlert(`日亏损达 $${dailyStats.losses}，已暂停买入`);
    return null;
  }

  const amountLamports = Math.floor(amountSol * 1e9);
  
  try {
    // 1. 获取Jupiter报价
    const quoteUrl = `${config.jupiterQuoteApi}?inputMint=${config.SOL_MINT}&outputMint=${mint}&amount=${amountLamports}&slippageBps=${config.trade.slippageBps}`;
    const quoteRes = await fetch(quoteUrl);
    const quote = await quoteRes.json();
    
    if (!quote || quote.error) {
      log.error('trader', 'Jupiter报价失败', { mint, error: quote?.error });
      return null;
    }

    // 2. 获取swap交易
    const swapRes = await fetch(config.jupiterSwapApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toString(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: config.trade.priorityFeeMicroLamports,
        dynamicComputeUnitLimit: true,
      }),
    });
    const swapData = await swapRes.json();

    if (!swapData.swapTransaction) {
      log.error('trader', 'Jupiter swap失败', { mint, error: swapData.error });
      return null;
    }

    // 3. 签名并发送
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([kp]);

    const t0 = Date.now();
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    
    // 4. 确认
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    const elapsed = Date.now() - t0;

    log.trade('trader', `✅ 买入成功 ${mint.slice(0, 8)}`, {
      amountSol,
      sig: sig.slice(0, 20),
      elapsed,
      outAmount: quote.outAmount,
    });

    return {
      signature: sig,
      mint,
      amountSol,
      amountLamports,
      outAmount: quote.outAmount,
      price: amountLamports / Number(quote.outAmount), // SOL per token
      elapsed,
    };
  } catch (e) {
    log.error('trader', `买入失败 ${mint.slice(0, 8)}`, { error: e.message });
    return null;
  }
}

// Jupiter swap — 卖出token
async function sellToken(mint, amountTokens, reason = '') {
  const kp = getWallet();
  
  try {
    const quoteUrl = `${config.jupiterQuoteApi}?inputMint=${mint}&outputMint=${config.SOL_MINT}&amount=${amountTokens}&slippageBps=${config.trade.slippageBps}`;
    const quoteRes = await fetch(quoteUrl);
    const quote = await quoteRes.json();
    
    if (!quote || quote.error) {
      log.error('trader', 'Jupiter卖出报价失败', { mint, error: quote?.error });
      return null;
    }

    const swapRes = await fetch(config.jupiterSwapApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toString(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: config.trade.priorityFeeMicroLamports,
        dynamicComputeUnitLimit: true,
      }),
    });
    const swapData = await swapRes.json();

    if (!swapData.swapTransaction) {
      log.error('trader', 'Jupiter卖出swap失败', { mint, error: swapData.error });
      return null;
    }

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([kp]);

    const t0 = Date.now();
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    const elapsed = Date.now() - t0;

    log.trade('trader', `✅ 卖出成功 ${mint.slice(0, 8)}`, {
      amountTokens,
      sig: sig.slice(0, 20),
      elapsed,
      outAmount: quote.outAmount,
      reason,
    });

    return {
      signature: sig,
      mint,
      amountTokens,
      outAmountLamports: Number(quote.outAmount),
      outAmountSol: Number(quote.outAmount) / 1e9,
      elapsed,
      reason,
    };
  } catch (e) {
    log.error('trader', `卖出失败 ${mint.slice(0, 8)}`, { error: e.message, reason });
    return null;
  }
}

// 记录买入持仓
function recordBuy(analysis, tradeResult) {
  const positions = loadPositions();
  positions.push({
    mint: analysis.mint,
    symbol: analysis.symbol,
    name: analysis.name,
    score: analysis.score,
    signalType: analysis.signalType,
    buyAmountSol: tradeResult.amountSol,
    buyPrice: tradeResult.price,
    tokenAmount: tradeResult.outAmount,
    remainingTokens: tradeResult.outAmount,
    buyTime: Date.now(),
    buySignature: tradeResult.signature,
    soldStages: [], // 已卖出的阶梯记录
    highestMultiple: 1,
  });
  savePositions(positions);

  const stats = loadDailyStats();
  stats.buys++;
  stats.trades++;
  saveDailyStats(stats);

  const history = loadTradeHistory();
  history.push({
    type: 'buy',
    mint: analysis.mint,
    symbol: analysis.symbol,
    amountSol: tradeResult.amountSol,
    tokenAmount: tradeResult.outAmount,
    score: analysis.score,
    signalType: analysis.signalType,
    signature: tradeResult.signature,
    time: Date.now(),
  });
  saveTradeHistory(history);
}

// 记录卖出
function recordSell(position, sellResult, sellPct, reason) {
  const pnlSol = sellResult.outAmountSol - (position.buyAmountSol * sellPct);
  const pnlUsd = pnlSol * 170; // 粗估SOL价格

  const stats = loadDailyStats();
  stats.sells++;
  stats.trades++;
  stats.pnl += pnlUsd;
  if (pnlUsd < 0) stats.losses += Math.abs(pnlUsd);
  saveDailyStats(stats);

  const history = loadTradeHistory();
  history.push({
    type: 'sell',
    mint: position.mint,
    symbol: position.symbol,
    amountTokens: sellResult.amountTokens,
    outSol: sellResult.outAmountSol,
    pnlSol,
    pnlUsd,
    sellPct,
    reason,
    signature: sellResult.signature,
    holdMinutes: Math.round((Date.now() - position.buyTime) / 60000),
    time: Date.now(),
  });
  saveTradeHistory(history);

  return { pnlSol, pnlUsd };
}

// 获取token当前价格（通过Jupiter报价1个token值多少SOL）
async function getTokenPrice(mint, tokenAmount) {
  try {
    // 用Jupiter报价获取价格
    const url = `${config.jupiterQuoteApi}?inputMint=${mint}&outputMint=${config.SOL_MINT}&amount=${tokenAmount}&slippageBps=100`;
    const res = await fetch(url);
    const quote = await res.json();
    if (quote && quote.outAmount) {
      return Number(quote.outAmount) / 1e9; // SOL
    }
    return null;
  } catch {
    return null;
  }
}

// 检查持仓止损/止盈
async function checkPositions() {
  const positions = loadPositions();
  if (positions.length === 0) return;

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (!pos.remainingTokens || pos.remainingTokens === '0') continue;

    const currentValueSol = await getTokenPrice(pos.mint, pos.remainingTokens);
    if (currentValueSol === null) continue;

    const remainingPct = Number(pos.remainingTokens) / Number(pos.tokenAmount);
    const costBasis = pos.buyAmountSol * remainingPct;
    const multiple = currentValueSol / costBasis;
    pos.highestMultiple = Math.max(pos.highestMultiple || 1, multiple);
    const pnlPct = multiple - 1;

    // 止损
    if (pnlPct <= config.risk.stopLoss) {
      log.trade('trader', `🔴 止损触发 ${pos.symbol} ${(pnlPct * 100).toFixed(1)}%`);
      const result = await sellToken(pos.mint, pos.remainingTokens, '止损');
      if (result) {
        const pnl = recordSell(pos, result, 1, '止损-50%');
        await notifier.sellAlert({
          symbol: pos.symbol,
          pnlPct,
          pnlUsd: pnl.pnlUsd,
          sellPct: 1,
          holdMinutes: Math.round((Date.now() - pos.buyTime) / 60000),
          reason: '止损-50%',
        });
        positions.splice(i, 1);
      }
      continue;
    }

    // 阶梯止盈
    for (const tp of config.risk.takeProfit) {
      if (multiple >= tp.multiple && !pos.soldStages.includes(tp.multiple)) {
        const sellAmount = Math.floor(Number(pos.remainingTokens) * tp.sellPct).toString();
        log.trade('trader', `🟢 止盈 ${pos.symbol} ${tp.multiple}x → 卖${(tp.sellPct * 100).toFixed(0)}%`);
        const result = await sellToken(pos.mint, sellAmount, `止盈${tp.multiple}x`);
        if (result) {
          pos.soldStages.push(tp.multiple);
          pos.remainingTokens = (BigInt(pos.remainingTokens) - BigInt(sellAmount)).toString();
          const pnl = recordSell(pos, result, tp.sellPct, `止盈${tp.multiple}x`);
          await notifier.sellAlert({
            symbol: pos.symbol,
            pnlPct,
            pnlUsd: pnl.pnlUsd,
            sellPct: tp.sellPct,
            holdMinutes: Math.round((Date.now() - pos.buyTime) / 60000),
            reason: `止盈${tp.multiple}x`,
          });
        }
        break; // 一次只触发一个阶梯
      }
    }
  }

  savePositions(positions);
}

// 获取SOL余额
async function getSolBalance() {
  const kp = getWallet();
  const balance = await conn.getBalance(kp.publicKey);
  return balance / 1e9;
}

module.exports = {
  buyToken,
  sellToken,
  recordBuy,
  recordSell,
  checkPositions,
  getSolBalance,
  loadPositions,
  savePositions,
  loadDailyStats,
  getTokenPrice,
};
