# 跑步哥的交易系统总览

## 一、🐕 土狗（链上DEX交易）

### 1. 横盘策略
- **逻辑**：发现横盘形态 + 聪明钱加仓 → 买入
- **四种横盘模式**：
  - 冲高回落底部横住
  - 底部抬升震荡上行
  - W底双底确认
  - 腰部横盘（等二次拉升）
- **链**：Solana / BSC / Base
- **仓位**：0.5 SOL/笔
- **止盈**：翻倍出本金 → 剩下跟聪明钱
- **止损**：聪明钱跑了我们也跑
- **状态**：✅ 扫描器运行中，等信号自动交易

### 2. 聪明钱跟单策略
- **逻辑**：多个聪明钱买同一个币 → 共识度权重≥5 → 跟买
- **聪明钱来源**：私有列表（不用OKX公开数据）
  - Solana: 链上分析 + 钓鱼过滤
  - BSC/Base: 链上分析（底部买入+持有+多币赚钱）
- **仓位**：0.5 SOL/笔
- **止盈**：翻倍出本金 → 剩下跟聪明钱
- **止损**：聪明钱跑了我们也跑
- **状态**：✅ WebSocket秒级监听150个地址

---

## 二、💰 套利（CEX交易所合约）

### 资金费率套利
- **逻辑**：利用永续合约资金费率差异，现货+合约对冲吃费率
- **数据源**：CoinGlass ArbitrageList
- **平台**：OKX / Bybit / Bitget
- **本金**：$10,000
- **预期年化**：30-50%（保守）
- **状态**：⏳ 等API Key（需各平台合约权限）

---

## 系统架构

| 组件 | 文件 | 功能 |
|---|---|---|
| 扫描器 | scanner_daemon.js | 24/7三链扫描+WebSocket监听 |
| Solana聪明钱 | solana_smart_money_builder.js | 私有聪明钱识别 |
| EVM聪明钱 | evm_smart_money_builder.js | BSC/Base聪明钱识别 |
| 钓鱼检测 | bait_wallet_detector.js | 识别+过滤钓鱼钱包 |
| 合约审计 | contract_audit.js | honeypot.is安全检查 |
| 叙事追踪 | narrative_tracker.js | 热点叙事监控 |
| 策略配置 | strategy_横盘.json | 横盘策略参数 |
| 策略配置 | strategy_聪明钱跟单.json | 跟单策略参数 |

## 钱包

| 用途 | 地址 | 余额 |
|---|---|---|
| Solana土狗 | jLVNxrQ6QX8neHx8bFeEvcTgRed4e4YXiePpfcPHosK | 1.44 SOL |
| BSC土狗 | 待充值 | — |
| Base土狗 | 待充值 | — |
| OKX合约套利 | 待建API Key | — |
| Bybit合约套利 | 待建API Key | — |
| Bitget合约套利 | 待建API Key | — |
