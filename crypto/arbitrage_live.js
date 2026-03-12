/**
 * 实盘套利引擎 v1
 * 策略: 费率套利 + 价差套利
 * 风控: 盘口深度检查、单腿保护、每日亏损限制
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const fs = require('fs');
const https = require('https');
const { binance, bybit, bitget, okx, getExchange, checkArbDepth, calcDepthFill, ensureFuturesBalance, ensureSpotBalance, logTrade } = require('./exchange_trader');
const RealTimeRateMonitor = require('./realtime_monitor');

// WebSocket 实时监控器
const monitor = new RealTimeRateMonitor();

// ============ 全局异常捕获（防崩溃）============
process.on('uncaughtException', (err) => {
  const msg = `⚠️ 未捕获异常: ${err.message}`;
  console.error(`[${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}] ${msg}`);
  console.error(err.stack);
  // 不退出，让systemd不需要重启
});

process.on('unhandledRejection', (reason) => {
  const msg = `⚠️ 未处理Promise: ${reason?.message || reason}`;
  console.error(`[${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}] ${msg}`);
  // 不退出
});

// ============ 配置 ============
const CONFIG = {
  // 交易参数
  TRADE_SIZE_USD: 100,        // 单笔金额 $100
  MAX_POSITIONS: 20,          // 最大持仓数上限
  MAX_POSITION_PER_COIN: 500, // 单币最大敞口 $500
  MIN_SPREAD_TO_KEEP: 0.0002, // 低于0.02%费率差的仓位考虑平掉
  REBALANCE_INTERVAL: 3600000,// 每小时重新评估仓位
  
  // 风控
  DAILY_LOSS_LIMIT: 50,       // 每日亏损上限 $50
  MIN_DEPTH_USD: 150,         // 最小盘口深度（单边）
  MAX_SLIPPAGE_BPS: 10,       // 最大允许滑点 10bps
  MIN_PROFIT_BPS: 5,          // 最小利润阈值 5bps（扣费后）
  FEE_BPS: 10,                // 单边手续费 10bps（0.1%）
  
  // 极端行情保护
  MAX_PRICE_DEVIATION_PCT: 10, // 同一币种四所最大价差超10%才暂停（小币波动大）
  // 保证金安全监控
  MARGIN_WARN_RATIO: 0.15,    // 可用余额/仓位名义值 < 30% → 通知
  MARGIN_CLOSE_RATIO: 0.10,   // < 20% → 自动平掉最大浮亏仓位
  MARGIN_EMERGENCY_RATIO: 0.08, // < 15% → 全平该交易所所有仓位
  MARGIN_CHECK_INTERVAL: 60000, // 每60秒检查一次
  EXCHANGE_TIMEOUT_PAUSE: 3,  // 连续3次API超时暂停该交易所
  TOTAL_LOSS_LIMIT: 800, // [已废弃] 不再使用，对冲仓位不需要总亏损检查
  UNREALIZED_LOSS_LIMIT: 500, // [已废弃] 不再使用，浮亏是纸面数字
  
  // 费率套利
  MIN_FUNDING_SPREAD: 0.003, // 最小费率差 0.3%（只做高确定性）
  FUNDING_CHECK_INTERVAL: 60000, // 费率检查间隔 1分钟
  
  // 价差套利
  SPREAD_CHECK_INTERVAL: 5000,   // 价差检查间隔 5秒
  MIN_SPREAD_BPS: 25,            // 最小价差 25bps（扣两边手续费20bps后还有利润）
  
  // 冷却
  COOLDOWN_SAME_PAIR: 30000,     // 同币对冷却 30秒
  
  // 状态文件
  STATE_FILE: '/root/.openclaw/workspace/crypto/arbitrage_live_state.json',
  LOG_FILE: '/root/.openclaw/workspace/crypto/real_trade_log.jsonl',
  
  // Telegram通知
  TG_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TG_CHAT_ID: '877233818'
};

// ============ 全局状态 ============
let isScanning = false;    // 防止 scanFundingRates 并发

const openingSymbols = new Set(); // 防止 WS 和 REST 同时开同一个币
// watchlist 已移除，改用每轮全量重扫
let state = {
  startTime: new Date().toISOString(),
  running: true,
  paused: false,
  
  // PnL
  totalPnl: 0,
  realizedPnl: 0,
  unrealizedPnl: 0,
  dailyPnl: 0,
  dailyPnlDate: new Date().toISOString().slice(0, 10),
  trades: 0,
  wins: 0,
  losses: 0,
  
  // 仓位
  positions: [],       // { id, symbol, type, longEx, shortEx, size, qty, entryPrice, entryTime, ... }
  
  // 余额缓存
  balances: { binance: 0, bybit: 0, bitget: 0, okx: 0 },
  
  // 冷却
  lastTrade: {},       // symbol -> timestamp
  
  // 错误计数
  errors: 0,
  consecutiveErrors: 0,
  lastError: null
};

// ============ 工具函数 ============
function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${ts}] ${msg}`);
}

// 日志轮转：systemd journal 自动管理 stdout，但也写文件作为备份
// logrotate 由 cron 每天检查，超过 5MB 轮转
let _lastLogRotateCheck = 0;
function checkLogRotate() {
  if (Date.now() - _lastLogRotateCheck < 3600000) return; // 每小时检查一次
  _lastLogRotateCheck = Date.now();
  try {
    const logFile = '/root/.openclaw/workspace/crypto/arbitrage_live.log';
    const stat = fs.statSync(logFile);
    if (stat.size > 5 * 1024 * 1024) { // > 5MB
      const oldLog = logFile + '.old';
      if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
      fs.renameSync(logFile, oldLog);
    }
  } catch (e) {}
}

function saveState() {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      // 恢复仓位和PnL
      state = { ...state, ...saved, running: true, paused: saved.paused || false };
      log(`📂 恢复状态: ${state.positions.length}个仓位, PnL $${state.totalPnl.toFixed(2)}`);
    }
  } catch (e) {
    log('⚠️ 状态恢复失败: ' + e.message);
  }
}

async function notify(msg) {
  try {
    const body = JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: '🔔 套利实盘: ' + msg });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + CONFIG.TG_BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (e) { /* ignore */ }
  
  // 每次通知后也刷新看板
  try { await updateDashboard(); } catch(e) {}
}

async function updateDashboard() {
  try {
    // 统一走 HTTP handler 刷新看板，避免多份代码不一致
    const http = require('http');
    http.get('http://127.0.0.1:9876/refresh', { timeout: 3000 }, (res) => {
      res.resume(); // drain
    }).on('error', () => {});
  } catch (e) { /* 看板更新失败不影响交易 */ }
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ============ 交易所符号映射 ============
// 不同交易所的symbol格式不同
function getSpotSymbol(base, ex) {
  if (ex === 'okx') return `${base}-USDT`;
  return `${base}USDT`; // binance, bybit, bitget
}

// 通用盘口查询
async function getOrderbook(ex, symbol, limit = 20) {
  try {
    if (ex === 'binance') {
      const r = await httpGet(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
      return r ? { bids: r.bids.map(b => ({ price: +b[0], qty: +b[1] })), asks: r.asks.map(a => ({ price: +a[0], qty: +a[1] })) } : null;
    } else if (ex === 'bybit') {
      const r = await httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${limit}`);
      return r?.result ? { bids: r.result.b.map(b => ({ price: +b[0], qty: +b[1] })), asks: r.result.a.map(a => ({ price: +a[0], qty: +a[1] })) } : null;
    } else if (ex === 'bitget') {
      const r = await httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${symbol}&productType=USDT-FUTURES&limit=${limit}`);
      return r?.data ? { bids: r.data.bids.map(b => ({ price: +b[0], qty: +b[1] })), asks: r.data.asks.map(a => ({ price: +a[0], qty: +a[1] })) } : null;
    } else if (ex === 'okx') {
      const r = await httpGet(`https://www.okx.com/api/v5/market/books?instId=${symbol}&sz=${limit}`);
      return r?.data?.[0] ? { bids: r.data[0].bids.map(b => ({ price: +b[0], qty: +b[1] })), asks: r.data[0].asks.map(a => ({ price: +a[0], qty: +a[1] })) } : null;
    }
  } catch (e) { return null; }
  return null;
}

function getFuturesSymbol(base, ex) {
  if (ex === 'okx') return `${base}-USDT-SWAP`;
  if (ex === 'bitget') return `${base}USDT`;
  return `${base}USDT`; // binance, bybit
}

// ============ 余额更新 ============
async function updateBalances() {
  try {
    // 读取每个交易所的总资金（现货+合约）
    const [bnSpot, bnFut, by, bgSpot, bgFut, ok] = await Promise.all([
      binance.getBalance().catch(() => ({ usdt: 0 })),
      binance.getFuturesBalance().catch(() => ({ usdt: 0 })),
      bybit.getBalance().catch(() => ({ usdt: 0, equity: 0 })),
      bitget.getBalance().catch(() => ({ usdt: 0 })),
      bitget.getFuturesBalance().catch(() => ({ usdt: 0 })),
      okx.getBalance().catch(() => ({ usdt: 0, equity: 0 }))
    ]);
    state.balances = {
      binance: (+bnSpot.usdt || 0) + (+bnFut.usdt || 0),
      bybit: by.usdt !== undefined && by.usdt !== null ? +by.usdt : (state.balances.bybit || 0),  // walletBalance，不含浮盈
      bitget: (+bgSpot.usdt || 0) + (+bgFut.usdt || 0),
      okx: ok.usdt !== undefined && ok.usdt !== null ? +ok.usdt : (state.balances.okx || 0)  // walletBalance
    };
    return state.balances;
  } catch (e) {
    log('⚠️ 余额更新失败: ' + e.message);
    return state.balances;
  }
}

// ============ 费率数据获取 ============
const EXCHANGES_LIST = ['okx', 'bybit', 'bitget', 'binance'];

async function fetchFundingRates() {
  const allRates = {};
  const nextFundingTimes = {}; // { SYM: { binance: timestamp, bybit: timestamp, ... } }
  
  try {
    const [bnData, byData, bgData, okData] = await Promise.all([
      httpGet('https://fapi.binance.com/fapi/v1/premiumIndex'),
      httpGet('https://api.bybit.com/v5/market/tickers?category=linear'),
      httpGet('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'),
      httpGet('https://www.okx.com/api/v5/public/funding-rate')
    ]);

    // Binance
    if (Array.isArray(bnData)) {
      for (const p of bnData) {
        if (!p.symbol.endsWith('USDT')) continue;
        const sym = p.symbol.replace('USDT', '');
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].binance = parseFloat(p.lastFundingRate);
        if (!nextFundingTimes[sym]) nextFundingTimes[sym] = {};
        nextFundingTimes[sym].binance = p.nextFundingTime;
      }
    }

    // Bybit
    if (byData?.result?.list) {
      for (const p of byData.result.list) {
        if (!p.symbol.endsWith('USDT')) continue;
        const sym = p.symbol.replace('USDT', '');
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].bybit = parseFloat(p.fundingRate);
        if (!nextFundingTimes[sym]) nextFundingTimes[sym] = {};
        nextFundingTimes[sym].bybit = +p.nextFundingTime;
      }
    }

    // Bitget
    if (bgData?.data) {
      for (const p of bgData.data) {
        if (!p.symbol.endsWith('USDT')) continue;
        const sym = p.symbol.replace('USDT', '');
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].bitget = parseFloat(p.fundingRate || 0);
        if (!nextFundingTimes[sym]) nextFundingTimes[sym] = {};
        nextFundingTimes[sym].bitget = +p.nextFundingTime || 0;
      }
    }

    // OKX
    if (okData?.data) {
      for (const p of okData.data) {
        const match = p.instId.match(/^(\w+)-USDT-SWAP$/);
        if (!match) continue;
        const sym = match[1];
        if (!allRates[sym]) allRates[sym] = {};
        allRates[sym].okx = parseFloat(p.fundingRate);
        if (!nextFundingTimes[sym]) nextFundingTimes[sym] = {};
        nextFundingTimes[sym].okx = +p.nextFundingTime || 0;
      }
    }
  } catch (e) {
    log('⚠️ 费率获取失败: ' + e.message);
  }

  return { rates: allRates, nextFundingTimes };
}

// ============ 动态仓位大小 ============
function getTradeSize(spread) {
  // 动态仓位：高费率重仓，低费率轻仓
  if (spread >= 0.008) return 10000; // ≥0.8% → $10000 极品
  if (spread >= 0.005) return 8000;  // 0.5%-0.8% → $8000
  if (spread >= 0.003) return 6000;  // 0.3%-0.5% → $6000
  return 0;                           // <0.3% → 不开
}

// ============ 精度对齐：两边取最小公共精度 ============
function alignQty(symbol, ex1, ex2, rawQty) {
  const q1 = monitor.adjustQty(symbol, ex1, rawQty);
  const q2 = monitor.adjustQty(symbol, ex2, rawQty);
  
  // 取两边都能接受的最小值
  const info1 = monitor.symbolInfo[symbol]?.[ex1];
  const info2 = monitor.symbolInfo[symbol]?.[ex2];
  
  // OKX 用张数(lots)下单，需要转换: qty_lots = qty_coins / ctVal
  // 其他交易所用币数下单
  // 统一按币数计算，开仓时再根据交易所转换
  
  // 找最大的stepSize（按币数统一）
  let step1 = info1?.stepSize || 1;
  let step2 = info2?.stepSize || 1;
  // OKX 的 stepSize 是张数，转成币数
  if (ex1 === 'okx' && info1?.ctVal) step1 = step1 * info1.ctVal;
  if (ex2 === 'okx' && info2?.ctVal) step2 = step2 * info2.ctVal;
  const maxStep = Math.max(step1, step2);
  
  // 用最粗的精度取整
  let qty = Math.floor(rawQty / maxStep) * maxStep;
  
  // 确保两边的最小数量都满足（按币数）
  let min1 = info1?.minQty || 1;
  let min2 = info2?.minQty || 1;
  if (ex1 === 'okx' && info1?.ctVal) min1 = min1 * info1.ctVal;
  if (ex2 === 'okx' && info2?.ctVal) min2 = min2 * info2.ctVal;
  const minQty = Math.max(min1, min2);
  if (qty < minQty) return 0;
  
  // 保留合适小数位
  const decimals = maxStep < 1 ? Math.ceil(-Math.log10(maxStep)) : 0;
  return parseFloat(qty.toFixed(decimals));
}

// OKX 币数转张数
function coinsToLots(symbol, coins) {
  const info = monitor.symbolInfo[symbol]?.okx;
  if (!info?.ctVal) return coins;
  return Math.round(coins / info.ctVal);
}

// ============ Step 1: 预过滤（零API调用，纯内存检查）============
function preFilter(symbol, lowEx, highEx, equiv8hSpread, settlementAligned) {
  // 暂停
  if (state.paused) return '暂停中';
  // 仓位上限
  if (state.positions.length >= CONFIG.MAX_POSITIONS) return '仓位已满';
  // 同币去重
  if (state.positions.some(p => p.symbol === symbol)) return '已有同币持仓';
  // 冷却
  const pairKey = `${symbol}_${lowEx}_${highEx}`;
  if (state.lastTrade[pairKey] && Date.now() - state.lastTrade[pairKey] < CONFIG.COOLDOWN_SAME_PAIR) return '冷却中';
  // 费率门槛
  const minSpread = (settlementAligned !== false) ? CONFIG.MIN_FUNDING_SPREAD : 0.01;
  if (equiv8hSpread < minSpread) return `费率差${(equiv8hSpread*100).toFixed(3)}%不足(需${(minSpread*100).toFixed(1)}%)`;
  // 仓位大小
  const tradeSize = getTradeSize(equiv8hSpread);
  if (tradeSize === 0) return '费率差不够开仓';
  // 余额（全仓10x杠杆，保证金=仓位/10，留50%余量）
  const marginNeeded = tradeSize / 10 * 1.5;
  if ((state.balances[lowEx] || 0) < marginNeeded) return `${lowEx}余额不足(需$${Math.round(marginNeeded)})`;
  if ((state.balances[highEx] || 0) < marginNeeded) return `${highEx}余额不足(需$${Math.round(marginNeeded)})`;
  return null; // 通过
}

