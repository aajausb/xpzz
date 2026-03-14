#!/bin/bash
# 套利系统自启动脚本 (2026-03-14 停用)
# 跑步哥指示停止套利引擎，不再自动拉起
# export HOME=/root
# export PATH="/root/.nvm/versions/node/v22.22.0/bin:$PATH"
# cd /root/.openclaw/workspace

# 已停用 - 不再自动拉起套利引擎
# if ! systemctl is-active --quiet arbitrage-live; then
#   systemctl start arbitrage-live
#   echo "[$(date)] arbitrage-live restarted by start_all.sh" >> crypto/startup.log
# fi

echo "[$(date)] start_all.sh disabled per 跑步哥 instruction" >> /root/.openclaw/workspace/crypto/startup.log
