// 日志模块
const fs = require('fs');
const path = require('path');
const config = require('./config');

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(config.paths.logDir, `meme_${date}.log`);
}

function log(level, module, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${module}] ${msg}${data ? ' | ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch (e) { /* ignore */ }
}

module.exports = {
  info: (mod, msg, data) => log('INFO', mod, msg, data),
  warn: (mod, msg, data) => log('WARN', mod, msg, data),
  error: (mod, msg, data) => log('ERROR', mod, msg, data),
  signal: (mod, msg, data) => log('SIGNAL', mod, msg, data),
  trade: (mod, msg, data) => log('TRADE', mod, msg, data),
};
