# HEARTBEAT.md

## 套利研究任务（跑步哥交代，不能偷懒）
### 进度追踪文件: crypto/research/progress.md
1. [ ] 拉取过去7天四所费率数据，存到 crypto/research/funding_history/
2. [ ] 回测现有策略：每次开平仓的实际收益vs手续费，算真实盈亏比
3. [ ] 统计亏钱根因分布（费率反转/滑点/bug各占多少）
4. [ ] 找出费率差最稳定的前20币种
5. [ ] 研究新策略：期现套利、跨期套利、波动率套利、上币时差套利
6. [ ] 搜索散户可做的套利策略（web_search）
7. [ ] 形成研究报告，给出具体建议+数据支撑
**每次heartbeat推进至少一步，完成后打勾**

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
