#!/usr/bin/env node
/**
 * 看板快速刷新 — 独立脚本，不经过AI
 * 实时查四所余额 + 读本地JSON
 * 用法: node dashboard_refresh.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '877233818';
const MESSAGE_ID = '2443';

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'crypto', file), 'utf8')); }
  catch(e) { return {}; }
}

function httpGet(url, timeout = 5000) {
  return new Promise(r => {
    https.get(url, { timeout }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { r(JSON.parse(d)); } catch(e) { r(null); } });
    }).on('error', () => r(null));
  });
}

function httpReq(method, hostname, path, headers = {}, body = null, timeout = 5000) {
  return new Promise(r => {
    const req = https.request({ hostname, path, method, headers, timeout }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { r(JSON.parse(d)); } catch(e) { r(d); } });
    });
    req.on('error', () => r(null));
    req.on('timeout', () => { req.destroy(); r(null); });
    if (body) req.write(body);
    req.end();
  });
}

// 签名
function signBinance(qs) { return crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY).update(qs).digest('hex'); }
function signBybit(ts, key, rw, payload) { return crypto.createHmac('sha256', process.env.BYBIT_SECRET_KEY).update(ts+key+rw+payload).digest('hex'); }
function signBitget(ts, method, path, body='') { return crypto.createHmac('sha256', process.env.BITGET_SECRET_KEY).update(ts+method+path+body).digest('base64'); }
function signOkx(ts, method, path, body='') { return crypto.createHmac('sha256', Buffer.from(process.env.OKX_CEX_SECRET_KEY)).update(ts+method+path+body).digest('base64'); }

async function getBalances() {
  const ts = Date.now();
  const timeout = 4000;

  try {
    // Binance 现货+合约
    const bnQs = 'timestamp='+ts+'&recvWindow=5000';
    const [bnSpot, bnFut] = await Promise.all([
      httpReq('GET','api.binance.com','/api/v3/account?'+bnQs+'&signature='+signBinance(bnQs),{'X-MBX-APIKEY':process.env.BINANCE_API_KEY}),
      httpReq('GET','fapi.binance.com','/fapi/v2/balance?timestamp='+ts+'&recvWindow=5000&signature='+signBinance('timestamp='+ts+'&recvWindow=5000'),{'X-MBX-APIKEY':process.env.BINANCE_API_KEY})
    ]);
  const bnSpotUsdt = parseFloat(bnSpot?.balances?.find(b=>b.asset==='USDT')?.free || 0);
  const bnFutUsdt = parseFloat((Array.isArray(bnFut) ? bnFut.find(b=>b.asset==='USDT')?.balance : 0) || 0);
  const bn = Math.round((bnSpotUsdt + bnFutUsdt) * 100) / 100;

  // Bybit
  const byTs = ts.toString();
  const byQs = 'accountType=UNIFIED';
  const bySig = signBybit(byTs, process.env.BYBIT_API_KEY, '5000', byQs);
  const byRes = await httpReq('GET','api.bybit.com','/v5/account/wallet-balance?'+byQs,{
    'X-BAPI-API-KEY':process.env.BYBIT_API_KEY,'X-BAPI-SIGN':bySig,'X-BAPI-TIMESTAMP':byTs,'X-BAPI-RECV-WINDOW':'5000'
  });
  const by = Math.round(parseFloat(byRes?.result?.list?.[0]?.totalEquity || 0) * 100) / 100;

  // Bitget 现货+合约
  const bgTs1 = Date.now().toString();
  const bgSpotPath = '/api/v2/spot/account/assets';
  const bgSpotRes = await httpReq('GET','api.bitget.com',bgSpotPath,{
    'ACCESS-KEY':process.env.BITGET_API_KEY,'ACCESS-SIGN':signBitget(bgTs1,'GET',bgSpotPath),
    'ACCESS-TIMESTAMP':bgTs1,'ACCESS-PASSPHRASE':process.env.BITGET_PASSPHRASE,'Content-Type':'application/json'
  });
  const bgTs2 = Date.now().toString();
  const bgFutPath = '/api/v2/mix/account/accounts?productType=USDT-FUTURES';
  const bgFutRes = await httpReq('GET','api.bitget.com',bgFutPath,{
    'ACCESS-KEY':process.env.BITGET_API_KEY,'ACCESS-SIGN':signBitget(bgTs2,'GET',bgFutPath),
    'ACCESS-TIMESTAMP':bgTs2,'ACCESS-PASSPHRASE':process.env.BITGET_PASSPHRASE,'Content-Type':'application/json'
  });
  const bgSpotUsdt = parseFloat(bgSpotRes?.data?.find(a=>a.coin==='USDT')?.available || 0);
  const bgFutUsdt = parseFloat(bgFutRes?.data?.find(a=>a.marginCoin==='USDT')?.available || 0);
  const bg = Math.round((bgSpotUsdt + bgFutUsdt) * 100) / 100;

  // OKX
  const okTs = new Date().toISOString();
  const okPath = '/api/v5/account/balance';
  const okRes = await httpReq('GET','www.okx.com',okPath,{
    'OK-ACCESS-KEY':process.env.OKX_CEX_API_KEY,'OK-ACCESS-SIGN':signOkx(okTs,'GET',okPath),
    'OK-ACCESS-TIMESTAMP':okTs,'OK-ACCESS-PASSPHRASE':process.env.OKX_PASSPHRASE,'Content-Type':'application/json'
  });
  const ok = Math.round(parseFloat(okRes?.data?.[0]?.totalEq || 0) * 100) / 100;

  return { binance: bn, bybit: by, bitget: bg, okx: ok, total: bn+by+bg+ok };
  } catch(e) {
    console.log('⚠️ 余额获取部分失败:', e.message);
    return { binance: 0, bybit: 0, bitget: 0, okx: 0, total: 0, error: true };
  }
}

async function main() {
  const start = Date.now();

  // 并行: 查余额 + 读本地数据
  const [bal, rank, positions, liveState] = await Promise.all([
    getBalances(),
    Promise.resolve(readJSON('smart_money_rank.json')),
    Promise.resolve(readJSON('positions.json')),
    Promise.resolve(readJSON('arbitrage_live_state.json'))
  ]);

  // 聪明钱
  const cnt = (chain, w) => (rank[chain]||[]).filter(x=>x.weight>=w).length;
  const cntExact = (chain, w) => (rank[chain]||[]).filter(x=>x.weight===w).length;
  const solCore = cnt('solana',3), solNormal = cntExact('solana',2);
  const bscCore = cnt('bsc',3), bscNormal = cntExact('bsc',2);
  const baseCore = cnt('base',3), baseNormal = cntExact('base',2);

  // 进程
  const { execSync } = require('child_process');
  const procs = execSync('ps aux | grep -E "scanner_daemon|auto_trader|arbitrage" | grep -v grep || true').toString();
  const scanner = procs.includes('scanner_daemon') ? '✅' : '❌';
  const trader = procs.includes('auto_trader') ? '✅' : '❌';
  const arbProc = (procs.includes('arbitrage_sim') || procs.includes('arbitrage_live')) ? '✅' : '❌';

  const memLine = execSync('free -m | grep Mem').toString().split(/\s+/);
  const memFree = memLine[3] || '?';

  // 实盘PnL
  const livePnl = liveState.totalPnl || 0;
  const liveTrades = liveState.trades || 0;
  const livePositions = liveState.positions || [];

  let posStr = '无';
  if (livePositions.length > 0) {
    posStr = livePositions.map(p => `${p.symbol} $${p.size}`).join(', ');
  }

  // 土狗持仓
  const dogPositions = Array.isArray(positions) ? positions.length : 0;

  const now = new Date().toLocaleTimeString('zh-CN', { hour12:false, timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit' });

  const text = `📊 系统看板 (${now} 更新)\n\n` +
    `💰 四所资产 (实时)\n` +
    `├ Binance: $${bal.binance.toLocaleString()}\n` +
    `├ Bybit: $${bal.bybit.toLocaleString()}\n` +
    `├ Bitget: $${bal.bitget.toLocaleString()}\n` +
    `├ OKX: $${bal.okx.toLocaleString()}\n` +
    `└ 总计: $${bal.total.toLocaleString()}\n\n` +
    `📈 套利实盘\n` +
    `├ PnL: $${livePnl.toFixed(2)}\n` +
    `├ 交易: ${liveTrades}笔 | 持仓: ${posStr}\n` +
    `└ 状态: ${livePositions.length > 0 ? '🟢 运行中' : '🟢 就绪'}\n\n` +
    `🐕 土狗跟单\n` +
    `├ 持仓: ${dogPositions}个\n` +
    `└ 状态: ⏸ SOL不足\n\n` +
    `🧠 聪明钱\n` +
    `├ SOL: 核心${solCore} 正常${solNormal}\n` +
    `├ BSC: 核心${bscCore} 正常${bscNormal}\n` +
    `└ BASE: 核心${baseCore} 正常${baseNormal}\n\n` +
    `⚙️ 系统\n` +
    `├ Scanner: ${scanner} | Trader: ${trader} | Arb: ${arbProc}\n` +
    `├ 内存: ${memFree}MB 可用\n` +
    `└ 🔒 4所API已加密 | IP白名单`;

  const replyMarkup = JSON.stringify({ inline_keyboard: [[{ text: '🔄 刷新', callback_data: 'refresh_dashboard' }]] });
  const body = JSON.stringify({ chat_id: CHAT_ID, message_id: MESSAGE_ID, text, reply_markup: replyMarkup });

  const result = await httpReq('POST', 'api.telegram.org', `/bot${BOT_TOKEN}/editMessageText`,
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);

  const ms = Date.now() - start;
  console.log(result?.ok ? `✅ 看板更新 (${ms}ms)` : `❌ ${JSON.stringify(result).slice(0,200)}`);
}

main().catch(e => console.error('❌', e.message));
