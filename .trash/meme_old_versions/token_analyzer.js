// Token 分析模块 — 安全检查 + 评分
const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');

const conn1 = new Connection(config.heliusRpc1, 'confirmed');
const conn2 = new Connection(config.heliusRpc2, 'confirmed');
let rpcToggle = false;
function getConn() { rpcToggle = !rpcToggle; return rpcToggle ? conn1 : conn2; }

// Helius Enhanced Transactions API
async function getEnhancedTx(signature) {
  try {
    const url = `https://api.helius.xyz/v0/transactions/?api-key=${config.heliusKey1}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data[0] || null;
  } catch (e) {
    logger.error('analyzer', `getEnhancedTx failed: ${e.message}`);
    return null;
  }
}

// 从 Enhanced TX 提取新币信息
function extractNewTokenInfo(enhancedTx) {
  if (!enhancedTx) return null;
  
  // pump.fun 创建事件
  const isPumpCreate = enhancedTx.type === 'CREATE' && enhancedTx.source === 'PUMP_FUN';
  if (!isPumpCreate) return null;

  const tokenTransfer = enhancedTx.tokenTransfers?.[0];
  if (!tokenTransfer) return null;

  return {
    mint: tokenTransfer.mint,
    creator: enhancedTx.feePayer,
    initialBuyAmount: tokenTransfer.tokenAmount,
    initialSolSpent: enhancedTx.nativeTransfers?.reduce((sum, t) => {
      if (t.fromUserAccount === enhancedTx.feePayer) return sum + t.amount;
      return sum;
    }, 0) / 1e9 || 0,
    signature: enhancedTx.signature,
    timestamp: enhancedTx.timestamp,
  };
}

// Helius DAS API 获取 token metadata
async function getTokenMetadata(mint) {
  try {
    const resp = await fetch(config.heliusRpc1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mint },
      }),
    });
    const data = await resp.json();
    if (data.result) {
      const r = data.result;
      return {
        mint,
        name: r.content?.metadata?.name || 'Unknown',
        symbol: r.content?.metadata?.symbol || '???',
        uri: r.content?.json_uri || '',
        decimals: r.token_info?.decimals || 6,
      };
    }
    return { mint, name: 'Unknown', symbol: '???', decimals: 6 };
  } catch (e) {
    logger.error('analyzer', `getTokenMetadata failed: ${e.message}`);
    return { mint, name: 'Unknown', symbol: '???', decimals: 6 };
  }
}

// 获取 token holder 信息
async function getHolderInfo(mint) {
  try {
    // 用 Helius DAS API，兼容 Token-2022（pump.fun 新币）
    const resp = await fetch(config.heliusRpc1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint, limit: 20 },
      }),
    });
    const data = await resp.json();
    const accounts = data.result?.token_accounts || [];
    
    if (accounts.length === 0) {
      return { holders: [], totalHolders: 0, topHolderPct: 0 };
    }

    accounts.sort((a, b) => Number(b.amount) - Number(a.amount));
    const totalAmount = accounts.reduce((s, a) => s + Number(a.amount), 0);
    
    const holders = accounts.map(a => ({
      address: a.owner,
      amount: Number(a.amount),
      pct: totalAmount > 0 ? (Number(a.amount) / totalAmount * 100) : 0,
    }));

    // holders[0] 通常是 bonding curve（最大），跳过看真实最大holder
    const topHolderPct = holders.length > 1 ? holders[1].pct : 0;

    return { holders, totalHolders: holders.length, topHolderPct };
  } catch (e) {
    logger.warn('analyzer', `getHolderInfo失败`, { mint: mint.slice(0, 8), error: e.message });
    return { holders: [], totalHolders: 0, topHolderPct: 0 };
  }
}

// 检查 Dev 历史
async function checkDevHistory(devAddress) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${devAddress}/transactions?api-key=${config.heliusKey2}&limit=100&type=CREATE`;
    const resp = await fetch(url);
    if (!resp.ok) return { totalCreated: 0, recentCreated: 0 };
    const txs = await resp.json();
    
    const pumpCreates = txs.filter(t => t.source === 'PUMP_FUN' && t.type === 'CREATE');
    const recent7d = pumpCreates.filter(t => t.timestamp > Date.now() / 1000 - 7 * 86400);
    
    return {
      totalCreated: pumpCreates.length,
      recentCreated: recent7d.length,
    };
  } catch (e) {
    logger.error('analyzer', `checkDevHistory failed: ${e.message}`);
    return { totalCreated: 0, recentCreated: 0 };
  }
}

