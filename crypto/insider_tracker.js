#!/usr/bin/env node
/**
 * 内幕钱包追踪器 v1.0
 * 
 * 流程：
 * 1. 买入某币后，通过OKX API获取该币的内幕钱包列表
 *    (insiders = bundlers + snipers + dev关联钱包)
 * 2. 通过Solana RPC监控这些地址的Token账户变化
 * 3. 如果内幕钱包开始卖出 → 触发止损
 * 4. 如果内幕钱包加仓 → 通知跑步哥，考虑加仓
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { execSync } = require('child_process');
const path = require('path');

// Helius RPC (高速，免费30次/秒)
const RPC_URLS = [
  'https://mainnet.helius-rpc.com/?api-key=5c5d615e-ba81-4f40-b6a7-dfa9a460839e',
  'https://mainnet.helius-rpc.com/?api-key=6553b0ad-32fa-4cfb-aea4-c4154e757ce1',
];

class InsiderTracker {
  constructor(tokenAddress, chain = 'solana') {
    this.tokenAddress = tokenAddress;
    this.chain = chain;
    this.connection = new Connection(RPC_URLS[0], 'confirmed');
    this.insiderWallets = [];
    this.initialHoldings = {};
    this.onchainos = path.join(process.env.HOME, '.local/bin/onchainos');
  }

  /**
   * 获取内幕钱包列表
   * 来源: OKX bundle info + dev info + signal list
   */
  async getInsiderWallets() {
    const wallets = new Set();

    // 1. 获取Dev地址及其资金来源
    try {
      const devInfo = JSON.parse(
        execSync(`cd ${process.env.HOME}/.openclaw/workspace && ${this.onchainos} market memepump-token-dev-info ${this.tokenAddress} --chain ${this.chain} 2>/dev/null`).toString()
      );
      if (devInfo.ok && devInfo.data?.devHoldingInfo) {
        const dev = devInfo.data.devHoldingInfo;
        if (dev.devAddress) wallets.add(dev.devAddress);
        if (dev.fundingAddress) wallets.add(dev.fundingAddress);
      }
    } catch (e) {}

    // 2. 获取Bundle信息（Bundler/Sniper地址）
    try {
      const bundleInfo = JSON.parse(
        execSync(`cd ${process.env.HOME}/.openclaw/workspace && ${this.onchainos} market memepump-token-bundle-info ${this.tokenAddress} --chain ${this.chain} 2>/dev/null`).toString()
      );
      if (bundleInfo.ok && bundleInfo.data?.bundlers) {
        for (const b of bundleInfo.data.bundlers) {
          if (b.address) wallets.add(b.address);
        }
      }
    } catch (e) {}

    // 3. 获取该币相关的聪明钱信号中的钱包
    try {
      const signals = JSON.parse(
        execSync(`cd ${process.env.HOME}/.openclaw/workspace && ${this.onchainos} market signal-list ${this.chain} --wallet-type "1,2,3" --min-amount-usd 100 2>/dev/null`).toString()
      );
      if (signals.ok && signals.data) {
        for (const sig of signals.data) {
          if (sig.token?.tokenAddress === this.tokenAddress) {
            const addrs = sig.triggerWalletAddress?.split(',') || [];
            addrs.forEach(a => wallets.add(a.trim()));
          }
        }
      }
    } catch (e) {}

    this.insiderWallets = [...wallets].filter(w => w && w.length > 30);
    return this.insiderWallets;
  }

  /**
   * 获取某钱包持有某Token的数量
   */
  async getTokenBalance(walletAddress) {
    try {
      const wallet = new PublicKey(walletAddress);
      const token = new PublicKey(this.tokenAddress);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(wallet, { mint: token });
      let total = 0;
      for (const acc of accounts.value) {
        total += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
      }
      return total;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 快照所有内幕钱包的当前持仓
   */
  async snapshotHoldings() {
    const holdings = {};
    for (const wallet of this.insiderWallets) {
      holdings[wallet] = await this.getTokenBalance(wallet);
      // 避免RPC限速
      await new Promise(r => setTimeout(r, 200));
    }
    this.initialHoldings = holdings;
    return holdings;
  }

  /**
   * 检查内幕钱包是否在卖出
   * 返回: { selling: [], holding: [], buying: [] }
   */
  async checkInsiderActivity() {
    const result = { selling: [], holding: [], buying: [] };
    
    for (const wallet of this.insiderWallets) {
      const currentBalance = await this.getTokenBalance(wallet);
      const initialBalance = this.initialHoldings[wallet] || 0;
      await new Promise(r => setTimeout(r, 200));

      const shortAddr = wallet.slice(0, 8) + '...' + wallet.slice(-4);

      if (currentBalance < initialBalance * 0.9) {
        // 减仓超过10%
        const soldPct = ((initialBalance - currentBalance) / initialBalance * 100).toFixed(1);
        result.selling.push({ wallet: shortAddr, full: wallet, soldPct, from: initialBalance, to: currentBalance });
      } else if (currentBalance > initialBalance * 1.1) {
        // 加仓超过10%
        const addedPct = ((currentBalance - initialBalance) / initialBalance * 100).toFixed(1);
        result.buying.push({ wallet: shortAddr, full: wallet, addedPct, from: initialBalance, to: currentBalance });
      } else {
        result.holding.push({ wallet: shortAddr, full: wallet, balance: currentBalance });
      }
    }

    return result;
  }
}

// 导出供交易脚本使用
module.exports = { InsiderTracker };

// 命令行测试
if (require.main === module) {
  const tokenAddr = process.argv[2];
  if (!tokenAddr) {
    console.log('用法: node insider_tracker.js <token_address>');
    process.exit(1);
  }

  (async () => {
    const tracker = new InsiderTracker(tokenAddr);
    
    console.log('🔍 获取内幕钱包...');
    const wallets = await tracker.getInsiderWallets();
    console.log(`找到 ${wallets.length} 个内幕钱包:`);
    wallets.forEach(w => console.log(`  ${w}`));

    if (wallets.length > 0) {
      console.log('\n📸 快照当前持仓...');
      const holdings = await tracker.snapshotHoldings();
      for (const [w, bal] of Object.entries(holdings)) {
        console.log(`  ${w.slice(0,8)}...${w.slice(-4)}: ${bal.toLocaleString()} tokens`);
      }
    }
  })();
}