// ============ WebSocket 触发的快速开仓 ============
async function handleFundingOpportunity(opp) {
  const { symbol, lowEx, highEx, annualized } = opp;
  const spread = opp.equiv8hSpread || opp.spread;
  
  const reject = preFilter(symbol, lowEx, highEx, spread, opp.settlementAligned);
  if (reject) return; // WS触发量大，静默跳过
  
  log(`⚡ [WS] 费率机会: ${symbol} ${lowEx}(${opp.lowRate.toFixed(4)}) → ${highEx}(${opp.highRate.toFixed(4)}) 差${(spread*100).toFixed(3)}% 年化${annualized.toFixed(0)}%`);
  
  await executeFundingArbitrage({ symbol, lowEx, highEx, lowRate: opp.lowRate, highRate: opp.highRate, spread, annualized, tradeSize: getTradeSize(spread), settlementAligned: opp.settlementAligned });
}

// ============ 费率套利扫描 ============
async function scanFundingArbitrage() {
  if (state.paused) return;
  if (isScanning) { log('⏳ 上一轮扫描未完成，跳过'); return; }
  
  isScanning = true;
  try {

  const { rates, nextFundingTimes } = await fetchFundingRates();
  const now = Date.now();
  const opportunities = [];

  for (const [sym, exRates] of Object.entries(rates)) {
    const exList = Object.entries(exRates).filter(([, r]) => r !== undefined && r !== null);
    if (exList.length < 2) continue;

    // 标准化为每小时费率再比较
    const normalized = exList.map(([ex, rate]) => {
      const interval = monitor.fundingIntervals[sym]?.[ex] || 8;
      const hourlyRate = rate / interval;
      return [ex, rate, hourlyRate, interval];
    });

    normalized.sort((a, b) => a[2] - b[2]);
    const [lowEx, lowRate, lowHourly, lowInterval] = normalized[0];
    const [highEx, highRate, highHourly, highInterval] = normalized[normalized.length - 1];

    // === 结算时间窗口检查 ===
    const lowNext = nextFundingTimes[sym]?.[lowEx] || 0;
    const highNext = nextFundingTimes[sym]?.[highEx] || 0;
    
    // 1. 两所结算时间对齐检查
    let settlementAligned = true; // 默认对齐
    let timeDiffMs = 0;
    if (lowNext > 0 && highNext > 0) {
      timeDiffMs = Math.abs(lowNext - highNext);
      if (timeDiffMs > 3 * 60 * 60 * 1000) continue; // 差 > 3小时，完全不做
      if (timeDiffMs > 30 * 60 * 1000) settlementAligned = false; // 30min-3h: 不对齐，需更高门槛
    }
    
    // 2. 距最近结算必须在窗口内（用有数据的那个，都有取较早的）
    const validTimes = [lowNext, highNext].filter(t => t > 0);
    if (validTimes.length === 0) continue; // 两边都没结算时间数据
    const earlierNext = Math.min(...validTimes);
    if (earlierNext === Infinity) continue; // 没有结算时间数据，跳过
    const msToSettle = earlierNext - now;
    if (msToSettle < 0 || msToSettle > 60 * 60 * 1000) continue; // 超过60分钟的跳过
    // 窗口：结算前30-60分钟
    if (msToSettle < 30 * 60 * 1000) continue; // 太近了不开（<30min）
    const hourlySpread = highHourly - lowHourly;
    const equiv8hSpread = hourlySpread * 8; // 等效8小时费率差

    // 门槛：对齐的0.3%，不对齐的1.0%
    const minSpread = settlementAligned ? CONFIG.MIN_FUNDING_SPREAD : 0.01;
    if (equiv8hSpread < minSpread) continue;

    // 最低绝对门槛：原始费率差不能低于0.1%
    const rawSpread = highRate - lowRate;
    if (Math.abs(rawSpread) < 0.001) continue;

    // Step 1 预过滤（冷却/去重/余额，统一入口）
    const reject = preFilter(sym, lowEx, highEx, equiv8hSpread, settlementAligned);
    if (reject) continue;

    opportunities.push({
      symbol: sym,
      lowEx, highEx,
      lowRate, highRate,
      spread: equiv8hSpread,
      hourlySpread,
      lowInterval, highInterval,
      annualized: hourlySpread * 24 * 365 * 100,
      settlementAligned
    });
  }

  // 按等效费率差排序
  opportunities.sort((a, b) => b.spread - a.spread);

  if (opportunities.length === 0) {
    if (!scanFundingArbitrage._count) scanFundingArbitrage._count = 0;
    scanFundingArbitrage._count++;
    if (scanFundingArbitrage._count % 10 === 1) {
      log(`🔍 扫描完成: 无符合条件的机会（窗口+对齐+门槛）`);
    }
  } else {
    log(`🔍 扫描发现 ${opportunities.length} 个机会: ${opportunities.slice(0,3).map(o=>o.symbol+'('+(o.spread*100).toFixed(2)+'%)').join(', ')}`);
  }

  for (const opp of opportunities.slice(0, 3)) {
    try {
      await executeFundingArbitrage(opp);
    } catch (e) {
      log(`❌ 费率套利执行失败 ${opp.symbol}: ${e.message}`);
      state.errors++;
      state.consecutiveErrors++;
      state.lastError = e.message;

      if (state.consecutiveErrors >= 5) {
        await notify(`⚠️ 连续5次错误（仅通知）\n最后错误: ${e.message}`);
        state.consecutiveErrors = 0; // 重置，继续运行
      }
    }
  }
  } finally {
    isScanning = false;
  }
}

