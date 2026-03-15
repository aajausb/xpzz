#!/bin/bash
DATE=$(date +%Y%m%d_%H%M)
BACKUP_DIR="/root/.openclaw/workspace/crypto/backups"
WORKSPACE="/root/.openclaw/workspace"
V8_BACKUP="/opt/wallet_backup/v8"

ARCHIVE="$BACKUP_DIR/crypto_backup_$DATE.tar.gz"

cd "$WORKSPACE" && tar czf "$ARCHIVE" \
  .env \
  crypto/wallet_runtime.js \
  crypto/secrets/ \
  crypto/meme/v8_engine.js \
  crypto/meme/dex_trader.js \
  crypto/meme/v8_dashboard.js \
  crypto/meme/data/v8/wallet_db.json \
  crypto/meme/data/v8/smart_wallets.json \
  crypto/meme/data/v8/positions.json \
  crypto/meme/data/v8/known_tokens.json \
  crypto/meme/data/v8/audit_cache.json \
  crypto/meme/data/v8/dashboard_state.json \
  SOUL.md \
  USER.md \
  MEMORY.md \
  IDENTITY.md \
  HEARTBEAT.md \
  AGENTS.md \
  memory/ \
  2>/dev/null

# wallet_db额外单独备份一份（快速恢复用）
cp crypto/meme/data/v8/wallet_db.json "$V8_BACKUP/wallet_db_$(date +%Y%m%d_%H).json" 2>/dev/null

# Git备份
cd "$WORKSPACE" && git add -A && git commit -m "🔄 自动备份 $(date '+%Y-%m-%d %H:%M')" --quiet 2>/dev/null
git push origin main --quiet 2>/dev/null

echo "[$(date)] ✅ 备份: $ARCHIVE ($(du -sh $ARCHIVE | cut -f1))"

# 保留7天
find "$BACKUP_DIR" -name "crypto_backup_*.tar.gz" -mtime +7 -delete
find "$V8_BACKUP" -name "wallet_db_*.json" -mtime +3 -delete