// 综合评分
async function analyzeToken(mint, tokenInfo, smartWalletSet) {
  const t0 = Date.now();
  logger.info('analyzer', `开始分析 ${mint}`);

  const results = { score: 0, reasons: [], issues: [], passed: false };

  // 并行获取数据
  const [metadata, holderInfo, devHistory] = await Promise.all([
    getTokenMetadata(mint),
    getHolderInfo(mint),
    tokenInfo?.creator ? checkDevHistory(tokenInfo.creator) : { totalCreated: 0, recentCreated: 0 },
  ]);

  const elapsed = Date.now() - t0;
  logger.info('analyzer', `数据查询完成 ${elapsed}ms`, { 
    mint: mint.slice(0, 8), 
    name: metadata.name, 
    symbol: metadata.symbol 
  });

  let score = 0;

  // === 安全分 (30分) ===

  if (holderInfo.totalHolders > 0) {
    // Dev持仓检查（holders[1]是最大非bonding-curve holder）
    if (holderInfo.topHolderPct > config.filter.maxDevHoldPct) {
      results.issues.push(`top holder占${holderInfo.topHolderPct.toFixed(1)}%`);
    } else {
      score += 15;
      results.reasons.push(`持仓分散(top${holderInfo.topHolderPct.toFixed(1)}%)`);
    }
  } else {
    // 新币太新查不到holder，给基础分
    score += 8;
    results.reasons.push('新币(holder待确认)');
  }

  // Dev历史
  if (devHistory.recentCreated > 10) {
    results.issues.push(`Dev 7天创建${devHistory.recentCreated}个币（批量发币）`);
  } else if (devHistory.recentCreated <= 3) {
    score += 15;
    results.reasons.push(`Dev正常(7天${devHistory.recentCreated}个)`);
  } else {
    score += 8;
    results.reasons.push(`Dev一般(7天${devHistory.recentCreated}个)`);
  }

  // 安全检查未通过
  if (results.issues.length > 0) {
    results.score = score;
    results.metadata = metadata;
    logger.signal('analyzer', `❌ ${metadata.symbol} (${metadata.name}) 安全检查未通过`, { issues: results.issues });
    return results;
  }

  // === 聪明钱分 (20分) ===
  if (smartWalletSet && smartWalletSet.size > 0 && holderInfo.holders.length > 0) {
    const smartHolders = holderInfo.holders.filter(h => smartWalletSet.has(h.address));
    if (smartHolders.length >= 2) {
      score += 20;
      results.reasons.push(`${smartHolders.length}个聪明钱持有 🔥`);
    } else if (smartHolders.length === 1) {
      score += 15;
      results.reasons.push('1个聪明钱持有');
    }
  }

  // === 活跃度分 (20分) ===
  if (holderInfo.totalHolders >= 15) {
    score += 20;
    results.reasons.push(`${holderInfo.totalHolders}个holder 🔥`);
  } else if (holderInfo.totalHolders >= 8) {
    score += 12;
    results.reasons.push(`${holderInfo.totalHolders}个holder`);
  } else if (holderInfo.totalHolders >= 3) {
    score += 6;
    results.reasons.push(`${holderInfo.totalHolders}个holder`);
  }

  // === 质量分 (30分) ===
  const name = (metadata.name || '').toLowerCase();
  const symbol = (metadata.symbol || '').toLowerCase();
  const hotNarratives = [
    // 英文
    'ai', 'agent', 'trump', 'elon', 'doge', 'pepe', 'cat', 'dog', 
    'frog', 'moon', 'grok', 'maga', 'solana', 'sol', 'wojak', 'chad', 'based',
    'pump', 'ape', 'degen', 'meme', 'shib', 'bonk', 'wif', 'popcat',
    // 中文热词
    '财', '发', '金', '龙', '虎', '牛', '猫', '狗', '月', '火',
    '暴富', '梭哈', '冲', '涨', '飞', '神', '仙', '佛', '妖', 
    '土狗', '打狗', '赌', '钻石', '火箭',
  ];
  const hasNarrative = hotNarratives.some(n => name.includes(n) || symbol.includes(n));
  if (hasNarrative) {
    score += 15;
    results.reasons.push('热门叙事 ✅');
  } else if (metadata.name !== 'Unknown') {
    score += 5;
  }

  // Creator初始买入大小
  if (tokenInfo?.initialSolSpent >= 2) {
    score += 10;
    results.reasons.push(`Dev买入${tokenInfo.initialSolSpent.toFixed(2)}SOL 💰`);
  } else if (tokenInfo?.initialSolSpent >= 0.5) {
    score += 5;
    results.reasons.push(`Dev买入${tokenInfo.initialSolSpent.toFixed(2)}SOL`);
  }

  // === 结果 ===
  results.score = score;
  results.passed = results.issues.length === 0;
  results.metadata = metadata;
  results.holderInfo = holderInfo;
  results.devHistory = devHistory;
  results.tokenInfo = tokenInfo;

  logger.signal('analyzer', `📊 ${metadata.symbol} (${metadata.name}) 评分: ${score}/100`, { reasons: results.reasons });
  return results;
}

module.exports = {
  getEnhancedTx,
  extractNewTokenInfo,
  getTokenMetadata,
  getHolderInfo,
  checkDevHistory,
  analyzeToken,
};
