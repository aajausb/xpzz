#!/usr/bin/env node
/**
 * 套利系统自动巡检脚本
 * 每2小时由cron触发，0 token消耗
 * 只在发现问题时通过Telegram通知
 */
require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const https = require('https');
const fs = require('fs');
const { binance, bybit, bitget, okx } = require('./exchange_trader');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '877233818';
const STATE_FILE = '/root/.openclaw/workspace/crypto/arbitrage_live_state.json';

function notify(msg) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text: '🔍 巡检: ' + msg });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + BOT_TOKEN + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 5000
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

(async () => {
  const issues = [];
  let state;
  
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    notify('❌ state文件读取失败: ' + e.message);
    process.exit(1);
  }

  // ============ 1. 引擎存活检查 ============
  try {
    const res = await new Promise((resolve) => {
      const req = require('http').get('http://127.0.0.1:9876/refresh', { timeout: 5000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(d));
      });
      req.on('error', () => resolve(null));
    });
    if (!res) {
      issues.push('🚨 引擎HTTP服务无响应，可能已挂');
    }
  } catch (e) {
    issues.push('🚨 引擎连接失败: ' + e.message);
  }

  // ============ 2. State vs 交易所持仓对账 ============
  try {
    const [bnPos, byRes, bgRes] = await Promise.all([
      binance.getFuturesPositions().catch(() => []),
      bybit.api('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }).catch(() => ({})),
      bitget.api('GET', '/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES' }).catch(() => ({}))
    ]);
    
    const byPos = byRes.result?.list?.filter(x => +x.size > 0) || [];
    const bgPos = bgRes.data?.filter(x => +x.total > 0) || [];
    
    for (const p of state.positions) {
      const sym = p.symbol + 'USDT';
      let longQty = 0, shortQty = 0;
      
      // 多头
      if (p.longEx === 'binance') { const f = bnPos.find(x => x.symbol === sym && +x.positionAmt > 0); if (f) longQty = Math.abs(+f.positionAmt); }
      else if (p.longEx === 'bybit') { const f = byPos.find(x => x.symbol === sym && x.side === 'Buy'); if (f) longQty = +f.size; }
      else if (p.longEx === 'bitget') { const f = bgPos.find(x => x.symbol === sym && x.holdSide === 'long'); if (f) longQty = +f.total; }
      
      // 空头
      if (p.shortEx === 'binance') { const f = bnPos.find(x => x.symbol === sym && +x.positionAmt < 0); if (f) shortQty = Math.abs(+f.positionAmt); }
      else if (p.shortEx === 'bybit') { const f = byPos.find(x => x.symbol === sym && x.side === 'Sell'); if (f) shortQty = +f.size; }
      else if (p.shortEx === 'bitget') { const f = bgPos.find(x => x.symbol === sym && x.holdSide === 'short'); if (f) shortQty = +f.total; }
      
      // qty 不匹配
      if (p.qty !== longQty || p.qty !== shortQty) {
        // 自动修复
        if (longQty === shortQty && longQty > 0) {
          const oldQty = p.qty;
          p.qty = longQty;
          issues.push(`⚠️ ${p.symbol} qty自动修复: ${oldQty} → ${longQty}`);
        } else if (longQty === 0 && shortQty === 0) {
          issues.push(`🚨 ${p.symbol} 两边都没仓位！state有记录但交易所没有`);
        } else if (longQty !== shortQty) {
          issues.push(`🚨 ${p.symbol} 对冲失衡! 多:${longQty}(${p.longEx}) 空:${shortQty}(${p.shortEx}) state:${p.qty}`);
        } else {
          issues.push(`⚠️ ${p.symbol} qty不匹配: state:${p.qty} 实际:${longQty}`);
        }
      }
      
      // 对冲数量不等
      if (longQty !== shortQty && longQty > 0 && shortQty > 0) {
        const diff = Math.abs(longQty - shortQty);
        const pct = diff / Math.max(longQty, shortQty) * 100;
        if (pct > 1) {
          issues.push(`🚨 ${p.symbol} 对冲偏差${pct.toFixed(1)}%! 多:${longQty} 空:${shortQty}`);
        }
      }
    }
    
    // 检查交易所有仓位但 state 没记录（孤儿仓位）
    const stateSymbols = new Set(state.positions.map(p => p.symbol));
    
    for (const p of bnPos) {
      if (+p.positionAmt === 0) continue;
      const sym = p.symbol.replace('USDT', '');
      if (!stateSymbols.has(sym)) {
        issues.push(`🚨 Binance孤儿仓位: ${sym} qty:${p.positionAmt}`);
      }
    }
    for (const p of byPos) {
      const sym = p.symbol.replace('USDT', '');
      if (!stateSymbols.has(sym)) {
        issues.push(`🚨 Bybit孤儿仓位: ${sym} qty:${p.size} ${p.side}`);
      }
    }
    for (const p of bgPos) {
      const sym = (p.symbol || '').replace('USDT', '');
      if (!stateSymbols.has(sym)) {
        issues.push(`🚨 Bitget孤儿仓位: ${sym} qty:${p.total} ${p.holdSide}`);
      }
    }
    
  } catch (e) {
    issues.push('❌ 持仓对账失败: ' + e.message);
  }

  // ============ 3. 余额检查 ============
  try {
    const [bnSpot, bnFut, by, bgSpot, bgFut, ok] = await Promise.all([
      binance.getBalance().catch(() => ({ usdt: 0 })),
      binance.getFuturesBalance().catch(() => ({ usdt: 0 })),
      bybit.getBalance().catch(() => ({ usdt: 0 })),
      bitget.getBalance().catch(() => ({ usdt: 0 })),
      bitget.getFuturesBalance().catch(() => ({ usdt: 0 })),
      okx.getBalance().catch(() => ({ usdt: 0 }))
    ]);
    
    const bn = (+bnSpot.usdt || 0) + (+bnFut.usdt || 0);
    const byW = +(by.usdt || 0);
    const bg = (+bgSpot.usdt || 0) + (+bgFut.usdt || 0);
    const okW = +(ok.usdt || 0);
    const total = bn + byW + bg + okW;
    
    // 余额异常低
    if (bn < 100) issues.push(`⚠️ Binance余额过低: $${bn.toFixed(0)}`);
    if (byW < 100) issues.push(`⚠️ Bybit余额过低: $${byW.toFixed(0)}`);
    if (bg < 100) issues.push(`⚠️ Bitget余额过低: $${bg.toFixed(0)}`);
    if (total < 10000) issues.push(`⚠️ 总余额偏低: $${total.toFixed(0)}`);
    
  } catch (e) {
    issues.push('❌ 余额检查失败: ' + e.message);
  }

  // ============ 4. State文件新鲜度 ============
  try {
    const stat = fs.statSync(STATE_FILE);
    const ageMin = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMin > 30) {
      issues.push(`⚠️ state文件${ageMin.toFixed(0)}分钟没更新，引擎可能卡住`);
    }
  } catch (e) {}

  // ============ 5. 内存检查 ============
  try {
    const { execSync } = require('child_process');
    const mem = execSync('free -m').toString();
    const match = mem.match(/Mem:\s+\d+\s+\d+\s+(\d+)/);
    if (match && +match[1] < 500) {
      issues.push(`⚠️ 可用内存不足: ${match[1]}MB`);
    }
  } catch (e) {}

  // ============ 6. 磁盘检查 ============
  try {
    const { execSync } = require('child_process');
    const df = execSync('df -h / | tail -1').toString();
    const match = df.match(/(\d+)%/);
    if (match && +match[1] > 90) {
      issues.push(`⚠️ 磁盘使用率${match[1]}%`);
    }
  } catch (e) {}

  // ============ 7. 限价单方法检查 ============
  try {
    const methods = ['futuresCloseLongLimit','futuresCloseShortLimit','futuresCancelOrder','futuresGetOrder'];
    for (const ex of ['binance','bybit','bitget']) {
      const obj = {binance,bybit,bitget}[ex];
      const missing = methods.filter(m => typeof obj[m] !== 'function');
      if (missing.length > 0) issues.push(`❌ ${ex}缺少方法: ${missing.join(',')}`);
    }
  } catch (e) {}

  // ============ 8. 保证金安全检查 ============
  try {
    const [bnPos2, byPos2, bgPos2] = await Promise.all([
      binance.getFuturesPositions().catch(() => []),
      bybit.api('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }).catch(() => ({})),
      bitget.api('GET', '/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES' }).catch(() => ({}))
    ]);
    for (const p of (Array.isArray(bnPos2) ? bnPos2 : []).filter(x => +x.positionAmt !== 0)) {
      const liq = +p.liquidationPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = +p.positionAmt < 0;
        const dist = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        if (dist <= 20) issues.push(`🚨 BN ${p.symbol} 距强平${dist.toFixed(1)}%!`);
      }
    }
    for (const p of (byPos2.result?.list || []).filter(x => +x.size > 0)) {
      const liq = +p.liqPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = p.side === 'Sell';
        const dist = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        if (dist <= 20) issues.push(`🚨 BY ${p.symbol} 距强平${dist.toFixed(1)}%!`);
      }
    }
    for (const p of (bgPos2.data || []).filter(x => +x.total > 0)) {
      const liq = +p.liquidationPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = p.holdSide === 'short';
        const dist = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        if (dist <= 20) issues.push(`🚨 BG ${p.symbol} 距强平${dist.toFixed(1)}%!`);
      }
    }
  } catch (e) {}

  // ============ 9. 日志文件大小 ============
  try {
    const logStat = fs.statSync('/root/.openclaw/workspace/crypto/arbitrage_live.log');
    const sizeMB = logStat.size / 1024 / 1024;
    if (sizeMB > 100) issues.push(`⚠️ 日志文件${sizeMB.toFixed(0)}MB，过大`);
  } catch (e) {}

  // ============ 结果处理 ============
  if (issues.length > 0) {
    // 有修复的话保存 state
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    
    const msg = `发现 ${issues.length} 个问题:\n\n` + issues.join('\n');
    console.log(msg);
    notify(msg);
  } else {
    console.log('✅ 巡检通过，无异常');
    // 静默，不通知
  }
})();
