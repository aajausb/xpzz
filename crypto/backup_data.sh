#!/bin/bash
DATE=$(date +%Y%m%d_%H%M)
BACKUP_DIR="/root/.openclaw/workspace/crypto/backups"
WORKSPACE="/root/.openclaw/workspace"

ARCHIVE="$BACKUP_DIR/crypto_backup_$DATE.tar.gz"

cd "$WORKSPACE" && tar czf "$ARCHIVE" \
  .env \
  crypto/arbitrage_live.js \
  crypto/exchange_trader.js \
  crypto/realtime_monitor.js \
  crypto/scanner_daemon.js \
  crypto/auto_trader.js \
  crypto/contract_audit.js \
  crypto/evm_smart_money_builder.js \
  crypto/narrative_tracker.js \
  crypto/start_all.sh \
  crypto/arbitrage_live_state.json \
  crypto/smart_money_rank.json \
  crypto/evm_smart_money.json \
  crypto/solana_private_smart_money.json \
  crypto/sol_smart_money_history.json \
  crypto/positions.json \
  crypto/sm_holdings.json \
  crypto/bait_blacklist.json \
  crypto/wallet_encrypted.json \
  crypto/dashboard_config.json \
  2>/dev/null

echo "[$(date)] ✅ 备份: $ARCHIVE ($(du -sh $ARCHIVE | cut -f1))"

# 保留7天
find "$BACKUP_DIR" -name "crypto_backup_*.tar.gz" -mtime +7 -delete
