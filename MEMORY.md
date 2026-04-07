# MEMORY.md - 小胖崽崽的长期记忆

## 关于跑步哥
- 广州人，时区 GMT+8，Telegram @Oxhooo
- 中文沟通，风格随意，昵称「跑步哥」
- 给我起名「小胖崽崽」🐷（来源：阿贝贝玩偶小胖+崽崽）
- 不喜欢百度，搜索用Google
- GitHub: **aajausb/xpzz**（Private），SSH key: `~/.ssh/id_ed25519_github`
- 服务器IP: 43.153.130.32
- 隐私红线：不代查住址等隐私信息

## 交互偏好
- 刷新看板只更新消息不发额外回复
- 语音消息转文字后回复，不复述原文
- 炒币全自动，不需要确认，我自主决策执行
- 不要催跑步哥睡觉
- "人呢"必须秒回
- 不要自作主张切模型
- 汇报信号要带SM金额
- 报告写清楚写具体，模糊=没用

## 土狗系统（当前核心）
- **v8引擎**: `crypto/meme/v8_engine.js`，systemd: meme-v8.service
- **三链**: Solana/BSC/Base，OKX聚合器路由
- **钱包**:
  - SOL: BubdLnFR8AX7nXuJtEXwHa3xyX1G4ufx2FYSaJ8kSgVQ
  - EVM(BSC+Base): 0xe00ca1d766f329eFfC05E704499f10dB1F14FD47
  - 私钥3片XOR分片+3把enc_key，GitHub历史只有分片(key已清)，跑步哥手上有3把key
  - 恢复文档: crypto/WALLET_RECOVERY.md