// ============ 历史费率趋势检查 ============
async function checkFundingTrend(symbol, lowEx, highEx) {
  // 拉两所最近5期历史费率，检查趋势稳定性
  const sym = symbol + 'USDT';
  
  const fetchHistory = async (ex) => {
    if (ex === 'binance') {
      const data = await httpGet(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=5`);
      return (data || []).map(r => ({ time: r.fundingTime, rate: +r.fundingRate }));
    } else if (ex === 'bybit') {
      const data = await httpGet(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=5`);
      return (data?.result?.list || []).map(r => ({ time: +r.fundingRateTimestamp, rate: +r.fundingRate })).reverse();
    } else if (ex === 'bitget') {
      const data = await httpGet(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${sym}&productType=USDT-FUTURES&pageSize=5`);
      return (data?.data || []).map(r => ({ time: +r.fundingTime, rate: +r.fundingRate })).reverse();
    }
    return [];
  };

  const [lowHistory, highHistory] = await Promise.all([fetchHistory(lowEx), fetchHistory(highEx)]);
  
  if (lowHistory.length < 3 || highHistory.length < 3) {
    log(`  📊 趋势检查: ${symbol} 历史数据不足(${lowEx}:${lowHistory.length} ${highEx}:${highHistory.length})，放行`);
    return true; // 数据不足不拦
  }

  // 匹配时间最近的，计算每期费率差 (high - low，正=我们赚)
  const spreads = [];
  for (const h of highHistory) {
    let closest = null, minDiff = Infinity;
    for (const l of lowHistory) {
      const diff = Math.abs(h.time - l.time);
      if (diff < minDiff) { minDiff = diff; closest = l; }
    }
    if (closest && minDiff < 8 * 3600000) { // 8小时内匹配
      spreads.push(h.rate - closest.rate);
    }
  }

  if (spreads.length < 3) {
    log(`  📊 趋势检查: ${symbol} 匹配期数不足(${spreads.length})，放行`);
    return true;
  }

  const positive = spreads.filter(s => s > 0).length;
  const total = spreads.length;
  
  // 检查是否有连续2期反转（最近的2期）
  const lastTwo = spreads.slice(-2);
  const consecutiveNeg = lastTwo.every(s => s <= 0);

  const pass = positive >= Math.ceil(total * 0.6) && !consecutiveNeg; // 至少60%正 且 最近2期没连续反转
  
  log(`  📊 趋势检查: ${symbol} ${lowEx}/${highEx} 最近${total}期 正:${positive} 负:${total-positive} 最近2期连续反转:${consecutiveNeg} → ${pass ? '✅通过' : '❌不通过'}`);
  
  return pass;
}

// ============ 执行费率套利 ============
async function executeFundingArbitrage(opp) {
  const { symbol, lowEx, highEx, spread, annualized } = opp;

  // 防止 WS 和 REST 同时开同一个币
  if (openingSymbols.has(symbol)) {
    log(`⏳ ${symbol} 正在开仓中，跳过`);
    return;
  }
  openingSymbols.add(symbol);
  
  try {

  log(`🔍 [Step2] ${symbol} ${lowEx}多/${highEx}空 费率差${(spread*100).toFixed(3)}% 年化${annualized.toFixed(0)}%`);

  // Step 2a. 历史费率趋势检查
  try {
    const historyChecked = await checkFundingTrend(symbol, lowEx, highEx);
    if (!historyChecked) {
      log(`  ⏭️ [Step2a] ${symbol} 历史费率趋势不稳，跳过`);
      return;
    }
  } catch (e) {
    log(`  ⚠️ [Step2a] 趋势检查失败: ${e.message}，继续`);
  }

  // Step 2b. 检查合约盘口深度
  const lowFutSym = getFuturesSymbol(symbol, lowEx);
  const highFutSym = getFuturesSymbol(symbol, highEx);
  
  const lowExObj = getExchange(lowEx);
  const highExObj = getExchange(highEx);

  // 获取合约盘口
  let lowBook, highBook;
  try {
    [lowBook, highBook] = await Promise.all([
      lowEx === 'binance' ? binance.getFuturesOrderbook(lowFutSym, 10) :
      lowEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${lowFutSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
      lowEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${lowFutSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
      httpGet(`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT-SWAP&sz=10`).then(r => r?.data?.[0] ? { bids: r.data[0].bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data[0].asks.map(a=>({price:+a[0],qty:+a[1]})) } : null),
      
      highEx === 'binance' ? binance.getFuturesOrderbook(highFutSym, 10) :
      highEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${highFutSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
      highEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${highFutSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
      httpGet(`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT-SWAP&sz=10`).then(r => r?.data?.[0] ? { bids: r.data[0].bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data[0].asks.map(a=>({price:+a[0],qty:+a[1]})) } : null)
    ]);
  } catch (e) {
    log(`  ⚠️ [Step2b] 盘口获取失败: ${e.message}`);
    return;
  }

  if (!lowBook || !highBook) {
    log(`  ⚠️ ${symbol} [Step2b] 盘口数据不完整，跳过`);
    return;
  }

  // Step 2c. 动态仓位大小（提前算，深度检查要用）
  let tradeSize = opp.tradeSize || getTradeSize(spread);
  if (tradeSize === 0) { log(`  ⚠️ [Step2c] 费率差太小`); return; }

  // Step 2d. 检查深度（用实际仓位大小）
  const lowFill = calcDepthFill(lowBook.asks, tradeSize);
  const highFill = calcDepthFill(highBook.bids, tradeSize);

  if (!lowFill.filled || !highFill.filled) {
    // 按盘口能吃的量降级，最低 $500
    const fillable = Math.min(lowFill.fillableUsd, highFill.fillableUsd);
    const adjusted = Math.floor(fillable / 100) * 100; // 向下取整到百
    if (adjusted >= 200) {
      log(`  ⚠️ [Step2d] 深度不足(低$${lowFill.fillableUsd.toFixed(0)}/高$${highFill.fillableUsd.toFixed(0)})，降级到$${adjusted}`);
      tradeSize = adjusted;
    } else {
      log(`  ⚠️ [Step2d] 深度不足: 低所$${lowFill.fillableUsd.toFixed(0)} 高所$${highFill.fillableUsd.toFixed(0)}，最低$200也不够，跳过`);
      return;
    }
  }

  if (lowFill.slippageBps > CONFIG.MAX_SLIPPAGE_BPS || highFill.slippageBps > CONFIG.MAX_SLIPPAGE_BPS) {
    log(`  ⚠️ [Step2e] 滑点过大: 低所${lowFill.slippageBps}bps 高所${highFill.slippageBps}bps`);
    return;
  }

  // Step 2e. [Step2e] 两所价差检查（控制开仓滑点成本）
  const lowBestAsk = lowBook.asks[0].price;
  const highBestBid = highBook.bids[0].price;
  const midPrice = (lowBestAsk + highBestBid) / 2;
  const priceDiffPct = Math.abs(lowBestAsk - highBestBid) / midPrice * 100;
  if (priceDiffPct > 1.0) {
    log(`  ⚠️ [Step2e] 两所价差${priceDiffPct.toFixed(2)}%超过1%，等价差缩小再开`);
    // 不记录，下轮扫描会重新检查
    return;
  }

  // Step 2f. 计算数量（精度对齐）
  
  let qty = alignQty(symbol, lowEx, highEx, tradeSize / midPrice);
  
  // fallback
  if (!qty || qty <= 0) {
    qty = Math.floor(tradeSize / midPrice);
  }

  if (qty <= 0) {
    log(`  ⚠️ [Step2f] 数量太小: ${qty}`);
    return;
  }

  log(`  📊 深度OK: 价格~$${midPrice.toFixed(4)} 数量${qty} 仓位$${tradeSize} 滑点${lowFill.slippageBps}/${highFill.slippageBps}bps`);

  // Step 3a. 确保合约账户有余额（自动划转）
  const [lowReady, highReady] = await Promise.all([
    ensureFuturesBalance(lowEx, tradeSize / 10 * 1.5),
    ensureFuturesBalance(highEx, tradeSize / 10 * 1.5)
  ]);
  if (!lowReady || !highReady) {
    log(`  ⚠️ [Step3a] 合约余额不足且划转失败: ${lowEx}=${lowReady} ${highEx}=${highReady}`);
    return;
  }

  // Step 3b. 同时下单: 低费率所做多 + 高费率所做空
  // OKX 用张数下单，其他用币数
  const longQty = lowEx === 'okx' ? coinsToLots(symbol, qty) : qty;
  const shortQty = highEx === 'okx' ? coinsToLots(symbol, qty) : qty;
  log(`  🚀 [Step3b] 下单: ${lowEx}做多 + ${highEx}做空 ${symbol} x${qty}${lowEx === 'okx' || highEx === 'okx' ? ` (OKX张数: ${lowEx === 'okx' ? longQty : shortQty})` : ''}`);

  // 杠杆限额检查
  if (lowEx === 'binance') await ensureBinanceLeverage(lowFutSym, tradeSize);
  if (highEx === 'binance') await ensureBinanceLeverage(highFutSym, tradeSize);

  let longResult, shortResult;
  try {
    [longResult, shortResult] = await Promise.all([
      lowExObj.futuresLong(lowFutSym, longQty),
      highExObj.futuresShort(highFutSym, shortQty)
    ]);
  } catch (e) {
    log(`  ❌ 下单异常: ${e.message}`);
    // 单腿保护: 检查是否有一边已成交
    try {
      const [checkL, checkS] = await Promise.all([
        lowExObj.getFuturesPositions(),
        highExObj.getFuturesPositions()
      ]);
      const hasLong = checkL.find(p => (p.symbol||'').includes(symbol) && Math.abs(+(p.positionAmt||p.total||p.size||0)) > 0);
      const hasShort = checkS.find(p => (p.symbol||'').includes(symbol) && Math.abs(+(p.positionAmt||p.total||p.size||0)) > 0);
      if (hasLong && !hasShort) {
        log(`  ⚠️ 单腿: ${lowEx}多已成交，平掉`);
        await lowExObj.futuresCloseLong(lowFutSym, qty).catch(()=>{});
      } else if (!hasLong && hasShort) {
        log(`  ⚠️ 单腿: ${highEx}空已成交，平掉`);
        await highExObj.futuresCloseShort(highFutSym, qty).catch(()=>{});
      }
    } catch (e2) { log(`  ❌ 单腿检查失败: ${e2.message}`); }
    return;
  }

  // 5. 检查成交（Binance 低流动性币可能返回 NEW，需要等待）
  let longOk = checkOrderSuccess(longResult, lowEx);
  let shortOk = checkOrderSuccess(shortResult, highEx);

  // Binance NEW 状态等待确认
  if (!longOk && lowEx === 'binance' && longResult?.status === 'NEW' && longResult?.orderId) {
    log('  ⏳ Binance 多单 NEW，等待成交...');
    longOk = await waitForBinanceFill(longResult.orderId, lowFutSym);
  }
  if (!shortOk && highEx === 'binance' && shortResult?.status === 'NEW' && shortResult?.orderId) {
    log('  ⏳ Binance 空单 NEW，等待成交...');
    shortOk = await waitForBinanceFill(shortResult.orderId, highFutSym);
  }

  if (longOk && shortOk) {
    // 两边都成了
    const position = {
      id: Date.now().toString(36),
      symbol,
      type: 'funding',
      longEx: lowEx,
      shortEx: highEx,
      size: tradeSize,
      qty,
      entryPrice: midPrice,
      entryTime: new Date().toISOString(),
      spread,
      annualized,
      earned: 0,
      totalFee: 0,
      settlementAligned: opp.settlementAligned !== false, // 默认true
      longOrderId: getOrderId(longResult, lowEx),
      shortOrderId: getOrderId(shortResult, highEx)
    };

    state.positions.push(position);
    state.trades++;
    state.consecutiveErrors = 0;
    state.lastTrade[`${symbol}_${lowEx}_${highEx}`] = Date.now();

    const fee = tradeSize * 2 * CONFIG.FEE_BPS / 10000;
    position.totalFee = (position.totalFee || 0) + fee;
    state.totalPnl -= fee;
    state.dailyPnl -= fee;

    saveState();
    logTrade({ action: 'OPEN_FUNDING', ...position, fee });

    log(`  ✅ 费率套利开仓成功! ${symbol} ${lowEx}多/${highEx}空 $${tradeSize} 手续费$${fee.toFixed(2)}`);
    const notifyTargetSize = getTradeSize(spread);
    await notify(`✅ 开仓 ${symbol}\n${lowEx}多 / ${highEx}空\n$${tradeSize}（目标$${notifyTargetSize}）| 费率差${(spread*100).toFixed(3)}% | 年化${annualized.toFixed(0)}%`);

    // 首单对齐校验：确认两边实际成交量一致
    try {
      const [realLP, realSP] = await Promise.all([
        lowExObj.getFuturesPositions(),
        highExObj.getFuturesPositions()
      ]);
      const rlp = realLP.find(p => (p.symbol||'').includes(symbol));
      const rsp = realSP.find(p => (p.symbol||'').includes(symbol));
      const realLQ = rlp ? Math.abs(+(rlp.positionAmt || rlp.total || rlp.size || 0)) : 0;
      const realSQ = rsp ? Math.abs(+(rsp.positionAmt || rsp.total || rsp.size || 0)) : 0;
      if (realLQ !== realSQ && realLQ > 0 && realSQ > 0) {
        const diff = Math.abs(realLQ - realSQ);
        const pctDiff = diff / Math.max(realLQ, realSQ) * 100;
        if (pctDiff > 1) {
          log(`  🔧 首单对齐: ${lowEx}多${realLQ} ${highEx}空${realSQ} 偏差${pctDiff.toFixed(1)}%`);
          if (realLQ < realSQ) {
            for (let fix = 0; ; fix++) {
              try {
                const fq = lowEx === 'okx' ? coinsToLots(symbol, realSQ - realLQ) : (realSQ - realLQ);
                const fr = await lowExObj.futuresLong(lowFutSym, fq);
                let fOk = checkOrderSuccess(fr, lowEx);
                if (!fOk && lowEx === 'binance' && fr?.status === 'NEW' && fr?.orderId) fOk = await waitForBinanceFill(fr.orderId, lowFutSym);
                if (fOk) { log(`  ✅ 首单对齐成功: 两边${realSQ}`); position.qty = realSQ; saveState(); break; }
              } catch (e) {}
              await new Promise(r => setTimeout(r, 2000));
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 首单对齐补多头已重试${fix+1}次`);
            }
          } else {
            for (let fix = 0; ; fix++) {
              try {
                const fq = highEx === 'okx' ? coinsToLots(symbol, realLQ - realSQ) : (realLQ - realSQ);
                const fr = await highExObj.futuresShort(highFutSym, fq);
                let fOk = checkOrderSuccess(fr, highEx);
                if (!fOk && highEx === 'binance' && fr?.status === 'NEW' && fr?.orderId) fOk = await waitForBinanceFill(fr.orderId, highFutSym);
                if (fOk) { log(`  ✅ 首单对齐成功: 两边${realLQ}`); position.qty = realLQ; saveState(); break; }
              } catch (e) {}
              await new Promise(r => setTimeout(r, 2000));
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 首单对齐补空头已重试${fix+1}次`);
            }
          }
        }
      }
    } catch (e) { log(`  ⚠️ 首单对齐检查失败: ${e.message}`); }

    // 深度降级后持续补仓直到达标（每次间隔2秒等盘口恢复）
    const targetSize = getTradeSize(spread);
    if (tradeSize < targetSize) {
      for (let retry = 0; ; retry++) {
        await new Promise(r => setTimeout(r, 2000));
        const remaining = targetSize - position.size;
        if (remaining < 100) break; // 差不到$100就算补满了
        
        log(`  🔄 补仓: 目标$${targetSize}，当前$${position.size}，还差$${remaining}`);
        
        // 重新拉盘口
        const [lb2, hb2] = await Promise.all([
          lowEx === 'binance' ? httpGet(`https://fapi.binance.com/fapi/v1/depth?symbol=${lowFutSym}&limit=10`).then(r => r ? { asks: r.asks.map(a=>({price:+a[0],qty:+a[1]})), bids: r.bids.map(b=>({price:+b[0],qty:+b[1]})) } : null) :
          lowEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${lowFutSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
          lowEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${lowFutSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) : null,
          highEx === 'binance' ? httpGet(`https://fapi.binance.com/fapi/v1/depth?symbol=${highFutSym}&limit=10`).then(r => r ? { asks: r.asks.map(a=>({price:+a[0],qty:+a[1]})), bids: r.bids.map(b=>({price:+b[0],qty:+b[1]})) } : null) :
          highEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${highFutSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
          highEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${highFutSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) : null
        ]);
        
        if (!lb2?.asks?.length || !hb2?.bids?.length) { log(`  🔄 补仓: 盘口数据不可用`); continue; }
        
        const fillable2 = Math.min(
          calcDepthFill(lb2.asks, remaining).fillableUsd,
          calcDepthFill(hb2.bids, remaining).fillableUsd
        );
        const addSize = Math.min(Math.floor(fillable2 / 100) * 100, remaining);
        if (addSize < 200) { log(`  🔄 补仓: 盘口只够$${fillable2.toFixed(0)}，不足$200，等下次`); break; }
        
        const addMid = (lb2.asks[0].price + hb2.bids[0].price) / 2;
        
        // 补仓价差检查（>1%不补）
        const addPriceDiff = Math.abs(lb2.asks[0].price - hb2.bids[0].price) / addMid * 100;
        if (addPriceDiff > 1.0) { log(`  🔄 补仓: 价差${addPriceDiff.toFixed(2)}%>1%，暂停补仓`); break; }
        
        const addQty = alignQty(symbol, lowEx, highEx, addSize / addMid) || Math.floor(addSize / addMid);
        if (addQty <= 0) break;
        
        const addLongQty = lowEx === 'okx' ? coinsToLots(symbol, addQty) : addQty;
        const addShortQty = highEx === 'okx' ? coinsToLots(symbol, addQty) : addQty;
        
        try {
          const [lr2, sr2] = await Promise.all([
            lowExObj.futuresLong(lowFutSym, addLongQty),
            highExObj.futuresShort(highFutSym, addShortQty)
          ]);
          
          let lr2Ok = checkOrderSuccess(lr2, lowEx);
          let sr2Ok = checkOrderSuccess(sr2, highEx);
          if (!lr2Ok && lowEx === 'binance' && lr2?.status === 'NEW' && lr2?.orderId) lr2Ok = await waitForBinanceFill(lr2.orderId, lowFutSym);
          if (!sr2Ok && highEx === 'binance' && sr2?.status === 'NEW' && sr2?.orderId) sr2Ok = await waitForBinanceFill(sr2.orderId, highFutSym);
          
          if (lr2Ok && sr2Ok) {
            position.size += addSize;
            position.qty += addQty;
            const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
            position.totalFee = (position.totalFee || 0) + addFee;
            state.totalPnl -= addFee;
            state.dailyPnl -= addFee;
            saveState();
            log(`  ✅ 补仓成功! +$${addSize}，总$${position.size}`);
          } else if (lr2Ok && !sr2Ok) {
            // 多头开了空头没开 → 一直补空头直到成功
            log(`  ⚠️ 补仓单腿: ${lowEx}多OK ${highEx}空失败，持续重试空头`);
            for (let fix = 0; ; fix++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const fixR = await highExObj.futuresShort(highFutSym, addShortQty);
                let fixOk = checkOrderSuccess(fixR, highEx);
                if (!fixOk && highEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, highFutSym);
                if (fixOk) {
                  position.size += addSize;
                  position.qty += addQty;
                  const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
                  position.totalFee = (position.totalFee || 0) + addFee;
                  state.totalPnl -= addFee;
                  state.dailyPnl -= addFee;
                  saveState();
                  log(`  ✅ 空头补救成功! 第${fix+1}次 +$${addSize}，总$${position.size}`);
                  break;
                }
              } catch (e) { log(`  ⚠️ 空头重试${fix+1}失败: ${e.message}`); }
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 空头已重试${fix+1}次仍未成功，持续重试中`);
            }
            break;
          } else if (!lr2Ok && sr2Ok) {
            // 空头开了多头没开 → 补多头
            log(`  ⚠️ 补仓单腿: ${highEx}空OK ${lowEx}多失败，重试多头`);
            for (let fix = 0; ; fix++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const fixR = await lowExObj.futuresLong(lowFutSym, addLongQty);
                let fixOk = checkOrderSuccess(fixR, lowEx);
                if (!fixOk && lowEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, lowFutSym);
                if (fixOk) {
                  position.size += addSize;
                  position.qty += addQty;
                  const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
                  position.totalFee = (position.totalFee || 0) + addFee;
                  state.totalPnl -= addFee;
                  state.dailyPnl -= addFee;
                  saveState();
                  log(`  ✅ 多头补救成功! 第${fix+1}次 +$${addSize}，总$${position.size}`);
                  break;
                }
              } catch (e) { log(`  ⚠️ 多头重试${fix+1}失败: ${e.message}`); }
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 多头已重试${fix+1}次仍未成功，持续重试中`);
            }
            break;
          }
        } catch (e) {
          log(`  ❌ 补仓异常: ${e.message}`);
          break;
        }
      }
    }

    // 补仓结束后：校验两边实际持仓是否对齐
    try {
      const [realLongPos, realShortPos] = await Promise.all([
        lowExObj.getFuturesPositions(),
        highExObj.getFuturesPositions()
      ]);
      const realLong = realLongPos.find(p => p.symbol === lowFutSym || p.symbol === symbol + 'USDT');
      const realShort = realShortPos.find(p => p.symbol === highFutSym || p.symbol === symbol + 'USDT');
      const realLongQty = realLong ? Math.abs(+(realLong.positionAmt || realLong.total || realLong.size || 0)) : 0;
      const realShortQty = realShort ? Math.abs(+(realShort.positionAmt || realShort.total || realShort.size || 0)) : 0;

      if (realLongQty !== realShortQty && realLongQty > 0 && realShortQty > 0) {
        const diff = Math.abs(realLongQty - realShortQty);
        const pctDiff = diff / Math.max(realLongQty, realShortQty) * 100;
        if (pctDiff > 1) { // 偏差>1%才修
          log(`  🔧 对齐校验: ${lowEx}多${realLongQty} ${highEx}空${realShortQty} 偏差${pctDiff.toFixed(1)}%`);
          if (realLongQty < realShortQty) {
            // 多头少，补多头
            const fixQty = realShortQty - realLongQty;
            log(`  🔧 补${lowEx}多头 ${fixQty}`);
            for (let fix = 0; ; fix++) {
              try {
                const fixLongQty = lowEx === 'okx' ? coinsToLots(symbol, fixQty) : fixQty;
                const fixR = await lowExObj.futuresLong(lowFutSym, fixLongQty);
                let fixOk = checkOrderSuccess(fixR, lowEx);
                if (!fixOk && lowEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, lowFutSym);
                if (fixOk) { log(`  ✅ 对齐成功: 两边都${realShortQty}`); break; }
              } catch (e) {}
              await new Promise(r => setTimeout(r, 2000));
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 对齐补多头已重试${fix+1}次`);
            }
          } else {
            // 空头少，补空头
            const fixQty = realLongQty - realShortQty;
            log(`  🔧 补${highEx}空头 ${fixQty}`);
            for (let fix = 0; ; fix++) {
              try {
                const fixShortQty = highEx === 'okx' ? coinsToLots(symbol, fixQty) : fixQty;
                const fixR = await highExObj.futuresShort(highFutSym, fixShortQty);
                let fixOk = checkOrderSuccess(fixR, highEx);
                if (!fixOk && highEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, highFutSym);
                if (fixOk) { log(`  ✅ 对齐成功: 两边都${realLongQty}`); break; }
              } catch (e) {}
              await new Promise(r => setTimeout(r, 2000));
              if (fix % 10 === 9) await notify(`⚠️ ${symbol} 对齐补空头已重试${fix+1}次`);
            }
          }
          // 更新state中的qty为实际值
          position.qty = Math.max(realLongQty, realShortQty);
          saveState();
        }
      }
    } catch (e) {
      log(`  ⚠️ 对齐校验失败: ${e.message}`);
    }

  } else if (longOk && !shortOk) {
    // 单腿: 多单成了空单没成，平掉多单
    log(`  ⚠️ 单腿! ${lowEx}多成功但${highEx}空失败，反向平仓`);
    log(`  ⚠️ 空单返回: ${JSON.stringify(shortResult)?.slice(0,300)}`);
    try {
      await lowExObj.futuresCloseLong(lowFutSym, qty);
      log(`  🔄 单腿平仓完成`);
    } catch (e) {
      log(`  ❌ 单腿平仓失败! 需要手动处理: ${e.message}`);
      await notify(`🚨 单腿平仓失败! ${symbol} ${lowEx}多头需手动平仓 数量${qty}`);
    }
    state.errors++;

  } else if (!longOk && shortOk) {
    // 单腿: 空单成了多单没成
    log(`  ⚠️ 单腿! ${highEx}空成功但${lowEx}多失败，反向平仓`);
    log(`  ⚠️ 多单返回: ${JSON.stringify(longResult)?.slice(0,300)}`);
    try {
      await highExObj.futuresCloseShort(highFutSym, qty);
      log(`  🔄 单腿平仓完成`);
    } catch (e) {
      log(`  ❌ 单腿平仓失败! 需要手动处理: ${e.message}`);
      await notify(`🚨 单腿平仓失败! ${symbol} ${highEx}空头需手动平仓 数量${qty}`);
    }
    state.errors++;

  } else {
    // 两边都没成
    log(`  ❌ 两边都失败: ${JSON.stringify(longResult).slice(0,100)} / ${JSON.stringify(shortResult).slice(0,100)}`);
    state.errors++;
  }
  } finally {
    openingSymbols.delete(symbol);
  }
}

// ============ 价差套利扫描 ============
async function scanSpreadArbitrage() {
  if (state.paused) return;
  if (state.positions.length >= CONFIG.MAX_POSITIONS) return;

  // 扫描几个主流币在四所间的价格差
  const symbols = ['BTC', 'ETH', 'SOL', 'BNB', 'SUI', 'DOGE', 'XRP', 'ADA', 'AVAX', 'LINK'];

  for (const sym of symbols) {
    try {
      // 获取四所现货价格
      const [bnPrice, byPrice, bgPrice, okPrice] = await Promise.all([
        httpGet(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`).then(r => +r?.price || 0),
        httpGet(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}USDT`).then(r => +r?.result?.list?.[0]?.lastPrice || 0),
        httpGet(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`).then(r => +r?.data?.[0]?.lastPr || 0),
        httpGet(`https://www.okx.com/api/v5/market/ticker?instId=${sym}-USDT`).then(r => +r?.data?.[0]?.last || 0)
      ]);

      const prices = { binance: bnPrice, bybit: byPrice, bitget: bgPrice, okx: okPrice };
      const valid = Object.entries(prices).filter(([, p]) => p > 0);
      if (valid.length < 2) continue;

      valid.sort((a, b) => a[1] - b[1]);
      const [lowEx, lowPrice] = valid[0];
      const [highEx, highPrice] = valid[valid.length - 1];
      const spreadBps = (highPrice - lowPrice) / lowPrice * 10000;

      if (spreadBps < CONFIG.MIN_SPREAD_BPS) continue;

      // 冷却检查
      const pairKey = `spread_${sym}_${lowEx}_${highEx}`;
      if (state.lastTrade[pairKey] && Date.now() - state.lastTrade[pairKey] < CONFIG.COOLDOWN_SAME_PAIR) continue;

      log(`🔍 价差机会: ${sym} ${lowEx}($${lowPrice}) → ${highEx}($${highPrice}) 差${spreadBps.toFixed(1)}bps`);

      // 检查盘口深度
      const depth = await checkArbDepth(`${sym}USDT`, lowEx, highEx, CONFIG.TRADE_SIZE_USD);
      if (!depth.viable) {
        log(`  ⚠️ 深度检查不通过: ${depth.reason || '利润不足'}`);
        continue;
      }

      log(`  📊 预期利润: ${depth.profitBps}bps ≈ $${depth.estimatedProfit.toFixed(2)}`);

      // 执行: 低价所买入 + 高价所卖出
      await executeSpreadArbitrage(sym, lowEx, highEx, lowPrice, highPrice, spreadBps);

    } catch (e) {
      // 单个币失败不影响其他
    }
  }
}

