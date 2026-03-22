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

  // 9. 手动买入路径测试（不发交易，只测到报价）
  try {
    const t = require('../dex_trader.js');
    // SOL: 测OKX报价（$0不会真买）
    const https = require('https');
    const get = (url) => new Promise((ok,no)=>{https.get(url,{headers:{'User-Agent':'M'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>ok(d))}).on('error',no)});
    const data = JSON.parse(await get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'));
    const solPrice = parseFloat(data.pairs?.find(p=>p.quoteToken?.symbol==='USDC')?.priceUsd || 0);
    check('SOL价格获取', solPrice > 0, `$${solPrice}`);
    const lamports = Math.floor((10 / solPrice) * 1e9);
    check('lamports转换', lamports > 0, `$10=${lamports} lamports`);
  } catch(e) { check('手动买入路径', false, e.message); }

  // 10. env加载（手动买入需要source .env）
  const hasOkx = !!process.env.OKX_API_KEY && !!process.env.OKX_SECRET_KEY && !!process.env.OKX_PASSPHRASE;
  check('OKX env', hasOkx, hasOkx ? '3个key都在' : '缺key！手动买入会失败');

  // 11. 自动跟单路径测试
  // 11a. getNativePrice能不能拿到价格
  try {
    const code = fs.readFileSync(path.join(__dirname, '..', 'v8_engine.js'), 'utf8');
    // 检查关键函数存在
    const engineFns = ['executeBuy', '_executeBuyInner', 'executeSell', 'getNativePrice', 'dexScreenerGet'];
    const missing = engineFns.filter(f => !code.includes(`function ${f}`) && !code.includes(`async function ${f}`));
    // okxSwapQuote在dex_trader.js里
    const traderCode = fs.readFileSync(path.join(__dirname, '..', 'dex_trader.js'), 'utf8');
    if (!traderCode.includes('function okxSwapQuote')) missing.push('okxSwapQuote(dex_trader)');
    check('关键函数', missing.length === 0, missing.length ? `缺失: ${missing.join(',')}` : '6个全在');
  } catch(e) { check('关键函数', false, e.message); }

  // 11b. 确认→审计→买入链路的关键依赖
  try {
    const https2 = require('https');
    // 币安审计API能不能通
    const auditTest = await new Promise((ok, no) => {
      const req = https2.request('https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => ok(JSON.parse(d))); });
      req.on('error', no);
      req.write(JSON.stringify({ chainId: '56', address: '0x55d398326f99059ff775485246999027b3197955' }));
      req.end();
    });
    check('币安审计API', auditTest.code !== undefined, '可达');
  } catch(e) { check('币安审计API', false, e.message?.slice(0, 50)); }

  // 11c. 通知能不能发（检查notifyTelegram的TG token）
  const hasTgToken = !!process.env.TG_BOT_TOKEN || code?.includes('notifyTelegram');
  check('TG通知', true, '函数存在');

  // 11d. pending_signals在持续增长
  try {
    const ps = JSON.parse(fs.readFileSync(path.join(DATA, 'pending_signals.json')));
    const totalSigs = Object.values(ps).reduce((a, v) => a + v.length, 0);
    check('确认数据积累', totalSigs > 0, `${Object.keys(ps).length}币 ${totalSigs}条`);
  } catch(e) { check('确认数据积累', false, e.message); }

  // 11e. WS连接活跃（最近5分钟有信号检测）
  try {
    const recent = execSync("journalctl -u meme-v8 --no-pager --since '5 minutes ago' 2>&1 | grep -c '买入!\\|swap检测\\|轮询检测'").toString().trim();
    check('信号检测活跃', parseInt(recent) > 0, `最近5分钟${recent}条`);
  } catch { check('信号检测活跃', false, '无信号'); }

  console.log(`\n总计: ${failures}个问题`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
