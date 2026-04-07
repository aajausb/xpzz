// 转发通知队列 - 由heartbeat调用: node forward_notify.js
// 输出JSON格式让heartbeat解析后用message工具发送
const fs = require('fs');
const path = require('path');
const queueFile = path.join(__dirname, 'data/v8/notify_queue.json');

try {
  const raw = fs.readFileSync(queueFile, 'utf8');
  const queue = JSON.parse(raw);
  if (!queue.length) { process.exit(0); }
  
  // 输出每条通知
  queue.forEach(n => {
    const out = { msg: n.msg };
    if (n.buttons && n.buttons.length > 0) {
      // 转成二维数组格式 [[btn1, btn2, btn3], [btn4]]
      // 买入按钮一行，跳过按钮一行
      const buyBtns = n.buttons.filter(b => !b.callback_data.startsWith('x_'));
      const skipBtns = n.buttons.filter(b => b.callback_data.startsWith('x_'));
      out.buttons = [buyBtns];
      if (skipBtns.length) out.buttons.push(skipBtns);
    }
    console.log('NOTIFY:' + JSON.stringify(out));
  });
  
  // 清空队列
  fs.writeFileSync(queueFile, '[]');
} catch(e) {
  if (e.code !== 'ENOENT') console.error(e.message);
}
