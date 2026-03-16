#!/bin/bash
# 通知转发：监听notify_queue.json变化，有新消息立刻通过openclaw发给跑步哥
QUEUE="/root/.openclaw/workspace/crypto/meme/data/v8/notify_queue.json"
LOCK="/tmp/notify_relay.lock"

# 防重复启动
exec 200>"$LOCK"
flock -n 200 || { echo "已有实例在运行"; exit 1; }

echo "🔔 通知转发服务启动，监听 $QUEUE"

# 确保文件存在
[ -f "$QUEUE" ] || echo '[]' > "$QUEUE"

process_queue() {
  local content
  content=$(cat "$QUEUE" 2>/dev/null)
  [ -z "$content" ] && return
  [ "$content" = "[]" ] && return
  
  # 读取并清空（原子操作）
  echo '[]' > "$QUEUE"
  
  # 逐条发送
  echo "$content" | python3 -c "
import json, sys, subprocess
msgs = json.load(sys.stdin)
for m in msgs:
    msg = m.get('msg', '')
    if not msg: continue
    # HTML标签转纯文本（OpenClaw message不支持HTML parse_mode）
    msg = msg.replace('<b>', '').replace('</b>', '').replace('<i>', '').replace('</i>', '')
    print(f'📤 转发: {msg[:60]}...' if len(msg)>60 else f'📤 转发: {msg}')
    subprocess.run([
        'openclaw', 'message', 'send',
        '--channel', 'telegram',
        '--target', '877233818',
        '--message', msg
    ], capture_output=True, timeout=15)
" 2>&1
}

# 初始检查一次
process_queue

# inotifywait监听文件变化
while true; do
  inotifywait -qq -e modify -e move_to -e create "$(dirname "$QUEUE")" 2>/dev/null
  sleep 0.3  # 等引擎写完
  process_queue
done
