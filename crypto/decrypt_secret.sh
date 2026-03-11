#!/bin/bash
# 解密敏感数据
# 用法: ./decrypt_secret.sh <name>

SECRETS_DIR="/root/.openclaw/workspace/crypto/secrets"
source /root/.openclaw/workspace/.env

NAME="$1"
openssl enc -aes-256-cbc -pbkdf2 -d -salt -pass env:WALLET_ENCRYPTION_KEY -in "$SECRETS_DIR/${NAME}.enc" 2>/dev/null