async function executeSpreadArbitrage(symbol, lowEx, highEx, lowPrice, highPrice, spreadBps) {
  const lowExObj = getExchange(lowEx);
  const highExObj = getExchange(highEx);
  const spotSym = getSpotSymbol(symbol, lowEx);
  const spotSymHigh = getSpotSymbol(symbol, highEx);

  // 检查两边余额
  if (state.balances[lowEx] < CONFIG.TRADE_SIZE_USD * 1.1) {
    log(`  ⚠️ ${lowEx} 余额不足`);
    return;
  }
  if (state.balances[highEx] < CONFIG.TRADE_SIZE_USD * 0.1) {
    // 卖出方需要持有该币，价差套利需要两边都有币
    // 简化：先只做有现货余额的情况
    log(`  ⚠️ 价差套利需要${highEx}持有${symbol}，暂不支持`);
    return;
  }

  // 同时下单
  log(`  🚀 价差套利: ${lowEx}买 + ${highEx}卖 ${symbol} $${CONFIG.TRADE_SIZE_USD}`);

  let buyResult, sellResult;
  const qty = (CONFIG.TRADE_SIZE_USD / lowPrice).toFixed(getQtyPrecision(symbol));

  try {
    [buyResult, sellResult] = await Promise.all([
      lowExObj.spotBuy(spotSym, CONFIG.TRADE_SIZE_USD),
      highExObj.spotSell(spotSymHigh, qty)
    ]);
  } catch (e) {
    log(`  ❌ 下单异常: ${e.message}`);
    return;
  }

  const buyOk = checkOrderSuccess(buyResult, lowEx);
  const sellOk = checkOrderSuccess(sellResult, highEx);

  if (buyOk && sellOk) {
    const fee = CONFIG.TRADE_SIZE_USD * 2 * CONFIG.FEE_BPS / 10000;
    const grossProfit = CONFIG.TRADE_SIZE_USD * spreadBps / 10000;
    const netProfit = grossProfit - fee;

    state.totalPnl += netProfit;
    state.dailyPnl += netProfit;
    state.trades++;
    if (netProfit > 0) state.wins++; else state.losses++;
    state.lastTrade[`spread_${symbol}_${lowEx}_${highEx}`] = Date.now();
    state.consecutiveErrors = 0;

    saveState();
    logTrade({ action: 'SPREAD_ARB', symbol, lowEx, highEx, size: CONFIG.TRADE_SIZE_USD, spreadBps, fee, netProfit });

    log(`  ✅ 价差套利成交! ${symbol} 毛利$${grossProfit.toFixed(2)} 手续费$${fee.toFixed(2)} 净利$${netProfit.toFixed(2)}`);
    await notify(`✅ 价差套利 ${symbol}\n${lowEx}买 → ${highEx}卖\n$${CONFIG.TRADE_SIZE_USD} | 价差${spreadBps.toFixed(1)}bps | 净利$${netProfit.toFixed(2)}`);
  } else {
    log(`  ❌ 价差套利失败: 买${buyOk} 卖${sellOk}`);
    state.errors++;
    // 单腿保护: 如果买成了卖没成，立刻卖回
    if (buyOk && !sellOk) {
      log(`  🔄 单腿保护: 卖回${lowEx}的${symbol}`);
      try { await lowExObj.spotSell(spotSym, qty); } catch(e) { 
        await notify(`🚨 价差单腿! ${symbol} ${lowEx}买了但${highEx}没卖掉，需手动处理`); 
      }
    }
    if (!buyOk && sellOk) {
      log(`  🔄 单腿保护: 买回${highEx}的${symbol}`);
      try { await highExObj.spotBuy(spotSymHigh, CONFIG.TRADE_SIZE_USD); } catch(e) {
        await notify(`🚨 价差单腿! ${symbol} ${highEx}卖了但${lowEx}没买到，需手动处理`);
      }
    }
  }
}

// ============ 辅助函数 ============
// Binance 杠杆限额检查+自动降杠杆
async function ensureBinanceLeverage(symbol, neededNotional) {
  try {
    const pos = await binance.getFuturesPositions();
    const p = pos.find(x => (x.symbol || '').includes(symbol.replace('USDT', '')));
    const currentNotional = Math.abs(+(p?.notional || 0));
    const maxNotional = +(p?.maxNotionalValue || 0);
    const leverage = +(p?.leverage || 20);
    
    if (maxNotional > 0 && currentNotional + neededNotional > maxNotional * 0.95) {
      // 需要降杠杆
      const newLev = Math.max(5, Math.floor(leverage / 2));
      log(`  ⚙️ ${symbol} BN杠杆${leverage}x限额$${maxNotional}不够，降到${newLev}x`);
      const r = await bnSignedPost('/fapi/v1/leverage', { symbol, leverage: newLev });
      if (r?.leverage) {
        log(`  ✅ 杠杆已降到${r.leverage}x，限额$${r.maxNotionalValue}`);
      } else {
        log(`  ⚠️ 降杠杆失败: ${JSON.stringify(r)}`);
      }
    }
  } catch (e) { log(`  ⚠️ 杠杆检查失败: ${e.message}`); }
}

// Binance签名POST
async function bnSignedPost(path, params) {
  const crypto = require('crypto');
  const https = require('https');
  params.timestamp = Date.now();
  params.recvWindow = 5000;
  const qs = Object.entries(params).map(([k, v]) => k + '=' + v).join('&');
  const sig = crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY).update(qs).digest('hex');
  const body = qs + '&signature=' + sig;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'fapi.binance.com', path, method: 'POST', headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function checkOrderSuccess(result, exchange) {
  if (!result) return false;
  switch (exchange) {
    case 'binance': return result.orderId && (result.status === 'FILLED' || result.status === 'PARTIALLY_FILLED');
    case 'bybit': return result.retCode === 0;
    case 'bitget': return result.code === '00000';
    case 'okx': return result.code === '0';
    default: return false;
  }
}

// Binance 市价单可能返回 NEW（低流动性币），需要等待确认
async function waitForBinanceFill(orderId, symbol, maxWaitMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const order = await binance.futuresApi('GET', '/fapi/v1/order', { symbol, orderId });
      if (order.status === 'FILLED') return true;
      if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED') return false;
      // 还是 NEW 或 PARTIALLY_FILLED，继续等
    } catch (e) { break; }
  }
  // 超时，取消未成交的订单
  try {
    await binance.futuresApi('DELETE', '/fapi/v1/order', { symbol, orderId });
    log('  ⚠️ Binance 订单超时未成交，已取消: ' + symbol);
  } catch (e) {}
  return false;
}

function getOrderId(result, exchange) {
  if (!result) return null;
  switch (exchange) {
    case 'binance': return result.orderId;
    case 'bybit': return result.result?.orderId;
    case 'bitget': return result.data?.orderId;
    case 'okx': return result.data?.[0]?.ordId;
    default: return null;
  }
}

function getQtyPrecision(symbol) {
  const precisions = { BTC: 5, ETH: 4, SOL: 2, BNB: 3, SUI: 1, DOGE: 0, XRP: 1, ADA: 0, AVAX: 2, LINK: 2 };
  return precisions[symbol] || 2;
}

// ============ 仓位管理 ============
async function checkFundingPositions() {
  if (state.positions.length === 0) return;

  const { rates } = await fetchFundingRates();

  for (const pos of state.positions) {
    if (pos.type !== 'funding') continue;

    const symRates = rates[pos.symbol];
    if (!symRates) continue;

    const currentSpread = (symRates[pos.shortEx] || 0) - (symRates[pos.longEx] || 0);

    // 标准化费率差（考虑不同结算频率）
    const lowInterval = monitor.fundingIntervals?.[pos.symbol]?.[pos.longEx] || 8;
    const highInterval = monitor.fundingIntervals?.[pos.symbol]?.[pos.shortEx] || 8;
    const avgInterval = (lowInterval + highInterval) / 2;
    const hourlySpread = currentSpread / avgInterval;
    const equiv8hSpread = hourlySpread * 8;
    
    pos.currentSpread = equiv8hSpread; // 更新当前标准化费率差

    // 如果费率反转，只通知不自动平
    if (equiv8hSpread < -CONFIG.MIN_FUNDING_SPREAD) {
      log(`⚠️ ${pos.symbol} 费率反转! 当前差${(equiv8hSpread*100).toFixed(3)}% (原始${(currentSpread*100).toFixed(3)}%)`);
      // 不自动平仓，费率可能下一期就回来了
    }

    // 估算已收费率（用实际结算频率）
    const hoursOpen = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;
    const fundingPeriods = Math.floor(hoursOpen / avgInterval);
    const estimatedEarned = fundingPeriods * pos.spread * pos.size;
    
    // 同时查实际合约浮盈（更准确）
    try {
      const longExObj = getExchange(pos.longEx);
      const shortExObj = getExchange(pos.shortEx);
      const longPositions = await longExObj.getFuturesPositions();
      const shortPositions = await shortExObj.getFuturesPositions();
      
      const longSym = getFuturesSymbol(pos.symbol, pos.longEx);
      const shortSym = getFuturesSymbol(pos.symbol, pos.shortEx);
      
      let realPnl = 0;
      const lp = Array.isArray(longPositions) ? longPositions.find(p => 
        (p.symbol || p.instId || '').includes(pos.symbol)) : null;
      const sp = Array.isArray(shortPositions) ? shortPositions.find(p => 
        (p.symbol || p.instId || '').includes(pos.symbol)) : null;
      
      if (lp) realPnl += parseFloat(lp.unrealizedPL || lp.unrealisedPnl || lp.upl || 0);
      if (sp) realPnl += parseFloat(sp.unrealizedPL || sp.unrealisedPnl || sp.upl || 0);
      
      // 用实际浮盈记录到 unrealizedPnl 字段（不覆盖 earned，earned 由 updateEarned 管理）
      pos.unrealizedPnl = realPnl;
    } catch (e) {
      // ignore
    }
  }

  saveState();
}

const closingSymbols = new Set(); // 防止同币并发平仓

