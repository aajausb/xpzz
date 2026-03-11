/**
 * WebSocket 实时费率监控 + 快速下单
 * 替代原来的 REST 轮询，延迟从 60s → <1s
 */

const WebSocket = require('ws');
const fs = require('fs');

class RealTimeRateMonitor {
  constructor() {
    this.rates = {};          // symbol -> { binance, bybit, bitget, okx }
    this.lastUpdate = {};     // symbol -> timestamp
    this.connections = {};    // exchange -> ws
    this.reconnectDelay = 5000;
    this.onOpportunity = null; // callback
    this.symbolInfo = {};     // 缓存合约精度信息
    this.fundingIntervals = {}; // 缓存结算频率: symbol -> { binance: 4, bybit: 1, ... } (小时)
  }

  start(onOpportunity) {
    this.onOpportunity = onOpportunity;
    this.connectBinance();
    this.connectBybit();
    this.connectBitget();
    this.connectOkx();
    this.loadSymbolInfo();
    
    // 定期检查连接存活
    setInterval(() => this.healthCheck(), 30000);
  }

  // ============ Binance WS ============
  connectBinance() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!markPrice@arr@1s');
    
    ws.on('open', () => {
      console.log('[WS] Binance 合约费率连接 ✅');
      this.connections.binance = ws;
    });

    ws.on('message', (data) => {
      try {
        const items = JSON.parse(data);
        for (const item of items) {
          if (!item.s?.endsWith('USDT')) continue;
          const sym = item.s.replace('USDT', '');
          if (!this.rates[sym]) this.rates[sym] = {};
          this.rates[sym].binance = parseFloat(item.r); // lastFundingRate
          this.rates[sym].binancePrice = parseFloat(item.p); // markPrice
          this.lastUpdate[sym] = Date.now();
        }
        this.checkOpportunities();
      } catch (e) {}
    });

    ws.on('close', () => {
      console.log('[WS] Binance 断开，5秒后重连');
      this.connections.binance = null;
      setTimeout(() => this.connectBinance(), this.reconnectDelay);
    });

    ws.on('error', (e) => {
      console.log('[WS] Binance 错误: ' + e.message);
    });

