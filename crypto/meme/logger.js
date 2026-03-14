// 日志模块
const fs = require('fs');
const path = require('path');
const config = require('./config');

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(config.paths.logDir, `meme_${date}.log`);
}

function log(level, component, msg, data = null) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${component}] ${msg}${data ? ' | ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch (e) { /* ignore */ }
}

module.exports = {
  info: (component, msg, data) => log('INFO', component, msg, data),
  warn: (component, msg, data) => log('WARN', component, msg, data),
  error: (component, msg, data) => log('ERROR', component, msg, data),
  signal: (component, msg, data) => log('SIGNAL', component, msg, data),
  trade: (component, msg, data) => log('TRADE', component, msg, data),
};
