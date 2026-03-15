# HEARTBEAT.md

## 土狗系统（专注！$100→$1,000-$10,000）
### 当前状态：v8引擎已上线运行！
### 服务：meme-v8.service (systemd)
1. [x] 三链买卖全通（Solana/BSC/Base，统一OKX聚合器）
2. [x] v8引擎：币安PnL Rank → 钱包库(持久化) → 动态排名 → 链上实时跟单
3. [x] 钱包库233个，实盘56个(WR 60-80%)，BSC/Base WebSocket实时推送
4. [ ] 等待真实信号验证完整链路（信号→确认→审计→买入）

## 进程存活检查（每次heartbeat执行）
1. 只检查 `meme-v8`（跟单引擎）
2. 挂了用 `systemctl restart meme-v8` 拉起
3. scanner-daemon / auto-trader / arbitrage-live 已永久停止，不要拉起

## 内存检查（每次heartbeat执行）
1. 运行 `free -m` 检查可用内存
2. 如果可用内存 < 1000MB：清理系统缓存
3. 如果可用内存 > 1000MB，不做操作

## 记忆维护（每天执行1-2次）
1. 检查 `memory/YYYY-MM-DD.md` 今天的日记是否存在，不存在就创建
2. 把当天重要事件写入日记
3. 每隔几天回顾最近日记，更新 MEMORY.md 长期记忆
