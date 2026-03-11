#!/bin/bash
# 加密存储敏感数据
# 用法: ./encrypt_secret.sh <name> <value>
# 存储到: crypto/secrets/<name>.enc

SECRETS_DIR="/root/.openclaw/workspace/crypto/secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

source /root/.openclaw/workspace/.env

NAME="$1"
VALUE="$2"

if [ -z "$NAME" ] || [ -z "$VALUE" ]; then
  echo "用法: ./encrypt_secret.sh <name> <value>"
  exit 1
fi

# 用WALLET_ENCRYPTION_KEY加密
echo -n "$VALUE" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:WALLET_ENCRYPTION_KEY -out "$SECRETS_DIR/${NAME}.enc"
chmod 600 "$SECRETS_DIR/${NAME}.enc"
echo "✅ 已加密保存: $SECRETS_DIR/${NAME}.enc"