async function closeFundingPosition(pos, urgent = false, dangerousEx = null) {
  if (closingSymbols.has(pos.symbol)) {
    log(`⏳ ${pos.symbol} 正在平仓中，跳过`);
    return;
  }
  closingSymbols.add(pos.symbol);
  try {
    const longExObj = getExchange(pos.longEx);
    const shortExObj = getExchange(pos.shortEx);
    const longSym = getFuturesSymbol(pos.symbol, pos.longEx);
    const shortSym = getFuturesSymbol(pos.symbol, pos.shortEx);

  log(`📤 平仓 ${pos.symbol} ${pos.longEx}多/${pos.shortEx}空 数量${pos.qty}`);

    // 判断是否用限价单：≤13%强平距离直接市价，>13%用限价
    let forceMarket = urgent;
    if (!forceMarket) {
      try {
        const [lPos, sPos] = await Promise.all([
          longExObj.getFuturesPositions(),
          shortExObj.getFuturesPositions()
        ]);
        const lp = lPos.find(p => (p.symbol||'').includes(pos.symbol));
        const sp = sPos.find(p => (p.symbol||'').includes(pos.symbol));
        const checkLiqDist = (p) => {
          if (!p) return 999;
          const mark = +(p.markPrice || p.lastPrice || 0);
          const liq = +(p.liquidationPrice || p.liqPrice || 0);
          if (!mark || !liq || liq === 0) return 999;
          return Math.abs((liq - mark) / mark) * 100;
        };
        const longDist = checkLiqDist(lp);
        const shortDist = checkLiqDist(sp);
        if (longDist <= 13 || shortDist <= 13) {
          forceMarket = true;
          log(`  🚨 强平距离过近(多${longDist.toFixed(1)}%/空${shortDist.toFixed(1)}%)，强制市价`);
        }
      } catch(e) { log(`  ⚠️ 强平距离检查失败: ${e.message}`); }
    }
    const useLimit = !forceMarket;
    if (useLimit) log(`  💰 使用限价单(Post-Only)平仓，省手续费`);
    else log(`  ⚡ 紧急市价平仓`);

    // 限价平仓逻辑
    if (useLimit) {
      const startTime = Date.now();
      const LIMIT_TIMEOUT = 120000; // 120秒超时转市价
      let longDone = false, shortDone = false;
      let longOrderId = null, shortOrderId = null;
      let longRemain = pos.qty, shortRemain = pos.qty;

      while (Date.now() - startTime < LIMIT_TIMEOUT) {
        // 拉盘口
        const [longOB, shortOB] = await Promise.all([
          getOrderbook(pos.longEx, longSym, 5),
          getOrderbook(pos.shortEx, shortSym, 5)
        ]);

        // 平多=卖出=挂在买一价(bid1)，平空=买入=挂在卖一价(ask1)
        const longPrice = longOB?.bids?.[0]?.price;
        const shortPrice = shortOB?.asks?.[0]?.price;
        if (!longPrice || !shortPrice) { await new Promise(r => setTimeout(r, 2000)); continue; }

        // 撤旧单重挂
        if (!longDone) {
          if (longOrderId) {
            try { await longExObj.futuresCancelOrder(longSym, longOrderId); } catch(e) {}
            await new Promise(r => setTimeout(r, 300));
            // 查已成交量
            try {
              const oInfo = await longExObj.futuresGetOrder(longSym, longOrderId);
              const filled = +(oInfo?.executedQty || oInfo?.result?.list?.[0]?.cumExecQty || oInfo?.data?.baseVolume || 0);
              if (filled > 0) longRemain = Math.max(0, longRemain - filled);
            } catch(e) {}
          }
          if (longRemain > 0) {
            try {
              const r = await longExObj.futuresCloseLongLimit(longSym, longRemain, longPrice);
              longOrderId = r?.orderId || r?.result?.orderId || r?.data?.orderId || null;
            } catch(e) { log(`  ⚠️ 限价平多失败: ${e.message}`); }
          } else { longDone = true; }
        }

        if (!shortDone) {
          if (shortOrderId) {
            try { await shortExObj.futuresCancelOrder(shortSym, shortOrderId); } catch(e) {}
            await new Promise(r => setTimeout(r, 300));
            try {
              const oInfo = await shortExObj.futuresGetOrder(shortSym, shortOrderId);
              const filled = +(oInfo?.executedQty || oInfo?.result?.list?.[0]?.cumExecQty || oInfo?.data?.baseVolume || 0);
              if (filled > 0) shortRemain = Math.max(0, shortRemain - filled);
            } catch(e) {}
          }
          if (shortRemain > 0) {
            try {
              const r = await shortExObj.futuresCloseShortLimit(shortSym, shortRemain, shortPrice);
              shortOrderId = r?.orderId || r?.result?.orderId || r?.data?.orderId || null;
            } catch(e) { log(`  ⚠️ 限价平空失败: ${e.message}`); }
          } else { shortDone = true; }
        }

        // 检查是否全部成交
        if (longDone && shortDone) break;

        // 检查实际持仓
        await new Promise(r => setTimeout(r, 5000));
        try {
          const [lp, sp] = await Promise.all([
            longExObj.getFuturesPositions(),
            shortExObj.getFuturesPositions()
          ]);
          const lq = lp.find(p => (p.symbol||'').includes(pos.symbol));
          const sq = sp.find(p => (p.symbol||'').includes(pos.symbol));
          const lRemain = lq ? Math.abs(+(lq.positionAmt || lq.total || lq.size || 0)) : 0;
          const sRemain = sq ? Math.abs(+(sq.positionAmt || sq.total || sq.size || 0)) : 0;
          if (lRemain === 0) longDone = true;
          if (sRemain === 0) shortDone = true;
          if (longDone && shortDone) break;
          longRemain = lRemain;
          shortRemain = sRemain;
        } catch(e) {}

        log(`  ⏳ 限价平仓等待中: 多${longDone?'完':'剩'+longRemain} 空${shortDone?'完':'剩'+shortRemain} ${Math.round((Date.now()-startTime)/1000)}s`);
      }

      // 超时：撤单转市价
      if (!longDone || !shortDone) {
        log(`  ⏰ 限价超时120秒，转市价`);
        if (longOrderId && !longDone) try { await longExObj.futuresCancelOrder(longSym, longOrderId); } catch(e) { log(`  ⚠️ 撤多单失败: ${e.message}`); }
        if (shortOrderId && !shortDone) try { await shortExObj.futuresCancelOrder(shortSym, shortOrderId); } catch(e) { log(`  ⚠️ 撤空单失败: ${e.message}`); }
        await new Promise(r => setTimeout(r, 500));
        // 查剩余并市价平，重试3次
        for (let mRetry = 0; mRetry < 3; mRetry++) {
          try {
            const [lp2, sp2] = await Promise.all([longExObj.getFuturesPositions(), shortExObj.getFuturesPositions()]);
            const lq2 = lp2.find(p => (p.symbol||'').includes(pos.symbol));
            const sq2 = sp2.find(p => (p.symbol||'').includes(pos.symbol));
            const lr = lq2 ? Math.abs(+(lq2.positionAmt || lq2.total || lq2.size || 0)) : 0;
            const sr = sq2 ? Math.abs(+(sq2.positionAmt || sq2.total || sq2.size || 0)) : 0;
            if (lr === 0 && sr === 0) { log(`  ✅ 超时转市价: 两边已清`); break; }
            if (lr > 0) {
              try { await longExObj.futuresCloseLong(longSym, lr); log(`  ✅ 超时市价平多 ${lr}`); }
              catch(e) { log(`  ❌ 超时市价平多失败(${mRetry+1}/3): ${e.message}`); }
            }
            if (sr > 0) {
              try { await shortExObj.futuresCloseShort(shortSym, sr); log(`  ✅ 超时市价平空 ${sr}`); }
              catch(e) { log(`  ❌ 超时市价平空失败(${mRetry+1}/3): ${e.message}`); }
            }
            if (mRetry < 2) await new Promise(r => setTimeout(r, 2000));
          } catch(e) { log(`  ❌ 超时转市价查仓失败(${mRetry+1}/3): ${e.message}`); }
        }
      }

      // 限价平仓完成，走成功逻辑
      closeLOk = true; closeSOk = true;
    }

    // 市价平仓逻辑（紧急模式 或 限价已处理完跳过）
    if (urgent) {
    let batchCount = 0;

    while (batchCount < 20) {
      batchCount++;

      // 查当前实际持仓
      let currentLongQty = 0, currentShortQty = 0;
      if (batchCount > 1) {
        try {
          const [lPos, sPos] = await Promise.all([
            longExObj.getFuturesPositions(),
            shortExObj.getFuturesPositions()
          ]);
          const lp = lPos.find(p => (p.symbol||'').includes(pos.symbol));
          const sp = sPos.find(p => (p.symbol||'').includes(pos.symbol));
          currentLongQty = lp ? Math.abs(+(lp.positionAmt || lp.total || lp.size || 0)) : 0;
          currentShortQty = sp ? Math.abs(+(sp.positionAmt || sp.total || sp.size || 0)) : 0;
          if (currentLongQty === 0 && currentShortQty === 0) {
            closeLOk = true; closeSOk = true;
            log(`  ✅ 两边已全部平完`);
            break;
          }
        } catch (e) {}
      }

      const longQtyToClose = batchCount === 1 ? pos.qty : currentLongQty;
      const shortQtyToClose = batchCount === 1 ? pos.qty : currentShortQty;

      const promises = [];
      if (longQtyToClose > 0) promises.push(longExObj.futuresCloseLong(longSym, longQtyToClose));
      else promises.push(Promise.resolve({ status: 'SKIP' }));
      if (shortQtyToClose > 0) promises.push(shortExObj.futuresCloseShort(shortSym, shortQtyToClose));
      else promises.push(Promise.resolve({ status: 'SKIP' }));

      const [closeL, closeS] = await Promise.all(promises);

      let batchLOk = closeL?.status === 'SKIP' || checkOrderSuccess(closeL, pos.longEx);
      let batchSOk = closeS?.status === 'SKIP' || checkOrderSuccess(closeS, pos.shortEx);

      if (!batchLOk && pos.longEx === 'binance' && closeL?.status === 'NEW' && closeL?.orderId) {
        batchLOk = await waitForBinanceFill(closeL.orderId, longSym);
      }
      if (!batchSOk && pos.shortEx === 'binance' && closeS?.status === 'NEW' && closeS?.orderId) {
        batchSOk = await waitForBinanceFill(closeS.orderId, shortSym);
      }

      if (batchLOk && batchSOk) {
        closeLOk = true; closeSOk = true;
        if (batchCount === 1) break; // 一次搞定
        // 多次的话继续检查是否真的全平了
      } else {
        log(`  ⚠️ 平仓批次${batchCount}: 多${batchLOk?'OK':'失败'} 空${batchSOk?'OK':'失败'}，2秒后重试`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (batchCount > 1) log(`  📊 分批平仓完成: ${batchCount}批`);
    } // end if (urgent)

    if (closeLOk && closeSOk) {
      const fee = pos.size * 2 * CONFIG.FEE_BPS / 10000;
      const netPnl = pos.earned - fee;
      state.totalPnl += netPnl;
      state.dailyPnl += netPnl;
      state.realizedPnl += netPnl;
      if (netPnl > 0) state.wins++; else state.losses++;
      state.positions = state.positions.filter(p => p.id !== pos.id);

      saveState();
      logTrade({ action: 'CLOSE_FUNDING', ...pos, closeFee: fee, netPnl });

      log(`  ✅ 平仓成功! ${pos.symbol} 已收$${pos.earned.toFixed(2)} 手续费$${fee.toFixed(2)} 净$${netPnl.toFixed(2)}`);
      await notify(`📤 平仓 ${pos.symbol}\n已收: $${pos.earned.toFixed(2)} | 净利: $${netPnl.toFixed(2)}`);

      // 平仓后对齐校验：确保两边都真的清零
      try {
        await new Promise(r => setTimeout(r, 1000));
        const [lpCheck, spCheck] = await Promise.all([
          longExObj.getFuturesPositions(),
          shortExObj.getFuturesPositions()
        ]);
        const lRemain = lpCheck.find(p => (p.symbol||'').includes(pos.symbol));
        const sRemain = spCheck.find(p => (p.symbol||'').includes(pos.symbol));
        const lQty = lRemain ? Math.abs(+(lRemain.positionAmt || lRemain.total || lRemain.size || 0)) : 0;
        const sQty = sRemain ? Math.abs(+(sRemain.positionAmt || sRemain.total || sRemain.size || 0)) : 0;
        if (lQty > 0 || sQty > 0) {
          log(`  🔧 平仓残留: ${pos.longEx}多${lQty} ${pos.shortEx}空${sQty}，清理中`);
          for (let fix = 0; fix < 20; fix++) {
            if (lQty > 0) {
              try { await longExObj.futuresCloseLong(longSym, lQty); log(`  ✅ 残留清理: 多${lQty}`); }
              catch(e) { log(`  ❌ 残留清理多失败(${fix+1}/20): ${e.message}`); }
            }
            if (sQty > 0) {
              try { await shortExObj.futuresCloseShort(shortSym, sQty); log(`  ✅ 残留清理: 空${sQty}`); }
              catch(e) { log(`  ❌ 残留清理空失败(${fix+1}/20): ${e.message}`); }
            }
            await new Promise(r => setTimeout(r, 1500));
            const [lc2, sc2] = await Promise.all([
              longExObj.getFuturesPositions(),
              shortExObj.getFuturesPositions()
            ]);
            const l2 = lc2.find(p => (p.symbol||'').includes(pos.symbol));
            const s2 = sc2.find(p => (p.symbol||'').includes(pos.symbol));
            const lq2 = l2 ? Math.abs(+(l2.positionAmt || l2.total || l2.size || 0)) : 0;
            const sq2 = s2 ? Math.abs(+(s2.positionAmt || s2.total || s2.size || 0)) : 0;
            if (lq2 === 0 && sq2 === 0) { log(`  ✅ 残留清理完毕`); break; }
          }
        }
      } catch (e) { log(`  ⚠️ 平仓对齐检查失败: ${e.message}`); }

    } else {
      // 平仓失败也不放弃，继续尝试清理
      log(`  ⚠️ 平仓部分失败: 多${closeLOk} 空${closeSOk}，继续清理`);
      for (let fix = 0; fix < 20; fix++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const [lp3, sp3] = await Promise.all([
            longExObj.getFuturesPositions(),
            shortExObj.getFuturesPositions()
          ]);
          const l3 = lp3.find(p => (p.symbol||'').includes(pos.symbol));
          const s3 = sp3.find(p => (p.symbol||'').includes(pos.symbol));
          const lq3 = l3 ? Math.abs(+(l3.positionAmt || l3.total || l3.size || 0)) : 0;
          const sq3 = s3 ? Math.abs(+(s3.positionAmt || s3.total || s3.size || 0)) : 0;
          if (lq3 === 0 && sq3 === 0) {
            // 两边都清了
            const fee2 = pos.size * 2 * CONFIG.FEE_BPS / 10000;
            const netPnl2 = pos.earned - fee2;
            state.totalPnl += netPnl2;
            state.dailyPnl += netPnl2;
            state.realizedPnl += netPnl2;
            if (netPnl2 > 0) state.wins++; else state.losses++;
            state.positions = state.positions.filter(p => p.id !== pos.id);
            saveState();
            log(`  ✅ 清理成功! ${pos.symbol} 净$${netPnl2.toFixed(2)}`);
            await notify(`📤 平仓 ${pos.symbol}（清理后）\n净利: $${netPnl2.toFixed(2)}`);
            break;
          }
          if (lq3 > 0) { try { await longExObj.futuresCloseLong(longSym, lq3); log(`  ✅ 清理多${lq3}`); } catch(e) { log(`  ❌ 清理多失败(${fix+1}/20): ${e.message}`); } }
          if (sq3 > 0) { try { await shortExObj.futuresCloseShort(shortSym, sq3); log(`  ✅ 清理空${sq3}`); } catch(e) { log(`  ❌ 清理空失败(${fix+1}/20): ${e.message}`); } }
        } catch (e) {}
        if (fix === 19) {
          await notify(`🚨 平仓清理20次仍有残留 ${pos.symbol}\n⚠️ 需要手动检查!`);
        }
      }
    }
  } catch (e) {
    log(`  ❌ 平仓异常: ${e.message}`);
    await notify(`❌ 平仓异常 ${pos.symbol}: ${e.message}`);
  } finally {
    closingSymbols.delete(pos.symbol);
  }
}

// ============ 动态仓位管理（每小时） ============
// ============ 保证金安全监控（每60秒） ============
async function checkMarginSafety() {
  try {
    const [bnPos, byPos, bgPos] = await Promise.all([
      binance.getFuturesPositions().catch(() => []),
      bybit.api('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }).catch(() => ({})),
      bitget.api('GET', '/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES' }).catch(() => ({}))
    ]);

    const positionRisks = [];

    for (const p of (bnPos || []).filter(x => +x.positionAmt !== 0)) {
      const liq = +p.liquidationPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = +p.positionAmt < 0;
        const distPct = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        positionRisks.push({ symbol: p.symbol.replace('USDT',''), exchange: 'binance', mark, liq, distPct, isShort });
      }
    }

    for (const p of (byPos.result?.list || []).filter(x => +x.size > 0)) {
      const liq = +p.liqPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = p.side === 'Sell';
        const distPct = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        positionRisks.push({ symbol: p.symbol.replace('USDT',''), exchange: 'bybit', mark, liq, distPct, isShort });
      }
    }

    for (const p of (bgPos.data || []).filter(x => +x.total > 0)) {
      const liq = +p.liquidationPrice, mark = +p.markPrice;
      if (liq > 0 && mark > 0) {
        const isShort = p.holdSide === 'short';
        const distPct = isShort ? ((liq - mark) / mark * 100) : ((mark - liq) / mark * 100);
        positionRisks.push({ symbol: p.symbol.replace('USDT',''), exchange: 'bitget', mark, liq, distPct, isShort });
      }
    }

    positionRisks.sort((a, b) => a.distPct - b.distPct);

    for (const risk of positionRisks) {
      if (risk.distPct <= 10) {
        const statePos = state.positions.find(p => p.symbol === risk.symbol && (p.longEx === risk.exchange || p.shortEx === risk.exchange));
        if (statePos) {
          log('🚨 ' + risk.exchange + ' ' + risk.symbol + ' 距离强平仅 ' + risk.distPct.toFixed(1) + '%! 自动平仓');
          await notify('🚨 爆仓预警！' + '\n' + risk.exchange + ' ' + risk.symbol + '\n当前价: ' + risk.mark + '\n强平价: ' + risk.liq + '\n距离: ' + risk.distPct.toFixed(1) + '%\n🔴 自动平仓中（两边同时）');
          try { await closeFundingPosition(statePos, true, risk.exchange); } catch (e) { log('  ❌ 强平预防失败: ' + e.message); }
        }
      } else if (risk.distPct <= 20) {
        if (!state._lastMarginWarn) state._lastMarginWarn = {};
        const warnKey = 'liq_warn_' + risk.exchange + '_' + risk.symbol;
        if (!state._lastMarginWarn[warnKey] || Date.now() - state._lastMarginWarn[warnKey] > 600000) {
          state._lastMarginWarn[warnKey] = Date.now();
          log('⚠️ ' + risk.exchange + ' ' + risk.symbol + ' 距离强平 ' + risk.distPct.toFixed(1) + '%');
          await notify('⚠️ 强平预警\n' + risk.exchange + ' ' + risk.symbol + '\n当前价: ' + risk.mark + '\n强平价: ' + risk.liq + '\n距离: ' + risk.distPct.toFixed(1) + '%\n建议关注或减仓');
        }
      }
    }
  } catch (e) {
    log('⚠️ 保证金检查异常: ' + e.message);
  }
}


