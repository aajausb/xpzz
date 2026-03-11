#!/bin/bash
# 套利系统自启动脚本 (2026-03-11 更新)
# 土狗/聪明钱/模拟盘已暂停，只保留套利引擎
export HOME=/root
export PATH="/root/.nvm/versions/node/v22.22.0/bin:$PATH"
cd /root/.openclaw/workspace

# 套利引擎由systemd管理，这里只做备用检查
if ! systemctl is-active --quiet arbitrage-live; then
  systemctl start arbitrage-live
  echo "[$(date)] arbitrage-live restarted by start_all.sh" >> crypto/startup.log
fi