    // Binance WS 需要定期 pong
    ws.on('ping', () => ws.pong());
  }

  // ============ Bybit WS ============
  connectBybit() {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    
    ws.on('open', () => {
      console.log('[WS] Bybit 合约费率连接 ✅');
      this.connections.bybit = ws;
      // 动态订阅所有USDT永续（通过 REST 获取完整列表）
      const topSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 
               'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'BNBUSDT',
               'KITEUSDT', 'PIXELUSDT', 'FOLKSUSDT', 'SXTUSDT', 'XCNUSDT', 
               'CVCUSDT', 'MBOXUSDT', 'MOVEUSDT',
               'RONINUSDT', '1000000MOGUSDT', 'XAIUSDT', 'MAGICUSDT', 
               'ICXUSDT', 'SLPUSDT', 'LYNUSDT', 'DYMUSDT',
               'NTRNUSDT', 'ARPAUSDT', 'PYRUSDT', 'ATAUSDT',
               'AIOUSDT', 'BUSUSDT', 'INUSDT'
              ];
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: topSymbols.map(s => 'tickers.' + s)
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.topic?.startsWith('tickers.') && msg.data) {
          const sym = msg.data.symbol?.replace('USDT', '');
          if (!sym) return;
          if (!this.rates[sym]) this.rates[sym] = {};
          if (msg.data.fundingRate) {
            this.rates[sym].bybit = parseFloat(msg.data.fundingRate);
            this.rates[sym].bybitPrice = parseFloat(msg.data.lastPrice);
            this.lastUpdate[sym] = Date.now();
          }
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      console.log('[WS] Bybit 断开，5秒后重连');
      this.connections.bybit = null;
      setTimeout(() => this.connectBybit(), this.reconnectDelay);
    });

    ws.on('error', (e) => console.log('[WS] Bybit 错误: ' + e.message));

    // Bybit 需要每20秒发心跳
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 'ping' }));
      } else {
        clearInterval(heartbeat);
      }
    }, 20000);
  }

  // ============ Bitget WS ============
  connectBitget() {
    const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
    
    ws.on('open', () => {
      console.log('[WS] Bitget 合约费率连接 ✅');
      this.connections.bitget = ws;
      // 订阅 ticker
      const symbols = ['KITEUSDT', 'PIXELUSDT', 'FOLKSUSDT', 'SXTUSDT', 'XCNUSDT', 
                        'CVCUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT',
                        'SUIUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT',
                        'RONINUSDT', '1000000MOGUSDT', 'XAIUSDT', 'MAGICUSDT',
                        'ICXUSDT', 'SLPUSDT', 'LYNUSDT', 'DYMUSDT',
                        'NTRNUSDT', 'ARPAUSDT', 'PYRUSDT'];
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: symbols.map(s => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s }))
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.data?.[0]) {
          const d = msg.data[0];
          const sym = d.instId?.replace('USDT', '');
          if (!sym) return;
          if (!this.rates[sym]) this.rates[sym] = {};
          if (d.fundingRate) {
            this.rates[sym].bitget = parseFloat(d.fundingRate);
            this.rates[sym].bitgetPrice = parseFloat(d.lastPr || d.last);
            this.lastUpdate[sym] = Date.now();
          }
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      console.log('[WS] Bitget 断开，5秒后重连');
      this.connections.bitget = null;
      setTimeout(() => this.connectBitget(), this.reconnectDelay);
    });

    ws.on('error', (e) => console.log('[WS] Bitget 错误: ' + e.message));

    // 心跳
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);
  }

  // ============ OKX WS ============
  connectOkx() {
    const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    
    ws.on('open', () => {
      console.log('[WS] OKX 合约费率连接 ✅');
      this.connections.okx = ws;
      const symbols = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'DOGE-USDT-SWAP',
                        'SUI-USDT-SWAP', 'XRP-USDT-SWAP', 'ADA-USDT-SWAP', 'AVAX-USDT-SWAP',
                        'LINK-USDT-SWAP', 'KITE-USDT-SWAP', 'PIXEL-USDT-SWAP',
                        'RONIN-USDT-SWAP', 'XAI-USDT-SWAP', 'MAGIC-USDT-SWAP',
                        'ICX-USDT-SWAP', 'SLP-USDT-SWAP', 'LYN-USDT-SWAP', 'DYM-USDT-SWAP'];
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: symbols.map(s => ({ channel: 'funding-rate', instId: s }))
      }));
      // 也订阅 mark-price 拿实时价格
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: symbols.map(s => ({ channel: 'mark-price', instId: s }))
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.data?.[0]) {
          const d = msg.data[0];
          const match = d.instId?.match(/^(\w+)-USDT-SWAP$/);
          if (!match) return;
          const sym = match[1];
          if (!this.rates[sym]) this.rates[sym] = {};
          if (d.fundingRate) {
            this.rates[sym].okx = parseFloat(d.fundingRate);
          }
          if (d.markPx) {
            this.rates[sym].okxPrice = parseFloat(d.markPx);
          }
          this.lastUpdate[sym] = Date.now();
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      console.log('[WS] OKX 断开，5秒后重连');
      this.connections.okx = null;
      setTimeout(() => this.connectOkx(), this.reconnectDelay);
    });

    ws.on('error', (e) => console.log('[WS] OKX 错误: ' + e.message));

    // 心跳
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      } else {
        clearInterval(heartbeat);
      }
    }, 25000);
  }

  // ============ 机会检测 ============
  checkOpportunities() {
    if (!this.onOpportunity) return;

    for (const [sym, rates] of Object.entries(this.rates)) {
      const exs = Object.entries(rates).filter(([k, v]) => 
        !k.includes('Price') && v !== undefined && v !== null && typeof v === 'number'
      );
      if (exs.length < 2) continue;

      // 标准化为每小时费率再比较
      const normalized = exs.map(([ex, rate]) => {
        const interval = this.fundingIntervals[sym]?.[ex] || 8;
        const hourlyRate = rate / interval; // 每小时费率
        return [ex, rate, hourlyRate, interval];
      });

      normalized.sort((a, b) => a[2] - b[2]); // 按每小时费率排序
      const [lowEx, lowRate, lowHourly, lowInterval] = normalized[0];
      const [highEx, highRate, highHourly, highInterval] = normalized[normalized.length - 1];
      const hourlySpread = highHourly - lowHourly;

      // 用每小时费率差 × 8 换算成等效8小时费率差，跟开仓门槛0.3%对比
      const equiv8hSpread = hourlySpread * 8;

      if (equiv8hSpread >= 0.003) { // 等效8小时费率差 ≥ 0.3%
        // 最低绝对门槛：原始费率差不能低于0.1%，防止高频结算币被噪音骗进去
        const rawSpread = highRate - lowRate;
        if (Math.abs(rawSpread) < 0.001) continue;
        this.onOpportunity({
          symbol: sym,
          lowEx, highEx,
          lowRate, highRate,
          spread: highRate - lowRate, // 原始费率差（传给引擎用于显示）
          hourlySpread,
          equiv8hSpread,
          lowInterval, highInterval,
          annualized: hourlySpread * 24 * 365 * 100,
          price: rates[lowEx + 'Price'] || rates[highEx + 'Price'] || 0
        });
      }
    }

    // 检查 pendingOpps：费率好但价差大的币，看价差是否缩小了
    if (this.onPendingCheck) {
      this.onPendingCheck(this.rates);
    }
  }

  // ============ 健康检查 ============
  healthCheck() {
    const active = Object.entries(this.connections)
      .filter(([, ws]) => ws?.readyState === WebSocket.OPEN)
      .map(([name]) => name);
    
    const symbols = Object.keys(this.rates).length;
    const fresh = Object.values(this.lastUpdate).filter(t => Date.now() - t < 60000).length;
    
    if (active.length < 3) {
      console.log(`[WS] ⚠️ 只有 ${active.length}/4 个连接: ${active.join(',')}`);
    }
  }

  // ============ 合约精度信息缓存 ============
  async loadSymbolInfo() {
    const https = require('https');
    const get = (url) => new Promise(r => {
      https.get(url, { timeout: 5000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { r(JSON.parse(d)); } catch(e) { r(null); } });
      }).on('error', () => r(null));
    });

    // Binance 合约规格
    try {
      const info = await get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      if (info?.symbols) {
        for (const s of info.symbols) {
          const base = s.symbol.replace('USDT', '');
          if (!this.symbolInfo[base]) this.symbolInfo[base] = {};
          this.symbolInfo[base].binance = {
            qtyPrecision: s.quantityPrecision,
            minQty: parseFloat(s.filters?.find(f => f.filterType === 'LOT_SIZE')?.minQty || 1),
            stepSize: parseFloat(s.filters?.find(f => f.filterType === 'LOT_SIZE')?.stepSize || 1)
          };
        }
        console.log(`[精度] Binance ${Object.keys(this.symbolInfo).length} 个币种精度已缓存`);
      }
    } catch (e) {}

    // Bybit 合约规格
    try {
      const info = await get('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=500');
      if (info?.result?.list) {
        for (const s of info.result.list) {
          if (!s.symbol.endsWith('USDT')) continue;
          const base = s.symbol.replace('USDT', '');
          if (!this.symbolInfo[base]) this.symbolInfo[base] = {};
          this.symbolInfo[base].bybit = {
            minQty: parseFloat(s.lotSizeFilter?.minOrderQty || 1),
            stepSize: parseFloat(s.lotSizeFilter?.qtyStep || 1)
          };
        }
        console.log(`[精度] Bybit 合约精度已缓存`);
      }
    } catch (e) {}

    // Bitget 合约规格
    try {
      const info = await get('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES');
      if (info?.data) {
        for (const s of info.data) {
          if (!s.symbol.endsWith('USDT')) continue;
          const base = s.symbol.replace('USDT', '');
          if (!this.symbolInfo[base]) this.symbolInfo[base] = {};
          this.symbolInfo[base].bitget = {
            minQty: parseFloat(s.minTradeNum || 1),
            stepSize: parseFloat(s.sizeMultiplier || 1)
          };
        }
        console.log(`[精度] Bitget 合约精度已缓存`);
      }
    } catch (e) {}

    // OKX 合约规格
    try {
      const info = await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
      if (info?.data) {
        for (const s of info.data) {
          if (!s.instId.endsWith('-USDT-SWAP')) continue;
          const base = s.instId.replace('-USDT-SWAP', '');
          if (!this.symbolInfo[base]) this.symbolInfo[base] = {};
          this.symbolInfo[base].okx = {
            minQty: parseFloat(s.minSz || 1),
            stepSize: parseFloat(s.lotSz || 1),
            ctVal: parseFloat(s.ctVal || 1) // OKX 用张数，ctVal是每张面值
          };
        }
        console.log(`[精度] OKX 合约精度已缓存`);
      }
    } catch (e) {}

    // ============ 结算频率缓存 ============
    // Binance
    try {
      const info = await get('https://fapi.binance.com/fapi/v1/fundingInfo');
      if (Array.isArray(info)) {
        for (const s of info) {
          if (!s.symbol.endsWith('USDT')) continue;
          const base = s.symbol.replace('USDT', '');
          if (!this.fundingIntervals[base]) this.fundingIntervals[base] = {};
          this.fundingIntervals[base].binance = s.fundingIntervalHours || 8;
        }
        console.log(`[频率] Binance 结算频率已缓存`);
      }
    } catch (e) {}

    // Bybit
    try {
      const info = await get('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
      if (info?.result?.list) {
        for (const s of info.result.list) {
          if (!s.symbol.endsWith('USDT')) continue;
          const base = s.symbol.replace('USDT', '');
          if (!this.fundingIntervals[base]) this.fundingIntervals[base] = {};
          this.fundingIntervals[base].bybit = (parseInt(s.fundingInterval) || 480) / 60;
        }
        console.log(`[频率] Bybit 结算频率已缓存`);
      }
    } catch (e) {}

    // Bitget - 默认8小时（API不直接返回频率）
    // OKX - 默认8小时
    console.log(`[频率] 结算频率缓存完成, ${Object.keys(this.fundingIntervals).length} 个币种`);
  }

  /**
   * 根据缓存的精度信息，调整下单数量
   */
  adjustQty(symbol, exchange, rawQty) {
    const info = this.symbolInfo[symbol]?.[exchange];
    if (!info) {
      // 没有精度信息，用保守策略
      return Math.floor(rawQty);
    }
    
    const { minQty, stepSize } = info;
    let qty = Math.floor(rawQty / stepSize) * stepSize;
    if (qty < minQty) return 0;
    
    // 保留合适的小数位
    const decimals = stepSize < 1 ? Math.ceil(-Math.log10(stepSize)) : 0;
    return parseFloat(qty.toFixed(decimals));
  }

  getConnectionStatus() {
    return {
      binance: this.connections.binance?.readyState === WebSocket.OPEN,
      bybit: this.connections.bybit?.readyState === WebSocket.OPEN,
      bitget: this.connections.bitget?.readyState === WebSocket.OPEN,
      okx: this.connections.okx?.readyState === WebSocket.OPEN,
      symbols: Object.keys(this.rates).length
    };
  }

  stop() {
    for (const ws of Object.values(this.connections)) {
      if (ws) ws.close();
    }
  }
}

module.exports = RealTimeRateMonitor;