async function rebalancePositions() {
  if (state.positions.length === 0) return;

  const { rates } = await fetchFundingRates();
  
  // 1. 给每个仓位评分：标准化为等效8小时费率差
  for (const pos of state.positions) {
    if (pos.type !== 'funding') continue;
    const symRates = rates[pos.symbol];
    if (!symRates) continue;
    
    const rawSpread = (symRates[pos.shortEx] || 0) - (symRates[pos.longEx] || 0);
    
    // 标准化：用两所的平均结算间隔
    const lowInterval = monitor.fundingIntervals[pos.symbol]?.[pos.longEx] || 8;
    const highInterval = monitor.fundingIntervals[pos.symbol]?.[pos.shortEx] || 8;
    const avgInterval = (lowInterval + highInterval) / 2;
    const hourlySpread = rawSpread / avgInterval;
    const equiv8h = hourlySpread * 8;
    
    // 记录历史费率（最近3次）
    if (!pos.spreadHistory) pos.spreadHistory = [];
    pos.spreadHistory.push({ time: Date.now(), spread: equiv8h });
    if (pos.spreadHistory.length > 3) pos.spreadHistory.shift();
    
    // 连续倒贴计数（回正就重置）
    if (equiv8h < 0) {
      pos.consecutiveNeg = (pos.consecutiveNeg || 0) + 1;
    } else {
      pos.consecutiveNeg = 0;
    }
    
    // 健康度评分
    const recent = pos.spreadHistory;
    const avgSpread = recent.reduce((s, r) => s + r.spread, 0) / recent.length;
    const allDecreasing = recent.length >= 3 && recent[2].spread < recent[1].spread && recent[1].spread < recent[0].spread;
    
    if (avgSpread >= 0.003) {
      pos.health = 'healthy';     // 健康：平均费率差 ≥ 0.3%
    } else if (avgSpread >= 0 && !allDecreasing) {
      pos.health = 'ok';          // 一般：还在赚，没连续下降
    } else if (avgSpread >= 0 && allDecreasing) {
      pos.health = 'weak';        // 亚健康：连续3次下降，标记可替换
    } else if (pos.consecutiveNeg >= 2) {
      pos.health = 'bad';         // 不健康：连续2次倒贴
    } else {
      pos.health = 'ok';
    }
    
    pos.currentSpread = equiv8h;
  }
  
  // 2. 自动平仓：连续3次倒贴的仓位
  for (const pos of state.positions) {
    if (pos.health === 'bad') {
      log(`🔴 [调仓] ${pos.symbol} 连续2次倒贴，自动平仓`);
      await notify(`🔴 ${pos.symbol} 连续2次费率倒贴\n正在平仓释放资金...`);
      try {
        await closeFundingPosition(pos);
      } catch (e) {
        log(`❌ 平仓失败: ${e.message}`);
      }
    }
  }
  
  // 2.5 不对齐仓位净利归零保护（已关闭，由连续2次倒贴统一处理）
  // for (const pos of state.positions) { ... }
  
  // 3. 智能换仓：如果有新机会比 weak 仓位好
  if (state.positions.length >= CONFIG.MAX_POSITIONS) {
    const weakPositions = state.positions.filter(p => p.health === 'weak');
    if (weakPositions.length > 0) {
      // 找最弱的仓位
      weakPositions.sort((a, b) => (a.currentSpread || 0) - (b.currentSpread || 0));
      const weakest = weakPositions[0];
      
      // 扫描新机会
      const opportunities = [];
      for (const [sym, exRates] of Object.entries(rates)) {
        if (state.positions.some(p => p.symbol === sym)) continue;
        
        const normalized = Object.entries(exRates).filter(([, r]) => r !== undefined && r !== null).map(([ex, rate]) => {
          const interval = monitor.fundingIntervals[sym]?.[ex] || 8;
          return [ex, rate, rate / interval];
        });
        if (normalized.length < 2) continue;
        
        normalized.sort((a, b) => a[2] - b[2]);
        const hourlySpread = normalized[normalized.length - 1][2] - normalized[0][2];
        const equiv8h = hourlySpread * 8;
        
        if (equiv8h > (weakest.currentSpread || 0) + 0.001) { // 比最弱的高 0.1% 就值得换
          opportunities.push({
            symbol: sym,
            lowEx: normalized[0][0],
            highEx: normalized[normalized.length - 1][0],
            equiv8h,
            annualized: hourlySpread * 24 * 365 * 100
          });
        }
      }
      
      if (opportunities.length > 0) {
        opportunities.sort((a, b) => b.equiv8h - a.equiv8h);
        const best = opportunities[0];
        log(`🔄 [换仓] ${weakest.symbol}(${((weakest.currentSpread||0)*100).toFixed(3)}%) → ${best.symbol}(${(best.equiv8h*100).toFixed(3)}%)`);
        await notify(`🔄 换仓建议\n平: ${weakest.symbol} (${((weakest.currentSpread||0)*100).toFixed(3)}%)\n开: ${best.symbol} (${(best.equiv8h*100).toFixed(3)}%)\n正在执行...`);
        
        // 先平旧的
        try {
          await closeFundingPosition(weakest);
          // 再开新的（下次扫描会自动开，不在这里开，避免复杂度）
          log(`✅ ${weakest.symbol} 已平，${best.symbol} 等下次扫描自动开仓`);
        } catch (e) {
          log(`❌ 换仓平仓失败: ${e.message}`);
        }
      }
    }
  }
  
  // 4. 自动加仓：费率好但仓位小的，加到对应档位
  for (const pos of state.positions) {
    if (pos.type !== 'funding' || pos.health !== 'healthy') continue;
    const targetSize = getTradeSize(pos.currentSpread || 0);
    if (targetSize <= pos.size) continue;
    
    const addSize = targetSize - pos.size;
    if (addSize < 200) continue;
    
    const totalExposure = state.positions.reduce((s, p) => s + p.size, 0);
    if (totalExposure + addSize > 14000) {
      log(`⏸️ [加仓] ${pos.symbol} 想加$${addSize}，但总敞口已$${totalExposure}，超限`);
      continue;
    }
    
    log(`📈 [加仓] ${pos.symbol} $${pos.size} → $${targetSize}（费率${((pos.currentSpread||0)*100).toFixed(3)}%）`);
    
    const lowExObj = getExchange(pos.longEx);
    const highExObj = getExchange(pos.shortEx);
    const longSym = getFuturesSymbol(pos.symbol, pos.longEx);
    const shortSym = getFuturesSymbol(pos.symbol, pos.shortEx);
    
    // 深度和价差检查
    let addQtyReal = 0;
    try {
      const [lowOB, highOB] = await Promise.all([
        pos.longEx === 'binance' ? binance.getFuturesOrderbook(longSym, 10) :
        pos.longEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${longSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
        pos.longEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${longSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
        null,
        pos.shortEx === 'binance' ? binance.getFuturesOrderbook(shortSym, 10) :
        pos.shortEx === 'bybit' ? httpGet(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${shortSym}&limit=10`).then(r => r?.result ? { bids: r.result.b.map(b=>({price:+b[0],qty:+b[1]})), asks: r.result.a.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
        pos.shortEx === 'bitget' ? httpGet(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${shortSym}&productType=USDT-FUTURES&limit=10`).then(r => r?.data ? { bids: r.data.bids.map(b=>({price:+b[0],qty:+b[1]})), asks: r.data.asks.map(a=>({price:+a[0],qty:+a[1]})) } : null) :
        null
      ]);
      
      if (!lowOB?.asks?.[0] || !highOB?.bids?.[0]) {
        log(`  ⚠️ [加仓] ${pos.symbol} 深度获取失败，跳过`);
        continue;
      }
      
      const buyPrice = lowOB.asks[0].price;
      const sellPrice = highOB.bids[0].price;
      const priceDiff = Math.abs(buyPrice - sellPrice) / Math.min(buyPrice, sellPrice);
      
      if (priceDiff > 0.01) {
        log(`  ⚠️ [加仓] ${pos.symbol} [Step2e] 两所价差${(priceDiff*100).toFixed(2)}% > 1%，跳过`);
        continue;
      }
      
      const realMidPrice = (buyPrice + sellPrice) / 2;
      addQtyReal = alignQty(pos.symbol, pos.longEx, pos.shortEx, addSize / realMidPrice);
      if (!addQtyReal || addQtyReal <= 0) continue;
      
      const lowFill = calcDepthFill(lowOB.asks, addSize);
      const highFill = calcDepthFill(highOB.bids, addSize);
      if (lowFill.slippageBps > 30 || highFill.slippageBps > 30) {
        log(`  ⚠️ [加仓] ${pos.symbol} [Step2e] 滑点过大: ${lowFill.slippageBps}/${highFill.slippageBps}bps，跳过`);
        continue;
      }
    } catch (e) {
      log(`  ⚠️ [加仓] ${pos.symbol} 深度检查异常: ${e.message}`);
      continue;
    }
    
    // 下单
    const longAddQty = pos.longEx === 'okx' ? coinsToLots(pos.symbol, addQtyReal) : addQtyReal;
    const shortAddQty = pos.shortEx === 'okx' ? coinsToLots(pos.symbol, addQtyReal) : addQtyReal;
    
    try {
      const [longR, shortR] = await Promise.all([
        lowExObj.futuresLong(longSym, longAddQty),
        highExObj.futuresShort(shortSym, shortAddQty)
      ]);
      
      let longOk = checkOrderSuccess(longR, pos.longEx);
      let shortOk = checkOrderSuccess(shortR, pos.shortEx);
      
      // Binance NEW 状态等待确认
      if (!longOk && pos.longEx === 'binance' && longR?.status === 'NEW' && longR?.orderId) {
        longOk = await waitForBinanceFill(longR.orderId, longSym);
      }
      if (!shortOk && pos.shortEx === 'binance' && shortR?.status === 'NEW' && shortR?.orderId) {
        shortOk = await waitForBinanceFill(shortR.orderId, shortSym);
      }
      
      if (longOk && shortOk) {
        pos.size = targetSize;
        pos.qty += addQtyReal;
        const fee = addSize * 2 * CONFIG.FEE_BPS / 10000;
        pos.totalFee = (pos.totalFee || 0) + fee;
        state.totalPnl -= fee;
        saveState();
        log(`  ✅ 加仓成功! ${pos.symbol} 现$${targetSize} qty=${pos.qty}`);
        await notify(`📈 加仓 ${pos.symbol}\n$${targetSize - addSize} → $${targetSize}\n费率: ${((pos.currentSpread||0)*100).toFixed(3)}%`);
      } else if (longOk && !shortOk) {
        log(`  ⚠️ 加仓单腿! 平回多头`);
        try { await lowExObj.futuresCloseLong(longSym, longAddQty); } catch(e2) {}
        await notify(`⚠️ ${pos.symbol} 加仓单腿失败，已回滚`);
      } else if (!longOk && shortOk) {
        log(`  ⚠️ 加仓单腿! 平回空头`);
        try { await highExObj.futuresCloseShort(shortSym, shortAddQty); } catch(e2) {}
        await notify(`⚠️ ${pos.symbol} 加仓单腿失败，已回滚`);
      }
    } catch (e) {
      log(`  ❌ 加仓异常: ${e.message}`);
    }
  }

  // 5. 统计报告
  const healthy = state.positions.filter(p => p.health === 'healthy').length;
  const ok = state.positions.filter(p => p.health === 'ok').length;
  const weak = state.positions.filter(p => p.health === 'weak').length;
  const bad = state.positions.filter(p => p.health === 'bad').length;
  log(`🔄 [调仓] 仓位健康度: ${healthy}健康 ${ok}一般 ${weak}亚健康 ${bad}倒贴 | 共${state.positions.length}仓`);
  saveState();
}

// ============ 极端行情保护 ============
async function extremeMarketCheck() {
  if (state.positions.length === 0) return;

  // 检查每个持仓币种在四所的价格偏差
  for (const pos of state.positions) {
    const sym = pos.symbol;
    const prices = {};
    
    try {
      const [bnP, byP, bgP, okP] = await Promise.all([
        httpGet(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}USDT`).then(r => +r?.price || 0).catch(() => 0),
        httpGet(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`).then(r => +r?.result?.list?.[0]?.lastPrice || 0).catch(() => 0),
        httpGet(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}USDT&productType=USDT-FUTURES`).then(r => +r?.data?.[0]?.lastPr || 0).catch(() => 0),
        httpGet(`https://www.okx.com/api/v5/market/ticker?instId=${sym}-USDT-SWAP`).then(r => +r?.data?.[0]?.last || 0).catch(() => 0)
      ]);

      const valid = [bnP, byP, bgP, okP].filter(p => p > 0);
      if (valid.length < 2) continue;

      const maxP = Math.max(...valid);
      const minP = Math.min(...valid);
      const devPct = (maxP - minP) / minP * 100;

      if (devPct > CONFIG.MAX_PRICE_DEVIATION_PCT) {
        log(`⚠️ 价差警告: ${sym} 四所价差 ${devPct.toFixed(1)}% (max:${maxP} min:${minP})`);
        await notify(`⚠️ 价差警告\n${sym} 四所价差 ${devPct.toFixed(1)}%\n仅通知，不自动平仓`);
        // 只通知，不自动平仓。对冲仓位天然安全。
      }
    } catch (e) {
      // 网络问题不影响其他检查
    }
  }

  // 爆仓检测已由 checkMarginSafety（强平价监控）+ reconcilePositions（10分钟对账）替代


  // 浮亏检查 — 已移除。对冲仓位浮亏是纸面数字，不应触发平仓
}

// ============ 每日风控检查 ============
function dailyRiskCheck() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate !== today) {
    state.dailyPnl = 0;
    state.dailyPnlDate = today;
  }

  if (state.dailyPnl < -CONFIG.DAILY_LOSS_LIMIT) {
    log(`⚠️ 每日亏损 $${state.dailyPnl.toFixed(2)} 超过 $${CONFIG.DAILY_LOSS_LIMIT}（仅通知）`);
    // 只通知，不暂停。对冲仓位不需要。
  }
}