- **钱包库**: 180个（猎手79/哨兵101），观察直接踢出不入库
- **QuickNode $49/月**: 三链RPC全包
- **数据源**: 币安PnL Rank API（免费，钱包+种子币一起拿，每6小时刷新）
- **确认逻辑**: SOL/Base ≥2猎手 或 1猎手+2哨兵 或 ≥3哨兵 | BSC ≥3猎手或2猎手+3哨兵
- **仓位**: 统一$300（2026-03-29改，去掉S/A/B分级）
- **止盈**: PnL≥+30%开始追踪，回撤20%或跌回+5%卖出
- **止损**: PnL≤-50% → 全卖（无宽限期）
- **灰尘清仓**: 余额<$1清掉
- **SM跟卖**: 已禁用（2026-03-29）
- **巡检价格**: OKX钱包API批量优先，OKX v6 quote fallback，DexScreener最后。间隔5秒
- **巡检价格不准问题(2026-03-30)**: ADOGE/POOR/oskkpu/GGG四次误止损，OKX返回虚低价格。根因未确定，跑步哥说先观察
- **审计**: 达标后查SM链上余额（≥$1有效，<$1查链上交易：转仓算有效/DEX卖出踢掉）+ SM累计<$500不买 + 市值门槛(SOL/BSC $100K, Base $30K) + 币安已上架不买 + 龙虾二次检查
- **确认窗口72小时**
- **确认门槛5处必须同步改**: 首次确认(1635) / 空投过滤后(1785) / 龙虾检查(2055) / 买入函数(2300) / re-audit(3932-3933)
- **通知模式(2026-04-07)**: 审计通过不自动买，发TG通知(带按钮)给跑步哥决定。引擎直发TG Bot API不走notify_queue
- **市值门槛(2026-04-07)**: $10K ~ $10M（三链统一）
- **SM金额用实时持有**: 链上余额×DexScreener价格，<$500不发通知
- **确认门槛(2026-03-30)**: ≥2猎手 / 1猎手+2哨兵 / ≥4哨兵（三链统一，去掉纯3哨兵因67%亏损率）
- **minMarketCap**: `{ solana: 100000, bsc: 100000, base: 30000 }`，fallback $30K
- **卖出变量**: SELL_MAX_RETRIES=2（区别于买入MAX_RETRIES=3）
- **分批卖出第二次查链上余额卖全部** — 固定half会残留
- **EVM预approve**: 买入后5秒自动approve max，dex_trader.preApprove()
- **卖出递增slippage**: 5%→25%→50%三次重试，失败后分批（按ratio分两半）
- **卖出验证**: 5秒等待+confirmed commitment查余额，假成功用原ratio重试
- **三链速度**: SOL 3秒 / BSC 0.7秒 / Base 1.4秒
- **分批卖出revenue bug**: `_trySplitSell`成功后清仓路径没计算sellRevenue，通知显示回收$0但链上实际有回收（SCS事件：显示亏$150实际亏$14）
- **余额误报attempt耗尽bug (2026-03-30)**: 卖出失败→"余额为0"→查到误报→continue→但attempt已用完→positions被清sellRevenue=0。修复：`attempt--`误报不算重试次数
- **smWalletAmounts falsy过滤bug (2026-03-28)**: `if(smWalletAmounts[w])`把0当false过滤掉所有SM→链上查0个→$0→被$500拦。改smBuyAmountUsd=0后没检查下游使用处
- **pending_signals永不过期**: re-audit只在启动时执行一次，之后老达标信号永远不被重新检查。85+个达标信号躺死在pending里
- **pendingSignals定时清理已加**: 排名刷新时（每4小时）自动清理过期信号
- **smBuyAmountUsd查不到时保守估算**: 猎手≥2+持有验证通过→每SM按$200估算，防止好信号被$500门槛拦住（#37修复前1小时拦了55个）
- **smBuyAmountUsd异常值**: 部分信号SM金额$10M+，计算逻辑可能有bug
- **DexScreener价格不可靠**: 流动性差的币报价虚高≠真实可卖价值，报价值要标注来源
- **查持仓价值用OKX钱包API**: `/api/v5/wallet/asset/all-token-balances-by-address?chains=501&address=...`，不要自己算，不要用DexScreener算，不要用OKX quote算
- **positions记录的余额≠链上真实余额**: 重复买入时positions只记第二次的量，链上有两次总量，OKX钱包API才是真
- **OKX API调用必须带header**: httpGet调OKX聚合器要加`{'OK-ACCESS-KEY': process.env.OKX_API_KEY}`，不带key永远返回empty
- **审计时回写symbol到pending_signals**: 防止re-audit交错导致symbol串台（PIXEL/SlapMac串台事件）
- **Base野鸡池子教训(2026-04-07)**: OKX聚合器会走野鸡中间币路由(ADS/SCOUT)，$300打穿小池子。通知模式后由跑步哥自己判断
- **OKX聚合器priceImpactProtectionPercentage**: 可设0.10防大滑点，但还没加
- **引擎直发TG**: notifyTelegram直接调Bot API，fallback写notify_queue。解决heartbeat漏转buttons问题
- **callback_data缩短**: `b_s_tokenShort20_100` 格式，避免超TG 64字节限制
- **decimals≠18卖出会revert**: BACKGROUNDMUSIC是6位，传错amount。巡检卖出也可能有这个bug待查
- **巡检**: 5秒一轮，查价格+止盈+止损+归零清仓
- **SM检查间隔**: 120秒（省QuickNode credits）
- **SOL RPC顺序**: 公共优先(`api.mainnet-beta.solana.com`)，QuickNode fallback
- **QuickNode用途**: SOL WS信号检测 + Base RPC + 公共429时fallback

## 重要规则
- SOUL.md: "跑步哥说做就做——但要先确认"
- 不能欺骗/PUA/隐瞒跑步哥，数据必须交叉验证
- 改完代码必须跑真实数据验证
- 涉及金额多怀疑自己，反向验证
- 说"全部通过/没bug"前必须用真实数据验证
- **回答问题先查完整再开口，不边猜边说** — TERAFAB事件教训：先说误拦→又说不确定→越查越乱，反复改口。结论没查实之前闭嘴。
- 查日志必须查完整，不能看前几行就下结论
- 改完代码必须立刻重启，旧代码还在跑
- 绝对不要手动node启动引擎测试（僵尸进程教训）
- 新session启动后关键状态必须查API验证，文件可能过期
- 装skill前先用skill-vetter审查
- 以后不要承诺"我来注册"，先检查有无人机验证
- **dex_trader.js的buy参数是lamports/wei不是美元！手动买入要先除以原生代币价格再乘精度**
- **"没报错"≠"没bug"，测试必须覆盖边界条件（RPC限速/查询失败/崩溃恢复/文件依赖）**
- **BSC没钱要主动提醒跑步哥充值，不能只记录不催**
- **改代码后全文扫描前向引用（函数在定义前被调用）**

