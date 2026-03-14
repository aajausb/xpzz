/**
 * 限价平仓所有套利仓位
 * Post-Only限价单，60秒未成交→撤单→市价
 */
require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const https = require('https');
const { exchanges } = require('./exchange_trader');

const STATE_FILE = '/root/.openclaw/workspace/crypto/arbitrage_live_state.json';
const state = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));

function fmtSym(ex, sym) {
  if (ex === 'okx') return sym + '-USDT-SWAP';
  return sym + 'USDT';
}

// 直接用合约盘口API
function httpGet(url) {
  return new Promise(resolve => {
    https.get(url, { timeout: 5000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function getFuturesPrice(ex, sym) {
  const symbol = fmtSym(ex, sym);
  try {
    let ob;
    if (ex === 'binance') {
      ob = await httpGet(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=5`);
      if (ob?.bids?.[0] && ob?.asks?.[0]) {
        return { bid: parseFloat(ob.bids[0][0]), ask: parseFloat(ob.asks[0][0]) };
      }
    } else if (ex === 'bybit') {
      ob = await httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=5`);
      const list = ob?.result;
      if (list?.b?.[0] && list?.a?.[0]) {
        return { bid: parseFloat(list.b[0][0]), ask: parseFloat(list.a[0][0]) };
      }
    } else if (ex === 'bitget') {
      ob = await httpGet(`https://api.bitget.com/api/v2/mix/market/depth?symbol=${symbol}&productType=USDT-FUTURES&limit=5`);
      if (ob?.data?.bids?.[0] && ob?.data?.asks?.[0]) {
        return { bid: parseFloat(ob.data.bids[0][0]), ask: parseFloat(ob.data.asks[0][0]) };
      }
    }
  } catch (e) {
    console.log(`  ❌ ${ex} ${sym} 盘口失败: ${e.message}`);
  }
  return null;
}

async function closePosLimit(pos) {
  const { symbol, longEx, shortEx, qty } = pos;
  const longSym = fmtSym(longEx, symbol);
  const shortSym = fmtSym(shortEx, symbol);

  console.log(`\n📍 ${symbol}: ${longEx}多 / ${shortEx}空, qty=${qty.toLocaleString()}`);

  const [longPrice, shortPrice] = await Promise.all([
    getFuturesPrice(longEx, symbol),
    getFuturesPrice(shortEx, symbol)
  ]);

  const results = { symbol, longEx, shortEx, qty, longSym, shortSym };

  // === 平多头 (在多头所卖出) ===
  if (longPrice) {
    const price = longPrice.ask; // Post-Only挂ask → maker
    console.log(`  平多: ${longEx} 挂卖@${price} (bid=${longPrice.bid})`);
    try {
      const res = await exchanges[longEx].futuresCloseLongLimit(longSym, qty, price);
      const oid = res?.orderId || res?.data?.orderId || res?.result?.orderId;
      console.log(`  ✅ orderId=${oid}`, res?.code ? `code=${res.code}` : '');
      results.longOrderId = oid;
      results.longOk = !!oid;
      if (res?.code && res.code !== '00000' && !oid) {
        console.log(`  ❌ 限价失败: ${JSON.stringify(res).slice(0, 200)}`);
        results.longOk = false;
      }
    } catch (e) {
      console.log(`  ❌ 挂单异常: ${e.message}`);
      results.longOk = false;
    }
  } else {
    console.log(`  ⚡ ${longEx} 无盘口，直接市价平多`);
    try {
      const res = await exchanges[longEx].futuresCloseLong(longSym, qty);
      console.log(`  市价:`, JSON.stringify(res).slice(0, 200));
      results.longOk = true; results.longMarket = true;
    } catch (e) {
      console.log(`  ❌ 市价失败: ${e.message}`);
    }
  }

  // === 平空头 (在空头所买入) ===
  if (shortPrice) {
    const price = shortPrice.bid; // Post-Only挂bid → maker
    console.log(`  平空: ${shortEx} 挂买@${price} (ask=${shortPrice.ask})`);
    try {
      const res = await exchanges[shortEx].futuresCloseShortLimit(shortSym, qty, price);
      const oid = res?.orderId || res?.data?.orderId || res?.result?.orderId;
      console.log(`  ✅ orderId=${oid}`, res?.code ? `code=${res.code}` : '');
      results.shortOrderId = oid;
      results.shortOk = !!oid;
      if (res?.code && res.code !== '00000' && !oid) {
        console.log(`  ❌ 限价失败: ${JSON.stringify(res).slice(0, 200)}`);
        results.shortOk = false;
      }
    } catch (e) {
      console.log(`  ❌ 挂单异常: ${e.message}`);
      results.shortOk = false;
    }
  } else {
    console.log(`  ⚡ ${shortEx} 无盘口，直接市价平空`);
    try {
      const res = await exchanges[shortEx].futuresCloseShort(shortSym, qty);
      console.log(`  市价:`, JSON.stringify(res).slice(0, 200));
      results.shortOk = true; results.shortMarket = true;
    } catch (e) {
      console.log(`  ❌ 市价失败: ${e.message}`);
    }
  }

  return results;
}

async function checkAndFallback(results) {
  for (const r of results) {
    if (!r) continue;
    console.log(`\n🔍 ${r.symbol} 检查成交:`);

    // 多头
    if (r.longOrderId && !r.longMarket) {
      try {
        const order = await exchanges[r.longEx].futuresGetOrder(r.longSym, r.longOrderId);
        const status = order?.status || order?.data?.[0]?.state || order?.result?.orderStatus;
        console.log(`  ${r.longEx}多头: ${status}`);
        if (!['FILLED', 'Filled', 'filled', 'full_fill'].includes(status)) {
          console.log(`  ⚠️ 未成交，撤单→市价`);
          await exchanges[r.longEx].futuresCancelOrder(r.longSym, r.longOrderId).catch(() => {});
          await new Promise(x => setTimeout(x, 300));
          const mkt = await exchanges[r.longEx].futuresCloseLong(r.longSym, r.qty);
          console.log(`  市价:`, JSON.stringify(mkt).slice(0, 200));
        } else {
          console.log(`  ✅ 已成交`);
        }
      } catch (e) {
        console.log(`  查单失败: ${e.message}, 尝试市价`);
        await exchanges[r.longEx].futuresCloseLong(r.longSym, r.qty).catch(e2 => console.log(`  市价也失败: ${e2.message}`));
      }
    } else if (r.longMarket) {
      console.log(`  ${r.longEx}多头: 已市价成交`);
    } else if (!r.longOk) {
      console.log(`  ${r.longEx}多头: 挂单失败，补市价`);
      try {
        const mkt = await exchanges[r.longEx].futuresCloseLong(r.longSym, r.qty);
        console.log(`  市价:`, JSON.stringify(mkt).slice(0, 200));
      } catch (e) {
        console.log(`  ❌ 市价也失败: ${e.message}`);
      }
    }

    // 空头
    if (r.shortOrderId && !r.shortMarket) {
      try {
        const order = await exchanges[r.shortEx].futuresGetOrder(r.shortSym, r.shortOrderId);
        const status = order?.status || order?.data?.[0]?.state || order?.result?.orderStatus;
        console.log(`  ${r.shortEx}空头: ${status}`);
        if (!['FILLED', 'Filled', 'filled', 'full_fill'].includes(status)) {
          console.log(`  ⚠️ 未成交，撤单→市价`);
          await exchanges[r.shortEx].futuresCancelOrder(r.shortSym, r.shortOrderId).catch(() => {});
          await new Promise(x => setTimeout(x, 300));
          const mkt = await exchanges[r.shortEx].futuresCloseShort(r.shortSym, r.qty);
          console.log(`  市价:`, JSON.stringify(mkt).slice(0, 200));
        } else {
          console.log(`  ✅ 已成交`);
        }
      } catch (e) {
        console.log(`  查单失败: ${e.message}, 尝试市价`);
        await exchanges[r.shortEx].futuresCloseShort(r.shortSym, r.qty).catch(e2 => console.log(`  市价也失败: ${e2.message}`));
      }
    } else if (r.shortMarket) {
      console.log(`  ${r.shortEx}空头: 已市价成交`);
    } else if (!r.shortOk) {
      console.log(`  ${r.shortEx}空头: 挂单失败，补市价`);
      try {
        const mkt = await exchanges[r.shortEx].futuresCloseShort(r.shortSym, r.qty);
        console.log(`  市价:`, JSON.stringify(mkt).slice(0, 200));
      } catch (e) {
        console.log(`  ❌ 市价也失败: ${e.message}`);
      }
    }
  }
}

async function main() {
  const positions = state.positions;
  if (!positions?.length) { console.log('没有持仓'); return; }

  console.log(`=== 限价平仓 ${positions.length} 个仓位 ===`);
  console.log(`时间: ${new Date().toISOString()}\n`);

  const results = [];
  for (const pos of positions) {
    const r = await closePosLimit(pos);
    results.push(r);
    await new Promise(x => setTimeout(x, 500));
  }

  console.log('\n=== 挂单完成，等60秒检查成交 ===');
  await new Promise(x => setTimeout(x, 60000));
  await checkAndFallback(results);

  // 最后验证持仓清零
  console.log('\n📋 验证持仓:');
  for (const ex of ['binance', 'bybit', 'bitget']) {
    try {
      const pos = await exchanges[ex].getFuturesPositions();
      const list = pos?.data || pos?.result?.list || pos || [];
      const active = (Array.isArray(list) ? list : []).filter(p => {
        const amt = parseFloat(p.positionAmt || p.size || p.total || p.available || 0);
        return Math.abs(amt) > 0;
      });
      if (active.length === 0) {
        console.log(`  ${ex}: ✅ 空仓`);
      } else {
        active.forEach(p => console.log(`  ${ex}: ⚠️ ${p.symbol} amt=${p.positionAmt || p.size || p.total} side=${p.holdSide || (parseFloat(p.positionAmt||0)>0?'long':'short')}`));
      }
    } catch (e) {
      console.log(`  ${ex}: 查询失败`);
    }
  }

  // 最终余额
  console.log('\n💰 最终余额:');
  let total = 0;
  for (const ex of ['binance', 'bybit', 'bitget']) {
    try {
      const bal = await exchanges[ex].getFuturesBalance();
      const v = typeof bal === 'number' ? bal : parseFloat(bal) || 0;
      console.log(`  ${ex}: $${v.toFixed(2)}`);
      total += v;
    } catch (e) {
      console.log(`  ${ex}: 查询失败`);
    }
  }
  console.log(`  总计: $${total.toFixed(2)}`);
}

main().catch(e => console.error('Fatal:', e));
