#!/usr/bin/env node
/**
 * 套利模拟器 v3 启动（四所三策略）
 * 
 * 策略1: 资金费率 → CoinGlass数据（省API调用）
 * 策略2: 跨所价差 → 自己抓四所数据
 * 策略3: DEX-CEX搬砖 → Jupiter vs CEX
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, '.openclaw/workspace');
require('dotenv').config({ path: path.join(WORKSPACE, '.env') });

const LOG_FILE = path.join(WORKSPACE, 'crypto', 'arbitrage_sim.log');
const TRADE_LOG = path.join(WORKSPACE, 'crypto', 'arbitrage_trades.jsonl');
const STATE_FILE = path.join(WORKSPACE, 'crypto', 'arbitrage_state.json');
const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const EXCHANGES = ['okx', 'bybit', 'bitget', 'binance'];

let state = {
  balance: { okx: 3000, bybit: 3000, bitget: 3000, binance: 3000 },
  fundingPositions: [], totalPnl: 0, trades: 0,
  crossArbPnl: 0, fundingPnl: 0, dexCexPnl: 0,
  startTime: null, maxDrawdown: 0, peakBalance: 12000, paused: false,
};

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
function log(msg) { const l = `[${ts()}] ${msg}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l+'\n'); } catch(e) {} }
function logTrade(t) { try { fs.appendFileSync(TRADE_LOG, JSON.stringify({...t,time:new Date().toISOString()})+'\n'); } catch(e) {} }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state,null,2)); } catch(e) {} }
function loadState() { try { const d=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if(d.balance) state=d; } catch(e) {} }

function httpGet(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    https.get({ hostname:u.hostname, path:u.pathname+u.search, agent, timeout:10000 }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve(null);} });
    }).on('error',()=>resolve(null));
  });
}

// 风控：总资产=余额+锁仓
function riskCheck() {
  const free = EXCHANGES.reduce((s,e) => s + state.balance[e], 0);
  const locked = state.fundingPositions.reduce((s,p) => s + p.size * 2, 0);
  const total = free + locked;
  if (total > state.peakBalance) state.peakBalance = total;
  const dd = (state.peakBalance - total) / state.peakBalance * 100;
  state.maxDrawdown = Math.max(state.maxDrawdown, dd);
  if (dd > 5) { if (!state.paused) log(`🚨 熔断! 回撤${dd.toFixed(1)}%`); state.paused = true; return false; }
  if (state.paused && dd < 3) { log(`✅ 恢复交易`); state.paused = false; }
  return !state.paused;
}

// ============ 策略1: 四所费率直查（替代CoinGlass）============
async function fundingFromCoinGlass() {
  if (!riskCheck()) return;
  if (state.fundingPositions.length >= 5) return;
  
  log('📡 直查四所费率数据...');
  try {
    // 并行拉Binance和Bybit全量费率
    const [bnAll, bbAll, bgAll] = await Promise.all([
      httpGet('https://fapi.binance.com/fapi/v1/premiumIndex'),
      httpGet('https://api.bybit.com/v5/market/tickers?category=linear'),
      httpGet('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'),
    ]);
    
    // 整理各所费率
    const allRates = {}; // symbol -> {binance, bybit, bitget, okx}
    
    // Binance
    if (Array.isArray(bnAll)) {
      for (const p of bnAll) {
        const sym = p.symbol.replace('USDT','');
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].binance = parseFloat(p.lastFundingRate);
      }
    }
    
    // Bybit
    if (bbAll?.result?.list) {
      for (const p of bbAll.result.list) {
        if (!p.symbol.endsWith('USDT')) continue;
        const sym = p.symbol.replace('USDT','');
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].bybit = parseFloat(p.fundingRate);
      }
    }
    
    // Bitget
    if (bgAll?.data) {
      for (const p of bgAll.data) {
        const sym = (p.symbol || '').replace('USDT','');
        if (!sym) continue;
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].bitget = parseFloat(p.fundingRate || 0);
      }
    }
    
    // 找所有机会
    const opportunities = [];
    for (const [sym, rates] of Object.entries(allRates)) {
      const pairs = Object.entries(rates).filter(([k,v]) => !isNaN(v) && v !== 0);
      if (pairs.length < 2) continue;
      
      pairs.sort((a,b) => a[1] - b[1]);
      const low = pairs[0], high = pairs[pairs.length-1];
      const spread = high[1] - low[1];
      const ann = spread * 3 * 365 * 100;
      
      if (ann > 30 && spread > 0.0001) {
        opportunities.push({ symbol: sym, lowEx: low[0], highEx: high[0], spread, ann });
      }
    }
    
    opportunities.sort((a,b) => b.ann - a.ann);
    const validCount = opportunities.length;
    log(`📊 扫描${Object.keys(allRates).length}个币，发现${validCount}个费率机会(>30%年化)`);
    
    if (validCount > 0) {
      log(`  Top5: ${opportunities.slice(0,5).map(o => o.symbol+'('+o.ann.toFixed(0)+'%)').join(', ')}`);
    }
    
    // 开仓
    const maxNew = 5 - state.fundingPositions.length;
    let opened = 0;
    for (const op of opportunities.slice(0, 20)) {
      if (opened >= maxNew) break;
      if (state.fundingPositions.find(p => p.symbol === op.symbol)) continue;
      
      const size = 500;
      const openFee = size * 0.0005 * 2;
      if (state.balance[op.lowEx] < size + openFee/2 || state.balance[op.highEx] < size + openFee/2) continue;
      
      state.balance[op.lowEx] -= size + openFee/2;
      state.balance[op.highEx] -= size + openFee/2;
      state.fundingPositions.push({
        symbol: op.symbol, longEx: op.lowEx, shortEx: op.highEx,
        size, spread: op.spread, ann: op.ann, openTime: new Date().toISOString(), earned: -openFee
      });
      state.totalPnl -= openFee;
      state.fundingPnl -= openFee;
      state.trades++;
      opened++;
      log(`💰 [费率] ${op.symbol}: ${op.lowEx}多+${op.highEx}空 | $${size} | 年化${op.ann.toFixed(0)}% | 手续费$${openFee.toFixed(2)}`);
      logTrade({ strategy:'funding', action:'open', ...op, size });
    }
  } catch(e) {
    log(`⚠️ 费率扫描失败: ${e.message}`);
    await fundingFallback();
  }
  saveState();
}

// 备用：直接查热门币费率
async function fundingFallback() {
  const hotCoins = ['BTC','ETH','SOL','DOGE','XRP','PEPE','WIF','BONK','MBOX','KITE','SAHARA'];
  for (const sym of hotCoins) {
    if (state.fundingPositions.length >= 5) break;
    if (state.fundingPositions.find(p => p.symbol === sym)) continue;
    
    const rates = {};
    // 只查4个所
    const [okxR, bybitR, bitgetR, binR] = await Promise.all([
      httpGet(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`).then(d=>d?.data?.[0]?+d.data[0].fundingRate:null),
      httpGet(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`).then(d=>d?.result?.list?.[0]?+d.result.list[0].fundingRate:null),
      httpGet(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${sym}USDT&productType=usdt-futures`).then(d=>d?.data?.[0]?+d.data[0].fundingRate:null),
      httpGet(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`).then(d=>d?+d.lastFundingRate:null),
    ]);
    if (okxR!==null) rates.okx=okxR;
    if (bybitR!==null) rates.bybit=bybitR;
    if (bitgetR!==null) rates.bitget=bitgetR;
    if (binR!==null) rates.binance=binR;
    
    const pairs = Object.entries(rates).filter(([k,v])=>!isNaN(v));
    if (pairs.length<2) continue;
    pairs.sort((a,b)=>a[1]-b[1]);
    const low=pairs[0], high=pairs[pairs.length-1];
    const spread=high[1]-low[1], ann=spread*3*365*100;
    if (ann<20) continue;
    
    const size=500;
    const openFee = size * 0.0005 * 2;
    if (state.balance[low[0]]<size+openFee/2 || state.balance[high[0]]<size+openFee/2) continue;
    state.balance[low[0]]-=size+openFee/2; state.balance[high[0]]-=size+openFee/2;
    state.fundingPositions.push({
      symbol:sym, longEx:low[0], shortEx:high[0], size, spread, ann, openTime:new Date().toISOString(), earned:-openFee
    });
    state.totalPnl -= openFee;
    state.fundingPnl -= openFee;
    state.trades++;
    log(`💰 [费率] ${sym}: ${low[0]}多+${high[0]}空 | $${size} | 年化${ann.toFixed(0)}% | 手续费$${openFee.toFixed(2)}`);
  }
  saveState();
}

// 费率结算
async function settleFunding() {
  for (const pos of state.fundingPositions) {
    // 重新获取两所的实时费率
    const getLiveRate = async (ex, sym) => {
      if (ex==='okx') { const d=await httpGet(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`); return d?.data?.[0]?+d.data[0].fundingRate:0; }
      if (ex==='bybit') { const d=await httpGet(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`); return d?.result?.list?.[0]?+d.result.list[0].fundingRate:0; }
      if (ex==='bitget') { const d=await httpGet(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${sym}USDT&productType=usdt-futures`); return d?.data?.[0]?+d.data[0].fundingRate:0; }
      const d=await httpGet(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`); return d?+d.lastFundingRate:0;
    };
    
    const [lr, sr] = await Promise.all([getLiveRate(pos.longEx, pos.symbol), getLiveRate(pos.shortEx, pos.symbol)]);
    const pnl = (-lr + sr) * pos.size;
    pos.earned += pnl;
    state.totalPnl += pnl;
    state.fundingPnl += pnl;
    state.balance[pos.longEx] += pnl/2;
    state.balance[pos.shortEx] += pnl/2;
    
    if (Math.abs(pnl)>0.01) log(`  💵 ${pos.symbol}: ${pnl>0?'+':''}$${pnl.toFixed(2)} (累计$${pos.earned.toFixed(2)})`);
    
    // 平仓条件：亏损>$5 或 持仓超24小时且当前年化<10%
    const holdHours = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
    const currentAnn = Math.abs((-lr + sr)) * 3 * 365 * 100;
    
    if (pos.earned < -5) {
      log(`🛑 平仓 ${pos.symbol}: 亏$${Math.abs(pos.earned).toFixed(2)}`);
      const closeFee = pos.size * 0.0005 * 2;
      state.balance[pos.longEx] += pos.size - closeFee/2;
      state.balance[pos.shortEx] += pos.size - closeFee/2;
      state.totalPnl -= closeFee;
      pos._closed = true;
    } else if (holdHours > 12 && currentAnn < 10) {
      log(`📉 平仓 ${pos.symbol}: 持${holdHours.toFixed(0)}h 年化已降至${currentAnn.toFixed(0)}%`);
      const closeFee = pos.size * 0.0005 * 2;
      state.balance[pos.longEx] += pos.size - closeFee/2;
      state.balance[pos.shortEx] += pos.size - closeFee/2;
      state.totalPnl -= closeFee;
      pos._closed = true;
    }
  }
  state.fundingPositions = state.fundingPositions.filter(p=>!p._closed);
  saveState();
}

// ============ 策略2: 跨所价差 ============
// ============ 跨所价差 WebSocket实时盘口 ============
const WebSocket = require('ws');
const crossPrices = {}; // { 'BTC': { binance: {bid,ask,ts}, bybit: {bid,ask,ts}, ... } }
const CROSS_COINS = ['BTC','ETH','SOL','DOGE','XRP','PEPE','WIF','BONK','ARB','OP','AVAX','NEAR','FIL','LINK','UNI','SHIB','FLOKI','SUI','APT','TIA'];

function initCrossWS() {
  // Binance WebSocket - 所有币的bookTicker
  try {
    const streams = CROSS_COINS.map(c => `${c.toLowerCase()}usdt@bookTicker`).join('/');
    const bnWs = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
    bnWs.on('message', d => {
      try {
        const msg = JSON.parse(d.toString());
        const data = msg.data || msg;
        const sym = (data.s || '').replace('USDT','');
        if (!sym) return;
        if (!crossPrices[sym]) crossPrices[sym] = {};
        crossPrices[sym].binance = { bid: +data.b, ask: +data.a, ts: Date.now() };
        checkCrossArb(sym); // 事件驱动：价格变→立刻比价
      } catch(e) {}
    });
    bnWs.on('close', () => setTimeout(initCrossWS_binance, 5000));
    bnWs.on('error', () => {});
    global._bnCrossWs = bnWs;
  } catch(e) {}
  
  // Bybit WebSocket
  try {
    const bbWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    bbWs.on('open', () => {
      bbWs.send(JSON.stringify({ op: 'subscribe', args: CROSS_COINS.map(c => `tickers.${c}USDT`) }));
    });
    bbWs.on('message', d => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.topic && msg.data) {
          const sym = msg.topic.replace('tickers.','').replace('USDT','');
          if (!crossPrices[sym]) crossPrices[sym] = {};
          const p = crossPrices[sym].bybit || {};
          if (msg.data.bid1Price) p.bid = +msg.data.bid1Price;
          if (msg.data.ask1Price) p.ask = +msg.data.ask1Price;
          p.ts = Date.now();
          crossPrices[sym].bybit = p;
          checkCrossArb(sym); // 事件驱动
        }
      } catch(e) {}
    });
    bbWs.on('close', () => setTimeout(initCrossWS_bybit, 5000));
    bbWs.on('error', () => {});
    global._bbCrossWs = bbWs;
  } catch(e) {}
  
  // OKX WebSocket  
  try {
    const okxWs = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    okxWs.on('open', () => {
      okxWs.send(JSON.stringify({ op: 'subscribe', args: CROSS_COINS.map(c => ({ channel: 'tickers', instId: `${c}-USDT-SWAP` })) }));
    });
    okxWs.on('message', d => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.data?.[0]) {
          const sym = (msg.data[0].instId || '').split('-')[0];
          if (!crossPrices[sym]) crossPrices[sym] = {};
          crossPrices[sym].okx = { bid: +msg.data[0].bidPx, ask: +msg.data[0].askPx, ts: Date.now() };
          checkCrossArb(sym); // 事件驱动
        }
      } catch(e) {}
    });
    okxWs.on('close', () => setTimeout(initCrossWS_okx, 5000));
    okxWs.on('error', () => {});
    global._okxCrossWs = okxWs;
  } catch(e) {}
  
  log('🔌 跨所WebSocket已连接 (Binance+Bybit+OKX+Bitget)');
  
  // Bitget WebSocket
  try {
    const bgWs = new WebSocket('wss://ws.bitget.com/v2/ws/public');
    bgWs.on('open', () => {
      bgWs.send(JSON.stringify({ op: 'subscribe', args: CROSS_COINS.map(c => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: `${c}USDT` })) }));
    });
    bgWs.on('message', d => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.data?.[0]) {
          const sym = (msg.data[0].instId || '').replace('USDT','');
          if (!crossPrices[sym]) crossPrices[sym] = {};
          crossPrices[sym].bitget = { bid: +msg.data[0].bidPr, ask: +msg.data[0].askPr, ts: Date.now() };
          checkCrossArb(sym);
        }
      } catch(e) {}
    });
    bgWs.on('close', () => setTimeout(() => { try { initCrossWS(); } catch(e) {} }, 5000));
    bgWs.on('error', () => {});
    global._bgCrossWs = bgWs;
  } catch(e) {}
}

function initCrossWS_binance() { try { global._bnCrossWs?.close(); } catch(e) {} initCrossWS(); }
function initCrossWS_bybit() { try { global._bbCrossWs?.close(); } catch(e) {} initCrossWS(); }
function initCrossWS_okx() { try { global._okxCrossWs?.close(); } catch(e) {} initCrossWS(); }

// 事件驱动：价格更新时立刻检查该币的价差
const crossCooldown = {}; // { 'BTC:binance→okx': timestamp }
function checkCrossArb(sym) {
  if (!riskCheck()) return;
  const prices = crossPrices[sym];
  if (!prices) return;
  
  const now = Date.now();
  const freshExs = Object.entries(prices).filter(([ex, p]) => p.bid > 0 && p.ask > 0 && now - p.ts < 3000);
  if (freshExs.length < 2) return;
  
  for (const [b, bp] of freshExs) {
    for (const [s, sp] of freshExs) {
      if (b === s) continue;
      
      // 冷却：同币同方向30秒内只成交一次（模拟实盘节奏）
      const cdKey = `${sym}:${b}→${s}`;
      if (crossCooldown[cdKey] && now - crossCooldown[cdKey] < 30000) continue;
      
      const pct = (sp.bid - bp.ask) / bp.ask * 100;
      if (pct > 0.08) {
        const size = Math.min(200, state.balance[b] * 0.1);
        if (size < 20) continue;
        const fee = size * 0.0004;
        const slippage = size * 0.0002;
        const profit = size * pct / 100 - fee - slippage;
        if (profit < 0.05) continue;
        
        crossCooldown[cdKey] = now;
        state.balance[b] -= fee / 2; state.balance[s] -= fee / 2;
        state.totalPnl += profit; state.crossArbPnl += profit; state.balance[s] += profit; state.trades++;
        log(`⚡ [价差] ${sym}: ${b}→${s} | ${pct.toFixed(3)}% | +$${profit.toFixed(2)}`);
        logTrade({ strategy: 'cross_arb', symbol: sym, buy: b, sell: s, pct, profit });
        saveState();
      }
    }
  }
}

// 兼容定时兜底（200ms），防止事件驱动漏掉
async function crossArbStrategy() {
  if (!riskCheck()) return;
  for (const sym of CROSS_COINS) { checkCrossArb(sym); }
}

// ============ 策略3: DEX-CEX搬砖 ============
async function dexCexStrategy() {
  if (!riskCheck()) return;
  const tokens=[{symbol:'SOL',mint:'So11111111111111111111111111111111111111112'},{symbol:'BONK',mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'}];
  for(const t of tokens){
    const jup=await httpGet(`https://api.jup.ag/price/v2?ids=${t.mint}`);
    const jupP=jup?.data?.[t.mint]?.price;
    if(!jupP) continue;
    for(const ex of EXCHANGES){
      let cex;
      if(ex==='okx'){const d=await httpGet(`https://www.okx.com/api/v5/market/ticker?instId=${t.symbol}-USDT`);cex=d?.data?.[0]?{bid:+d.data[0].bidPx,ask:+d.data[0].askPx}:null;}
      else if(ex==='binance'){const d=await httpGet(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${t.symbol}USDT`);cex=d?{bid:+d.bidPrice,ask:+d.askPrice}:null;}
      else if(ex==='bybit'){const d=await httpGet(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${t.symbol}USDT`);const r=d?.result?.list?.[0];cex=r?{bid:+r.bid1Price,ask:+r.ask1Price}:null;}
      else{const d=await httpGet(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${t.symbol}USDT`);const r=d?.data?.[0];cex=r?{bid:+r.bidPr,ask:+r.askPr}:null;}
      if(!cex) continue;
      
      const dex2cex=(cex.bid-jupP)/jupP*100;
      if(dex2cex>0.15){const profit=100*dex2cex/100-0.05;if(profit>0){state.totalPnl+=profit;state.dexCexPnl+=profit;state.trades++;log(`🔄 [DEX→${ex}] ${t.symbol}: $${(+jupP).toFixed(2)}→$${cex.bid.toFixed(2)} | ${dex2cex.toFixed(2)}% | +$${profit.toFixed(2)}`);}}
      const cex2dex=(jupP-cex.ask)/cex.ask*100;
      if(cex2dex>0.15){const profit=100*cex2dex/100-0.05;if(profit>0){state.totalPnl+=profit;state.dexCexPnl+=profit;state.trades++;log(`🔄 [${ex}→DEX] ${t.symbol}: $${cex.ask.toFixed(2)}→$${(+jupP).toFixed(2)} | ${cex2dex.toFixed(2)}% | +$${profit.toFixed(2)}`);}}
    }
  }
  saveState();
}

// ============ 主循环 ============
async function main() {
  loadState();
  if(!state.startTime){state.startTime=new Date().toISOString();state.balance={okx:3000,bybit:3000,bitget:3000,binance:3000};state.peakBalance=12000;}
  
  log('🚀 套利模拟器 v3 启动（四所三策略）');
  log(`💰 OKX=$${state.balance.okx.toFixed(0)} Bybit=$${state.balance.bybit.toFixed(0)} Bitget=$${state.balance.bitget.toFixed(0)} Binance=$${state.balance.binance.toFixed(0)}`);
  
  await fundingFromCoinGlass();
  await crossArbStrategy();
  initCrossWS(); // 启动WebSocket实时盘口
  // await dexCexStrategy(); // 已关闭：DEX-CEX套利无收益
  
  setInterval(fundingFromCoinGlass, 10*60*1000);   // 费率10分钟
  // 去掉轮询，纯事件驱动（WebSocket推送触发checkCrossArb）
  // setInterval(crossArbStrategy, 200);
  // setInterval(dexCexStrategy, 30*1000); // 已关闭：DEX-CEX套利无收益
  setInterval(settleFunding, 30*60*1000);            // 结算30分钟
  setTimeout(settleFunding, 2*60*1000);
  
  setInterval(()=>{
    const free=EXCHANGES.reduce((s,e)=>s+state.balance[e],0);
    const locked=state.fundingPositions.reduce((s,p)=>s+p.size*2,0);
    log(`📊 总=$${(free+locked).toFixed(2)} | PnL=$${state.totalPnl.toFixed(2)} (费率:$${state.fundingPnl.toFixed(2)} 价差:$${state.crossArbPnl.toFixed(2)} DEX:$${state.dexCexPnl.toFixed(2)}) | 交易:${state.trades} | 仓:${state.fundingPositions.length}/5`);
    saveState();
    // 强制GC（需要 --expose-gc 或 --max-old-space-size 会触发aggressive GC）
    if (global.gc) global.gc();
  }, 5*60*1000);
  
  log('✅ v3就绪');
}

main().catch(console.error);