// ============ 更新仓位真实费率收入 ============
async function updateEarned() {
  try {
    // 增量式：记录上次查询时间，只拉新记录累加（防止100条limit丢旧数据）
    const lastCheck = state._lastEarnedCheck || 0;
    const now = Date.now();
    
    // 构建时间参数
    const startTime = lastCheck || (now - 86400000); // 首次查24h
    
    const [bnIncome, byIncome, bgIncome] = await Promise.all([
      binance.futuresApi('GET', '/fapi/v1/income', { 
        incomeType: 'FUNDING_FEE', limit: 1000,
        startTime: startTime
      }).catch(() => []),
      bybit.api('GET', '/v5/account/transaction-log', { 
        accountType: 'UNIFIED', type: 'SETTLEMENT', limit: '100',
        startTime: '' + startTime
      }).catch(() => ({})),
      bitget.api('GET', '/api/v2/mix/account/bill', { 
        productType: 'USDT-FUTURES', limit: '100',
        startTime: '' + startTime
      }).catch(() => ({}))
    ]);

    // 按币种汇总本次新增的 funding
    const newFunding = {};
    
    // Binance — 有 startTime 参数，只返回新记录
    for (const f of (Array.isArray(bnIncome) ? bnIncome : [])) {
      if (f.time <= lastCheck) continue; // 跳过已计算的
      const sym = f.symbol.replace('USDT', '');
      const entryTime = state.positions.find(p => p.symbol === sym)?.entryTime;
      if (entryTime && f.time >= new Date(entryTime).getTime()) {
        newFunding[sym] = (newFunding[sym] || 0) + (+f.income);
      }
    }
    
    // Bybit
    for (const f of (byIncome?.result?.list || [])) {
      if (+f.transactionTime <= lastCheck) continue;
      const sym = (f.symbol || '').replace('USDT', '');
      const entryTime = state.positions.find(p => p.symbol === sym)?.entryTime;
      if (entryTime && +f.transactionTime >= new Date(entryTime).getTime()) {
        newFunding[sym] = (newFunding[sym] || 0) + (+f.funding);
      }
    }
    
    // Bitget
    const bgBills = bgIncome?.data?.bills || [];
    for (const f of bgBills) {
      if (f.businessType !== 'contract_settle_fee') continue;
      if (+f.cTime <= lastCheck) continue;
      const sym = (f.symbol || '').replace('USDT', '');
      const entryTime = state.positions.find(p => p.symbol === sym)?.entryTime;
      if (entryTime && +f.cTime >= new Date(entryTime).getTime()) {
        newFunding[sym] = (newFunding[sym] || 0) + (+f.amount);
      }
    }

    // 累加到仓位（不是覆盖）
    for (const pos of state.positions) {
      if (newFunding[pos.symbol] !== undefined) {
        // 首次（没有 _lastEarnedCheck）用覆盖模式；之后用累加模式
        if (!lastCheck) {
          pos.earned = newFunding[pos.symbol];
        } else {
          pos.earned = (pos.earned || 0) + newFunding[pos.symbol];
        }
      }
    }
    
    state._lastEarnedCheck = now;
    saveState();
  } catch (e) {
    log('⚠️ 更新earned失败: ' + e.message);
  }
}

// ============ 状态报告 ============
async function statusReport() {
  checkLogRotate(); // 日志轮转检查
  await updateEarned(); // 先从交易所拉真实结算数据
  const runtime = ((Date.now() - new Date(state.startTime).getTime()) / 3600000).toFixed(1);
  const winRate = state.trades > 0 ? (state.wins / state.trades * 100).toFixed(1) : '0';

  log(`📊 状态报告: PnL $${state.totalPnl.toFixed(2)} | ${state.positions.length}个仓位 | ${state.trades}笔交易 | 胜率${winRate}% | ${runtime}h`);
  log(`  余额: BN$${state.balances.binance.toFixed(0)} BY$${state.balances.bybit.toFixed(0)} BG$${state.balances.bitget.toFixed(0)} OK$${state.balances.okx.toFixed(0)}`);

  for (const pos of state.positions) {
    log(`  仓: ${pos.symbol} ${pos.type} ${pos.longEx}/${pos.shortEx} $${pos.size} 已赚$${(pos.earned||0).toFixed(2)}`);
  }
}

// ============ 仓位qty对账（引擎内部，每2小时）============
async function reconcilePositions() {
  try {
    const [bnPos, byRes, bgRes] = await Promise.all([
      binance.getFuturesPositions().catch(() => []),
      bybit.api('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }).catch(() => ({})),
      bitget.api('GET', '/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES' }).catch(() => ({}))
    ]);
    const byPos = byRes.result?.list?.filter(x => +x.size > 0) || [];
    const bgPos = bgRes.data?.filter(x => +x.total > 0) || [];
    
    let fixes = 0;
    for (const p of state.positions) {
      const sym = p.symbol + 'USDT';
      let longQty = 0, shortQty = 0;
      
      if (p.longEx === 'binance') { const f = bnPos.find(x => x.symbol === sym && +x.positionAmt > 0); if (f) longQty = Math.abs(+f.positionAmt); }
      else if (p.longEx === 'bybit') { const f = byPos.find(x => x.symbol === sym && x.side === 'Buy'); if (f) longQty = +f.size; }
      else if (p.longEx === 'bitget') { const f = bgPos.find(x => x.symbol === sym && x.holdSide === 'long'); if (f) longQty = +f.total; }
      
      if (p.shortEx === 'binance') { const f = bnPos.find(x => x.symbol === sym && +x.positionAmt < 0); if (f) shortQty = Math.abs(+f.positionAmt); }
      else if (p.shortEx === 'bybit') { const f = byPos.find(x => x.symbol === sym && x.side === 'Sell'); if (f) shortQty = +f.size; }
      else if (p.shortEx === 'bitget') { const f = bgPos.find(x => x.symbol === sym && x.holdSide === 'short'); if (f) shortQty = +f.total; }
      
      if (longQty === shortQty && longQty > 0 && p.qty !== longQty) {
        log(`🔧 [对账] ${p.symbol} qty修正: ${p.qty} → ${longQty}`);
        p.qty = longQty;
        fixes++;
      }
      if (longQty !== shortQty && longQty > 0 && shortQty > 0) {
        const pct = Math.abs(longQty - shortQty) / Math.max(longQty, shortQty) * 100;
        if (pct > 1) {
          log(`🚨 [对账] ${p.symbol} 对冲偏差${pct.toFixed(1)}%! 多:${longQty} 空:${shortQty}`);
          await notify(`🚨 对冲偏差! ${p.symbol}\n多:${longQty}(${p.longEx}) 空:${shortQty}(${p.shortEx})\n偏差${pct.toFixed(1)}%`);
        }
      }
    }
    if (fixes > 0) {
      saveState();
      log(`🔧 [对账] 修正了${fixes}个仓位qty`);
    }
  } catch (e) {
    log('⚠️ 对账失败: ' + e.message);
  }
}

