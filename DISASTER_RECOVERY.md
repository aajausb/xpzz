# 灾难恢复手册 🚨

> 如果服务器没了，按这个步骤恢复。不需要技术背景，跟着做就行。

## 第零步：别慌，钱没丢

钱在交易所账户里，不在服务器上。用手机登录 Binance/Bybit/Bitget/OKX app 确认余额还在。
仓位是对冲的，短期不管也不会亏钱。

## 第一步：买一台新云服务器（5分钟）

1. 登录腾讯云 https://cloud.tencent.com
2. 买一台轻量应用服务器（推荐东京/新加坡，离交易所近延迟低）
3. 配置：2核4G以上，Ubuntu 22.04
4. 记住新服务器 IP 和密码

## 第二步：连接服务器（2分钟）

手机用 Termius / JuiceSSH，电脑用终端：
```bash
ssh root@新服务器IP
```

## 第三步：安装环境（5分钟）

复制粘贴这一整块：
```bash
# 安装 Node.js
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
npm i -g pnpm

# 安装 OpenClaw
pnpm add -g openclaw

# 安装其他依赖
apt update && apt install -y git
```

## 第四步：拉代码（1分钟）

```bash
cd /root/.openclaw
git clone https://github.com/aajausb/xpzz.git workspace
cd workspace
```

## 第五步：配置密钥（3分钟）

创建 .env 文件，填入 API 密钥。**密钥不在 GitHub 上，你需要手动填：**

```bash
nano /root/.openclaw/workspace/.env
```

需要填的密钥（从各交易所 app 的 API 管理页面获取）：
- BINANCE_API_KEY / BINANCE_SECRET_KEY
- BYBIT_API_KEY / BYBIT_SECRET_KEY
- BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE
- OKX_CEX_API_KEY / OKX_CEX_SECRET_KEY / OKX_PASSPHRASE
- TELEGRAM_BOT_TOKEN
- HELIUS_API_KEY（可选，SOL 链用）
- WALLET_ENCRYPTION_KEY（可选，SOL 钱包用）

## 第六步：启动套利引擎（1分钟）

```bash
cd /root/.openclaw/workspace/crypto
npm install ws dotenv
node arbitrage_live.js
```

引擎会自动：
- 读取 state 文件恢复仓位
- 连接四所 WebSocket
- 缓存精度和费率数据
- 开始监控和交易

## 第七步：配置开机自启（2分钟）

```bash
# 复制 systemd 服务文件
cp /root/.openclaw/workspace/crypto/arbitrage-live.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable arbitrage-live
systemctl start arbitrage-live
```

## 第八步：恢复小胖崽崽（3分钟）

```bash
# 配置 OpenClaw
openclaw setup
# 按提示填 Telegram bot token
# 连接后小胖崽崽就回来了，记忆都在 SOUL.md / MEMORY.md 里
```

---

## 总时间：约 20 分钟

## 紧急联系

如果搞不定，在 Telegram 随便找个能用的 bot 问 ChatGPT/Claude，把这个文件发给它，它能指导你。

## 如果只是想平仓不想恢复

直接用手机登各交易所 app，手动平掉所有仓位就行：
1. Binance Futures → 逐个平仓
2. Bybit 合约 → 逐个平仓  
3. Bitget 合约 → 逐个平仓
4. OKX 没有持仓，不用管

记住：**两边都要平**。比如一个仓位是 Bybit 多 + Bitget 空，两边都要关。
