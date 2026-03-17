#!/bin/bash
# 通知转发：监听notify_queue.json变化，有新消息立刻通过openclaw发给跑步哥
QUEUE="/root/.openclaw/workspace/crypto/meme/data/v8/notify_queue.json"
LOCK="/tmp/notify_relay.lock"

exec 200>"$LOCK"
flock -n 200 || { echo "已有实例在运行"; exit 1; }

echo "🔔 通知转发服务启动，监听 $QUEUE"
[ -f "$QUEUE" ] || echo '[]' > "$QUEUE"

process_queue() {
  local tmp="/tmp/notify_process_$$.json"
  mv "$QUEUE" "$tmp" 2>/dev/null || return
  echo '[]' > "$QUEUE"
  
  local content
  content=$(cat "$tmp" 2>/dev/null)
  rm -f "$tmp"
  
  [ -z "$content" ] && return
  [ "$content" = "[]" ] && return
  
  echo "$content" | python3 -c "
import json, sys, subprocess
msgs = json.load(sys.stdin)
for m in msgs:
    msg = m.get('msg', '')
    if not msg: continue
    msg = msg.replace('<b>', '').replace('</b>', '').replace('<i>', '').replace('</i>', '')
    short = (msg[:60] + '...') if len(msg) > 60 else msg
    try:
        r = subprocess.run([
            'openclaw', 'message', 'send',
            '--channel', 'telegram',
            '--target', '877233818',
            '--message', msg
        ], capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and 'messageId' in r.stdout:
            print(f'✅ 发送成功: {short}')
        else:
            print(f'❌ 发送失败(code={r.returncode}): {short}')
            print(f'   stderr: {r.stderr[:200]}')
    except subprocess.TimeoutExpired:
        print(f'⏰ 发送超时: {short}')
    except Exception as e:
        print(f'❌ 异常: {e}')
" 2>&1
}

process_queue

while true; do
  inotifywait -qq -e modify -e move_to -e create "$(dirname "$QUEUE")" 2>/dev/null
  sleep 0.3
  process_queue
done
