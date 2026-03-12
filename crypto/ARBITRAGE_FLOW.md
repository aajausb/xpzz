# 套利引擎链路图

## 开仓链路（从上到下，每步有明确拦截原因）

```
触发源
├── REST扫描（每2分钟）
└── WS实时推送

    ↓

[Step 1] 预过滤（scanFundingArbitrage 内，零API调用）
├── 暂停检查 → paused=true 跳过
├── 仓位上限 → positions >= MAX_POSITIONS 跳过
├── 结算窗口 → 40-70分钟内才继续
├── 结算对齐 → >3h差不做，30min-3h需1%门槛
├── 费率门槛 → 对齐≥0.3%, 不对齐≥1.0%
├── 原始费率差 → ≥0.1%
├── 冷却检查 → 同币对冷却期内跳过
├── 去重检查 → 已有同币持仓跳过
└── 余额预检 → 两所余额 > 仓位*1.2

    ↓ 通过 → 生成 opportunity 对象

[Step 2] 验证（executeFundingArbitrage 内，需API调用）
├── 并发锁 → openingSymbols 防重复
├── 历史趋势 → checkFundingTrend: 5期≥60%正, 最近2期不连续反转
├── 盘口深度 → 两所orderbook, 不够则降级(最低$200)
├── 滑点检查 → 两所≤10bps
├── 价差检查 → 两所价差≤1%
└── 数量计算 → alignQty精度对齐

    ↓ 通过 → 准备下单

[Step 3] 执行
├── 余额划转 → ensureFuturesBalance
├── 双边下单 → futuresLong + futuresShort 并发
├── 成交确认 → Binance NEW状态等待
└── 单腿保护 → 一边成一边没成则反向平仓

    ↓ 成功

[Step 4] 补仓（深度降级后立刻重试）
├── 差额计算 → target - current
├── 盘口重查 → 2秒间隔
├── 价差检查 → >1%暂停
├── 双边下单 → 同Step 3
└── 最多3次重试
```

## 持仓管理链路

```
[每5分钟] checkFundingPositions
├── 拉两所当前费率
├── 计算当前费率差
├── 费率反转检查
│   ├── 正费率差 → consecutiveNeg=0, 状态更新
│   └── 负费率差 → consecutiveNeg++
│       └── ≥2次连续 → 触发平仓
└── 更新 currentSpread, unrealizedPnl

[每1小时] rebalancePositions
├── 遍历所有仓位
├── 健康评分（healthy/ok/weak/bad）
├── 加仓判断 → 当前size < targetSize(费率差档位)
│   ├── 深度检查
│   ├── 价差检查
│   └── 双边下单
└── 弱仓替换 → 更好机会差≥0.1%
```

## 安全链路

```
[每60秒] checkMarginSafety
├── 查三所保证金率（原生API）
├── ≥90% → 自动平最大仓位
├── ≥70% → 通知(10min间隔)
└── ≥50% → 通知(30min间隔)

[每30秒] extremeMarketCheck
├── 检查持仓币价格波动
└── 异常通知

[WS] 强平监听
└── 收到强平事件 → 立即通知
```

## 日志规范

每步拦截时打日志，格式：
- `⏭️ {symbol} 原因` — 被拦截
- `🔍 {symbol} ...` — 机会发现
- `📊 {symbol} ...` — 验证通过
- `🚀 {symbol} ...` — 开始下单
- `✅ {symbol} ...` — 成功
- `❌ {symbol} ...` — 失败
- `⚠️ {symbol} ...` — 警告
