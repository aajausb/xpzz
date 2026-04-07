# HEARTBEAT.md

## 土狗系统（专注！$100→$1,000-$10,000）
### 当前状态：v8引擎已上线运行！
### 服务：meme-v8.service (systemd)
1. [x] 三链买卖全通（Solana/BSC/Base，统一OKX聚合器）
2. [x] v8引擎：币安PnL Rank → 钱包库(持久化) → 动态排名 → 链上实时跟单
3. [x] 钱包库233个，实盘56个(WR 60-80%)，BSC/Base WebSocket实时推送
4. [ ] 等待真实信号验证完整链路（信号→确认→审计→买入）

## 聪明钱包监控回查（每次heartbeat执行）
1. 抽查3-5个实盘钱包（每链各1-2个**猎手**），查最近1小时有没有新交易
   - SOL: getSignaturesForAddress limit=3
   - BSC/Base: 查链上最近Transfer事件，对比引擎日志是否检测到
2. 如果发现有新交易但引擎日志里没有对应检测记录 → 说明WS漏了
3. 漏了就：通知跑步哥 + 重启引擎WS连接
4. 抽查结果记入 `memory/heartbeat-state.json` 的 `lastWalletCheck`
5. **不要跳过这步**——BSC WS超限漏了5个猎手买骡子快跑，差点错过大机会

## AI信号分析（每次heartbeat执行，最优先！）
1. 直接读取 `crypto/meme/data/v8/analyze_queue.json`（不是notify_queue.json！）
2. 找 `type: 'analyze'` 的条目
3. 对每条分析请求：
   a. 用 `curl -s "https://r.jina.ai/网站URL"` 读取网站内容（如果有website）
   b. 用 `curl -s "https://r.jina.ai/Twitter链接"` 读取Twitter/社区信息（如果有twitter）
   c. 综合所有数据写出AI分析：叙事 + 100分评分 + 建议
   d. 评分维度(满分100)：主池质量(10) + 流动性(10) + 趋势动能(10) + 交易活跃度(10) + 梗/传播力(15) + 社区规模(15) + SM共识(15) + 猎手信号(10) + 跑路风险(5)
   e. **合成一条消息发送**：数据部分用 `notifyMsg` 字段 + 追加AI分析部分
   f. 用引擎的TG Bot直发（node脚本），parse_mode=HTML，带buttons，合约用<code>包裹
   g. 发送脚本：`node -e "require('node-fetch')('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:'877233818',text:消息,parse_mode:'HTML',disable_web_page_preview:true,reply_markup:JSON.stringify({inline_keyboard:按钮})})})"`
4. 处理完后清空队列（写入 `[]`）
5. **分析必须客观，不确定就说不确定，不要编**
6. **meme币评分标准：越抽象越有梗=传播力高分，不要用传统项目标准**
7. **网站/Twitter读不到时标注"无法访问"，不扣分不加分**

## 引擎通知转发（已废弃）
引擎通知现在走AI分析流程合成一条发送，不再单独转发。
4. **不要跳过**——引擎直连TG API被墙，所有买卖通知都靠这个转发

## 进程存活检查（每次heartbeat执行）
1. 只检查 `meme-v8`（跟单引擎）
2. 挂了用 `systemctl restart meme-v8` 拉起
3. scanner-daemon / auto-trader / arbitrage-live 已永久停止，不要拉起

## 买入链路验证（每次heartbeat执行）
1. 查最近6小时有没有达标信号（通过审计）
2. 如果有达标信号但没有对应的"买入成功"记录 → 立刻查日志找原因，通知跑步哥
3. 引擎跑了>6小时且0笔成功买入 → 主动排查，不要等跑步哥问
4. **不要假设"没报错就没问题"**
5. **改代码后6小时内必须有买卖活动，没有就立刻排查通知跑步哥**

## 引擎日志自检（每次heartbeat执行）
1. 查最近30分钟 `journalctl -u meme-v8` 里的ERROR和WARN（排除coalesce）
2. 如果有**重复出现的同一条WARN/ERROR**（比如同一个变量undefined反复报） → 说明有bug，立刻通知跑步哥
3. 如果有"执行买入"但没有对应"买入成功" → 说明买入链路断了，立刻通知
4. **不要等跑步哥问才去查**

## 内存检查（每次heartbeat执行）
1. 运行 `free -m` 检查可用内存
2. 如果可用内存 < 1000MB：清理系统缓存
3. 如果可用内存 > 1000MB，不做操作

## 记忆维护（每天执行1-2次）
1. 检查 `memory/YYYY-MM-DD.md` 今天的日记是否存在，不存在就创建
2. 把当天重要事件写入日记
3. 每隔几天回顾最近日记，更新 MEMORY.md 长期记忆
