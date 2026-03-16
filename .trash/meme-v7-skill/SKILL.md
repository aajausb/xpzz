---
name: meme-v7
description: >
  土狗v7跟单系统 — OKX聪明钱信号自动跟单。三链(Solana/BSC/Base)支持。
  功能：OKX聪明钱信号采集→≥3个SM确认→自动买入→止盈止损。
  依赖：OKX API Key + 钱包私钥 + onchainos CLI。
  使用场景："跟单"、"聪明钱"、"土狗"、"meme跟单"、"smart money"。
---

# 土狗v7 — OKX聪明钱信号跟单

OKX三链聪明钱信号 → ≥3个SM买同一币 → 自动买入 → 止盈止损。

## 前置条件

1. OKX API Key（https://web3.okx.com/build/dev-portal）
2. onchainos CLI（`npm install -g onchainos && onchainos auth`）
3. 钱包私钥

## 安装

```bash
cd <skill_dir>/scripts && npm install
cp .env.example .env  # 填入密钥
```

## 运行

```bash
node <skill_dir>/scripts/v7_engine.js
```

## 配置（v7_engine.js顶部CONFIG）

| 参数 | 默认 | 说明 |
|------|------|------|
| positionSizeUsd | $10 | 每笔金额 |
| maxPositions | 10 | 最多持仓 |
| minSmartMoneyCount | 3 | 最少SM确认 |
| takeProfitPercent | 100% | 翻倍止盈 |
| stopLossPercent | -50% | 止损线 |
| trailingStopPercent | 30% | 追踪止盈回撤 |

## 文件

- `v7_engine.js` — 主引擎（信号+买卖+持仓管理+钱包）
- `dex_trader.js` — 三链交易模块（OKX聚合器500+ DEX）
