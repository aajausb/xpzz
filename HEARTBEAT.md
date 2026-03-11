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
