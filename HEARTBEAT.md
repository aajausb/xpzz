# HEARTBEAT.md

## 看板自动更新（每次heartbeat执行）
1. 查三所真实浮盈（binance+bybit+bitget 的 unrealizedPnl 两侧合计）
2. 读取 `crypto/arbitrage_live_state.json` 的 PnL 和仓位
3. 用 `message` tool `action=edit` 更新看板消息 (messageId=3524, target=877233818)
4. 聪明钱/土狗已暂停，不显示

## 内存检查（每次heartbeat执行）
1. 运行 `free -m` 检查可用内存
2. 如果可用内存 < 1000MB：
   - 检查各进程内存占用
   - 运行 `sync && echo 3 > /proc/sys/vm/drop_caches` 清理系统缓存
3. 如果可用内存 > 1000MB，不做操作

## 进程存活检查（每次heartbeat执行）
1. 只检查 `arbitrage-live`（套利实盘引擎）
2. scanner-daemon / auto-trader 已暂停，不要拉起
3. 挂了用 `systemctl restart arbitrage-live` 拉起
