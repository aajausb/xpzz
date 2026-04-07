// 转发通知队列 - 由heartbeat调用: node forward_notify.js
// 输出JSON格式让heartbeat解析
const fs = require('fs');
const path = require('path');
const queueFile = path.join(__dirname, 'data/v8/notify_queue.json');

try {
  const raw = fs.readFileSync(queueFile, 'utf8');
  const queue = JSON.parse(raw);
  if (!queue.length) { process.exit(0); }
  
  // 分两类输出
  queue.forEach(n => {
    if (n.type === 'analyze') {
      // AI分析请求
      console.log('ANALYZE:' + JSON.stringify(n));
    } else if (n.msg) {
      // 普通通知（现在引擎直发TG了，这里只是fallback）
      const out = { msg: n.msg };
      if (n.buttons && n.buttons.length > 0) {
        const buyBtns = n.buttons.filter(b => !b.callback_data.startsWith('x_'));
        const skipBtns = n.buttons.filter(b => b.callback_data.startsWith('x_'));
        out.buttons = [buyBtns];
        if (skipBtns.length) out.buttons.push(skipBtns);
      }
      console.log('NOTIFY:' + JSON.stringify(out));
    }
  });
  
  // 清空队列
  fs.writeFileSync(queueFile, '[]');
} catch(e) {
  if (e.code !== 'ENOENT') console.error(e.message);
}
