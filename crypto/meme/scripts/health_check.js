#!/usr/bin/env node
/**
 * 引擎全链路健康检查
 * 用法: node scripts/health_check.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ethers } = require('ethers');

const DATA = path.join(__dirname, '..', 'data', 'v8');
let failures = 0;

function check(name, ok, detail) {
  const mark = ok ? '✅' : '❌';
  if (!ok) failures++;
  console.log(`${mark} ${name}: ${detail}`);
}

async function main() {
  // 1. 进程
  try {
    const status = execSync('systemctl is-active meme-v8').toString().trim();
    check('进程', status === 'active', status);
  } catch { check('进程', false, 'inactive'); }

  // 2. 数据文件
  for (const f of ['wallet_db.json','pending_signals.json','positions.json','bought_tokens.json','blacklist.json']) {
    const fp = path.join(DATA, f);
    try {
      const sz = fs.statSync(fp).size;
      if (f !== 'trade_log.json') JSON.parse(fs.readFileSync(fp)); // NDJSON skip
      check(`数据/${f}`, sz > 2, `${sz}B`);
    } catch(e) { check(`数据/${f}`, false, e.message); }
  }

  // 3. 依赖
  for (const [name, p] of [['dex_trader', '../dex_trader.js'], ['wallet_runtime', '../../wallet_runtime.js']]) {
    check(`依赖/${name}`, fs.existsSync(path.join(__dirname, p)), fs.existsSync(path.join(__dirname, p)) ? '存在' : 'MISSING');
  }

  // 4. 语法
  try { execSync('node --check ' + path.join(__dirname, '..', 'v8_engine.js')); check('语法', true, 'OK'); }
  catch { check('语法', false, '语法错误'); }

  // 5. 前向引用
  const code = fs.readFileSync(path.join(__dirname, '..', 'v8_engine.js'), 'utf8');
  const lines = code.split('\n');
  let logDef = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(const|let|function)\s+log\s*[=(]/.test(lines[i])) { logDef = i + 1; break; }
  }
  let fwdRefs = 0;
  if (logDef > 0) {
    for (let i = 0; i < logDef - 1; i++) {
      if (/(?<!console\.)(?<!\.)\blog\s*\(/.test(lines[i]) && !lines[i].trim().startsWith('//')) fwdRefs++;
    }
  }
  check('前向引用', fwdRefs === 0, `log定义在${logDef}行, 前面有${fwdRefs}处调用`);

  // 6. 钱包
  try {
    const t = require('../dex_trader.js');
    const sol = t.getWalletAddress('solana');
    const evm = t.getWalletAddress('evm');
    check('钱包', !!sol && !!evm, `SOL=${sol?.slice(0,8)}... EVM=${evm?.slice(0,8)}...`);
  } catch(e) { check('钱包', false, e.message); }

  // 7. RPC
  try {
    const b = await new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org').getBlockNumber();
    check('BSC RPC', true, `#${b}`);
  } catch { check('BSC RPC', false, '连不上'); }
  try {
    const b = await new ethers.JsonRpcProvider('https://mainnet.base.org').getBlockNumber();
    check('Base RPC', true, `#${b}`);
  } catch { check('Base RPC', false, '连不上'); }

  // 8. 内存
  const mem = execSync("free -m | awk '/Mem/{print $7}'").toString().trim();
  check('内存', parseInt(mem) > 1000, `可用${mem}MB`);

  console.log(`\n总计: ${failures}个问题`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