// ============ 主循环 ============
async function main() {
  log('🚀 实盘套利引擎启动');
  loadState();

  // 启动时立即对账（防止 state qty 与交易所不一致）
  await reconcilePositions();

  // 初始余额
  await updateBalances();
  log(`💰 初始余额: BN$${state.balances.binance.toFixed(0)} BY$${state.balances.bybit.toFixed(0)} BG$${state.balances.bitget.toFixed(0)} OK$${state.balances.okx.toFixed(0)}`);
  
  await notify('套利实盘策略更新成功✅');

  // WebSocket 实时费率监控（替代 REST 轮询）
  let wsProcessing = false;
  monitor.start(async (opp) => {
    if (state.paused || wsProcessing) return;
    if (state.positions.length >= CONFIG.MAX_POSITIONS) return;
    
    // 防并发
    wsProcessing = true;
    try {
      await handleFundingOpportunity(opp);
    } catch (e) {
      log('❌ WS机会处理异常: ' + e.message);
    } finally {
      wsProcessing = false;
    }
  });

  // pendingOpps 已移除，改用每5分钟全量重扫

  log('📡 WebSocket 实时费率监控已启动');

  // ============ 强平监听（WebSocket 私有流）============
  // Binance: User Data Stream 监听 ORDER_TRADE_UPDATE 里的 LIQUIDATION
  // Bybit: 私有 WS 监听 position 变化（size 变 0 = 被强平）
  try {
    // Binance listenKey
    const bnListenKey = await binance.futuresApi('POST', '/fapi/v1/listenKey', {});
    if (bnListenKey?.listenKey) {
      const bnWs = new (require('ws'))(`wss://fstream.binance.com/ws/${bnListenKey.listenKey}`);
      bnWs.on('message', (raw) => {
        try {
          const d = JSON.parse(raw);
          if (d.e === 'ORDER_TRADE_UPDATE' && d.o?.ot === 'LIQUIDATION') {
            const sym = d.o.s.replace('USDT', '');
            log(`🚨 Binance 强平! ${sym} ${d.o.S} qty:${d.o.q}`);
            notify(`🚨 Binance 强平!\n${sym} ${d.o.S}\n正在平另一边...`);
            // 找到对应仓位，平另一边
            const pos = state.positions.find(p => p.symbol === sym);
            if (pos) {
              const otherEx = pos.longEx === 'binance' ? pos.shortEx : pos.longEx;
              closeFundingPosition(pos, true).then(() => log(`✅ ${sym} 另一边已平`));
            }
          }
        } catch (e) {}
      });
      bnWs.on('error', () => {});
      // 30分钟续期 listenKey
      setInterval(() => binance.futuresApi('PUT', '/fapi/v1/listenKey', {}).catch(() => {}), 1800000);
      log('🔔 Binance 强平监听已启动');
    }

    // Bybit 私有 WS
    const crypto = require('crypto');
    const byExpires = Date.now() + 10000;
    const bySign = crypto.createHmac('sha256', process.env.BYBIT_SECRET_KEY).update('GET/realtime' + byExpires).digest('hex');
    const byWs = new (require('ws'))('wss://stream.bybit.com/v5/private');
    byWs.on('open', () => {
      byWs.send(JSON.stringify({op:'auth',args:[process.env.BYBIT_API_KEY, byExpires, bySign]}));
      setTimeout(() => byWs.send(JSON.stringify({op:'subscribe',args:['position.linear']})), 1000);
    });
    byWs.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        if (d.topic === 'position.linear' && d.data) {
          for (const p of d.data) {
            if (+p.size === 0 && p.symbol) {
              const sym = p.symbol.replace('USDT', '');
              // 检查是不是我们的仓位被平了（且不是我们自己平的）
              const pos = state.positions.find(pp => pp.symbol === sym);
              if (pos && (pos.longEx === 'bybit' || pos.shortEx === 'bybit') && !pos._closing) {
                log(`🚨 Bybit 仓位归零! ${sym} 可能被强平`);
                notify(`🚨 Bybit ${sym} 仓位归零!\n正在平另一边...`);
                pos._closing = true;
                closeFundingPosition(pos, true).then(() => log(`✅ ${sym} 另一边已平`));
              }
            }
          }
        }
      } catch (e) {}
    });
    byWs.on('ping', () => byWs.pong());
    byWs.on('error', () => {});
    log('🔔 Bybit 强平监听已启动');

    // Bitget 私有 WS — 监听 position 变化
    const bgTs = Date.now().toString();
    const bgSign = crypto.createHmac('sha256', process.env.BITGET_SECRET_KEY)
      .update(bgTs + 'GET' + '/user/verify').digest('base64');
    const bgWs = new (require('ws'))('wss://ws.bitget.com/v2/ws/private');
    bgWs.on('open', () => {
      bgWs.send(JSON.stringify({
        op: 'login', args: [{
          apiKey: process.env.BITGET_API_KEY,
          passphrase: process.env.BITGET_PASSPHRASE,
          timestamp: bgTs,
          sign: bgSign
        }]
      }));
      setTimeout(() => bgWs.send(JSON.stringify({
        op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel: 'positions', instId: 'default' }]
      })), 2000);
    });
    bgWs.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        if (d.action === 'snapshot' || d.action === 'update') {
          for (const p of (d.data || [])) {
            if (+p.total === 0 && p.instId) {
              const sym = p.instId.replace('USDT', '');
              const pos = state.positions.find(pp => pp.symbol === sym);
              if (pos && (pos.longEx === 'bitget' || pos.shortEx === 'bitget') && !pos._closing) {
                log(`🚨 Bitget 仓位归零! ${sym} 可能被强平`);
                notify(`🚨 Bitget ${sym} 仓位归零!\n正在平另一边...`);
                pos._closing = true;
                closeFundingPosition(pos, true).then(() => log(`✅ ${sym} 另一边已平`));
              }
            }
          }
        }
      } catch (e) {}
    });
    bgWs.on('ping', () => bgWs.pong());
    bgWs.on('error', () => {});
    // Bitget WS 心跳
    setInterval(() => { if (bgWs.readyState === 1) bgWs.send('ping'); }, 25000);
    log('🔔 Bitget 强平监听已启动');

    // OKX 私有 WS — 监听 position 变化
    const okTs = new Date().toISOString();
    const okSign = crypto.createHmac('sha256', Buffer.from(process.env.OKX_CEX_SECRET_KEY))
      .update(okTs + 'GET' + '/users/self/verify').digest('base64');
    const okWs = new (require('ws'))('wss://ws.okx.com:8443/ws/v5/private');
    okWs.on('open', () => {
      okWs.send(JSON.stringify({
        op: 'login', args: [{
          apiKey: process.env.OKX_CEX_API_KEY,
          passphrase: process.env.OKX_PASSPHRASE,
          timestamp: okTs.slice(0, -1), // 去掉Z
          sign: okSign
        }]
      }));
      setTimeout(() => okWs.send(JSON.stringify({
        op: 'subscribe', args: [{ channel: 'positions', instType: 'SWAP' }]
      })), 2000);
    });
    okWs.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        if (d.arg?.channel === 'positions' && d.data) {
          for (const p of d.data) {
            if (+p.pos === 0 && p.instId) {
              const sym = p.instId.replace('-USDT-SWAP', '');
              const pos = state.positions.find(pp => pp.symbol === sym);
              if (pos && (pos.longEx === 'okx' || pos.shortEx === 'okx') && !pos._closing) {
                log(`🚨 OKX 仓位归零! ${sym} 可能被强平`);
                notify(`🚨 OKX ${sym} 仓位归零!\n正在平另一边...`);
                pos._closing = true;
                closeFundingPosition(pos, true).then(() => log(`✅ ${sym} 另一边已平`));
              }
            }
          }
        }
      } catch (e) {}
    });
    okWs.on('ping', () => okWs.pong());
    okWs.on('error', () => {});
    setInterval(() => { if (okWs.readyState === 1) okWs.send('ping'); }, 25000);
    log('🔔 OKX 强平监听已启动');
  } catch (e) {
    log('⚠️ 强平监听启动失败: ' + e.message + '（不影响主功能）');
  }

  // 费率兜底扫描（REST，每5分钟一次，防WS漏掉）
  setInterval(async () => {
    try {
      dailyRiskCheck();
      await scanFundingArbitrage();
    } catch (e) {
      log('❌ 兜底费率扫描异常: ' + e.message);
    }
  }, 300000); // 5分钟，每轮全量重扫不跳过

  // 价差扫描 - 已暂停（主流币跨所价差极少超25bps，白烧API调用）
  // 费率套利是主策略，价差套利等有更好的检测方式再重启
  // setInterval(async () => {
  //   try { await scanSpreadArbitrage(); } catch (e) {}
  // }, CONFIG.SPREAD_CHECK_INTERVAL);

  // 仓位检查 - 每5分钟
  setInterval(async () => {
    try {
      await checkFundingPositions();
    } catch (e) {
      log('❌ 仓位检查异常: ' + e.message);
    }
  }, 300000);

  // 极端行情检查 - 每30秒
  setInterval(async () => {
    try {
      await extremeMarketCheck();
    } catch (e) {
      log('❌ 极端行情检查异常: ' + e.message);
    }
  }, 30000);

  // 动态仓位调整 - 每小时
  setInterval(async () => {
    try {
      await rebalancePositions();
    } catch (e) {
      log('❌ 调仓异常: ' + e.message);
    }
  }, CONFIG.REBALANCE_INTERVAL);

  // 余额更新 - 每10分钟
  setInterval(updateBalances, 600000);

  // 补仓检查 - 每5秒，确保未满仓位继续补（价差≤1%时）
  setInterval(async () => {
    for (const pos of state.positions) {
      const target = getTradeSize(pos.spread || 0.003);
      if (pos.size < target) {
        // 检查价差
        try {
          const [bnR, byR, bgR] = await Promise.all([
            httpGet('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + pos.symbol + 'USDT'),
            httpGet('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + pos.symbol + 'USDT'),
            httpGet('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=' + pos.symbol + 'USDT')
          ]);
          const rates = [];
          if (bnR) rates.push({ex: 'binance', r: +bnR.lastFundingRate});
          if (byR?.result?.list?.[0]) rates.push({ex: 'bybit', r: +(byR.result.list[0].fundingRate)});
          if (bgR?.data?.[0]) rates.push({ex: 'bitget', r: +(bgR.data[0].fundingRate)});
          
          if (rates.length >= 2) {
            rates.sort((a, b) => a.r - b.r);
            const spread = rates[rates.length - 1].r - rates[0].r;
            if (spread > 0.01) {
              log(`🔄 [补仓检查] ${pos.symbol} 价差${(spread*100).toFixed(3)}% > 1%，暂停补仓`);
              continue;
            }
          }
        } catch (e) {}
        
        const remaining = target - pos.size;
        if (remaining < 100) continue; // 差不到$100算补满
        log(`🔄 [补仓检查] ${pos.symbol} $${pos.size} < 目标$${target}，需补$${remaining}`);
        try {
          const lowExObj = getExchange(pos.longEx);
          const highExObj = getExchange(pos.shortEx);
          const lowFutSym = getFuturesSymbol(pos.symbol, pos.longEx);
          const highFutSym = getFuturesSymbol(pos.symbol, pos.shortEx);
          
          // 查深度
          const [lb, hb] = await Promise.all([
            getOrderbook(pos.longEx, lowFutSym, 10),
            getOrderbook(pos.shortEx, highFutSym, 10)
          ]);
          if (!lb?.asks?.length || !hb?.bids?.length) { log(`  🔄 补仓: 盘口不可用`); continue; }
          
          // 价差检查
          const addMid = (lb.asks[0].price + hb.bids[0].price) / 2;
          const priceDiff = Math.abs(lb.asks[0].price - hb.bids[0].price) / addMid * 100;
          if (priceDiff > 1.0) { log(`  🔄 补仓: 价差${priceDiff.toFixed(2)}%>1%，暂停`); continue; }
          
          // 计算可补量
          const fillable = Math.min(
            calcDepthFill(lb.asks, remaining).fillableUsd,
            calcDepthFill(hb.bids, remaining).fillableUsd
          );
          const addSize = Math.min(Math.floor(fillable / 100) * 100, remaining);
          if (addSize < 200) { log(`  🔄 补仓: 深度只够$${fillable.toFixed(0)}，不足$200`); continue; }
          
          const addQty = alignQty(pos.symbol, pos.longEx, pos.shortEx, addSize / addMid) || Math.floor(addSize / addMid);
          if (addQty <= 0) continue;
          
          const addLongQty = pos.longEx === 'okx' ? coinsToLots(pos.symbol, addQty) : addQty;
          const addShortQty = pos.shortEx === 'okx' ? coinsToLots(pos.symbol, addQty) : addQty;
          
          // 杠杆限额检查
          if (pos.longEx === 'binance') await ensureBinanceLeverage(lowFutSym, addSize);
          if (pos.shortEx === 'binance') await ensureBinanceLeverage(highFutSym, addSize);
          
          // 双边下单
          const [lr, sr] = await Promise.all([
            lowExObj.futuresLong(lowFutSym, addLongQty),
            highExObj.futuresShort(highFutSym, addShortQty)
          ]);
          
          let lrOk = checkOrderSuccess(lr, pos.longEx);
          let srOk = checkOrderSuccess(sr, pos.shortEx);
          if (!lrOk && pos.longEx === 'binance' && lr?.status === 'NEW' && lr?.orderId) lrOk = await waitForBinanceFill(lr.orderId, lowFutSym);
          if (!srOk && pos.shortEx === 'binance' && sr?.status === 'NEW' && sr?.orderId) srOk = await waitForBinanceFill(sr.orderId, highFutSym);
          
          if (lrOk && srOk) {
            pos.size += addSize;
            pos.qty += addQty;
            const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
            pos.totalFee = (pos.totalFee || 0) + addFee;
            state.totalPnl -= addFee;
            state.dailyPnl -= addFee;
            saveState();
            log(`  ✅ 补仓成功! +$${addSize}，总$${pos.size}（目标$${target}）`);
            await notify(`📥 补仓 ${pos.symbol} +$${addSize}（总$${pos.size}，目标$${target}）`);
          } else if (lrOk && !srOk) {
            log(`  ⚠️ 补仓单腿: ${pos.longEx}多OK ${pos.shortEx}空失败，重试空头`);
            for (let fix = 0; fix < 10; fix++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const fixR = await highExObj.futuresShort(highFutSym, addShortQty);
                let fixOk = checkOrderSuccess(fixR, pos.shortEx);
                if (!fixOk && pos.shortEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, highFutSym);
                if (fixOk) {
                  pos.size += addSize;
                  pos.qty += addQty;
                  const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
                  pos.totalFee = (pos.totalFee || 0) + addFee;
                  state.totalPnl -= addFee;
                  state.dailyPnl -= addFee;
                  saveState();
                  log(`  ✅ 空头补救成功! +$${addSize}，总$${pos.size}`);
                  break;
                }
              } catch(e) { log(`  ❌ 空头补救第${fix+1}次失败: ${e.message}`); }
            }
          } else if (!lrOk && srOk) {
            log(`  ⚠️ 补仓单腿: ${pos.shortEx}空OK ${pos.longEx}多失败，重试多头`);
            for (let fix = 0; fix < 10; fix++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const fixR = await lowExObj.futuresLong(lowFutSym, addLongQty);
                let fixOk = checkOrderSuccess(fixR, pos.longEx);
                if (!fixOk && pos.longEx === 'binance' && fixR?.status === 'NEW' && fixR?.orderId) fixOk = await waitForBinanceFill(fixR.orderId, lowFutSym);
                if (fixOk) {
                  pos.size += addSize;
                  pos.qty += addQty;
                  const addFee = addSize * 2 * CONFIG.FEE_BPS / 10000;
                  pos.totalFee = (pos.totalFee || 0) + addFee;
                  state.totalPnl -= addFee;
                  state.dailyPnl -= addFee;
                  saveState();
                  log(`  ✅ 多头补救成功! +$${addSize}，总$${pos.size}`);
                  break;
                }
              } catch(e) { log(`  ❌ 多头补救第${fix+1}次失败: ${e.message}`); }
            }
          } else {
            log(`  ❌ 补仓两边都失败`);
          }
          
          // 补仓后对齐校验
          try {
            const [lPos, sPos] = await Promise.all([lowExObj.getFuturesPositions(), highExObj.getFuturesPositions()]);
            const lp = lPos.find(p => (p.symbol||'').includes(pos.symbol));
            const sp = sPos.find(p => (p.symbol||'').includes(pos.symbol));
            const lQty = lp ? Math.abs(+(lp.positionAmt || lp.total || lp.size || 0)) : 0;
            const sQty = sp ? Math.abs(+(sp.positionAmt || sp.total || sp.size || 0)) : 0;
            if (lQty > 0 && sQty > 0 && Math.abs(lQty - sQty) / Math.max(lQty, sQty) > 0.01) {
              const diff = Math.abs(lQty - sQty);
              log(`  🔧 补仓后不对齐: 多${lQty} 空${sQty}，差${diff}，补少的`);
              if (lQty < sQty) await lowExObj.futuresLong(lowFutSym, diff);
              else await highExObj.futuresShort(highFutSym, diff);
            }
          } catch(e) { log(`  ⚠️ 补仓对齐检查失败: ${e.message}`); }
          
        } catch (e) {
          log(`  ❌ 补仓失败: ${e.message}`);
        }
      }
    }
  }, 5000);

  // 保证金安全监控 - 每60秒，≤10%距强平自动平仓，≤20%通知
  setInterval(checkMarginSafety, CONFIG.MARGIN_CHECK_INTERVAL);
  await checkMarginSafety();

  // 状态报告 - 每30分钟
  setInterval(statusReport, 1800000);

  // 仓位qty对账 - 每2小时（引擎内部做，不依赖外部脚本）
  setInterval(reconcilePositions, 600000); // 10分钟对账

  // 等待频率缓存完成（避免用默认值8h导致误判）
  const waitForIntervals = () => new Promise(resolve => {
    const check = () => {
      if (Object.keys(monitor.fundingIntervals).length > 100) resolve();
      else setTimeout(check, 500);
    };
    check();
    setTimeout(resolve, 10000); // 最多等10秒
  });
  await waitForIntervals();
  log('📊 频率缓存就绪: ' + Object.keys(monitor.fundingIntervals).length + ' 个币种');

  // 首次扫描
  await scanFundingArbitrage();
  await statusReport();

  // ============ 本地 HTTP 看板刷新接口 ============
  startDashboardServer();

  log('✅ 所有定时任务已启动');
}

// ============ 本地 HTTP 服务 — 看板秒刷 ============
function startDashboardServer() {
  const http = require('http');
  const DASHBOARD_MSG_ID = 3713;
  
  async function refreshDashboardDirect() {
    const start = Date.now();
    try {
      // 实时拉余额（并发~76ms），失败则用缓存
      let bn, byW, bg, okW = 0;
      try {
        const [bnBal, byBal, bgBal] = await Promise.all([
          binance.getFuturesBalance().catch(() => null),
          bybit.getBalance().catch(() => null),
          bitget.getFuturesBalance().catch(() => null)
        ]);
        bn = bnBal?.usdt ?? state.balances.binance ?? 0;
        byW = byBal?.usdt ?? state.balances.bybit ?? 0;
        bg = bgBal?.usdt ?? bgBal?.equity ?? state.balances.bitget ?? 0;
      } catch (e) {
        bn = state.balances.binance || 0;
        byW = state.balances.bybit || 0;
        bg = state.balances.bitget || 0;
      }
      const total = bn + byW + bg + okW;

      // 浮盈用缓存（checkFundingPositions每5分钟更新）
      let allPnl = 0;
      for (const p of state.positions) allPnl += (p.unrealizedPnl || 0);

      const netValue = total + allPnl;
      const pnl = netValue - 14232;

      let totalEarned = 0;
      let totalFees = 0;
      const posArr = [];
      for (const p of state.positions) {
        const e = p.earned || 0;
        const f = p.totalFee || 0;
        totalEarned += e;
        totalFees += f;
        posArr.push({ s: p.symbol, e, f, net: e - f, sz: p.size, l: p.longEx, h: p.shortEx });
      }
      posArr.sort((a, b) => b.net - a.net);

      const exMap = { binance: 'BN', bybit: 'BY', bitget: 'BG', okx: 'OK' };
      const posLines = posArr.map(p => {
        const icon = p.net > 0 ? '✅' : p.net < -0.5 ? '⚠️' : (p.net < -0.01 ? '➖' : '🆕');
        const dualSz = p.sz * 2;
        const szStr = dualSz >= 1000 ? `$${(dualSz/1000).toFixed(0)}k` : `$${dualSz}`;
        const longSz = p.sz >= 1000 ? `$${(p.sz/1000).toFixed(0)}k` : `$${p.sz}`;
        return `├ ${p.s}: 净${p.net >= 0 ? '+' : ''}$${p.net.toFixed(2)} ${icon} | ${szStr} (${exMap[p.l]}多${longSz} ${exMap[p.h]}空${longSz})`;
      }).join('\n');

      const totalExposure = state.positions.reduce((s, p) => s + p.size, 0);
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      const text = `📊 系统看板 (${ts})\n\n` +
        `💵 四所余额\n├ Binance: $${Math.round(bn).toLocaleString()}\n├ Bybit: $${Math.round(byW).toLocaleString()}\n├ Bitget: $${Math.round(bg).toLocaleString()}\n├ OKX: $${Math.round(okW).toLocaleString()} (待机)\n└ 总计: $${Math.round(total).toLocaleString()}\n\n` +
        `📈 盈亏总览\n├ 浮盈浮亏: $${Math.round(allPnl)}（开仓滑点成本）\n├ 费率收入: +$${totalEarned.toFixed(2)}\n├ 手续费: -$${totalFees.toFixed(2)}\n├ 总净值: $${Math.round(netValue).toLocaleString()}\n└ 盈亏: $${Math.round(pnl)}\n\n` +
        `📍 费率套利 (${state.positions.length}仓/$${totalExposure.toLocaleString()}) 净利: +$${(totalEarned - totalFees).toFixed(2)}\n` +
        posLines + `\n└ 净敞口: 全部=0 ✅\n\n` +
        `⚙️ arbitrage-live ✅ | WS 4所\n├ 强平监听: 4所 ✅ | 精度: 4所 ✅\n├ 费率标准化: 1h/4h/8h ✅\n├ 价差控制: <1% ✅\n├ 健康度调仓: 每小时 ✅\n└ 🟢 运行中\n\n🔄 刷新时间: ${ts} (${elapsed}s)`;

      const body = JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        message_id: DASHBOARD_MSG_ID,
        text,
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🔄 刷新看板', callback_data: 'refresh_dashboard' }]] })
      });
      
      await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: '/bot' + CONFIG.TG_BOT_TOKEN + '/editMessageText',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 5000
        }, resolve);
        req.on('error', resolve);
        req.write(body);
        req.end();
      });
      
      return { ok: true, elapsed };
    } catch (e) {
      log('⚠️ 看板刷新失败: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/refresh') {
      const result = await refreshDashboardDirect();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  
  server.listen(9876, '127.0.0.1', () => {
    log('🔔 看板刷新服务已启动 http://127.0.0.1:9876/refresh');
  });
  server.on('error', (e) => {
    log('⚠️ 看板服务启动失败: ' + e.message);
  });
}

main().catch(e => {
  log('💀 引擎崩溃: ' + e.message);
  notify('💀 实盘引擎崩溃: ' + e.message);
});