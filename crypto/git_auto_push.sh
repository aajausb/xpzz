#!/bin/bash
cd /root/.openclaw/workspace
git add -A 2>/dev/null
CHANGES=$(git diff --cached --stat)
if [ -n "$CHANGES" ]; then
  git commit -m "🔄 自动备份 $(date '+%Y-%m-%d %H:%M')" 2>/dev/null
  git push 2>/dev/null
fi
