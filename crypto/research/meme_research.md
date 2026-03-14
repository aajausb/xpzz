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

## 6. 2026年初 Meme 市场数据快照（2026-03-14 搜集）

### 市场规模
- Solana meme 总市值 $6.7B（2026年1月）
- Pump.fun 日DEX交易量峰值 $2.03B（1/6），月均从$11.7B降至~$2.4B
- 每日新发币 30,000+（pump.fun平台）
- 仅极小比例的币能跑出10x+（Galaxy Research确认）

### 头部 meme 表现（2026年1月数据）
| Token | 市值 | 周涨幅 | 特征 |
|-------|------|--------|------|
| BONK | $1.5B+ | +50% | Solana叙事复苏，社区burn |
| WIF | $2B+ | 稳定 | 蓝筹meme，持仓分布健康 |
| POPCAT | ~$500M | 高波动 | 病毒式社交传播，快速pump/dump |
| PEPE | $4B+ | +32% | 跨链吸引力，1月流动性带动 |
| $PUMP | ATH跌70% | — | 平台token，$0.0026，pivot做基建 |

### 重要趋势
1. **AI + Meme 叙事**：SUGEE（3月初pump.fun上线，AI agent创建）引发关注
2. **政治meme**：$TRUMP上线后$MELANIA分流流动性，$TRUMP跌50%
3. **创始人风险**：Bags生态创始人跑路，$GAS -91%、$RALPH -54%
4. **Pump.fun转型**：$3M Pump Fund投资12个项目，从炒作转基建
5. **Sniper bot 生态成熟**：Padre/Axium/Photon/Trojan/BonkBot 五大工具

### 10x币的共同特征（综合分析）
1. **叙事先行**：有清晰的 meme 主题（AI/政治/动物/病毒梗）
2. **社交爆发**：推特KOL喊单能带34%涨幅（James Wynn案例）
3. **bonding curve速度**：成功币的bonding curve 10x速度完成
4. **持仓分散**：top10 holder 占比低，几百个maker以上
5. **流动性锁定**：有LP锁，不是随时能跑的
6. **时机对**：跟随BTC/SOL大盘上涨趋势，不逆势
7. **生命周期极短**：多数pump.fun币在小时级别完成涨跌，要极快进出

### 对我们策略的启示
- **纯数据驱动不够**：必须加社交情绪（推特热度 = 最强信号）
- **速度是核心竞争力**：sniper bot级别的毫秒响应
- **小仓位多试错**：$20/笔，5笔并行，1个10x就回本
- **创始人背景查**：避开key-man risk（一人项目跑路=归零）
- **跟KOL不如跟链上**：KOL喊单时已经晚了，要看他们的钱包先动

## 7. 选币评分模型 v1（2026-03-14 14:00 设计）

### 设计原则
- 简单 > 复杂（Reddit经验：越复杂越容易失效）
- 速度 > 精度（毫秒级响应，宁可误杀不可漏防）
- 数据驱动，不凭感觉
- $20/笔小仓位，允许高误判率，只要偶尔10x就赚

### 评分维度（总分100分，≥60分买入）

#### A. 安全基础（30分，硬性淘汰项）
| 检查项 | 分值 | 标准 | 工具 |
|--------|------|------|------|
| 非貔貅盘 | 10 | 能正常卖出 | RugCheck / honeypot.is |
| DEV持仓≤5% | 10 | 单一地址不超过5% | getTokenLargestAccounts |
| 流动性≥$10k | 5 | 至少能出得去 | DexScreener |
| 非已知scam模板 | 5 | 合约不在黑名单 | RugCheck |

**任何一项不过=直接淘汰，不看其他分数**

#### B. 链上信号（40分，核心）
| 指标 | 分值 | 标准 | 数据源 |
|------|------|------|--------|
| 庄家/聪明钱参与 | 15 | 我们库里的钱包买了 | smart_wallets.json |
| Holder增长率 | 10 | 1h内新增≥50个holder | Helius getTokenAccounts |
| 买入/卖出比 | 10 | buy:sell ≥ 3:1（前30min） | Helius parsedTransactions |
| 大单买入 | 5 | 单笔≥1 SOL的买入≥5笔 | Helius parsedTransactions |

#### C. 市场结构（15分）
| 指标 | 分值 | 标准 | 数据源 |
|------|------|------|--------|
| bonding curve进度 | 5 | 20%-70%（太低没人买，太高快毕业） | pump.fun API |
| 市值合理区间 | 5 | $50k-$5M（太小流动性差，太大倍数低） | DexScreener |
| 大盘环境 | 5 | SOL 24h涨幅≥0%（不逆势） | CoinGecko |

#### D. 情绪加分（15分，锦上添花）
| 指标 | 分值 | 标准 | 数据源 |
|------|------|------|--------|
| 推特提及 | 10 | 搜到≥3条非bot推文 | agent-reach Twitter搜索 |
| 叙事热点 | 5 | 符合当前热门叙事（AI/政治/动物） | 人工维护热词表 |

### 动态权重
- **庄家信号权重翻倍**：如果聪明钱库里≥2个钱包买了同一个币，B部分庄家分数×2（最高30分）
- **速度衰减**：币创建超过4小时，总分×0.8；超过24小时，×0.5
- **大盘惩罚**：SOL 24h跌幅>5%，总分×0.7（熊市别冲）

### 实际执行流程
```
新币出现 → 安全检查(A) → 不过直接跳过
         ↓ 过了
  链上信号(B) + 市场结构(C) 并行计算（<2秒）
         ↓
  总分≥45 → 推特快查(D)（<5秒）
         ↓
  总分≥60 → 下单$20
  总分45-60 → 加入观察，5分钟后重新评分
  总分<45 → 跳过
```

### 止盈止损（买入后）
| 条件 | 动作 |
|------|------|
| +100%（2x）| 卖40%，保本 |
| +400%（5x）| 再卖30%，锁利 |
| +900%（10x）| 再卖20%，剩10%放飞 |
| -50% | 全清，不补仓 |
| 庄家钱包开始卖 | 立即跟卖全部 |
| 创建>24h且没涨 | 全清 |

### 模型验证方法
- 用过去30天已涨10x的币（WAR/SMITH等）回测：这些币在早期能打多少分？
- 用过去30天归零的币回测：这些币能被筛掉吗？
- 目标：10x币评分≥60，归零币评分<45

### v1局限性（已知）
- 推特搜索有延迟（5-10秒），可能错过最快的窗口
- 聪明钱库还在建设中（scanner v5运行中，当前≤5个验证钱包）
- 没有TG群监控（信息盲区）
- bonding curve数据需要pump.fun API（目前503，需替代方案）

## 8. 待办
- [x] 搜索现在 Solana 上有什么好的新币监控 API ✅
- [x] 调研推特情绪监控方案 ✅
- [x] 分析10倍币共同特征 ✅（综合搜索数据 + 文章分析，见第6节）
- [x] 设计自动筛选评分模型 ✅（第7节，100分制，4维度+动态权重）
- [ ] 把 Chainstack bot 改写成 Node.js 版本（匹配现有技术栈）
- [ ] 测试 Helius webhook 配置 pump.fun 监听
- [ ] 用 okx-dex-market 的 meme 安全检查功能验证方案可行性
