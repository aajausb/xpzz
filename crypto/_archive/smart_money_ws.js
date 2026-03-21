#!/usr/bin/env node
/**
 * 聪明钱实时跟单 - WebSocket毫秒级监听
 * 
 * 监听Helius WebSocket，实时捕捉聪明钱的链上交易
 * 发现买入信号 → 立即跟单
 */

const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const HELIUS_WS_1 = 'wss://mainnet.helius-rpc.com/?api-key=5c5d615e-ba81-4f40-b6a7-dfa9a460839e';
const HELIUS_WS_2 = 'wss://mainnet.helius-rpc.com/?api-key=6553b0ad-32fa-4cfb-aea4-c4154e757ce1';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=5c5d615e-ba81-4f40-b6a7-dfa9a460839e';
const ONCHAINOS = path.join(process.env.HOME, '.local/bin/onchainos');
const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');

// 已知聪明钱地址（从OKX signal-list动态更新）
let smartMoneyWallets = new Set();
let lastWalletUpdate = 0;

// 交易记录（防重复）
const recentTrades = new Map();

/**
 * 从OKX获取最新聪明钱地址列表
 */
function updateSmartMoneyList() {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market signal-list solana --wallet-type "1" --min-amount-usd 500 2>/dev/null`,
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(result);
    if (data.ok && data.data) {
      const newWallets = new Set();
      for (const signal of data.data) {
        const addrs = (signal.triggerWalletAddress || '').split(',');
        addrs.forEach(a => {
          const trimmed = a.trim();
          if (trimmed.length > 30) newWallets.add(trimmed);
        });
      }
      smartMoneyWallets = newWallets;
      console.log(`[${timestamp()}] 🔄 更新聪明钱列表: ${smartMoneyWallets.size}个地址`);
    }
  } catch (e) {
    console.error(`[${timestamp()}] ❌ 更新聪明钱列表失败: ${e.message}`);
  }
  lastWalletUpdate = Date.now();
}

/**
 * 分析交易是否为买入
 */
function isTokenBuy(tx) {
  // 简化判断：SOL转出 + Token转入 = 买入
  if (!tx.meta || tx.meta.err) return null;
  
  const preBalances = tx.meta.preBalances || [];
  const postBalances = tx.meta.postBalances || [];
  
  // SOL减少 = 花了SOL买东西
  if (preBalances[0] > postBalances[0]) {
    const solSpent = (preBalances[0] - postBalances[0]) / 1e9;
    if (solSpent > 0.01) { // 过滤掉纯gas
      return { solSpent };
    }
  }
  return null;
}

/**
 * 发送Telegram通知
 */
function notify(message) {
  try {
    // 写入通知文件，由外部脚本发送
    const notifyPath = path.join(WORKSPACE, 'crypto', 'notifications.jsonl');
    const entry = JSON.stringify({ time: new Date().toISOString(), message }) + '\n';
    fs.appendFileSync(notifyPath, entry);
    console.log(`[${timestamp()}] 📢 ${message}`);
  } catch (e) {}
}

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 主监听循环
 */
function startWebSocket() {
  const ws = new WebSocket(HELIUS_WS_1);
  let subscriptionId = null;

  ws.on('open', () => {
    console.log(`[${timestamp()}] 🟢 WebSocket已连接`);
    
    // 订阅聪明钱地址的账户变化
    const addresses = [...smartMoneyWallets].slice(0, 100); // WS限制100个
    
    if (addresses.length === 0) {
      console.log(`[${timestamp()}] ⚠️ 聪明钱列表为空，等待更新...`);
      return;
    }

    // 使用accountSubscribe监听每个地址
    for (const addr of addresses.slice(0, 20)) { // 先监听前20个
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: addr.slice(0, 8),
        method: 'accountSubscribe',
        params: [
          addr,
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]
      }));
    }
    
    console.log(`[${timestamp()}] 👁️ 监听 ${Math.min(addresses.length, 20)} 个聪明钱地址`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.method === 'accountNotification') {
        const accountData = msg.params?.result?.value;
        if (accountData) {
          console.log(`[${timestamp()}] 💡 检测到聪明钱账户变化!`);
          // 防止频繁触发，至少间隔30秒
          if (Date.now() - (global.lastQuickCheck || 0) > 30000) {
            global.lastQuickCheck = Date.now();
            setTimeout(quickCheck, 2000); // 延迟2秒避免限速
          }
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log(`[${timestamp()}] 🔴 WebSocket断开，5秒后重连...`);
    setTimeout(startWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[${timestamp()}] ❌ WebSocket错误: ${err.message}`);
  });
}

/**
 * 快速检查 - 发现聪明钱活动时触发
 */
function quickCheck() {
  try {
    const result = execSync(
      `cd ${WORKSPACE} && ${ONCHAINOS} market signal-list solana --wallet-type "1" --min-amount-usd 500 2>/dev/null`,
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(result);
    
    if (!data.ok || !data.data) return;

    for (const signal of data.data) {
      const token = signal.token;
      const mcap = parseFloat(token.marketCapUsd || 0);
      const holders = parseInt(token.holders || 0);
      const soldRatio = parseFloat(signal.soldRatioPercent || 100);
      const walletCount = parseInt(signal.triggerWalletCount || 0);
      const top10 = parseFloat(token.top10HolderPercent || 100);
      const tokenAddr = token.tokenAddress;

      // 跳过已交易的
      if (recentTrades.has(tokenAddr)) continue;

      // 跟单条件
      if (mcap > 1000000) continue;      // 市值<1M
      if (soldRatio > 30) continue;       // 还在建仓
      if (walletCount < 3) continue;      // 至少3个聪明钱
      if (top10 > 40) continue;           // 筹码不能太集中

      // 发现目标！
      const msg = `🎯 聪明钱跟单信号!\n${token.symbol} (${token.name})\n市值: $${mcap.toLocaleString()}\n聪明钱: ${walletCount}个在买\n已卖出: ${soldRatio}%\n持币人: ${holders}\nTop10: ${top10}%\n地址: ${tokenAddr}`;
      
      notify(msg);
      recentTrades.set(tokenAddr, Date.now());

      // 清理24小时前的记录
      for (const [addr, time] of recentTrades) {
        if (Date.now() - time > 86400000) recentTrades.delete(addr);
      }
    }
  } catch (e) {
    console.error(`[${timestamp()}] ❌ 快速检查失败: ${e.message}`);
  }
}

// === 启动 ===
console.log('🚀 聪明钱实时跟单系统启动');
console.log('================================');

// 初始化聪明钱列表
updateSmartMoneyList();

// 每10分钟更新聪明钱列表
setInterval(updateSmartMoneyList, 10 * 60 * 1000);

// 每5分钟快速检查（兜底，防止WS漏消息）
setInterval(quickCheck, 5 * 60 * 1000);

// 启动WebSocket监听
startWebSocket();

console.log(`[${timestamp()}] ✅ 系统就绪，监听中...`);
