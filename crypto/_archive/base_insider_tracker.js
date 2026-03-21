#!/usr/bin/env node
/**
 * Base链内幕钱包追踪器
 * 
 * Base是EVM链，通过RPC直接查询ERC-20 balanceOf追踪持仓
 * 不需要额外API Key
 */

const { ethers } = require('ethers');

const RPC_URLS = [
  'https://base-mainnet.public.blastapi.io',
  'https://1rpc.io/base',
  'https://base.drpc.org',
];

// ERC-20 ABI (只需要balanceOf和Transfer事件)
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

class BaseInsiderTracker {
  constructor(tokenAddress) {
    this.tokenAddress = tokenAddress;
    this.provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
    this.contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    this.insiderWallets = [];
    this.initialHoldings = {};
  }

  /**
   * 获取内幕钱包 - 通过分析早期Transfer事件
   * 前N个区块内收到代币的地址 = 内幕/早期持有者
   */
  async getInsiderWallets(lookbackBlocks = 1000) {
    const wallets = new Map(); // address -> amount
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = currentBlock - lookbackBlocks;

    // 获取Transfer事件
    const filter = this.contract.filters.Transfer();
    const events = await this.contract.queryFilter(filter, fromBlock, currentBlock);

    const decimals = await this.contract.decimals();

    for (const event of events) {
      const to = event.args[1];
      const value = Number(ethers.formatUnits(event.args[2], decimals));
      
      // 累计收到的代币
      wallets.set(to, (wallets.get(to) || 0) + value);
    }

    // 按收到金额排序，取前20大
    const sorted = [...wallets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    this.insiderWallets = sorted.map(([addr]) => addr);
    return sorted;
  }

  /**
   * 快照当前持仓
   */
  async snapshotHoldings() {
    const decimals = await this.contract.decimals();
    const holdings = {};

    for (const wallet of this.insiderWallets) {
      try {
        const balance = await this.contract.balanceOf(wallet);
        holdings[wallet] = Number(ethers.formatUnits(balance, decimals));
      } catch (e) {
        holdings[wallet] = 0;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    this.initialHoldings = holdings;
    return holdings;
  }

  /**
   * 检查内幕钱包活动
   */
  async checkInsiderActivity() {
    const result = { selling: [], holding: [], buying: [] };
    const decimals = await this.contract.decimals();

    for (const wallet of this.insiderWallets) {
      try {
        const balance = await this.contract.balanceOf(wallet);
        const currentBalance = Number(ethers.formatUnits(balance, decimals));
        const initialBalance = this.initialHoldings[wallet] || 0;
        await new Promise(r => setTimeout(r, 100));

        const shortAddr = wallet.slice(0, 8) + '...' + wallet.slice(-4);

        if (initialBalance > 0 && currentBalance < initialBalance * 0.9) {
          const soldPct = ((initialBalance - currentBalance) / initialBalance * 100).toFixed(1);
          result.selling.push({ wallet: shortAddr, full: wallet, soldPct, from: initialBalance, to: currentBalance });
        } else if (initialBalance > 0 && currentBalance > initialBalance * 1.1) {
          const addedPct = ((currentBalance - initialBalance) / initialBalance * 100).toFixed(1);
          result.buying.push({ wallet: shortAddr, full: wallet, addedPct, from: initialBalance, to: currentBalance });
        } else {
          result.holding.push({ wallet: shortAddr, full: wallet, balance: currentBalance });
        }
      } catch (e) {}
    }

    return result;
  }
}

module.exports = { BaseInsiderTracker };

if (require.main === module) {
  const tokenAddr = process.argv[2];
  if (!tokenAddr) {
    console.log('用法: node base_insider_tracker.js <token_address>');
    process.exit(1);
  }
  (async () => {
    const tracker = new BaseInsiderTracker(tokenAddr);
    console.log('🔍 扫描Base链内幕钱包...');
    const wallets = await tracker.getInsiderWallets();
    console.log(`找到 ${wallets.length} 个大额持有者:`);
    for (const [addr, amount] of wallets.slice(0, 10)) {
      console.log(`  ${addr.slice(0,10)}...${addr.slice(-4)}: ${amount.toLocaleString()} tokens`);
    }
  })();
}
