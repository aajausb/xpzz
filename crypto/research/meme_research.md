# 土狗研究笔记

## 研究时间: 2026-03-14

## 1. 关键发现

### Reddit 用户真实经验（重要）
一个尝试做 Solana meme bot 的人的总结：
> "大多数策略保质期很短。这周有效的下周就失效了。因为顶层自动化玩家不断进化。越复杂的条件越容易失效，反而越简单的条件越有效，但需要极快的执行速度。"

**启示**：不要做复杂策略，做简单但快的。

### 2026 Meme 交易策略框架（tradingsignalzone.com）
- **两阶段市场周期**：吸筹期（低波动、持仓人数稳定增长）→ 拉盘期（爆发式上涨）
- **仓位管理**：总 meme 仓位不超过总资产 10%，单笔不超过 2%
- **筛选条件**：流动性 > $500k，市值 < $50M，持仓分布不能太集中
- **止盈**：2x 卖一部分，5x 再卖，10x 再卖
- **止损**：-30% 硬止损，不抱幻想

### 实操流程（Reddit 交易者）
1. 开 Photon（交易）+ DexScreener（图表）+ RugCheck（安全）
2. 看 30min/1h 涨幅榜
3. 筛选：流动性锁定、几百个 maker、有回调但还在涨
4. 避开暴涨后暴跌 90% 的币
5. 买入后盯盘不离手

## 2. 我们的优势和劣势

### 优势
- 24 小时不间断监控
- 有 3 条链的基础设施（Solana/BSC/Base）
- 有聪明钱数据库（Solana 543 + BSC 253 + Base 84）
- 能自动执行，不受情绪影响

### 劣势
- 信号源被稀释（公开平台聪明钱列表alpha已耗尽）
- 之前 69% 归零率
- 没有情绪感知能力（推特/TG 群热度）
- $100 起步资金极小

## 3. 策略方向

### 方向 A：庄家行为追踪（链上）
- 不用公开聪明钱列表，自建私有列表
- 监控新出现的高胜率钱包（过去 7 天胜率 > 60%、利润 > $10k）
- 跟踪这些钱包的买入行为
- 优点：纯数据驱动，可自动化
- 缺点：滞后，庄家可能用新钱包

### 方向 B：叙事驱动（情绪面）
- 监控推特/TG 热词爆发
- 检测到某个币名突然被大量提及 → 检查链上数据 → 买入
- 优点：能抓到情绪起来的第一波
- 缺点：需要推特 API、可能被假信息骗

### 方向 C：新币筛选（pump.fun 风格）
- 监控 pump.fun / Raydium 新上线的币
- 实时筛选：bonding curve 进度、holder 数量增速、DEV 持仓
- 买入满足条件的币，快进快出
- 优点：最早期，利润空间大
- 缺点：99% 是垃圾，需要极高的过滤精度

### 方向 D：混合策略（推荐）
- 用 C 监控新币
- 用 A 过滤（有庄家钱包参与的优先）
- 用 B 确认（有社交热度的优先）
- 三重验证才下单

## 4. $100 策略

$100 分成 5 笔 × $20：
- 每笔 $20 买入一个币
- 止损 -50%（$10）
- 止盈阶梯：2x 卖 40%，5x 卖 30%，10x+ 卖剩下
- 最坏情况：5 笔全亏 = -$50（还剩 $50 再来）
- 只要 1 个 10x = $200，覆盖所有亏损还赚

## 5. 新币监控 API 调研（2026-03-14 07:41 更新）

### 方案 A：pump.fun WebSocket（第三方）
- **NoLimitNodes**: `wss://api.nolimitnodes.com/pump-fun?api_key=KEY`
  - 免费 API key，实时推送新币创建事件
  - 返回数据：name, symbol, mint, bondingCurve, creator_wallet, block, timestamp
  - 优点：零延迟，数据完整，Python/Node.js 都能接
  - 缺点：依赖第三方，免费额度可能有限
  - 教程：https://nolimitnodes.com/blog/pump-fun-websocket-tutorial-get-a-realtime-token-stream-of-newly-launched-tokens/

- **PumpDev.io**: 另一个 pump.fun API 提供商
  - 支持买卖+WebSocket+IPFS metadata+Jito bundles
  - 更全面但可能收费

### 方案 B：直接链上监听（无第三方依赖，推荐）
- **Chainstack 开源 bot**: https://github.com/chainstacklabs/pump-fun-bot
  - 纯 Python，直接订阅 Solana RPC WebSocket（blockSubscribe）
  - 监听 pump.fun 主程序 `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
  - 过滤 `create` 指令，提取 mint/bondingCurve/associatedBondingCurve
  - 自带买入+卖出脚本，完整的监听→买→卖闭环
  - 用 Anchor IDL 解码，不依赖任何第三方 API
  - 注意：pump.fun token 是 6 位小数（非默认 9 位）
  - **我们已有 Helius RPC×2，可以直接用！**
  - Solana 官方推荐生产环境用 Geyser（而非 blockSubscribe），性能更好

- **Helius Webhooks**: 我们已有 Helius key
  - 可配置 webhook 监听特定程序的交易
  - 比 WebSocket 更稳定，Helius 管理重连
  - 待测试具体配置

### 方案 C：Apify pump.fun Monitor
- Apify 上有现成的 pump.fun 新币监控 actor
- 但我们注册 Apify 失败过（reCAPTCHA），跳过

### 推特情绪监控方案

找到的工具：
1. **Meme Coin Tracker (GitHub: amul69906995)**: 爬推特 KOL 推文，Socket 实时推送
2. **Sorsa.io**: Crypto Twitter 情报平台，AI 过滤假粉丝/bot
3. **AxiomRadar**: 扫推特+社交，追踪 meme 讨论，过滤 bot，验证 dev 背景
4. **LunarCrush**: 加密社交情绪聚合（可能需付费）

**无 API key 免费方案**：
- 直接用 agent-reach skill 搜推特关键词（我们已有！）
- 定时搜索热词：pump.fun, SOL meme, 🚀, 100x 等
- 缺点：不实时，有搜索频率限制

### 💡 推荐技术路线
1. **新币监控**: 方案 B（Chainstack bot）改写成 Node.js，用 Helius RPC
2. **情绪验证**: agent-reach 搜推特 + AxiomRadar 免费层
3. **链上过滤**: OKX OnchainOS skills（已装）查 holder/liquidity/dev 行为
4. **执行交易**: OKX OnchainOS swap（已装）

## 6. 待办
- [x] 搜索现在 Solana 上有什么好的新币监控 API ✅
- [x] 调研推特情绪监控方案 ✅
- [ ] 回测过去 30 天的 10 倍币特征（用 okx-dex-market skill 拉数据）
- [ ] 设计自动筛选评分模型
- [ ] 把 Chainstack bot 改写成 Node.js 版本（匹配现有技术栈）
- [ ] 测试 Helius webhook 配置 pump.fun 监听
- [ ] 用 okx-dex-market 的 meme 安全检查功能验证方案可行性
