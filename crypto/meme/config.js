// 土狗系统配置
require('dotenv').config({ path: '/root/.openclaw/workspace/.env', override: true });

module.exports = {
  // RPC
  heliusKey1: process.env.HELIUS_API_KEY,
  heliusKey2: process.env.HELIUS_API_KEY_2,
  heliusRpc1: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  heliusRpc2: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_2}`,
  heliusWs1: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  heliusWs2: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_2}`,

  // pump.fun 程序地址
  PUMP_FUN_PROGRAM: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  
  // Jupiter API
  jupiterQuoteApi: 'https://quote-api.jup.ag/v6/quote',
  jupiterSwapApi: 'https://quote-api.jup.ag/v6/swap',
  
  // SOL mint
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  
  // 交易参数
  trade: {
    defaultBuyAmountSol: 0.12,      // ~$20
    largeBuyAmountSol: 0.18,        // ~$30（多聪明钱确认）
    smallBuyAmountSol: 0.09,        // ~$15（纯评分无聪明钱）
    maxPositions: 5,                // 最大同时持仓
    priorityFeeMicroLamports: 500000, // priority fee
    computeUnits: 200000,
    slippageBps: 1000,              // 10% slippage（土狗流动性差）
  },

  // 评分阈值
  score: {
    smartMoneyBuy: 60,    // 聪明钱主动买入最低分
    newTokenWithSM: 70,   // 新币+聪明钱验证
    newTokenPure: 80,     // 新币纯评分（无聪明钱）
    graduated: 65,        // 毕业币
  },

  // 止损止盈
  risk: {
    stopLoss: -0.50,              // -50% 无条件止损
    takeProfit: [
      { multiple: 2, sellPct: 0.40 },   // 2x卖40%
      { multiple: 5, sellPct: 0.30 },   // 5x卖30%
      { multiple: 10, sellPct: 0.20 },  // 10x卖20%
      // 剩10% moonbag
    ],
    emergencySell: {
      devDump: true,          // Dev大量卖出→全卖
      lpRemoved: true,        // LP被撤→全卖
      flashCrash: -0.30,      // 5分钟跌30%→全卖
    },
    dailyLossLimit: 50,       // 日亏$50暂停
    totalLossLimit: 100,      // 总亏$100熔断
  },

  // 过滤条件
  filter: {
    maxDevHoldPct: 5,         // Dev持仓>5%不买
    minLiquiditySol: 5,       // 最小流动性5 SOL
    maxTokenAgeMinutes: 15,   // 新币最大年龄15分钟
    minBuyersFirst10Min: 10,  // 前10分钟最少买家数
    minBondingCurvePct: 10,   // bonding curve至少10%
  },

  // 聪明钱
  smartMoney: {
    minWinRate: 0.60,         // 最低胜率60%
    minProfitUsd: 5000,       // 最低盈利$5k
    minTrades: 20,            // 最少交易次数
    rescanIntervalDays: 3,    // 每3天重扫
  },

  // 监控
  monitor: {
    priceCheckIntervalMs: 5000,   // 每5秒查价格
    wsReconnectDelayMs: 3000,     // WS断线重连延迟
    maxReconnectAttempts: 50,     // 最大重连次数
  },

  // Telegram 通知
  telegram: {
    enabled: true,
    chatId: '877233818',
  },

  // 数据文件路径
  paths: {
    smartWallets: '/root/.openclaw/workspace/crypto/meme/data/smart_wallets.json',
    positions: '/root/.openclaw/workspace/crypto/meme/data/positions.json',
    tradeHistory: '/root/.openclaw/workspace/crypto/meme/data/trade_history.json',
    tokenCache: '/root/.openclaw/workspace/crypto/meme/data/token_cache.json',
    dailyStats: '/root/.openclaw/workspace/crypto/meme/data/daily_stats.json',
    logDir: '/root/.openclaw/workspace/crypto/meme/logs',
  },
};
