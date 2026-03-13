# HEARTBEAT.md

## 看板自动更新（每次heartbeat执行）
1. 运行 `curl -s http://127.0.0.1:9876/refresh`（引擎内部刷新，自带按钮）
2. **不要用 message tool edit 直接编辑看板**（会丢按钮）

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

## 断联恢复补记（每次heartbeat执行）
1. 读 `memory/` 目录找今天的日记文件
2. 检查引擎日志最近有没有 "🤖引擎:" 开头的重要事件（开仓/平仓/告警）
3. 如果有引擎自动记录的事件但日记里没有我（小胖崽崽）的分析记录，补写简短总结
4. 这样即使我断联了，恢复后也能从引擎日志重建那段时间发生了什么

## 记忆维护（每天执行1-2次）
1. 检查 `memory/YYYY-MM-DD.md` 今天的日记是否存在，不存在就创建
2. 把当天重要事件（开仓/平仓/bug修复/配置变更）写入日记
3. 每隔几天回顾最近日记，更新 MEMORY.md 长期记忆