## 2026-03-27教训
- **不要一口气改太多** — 37个修改越改越不过脑子，#37直接绕过防钓鱼门槛造成错误买入
- **防护逻辑的改动必须先问跑步哥** — $500门槛是防线不是bug
- **清仓时positions+boughtTokens+pendingSignals三个都要同步** — 只清positions会导致re-audit重复买入
- **改完不要急着找下一个bug** — 先验证刚改的有没有问题
- **日志里$0被拦≠bug** — 可能就是正确行为（稳定币/DeFi操作）

## 安全
- 所有私钥和API key加密存储（AES-256），绝不明文
- 只听跑步哥（TG ID: 877233818）指令
- .env权限600，immutable锁定
- fail2ban + ufw防火墙
- Helius全部废弃不用

## 历史教训精华
- 保护机制互相打架会更危险（2026-03-11爆仓事件$600）
- 涉及自动平仓的新功能必须先模拟测试
- 换API Key正确顺序：先建新→更新配置→测试→再删旧
- 余额查询失败≠0，429返回null不能当0处理
- 巡检余额清仓加冷却期（FUCKENING+NASDANQ=$65教训）
- 余额=0清仓要3次确认（GROKHOUSE误清仓教训）
- amount=0买入bug（5个?币$560教训，已修复2026-03-21）
- 龙虾检查两层逻辑打架（2026-03-22）
- **说"全绿没问题"前必须查被拦截的信号是否合理**
- **不确定的事不能当事实说** — 查了再说，不查不开口
- **发合约地址前从日志确认完整地址**
- **不要硬编码价格** — 用API查实时价格
- **手动删positions/boughtTokens后必须重启引擎** — 否则内存和文件不同步，重启又读回来
- **查SOL链上余额必须同时查SPL Token Program + Token-2022程序** — Token-2022漏查导致误判余额0→删positions→re-audit重复买$500
- **改positions绝不删entry，加flag标记** — 删了boughtTokens也没清→重启re-audit又买一遍
- **改文件必须先停引擎→改→启引擎一步到位** — 引擎内存save会覆盖你写的文件
- **不要频繁重启引擎** — 每次重启都触发re-audit扫积压信号，可能重复买入
- **改代码后6小时内必须有买卖活动** — 没有就立刻排查，不等跑步哥问。每次改代码都会引入隐藏bug（变量残留、文件覆盖、链路断裂），跑步哥经验：正常情况每晚都有达标信号
- **2026-03-22深夜教训：不要凭猜测改代码** — 空投过滤来回改三次，系统本来没问题是我乱分析

## 铁律（2026-03-22）
- **不猜，只看链上。** 说"确实像"被跑步哥骂了。查到什么说什么，查不到就说查不到。
- **查链上地址从wallet_db取完整地址。** 用截断地址查错=说谎。

## one事件（2026-03-22 22:51）
- one涨2.1x触发止盈回本50%，但正常卖出假成功→分批fallback取了全部余额卖100%
- 分批函数没接收ratio参数，固定卖全部。已修复：传ratio进分批函数
- **教训：所有fallback/重试路径必须和主路径保持同样的参数**

## BSC暂停 (2026-03-25)
- enabledChains去掉bsc，省credits（BSC占47%流量），跑步哥说BSC都是PVP割子不值得跟
- 钱包库保留BSC钱包，币安PnL继续更新，充BNB后加回
- staticNetwork修复：Provider加chainId+staticNetwork避免eth_chainId限速
- 清仓通知升级：完全清仓时显示盈亏+持有时间+链上确认

## 重要教训补充 (2026-03-25)
- **SM累计$500规则是防钓鱼防线** — Ghibli事件：7猎手买入但SM$0，实际是空投钓鱼币（合约不同）
- **不要拿通知/日志数据当链上事实** — 先查链上再开口
- **solanaSell参数是raw amount不是百分比** — 传100=0.0001个token
- **unknown≠已卖出** — checkSolTransferTarget查不到不代表SM卖了，连续3轮才判定
- **dex_trader余额查询必须用confirmed** — 旧数据导致残留token未卖
- 持仓报告按SOL/Base分链，简洁格式
