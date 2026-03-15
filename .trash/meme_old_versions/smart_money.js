// 聪明钱模块 — 管理 + 监控 + 信号
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

// 加载聪明钱列表
function loadSmartWallets() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.smartWallets, 'utf8'));
  } catch {
    return { wallets: [], lastScan: null };
  }
}

function saveSmartWallets(data) {
  fs.writeFileSync(config.paths.smartWallets, JSON.stringify(data, null, 2));
}

// 获取聪明钱地址Set（用于快速查找）
function getSmartWalletSet() {
  const data = loadSmartWallets();
  return new Set((data.wallets || []).map(w => w.address));
}

// 获取聪明钱地址数组
function getSmartWalletAddresses() {
  const data = loadSmartWallets();
  return (data.wallets || []).map(w => w.address);
}

// 判断是否聪明钱
function isSmartWallet(address) {
  return getSmartWalletSet().has(address);
}

// 添加钱包
function addSmartWallet(address, label = '', stats = {}) {
  const data = loadSmartWallets();
  if ((data.wallets || []).find(w => w.address === address)) {
    logger.warn('smartMoney', `钱包已存在: ${address}`);
    return false;
  }
  if (!data.wallets) data.wallets = [];
  data.wallets.push({
    address,
    label,
    addedAt: Date.now(),
    winRate: stats.winRate || 0,
    profit: stats.profit || 0,
    trades: stats.trades || 0,
    source: stats.source || 'manual',
  });
  saveSmartWallets(data);
  logger.info('smartMoney', `添加钱包: ${address} (${label})`);
  return true;
}

// 批量匹配：输入地址数组，返回命中的聪明钱
function matchSmartWallets(addresses) {
  const set = getSmartWalletSet();
  return addresses.filter(a => set.has(a));
}

// 从Helius获取钱包最近交易
async function getWalletTransactions(address, limit = 100) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config.heliusKey1}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    return resp.json();
  } catch (e) {
    logger.error('smartMoney', `获取钱包交易失败: ${e.message}`);
    return [];
  }
}

// 链上扫描发现新的聪明钱
async function discoverSmartWallets() {
  logger.info('smartMoney', '开始扫描链上聪明钱...');
  // TODO: Phase 3实现
  logger.info('smartMoney', '扫描完成（TODO：待实现自动发现）');
}

module.exports = {
  loadSmartWallets,
  saveSmartWallets,
  getSmartWalletSet,
  getSmartWalletAddresses,
  isSmartWallet,
  addSmartWallet,
  matchSmartWallets,
  getWalletTransactions,
  discoverSmartWallets,
};
