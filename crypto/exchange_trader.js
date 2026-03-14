/**
 * 统一交易所交易模块 v1
 * 支持: Binance, Bybit, Bitget, OKX
 * 功能: 查余额、查盘口深度、现货下单、合约下单
 */

require('dotenv').config({ path: '/root/.openclaw/workspace/.env' });
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// ============ 通用HTTP ============
function httpReq(method, hostname, path, headers = {}, body = null, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers, timeout };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    https.get(url, { timeout }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// ============ 签名函数 ============
function signBinance(qs) {
  return crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY).update(qs).digest('hex');
}

function signBybit(ts, apiKey, recvWindow, payload) {
  return crypto.createHmac('sha256', process.env.BYBIT_SECRET_KEY)
    .update(ts + apiKey + recvWindow + payload).digest('hex');
}

function signBitget(ts, method, path, body = '') {
  return crypto.createHmac('sha256', process.env.BITGET_SECRET_KEY)
    .update(ts + method + path + body).digest('base64');
}

function signOkx(ts, method, path, body = '') {
  return crypto.createHmac('sha256', Buffer.from(process.env.OKX_CEX_SECRET_KEY))
    .update(ts + method + path + body).digest('base64');
}

// ============ Binance ============
const binance = {
  async api(method, path, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const qs = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const sig = signBinance(qs);
    return httpReq(method, 'api.binance.com', path + '?' + qs + '&signature=' + sig, {
      'X-MBX-APIKEY': process.env.BINANCE_API_KEY
    });
  },

  async futuresApi(method, path, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const qs = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const sig = signBinance(qs);
    const body = method === 'POST' ? qs + '&signature=' + sig : null;
    const fullPath = method === 'GET' ? path + '?' + qs + '&signature=' + sig : path;
    return httpReq(method, 'fapi.binance.com', fullPath, {
      'X-MBX-APIKEY': process.env.BINANCE_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    }, body);
  },

  async getBalance() {
    const res = await this.api('GET', '/api/v3/account');
    if (!res.balances) return { error: res.msg || 'unknown' };
    const usdt = res.balances.find(b => b.asset === 'USDT');
    return { usdt: parseFloat(usdt?.free || 0), raw: res.balances.filter(b => parseFloat(b.free) > 0) };
  },

  async getFuturesBalance() {
    const res = await this.futuresApi('GET', '/fapi/v2/balance');
    if (!Array.isArray(res)) return { error: res.msg || 'unknown' };
    const usdt = res.find(b => b.asset === 'USDT');
    return { usdt: parseFloat(usdt?.balance || 0), available: parseFloat(usdt?.availableBalance || 0) };
  },

  async getOrderbook(symbol, limit = 10) {
    const res = await httpGet(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`);
    if (!res?.bids) return null;
    return {
      bids: res.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: res.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }))
    };
  },

  async getFuturesOrderbook(symbol, limit = 10) {
    const res = await httpGet(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
    if (!res?.bids) return null;
    return {
      bids: res.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: res.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }))
    };
  },

  // 现货市价买（用USDT金额）
  async spotBuy(symbol, quoteAmount) {
    return this.api('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteAmount.toString()
    });
  },

  // 现货市价卖（用币数量）
  async spotSell(symbol, quantity) {
    return this.api('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity: quantity.toString()
    });
  },

  // 现货限价买
  async spotLimitBuy(symbol, price, quantity) {
    return this.api('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
      price: price.toString(), quantity: quantity.toString()
    });
  },

  // 现货限价卖
  async spotLimitSell(symbol, price, quantity) {
    return this.api('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'LIMIT', timeInForce: 'GTC',
      price: price.toString(), quantity: quantity.toString()
    });
  },

  // 合约市价开多
  async futuresLong(symbol, quantity) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity: quantity.toString()
    });
  },

  // 合约市价开空
  async futuresShort(symbol, quantity) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity: quantity.toString()
    });
  },

  // 合约平多
  async futuresCloseLong(symbol, quantity) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity: quantity.toString(), reduceOnly: 'true'
    });
  },

  // 合约限价平多 (Post-Only)
  async futuresCloseLongLimit(symbol, quantity, price) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'LIMIT', timeInForce: 'GTX', price: price.toString(), quantity: quantity.toString(), reduceOnly: 'true'
    });
  },

  // 合约平空
  async futuresCloseShort(symbol, quantity) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity: quantity.toString(), reduceOnly: 'true'
    });
  },

  // 合约限价平空 (Post-Only)
  async futuresCloseShortLimit(symbol, quantity, price) {
    return this.futuresApi('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'GTX', price: price.toString(), quantity: quantity.toString(), reduceOnly: 'true'
    });
  },

  // 撤单
  async futuresCancelOrder(symbol, orderId) {
    return this.futuresApi('DELETE', '/fapi/v1/order', { symbol, orderId: orderId.toString() });
  },

  // 查订单
  async futuresGetOrder(symbol, orderId) {
    return this.futuresApi('GET', '/fapi/v1/order', { symbol, orderId: orderId.toString() });
  },

  // 查合约持仓
  async getFuturesPositions() {
    const res = await this.futuresApi('GET', '/fapi/v2/positionRisk');
    if (!Array.isArray(res)) return { error: res.msg };
    return res.filter(p => parseFloat(p.positionAmt) !== 0);
  }
};

// ============ Bybit ============
const bybit = {
  async api(method, path, params = {}) {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    let qs = '';
    let body = null;

    if (method === 'GET') {
      qs = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    } else {
      body = JSON.stringify(params);
    }

    const payload = method === 'GET' ? qs : (body || '');
    const sig = signBybit(ts, process.env.BYBIT_API_KEY, recvWindow, payload);

    const headers = {
      'X-BAPI-API-KEY': process.env.BYBIT_API_KEY,
      'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json'
    };

    const fullPath = method === 'GET' && qs ? path + '?' + qs : path;
    return httpReq(method, 'api.bybit.com', fullPath, headers, body);
  },

  async getBalance() {
    const res = await this.api('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    if (res.retCode !== 0) return { error: res.retMsg };
    const coins = res.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT');
    return {
      usdt: parseFloat(usdt?.walletBalance || 0),
      available: parseFloat(usdt?.availableToWithdraw || 0),
      equity: parseFloat(res.result?.list?.[0]?.totalEquity || 0)
    };
  },

  // Bybit统一账户，getFuturesBalance = getBalance（兼容其他交易所接口）
  async getFuturesBalance() {
    return this.getBalance();
  },

  async getOrderbook(symbol, limit = 10) {
    const res = await httpGet(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${limit}`);
    if (!res?.result?.b) return null;
    return {
      bids: res.result.b.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: res.result.a.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }))
    };
  },

  // 现货市价买
  async spotBuy(symbol, quoteAmount) {
    return this.api('POST', '/v5/order/create', {
      category: 'spot', symbol, side: 'Buy', orderType: 'Market',
      qty: quoteAmount.toString(), marketUnit: 'quoteCoin'
    });
  },

  // 现货市价卖
  async spotSell(symbol, quantity) {
    return this.api('POST', '/v5/order/create', {
      category: 'spot', symbol, side: 'Sell', orderType: 'Market',
      qty: quantity.toString(), marketUnit: 'baseCoin'
    });
  },

  // 合约市价开多
  async futuresLong(symbol, quantity) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Buy', orderType: 'Market', qty: quantity.toString()
    });
  },

  // 合约市价开空
  async futuresShort(symbol, quantity) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Sell', orderType: 'Market', qty: quantity.toString()
    });
  },

  // 合约平多
  async futuresCloseLong(symbol, quantity) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Sell', orderType: 'Market', qty: quantity.toString(), reduceOnly: true
    });
  },

  // 合约平空
  async futuresCloseShort(symbol, quantity) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Buy', orderType: 'Market', qty: quantity.toString(), reduceOnly: true
    });
  },

  // 合约限价平多 (Post-Only)
  async futuresCloseLongLimit(symbol, quantity, price) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Sell', orderType: 'Limit', price: price.toString(), qty: quantity.toString(), reduceOnly: true, timeInForce: 'PostOnly'
    });
  },

  // 合约限价平空 (Post-Only)
  async futuresCloseShortLimit(symbol, quantity, price) {
    return this.api('POST', '/v5/order/create', {
      category: 'linear', symbol, side: 'Buy', orderType: 'Limit', price: price.toString(), qty: quantity.toString(), reduceOnly: true, timeInForce: 'PostOnly'
    });
  },

  // 撤单
  async futuresCancelOrder(symbol, orderId) {
    return this.api('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId });
  },

  // 查订单
  async futuresGetOrder(symbol, orderId) {
    return this.api('GET', '/v5/order/realtime', { category: 'linear', symbol, orderId });
  },

  async getFuturesPositions(symbol) {
    const params = { category: 'linear', settleCoin: 'USDT' };
    if (symbol) params.symbol = symbol;
    const res = await this.api('GET', '/v5/position/list', params);
    if (res.retCode !== 0) return { error: res.retMsg };
    return (res.result?.list || []).filter(p => parseFloat(p.size) > 0);
  }
};

// ============ Bitget ============
const bitget = {
  async api(method, path, params = {}, body = null) {
    const ts = Date.now().toString();
    let queryPath = path;
    if (method === 'GET' && Object.keys(params).length) {
      queryPath += '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    }
    const bodyStr = body ? JSON.stringify(body) : '';
    const sig = signBitget(ts, method, queryPath, bodyStr);

    const headers = {
      'ACCESS-KEY': process.env.BITGET_API_KEY,
      'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
      'Content-Type': 'application/json',
      'locale': 'en-US'
    };

    return httpReq(method, 'api.bitget.com', queryPath, headers, bodyStr || null);
  },

  async getBalance() {
    const res = await this.api('GET', '/api/v2/spot/account/assets');
    if (res.code !== '00000') return { error: res.msg };
    const usdt = res.data?.find(a => a.coin === 'USDT');
    return { usdt: parseFloat(usdt?.available || 0), raw: res.data?.filter(a => parseFloat(a.available) > 0) };
  },

  async getFuturesBalance() {
    const res = await this.api('GET', '/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' });
    if (res.code !== '00000') return { error: res.msg };
    const usdt = res.data?.find(a => a.marginCoin === 'USDT');
    return { usdt: parseFloat(usdt?.available || 0), equity: parseFloat(usdt?.usdtEquity || 0) };
  },

  async getOrderbook(symbol, limit = 10) {
    const res = await httpGet(`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${symbol}&limit=${limit}`);
    if (!res?.data?.bids) return null;
    return {
      bids: res.data.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: res.data.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }))
    };
  },

  // 现货市价买
  async spotBuy(symbol, quoteAmount) {
    return this.api('POST', '/api/v2/spot/trade/place-order', null, {
      symbol, side: 'buy', orderType: 'market', size: quoteAmount.toString(), force: 'gtc'
    });
  },

  // 现货市价卖
  async spotSell(symbol, quantity) {
    return this.api('POST', '/api/v2/spot/trade/place-order', null, {
      symbol, side: 'sell', orderType: 'market', size: quantity.toString(), force: 'gtc'
    });
  },

  // 合约市价开多
  async futuresLong(symbol, quantity) {
    return this.api('POST', '/api/v2/mix/order/place-order', null, {
      symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
      side: 'buy', tradeSide: 'open', orderType: 'market', size: quantity.toString()
    });
  },

  // 合约市价开空
  async futuresShort(symbol, quantity) {
    return this.api('POST', '/api/v2/mix/order/place-order', null, {
      symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
      side: 'sell', tradeSide: 'open', orderType: 'market', size: quantity.toString()
    });
  },

  // 合约平多
  async futuresCloseLong(symbol, quantity) {
    // 用 place-order 指定数量平仓（支持部分平仓）
    if (quantity) {
      const res = await this.api('POST', '/api/v2/mix/order/place-order', null, {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side: 'sell', tradeSide: 'close', orderType: 'market',
        size: String(quantity), holdSide: 'long'
      });
      // place-order 失败时 fallback 到 close-positions
      if (res?.code && res.code !== '00000') {
        console.log(`[BG] place-order平多失败(${res.code}: ${res.msg})，fallback close-positions`);
        return this.api('POST', '/api/v2/mix/order/close-positions', null, {
          symbol, productType: 'USDT-FUTURES', holdSide: 'long', marginCoin: 'USDT'
        });
      }
      return res;
    }
    // 不传数量则全平
    return this.api('POST', '/api/v2/mix/order/close-positions', null, {
      symbol, productType: 'USDT-FUTURES', holdSide: 'long', marginCoin: 'USDT'
    });
  },

  // 合约平空
  async futuresCloseShort(symbol, quantity) {
    if (quantity) {
      const res = await this.api('POST', '/api/v2/mix/order/place-order', null, {
        symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
        side: 'buy', tradeSide: 'close', orderType: 'market',
        size: String(quantity), holdSide: 'short'
      });
      // place-order 失败时 fallback 到 close-positions
      if (res?.code && res.code !== '00000') {
        console.log(`[BG] place-order平空失败(${res.code}: ${res.msg})，fallback close-positions`);
        return this.api('POST', '/api/v2/mix/order/close-positions', null, {
          symbol, productType: 'USDT-FUTURES', holdSide: 'short', marginCoin: 'USDT'
        });
      }
      return res;
    }
    return this.api('POST', '/api/v2/mix/order/close-positions', null, {
      symbol, productType: 'USDT-FUTURES', holdSide: 'short', marginCoin: 'USDT'
    });
  },

  // 合约限价平多 (Post-Only)
  async futuresCloseLongLimit(symbol, quantity, price) {
    return this.api('POST', '/api/v2/mix/order/place-order', null, {
      symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
      side: 'sell', tradeSide: 'close', orderType: 'limit', price: String(price),
      size: String(quantity), force: 'post_only', holdSide: 'long'
    });
  },

  // 合约限价平空 (Post-Only)
  async futuresCloseShortLimit(symbol, quantity, price) {
    return this.api('POST', '/api/v2/mix/order/place-order', null, {
      symbol, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT',
      side: 'buy', tradeSide: 'close', orderType: 'limit', price: String(price),
      size: String(quantity), force: 'post_only', holdSide: 'short'
    });
  },

  // 撤单
  async futuresCancelOrder(symbol, orderId) {
    return this.api('POST', '/api/v2/mix/order/cancel-order', null, {
      symbol, productType: 'USDT-FUTURES', orderId
    });
  },

  // 查订单
  async futuresGetOrder(symbol, orderId) {
    return this.api('GET', '/api/v2/mix/order/detail', { symbol, productType: 'USDT-FUTURES', orderId });
  },

  async getFuturesPositions(symbol) {
    const params = { productType: 'USDT-FUTURES' };
    if (symbol) params.symbol = symbol;
    const res = await this.api('GET', '/api/v2/mix/position/all-position', params);
    if (res.code !== '00000') return { error: res.msg };
    return (res.data || []).filter(p => parseFloat(p.total) > 0);
  }
};

// ============ OKX ============
const okx = {
  async api(method, path, body = null) {
    const ts = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const sig = signOkx(ts, method, path, bodyStr);

    const headers = {
      'OK-ACCESS-KEY': process.env.OKX_CEX_API_KEY,
      'OK-ACCESS-SIGN': sig,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
      'Content-Type': 'application/json'
    };

    return httpReq(method, 'www.okx.com', path, headers, bodyStr || null);
  },

  async getBalance() {
    const res = await this.api('GET', '/api/v5/account/balance');
    if (res.code !== '0') return { error: res.msg };
    const details = res.data?.[0]?.details || [];
    const usdt = details.find(d => d.ccy === 'USDT');
    return {
      usdt: parseFloat(usdt?.availBal || 0),
      equity: parseFloat(res.data?.[0]?.totalEq || 0)
    };
  },

  async getOrderbook(instId, limit = 10) {
    const res = await httpGet(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=${limit}`);
    if (!res?.data?.[0]?.bids) return null;
    return {
      bids: res.data[0].bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
      asks: res.data[0].asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }))
    };
  },

  // 现货市价买（用USDT）
  async spotBuy(instId, quoteAmount) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cash', side: 'buy', ordType: 'market', sz: quoteAmount.toString(), tgtCcy: 'quote_ccy'
    });
  },

  // 现货市价卖
  async spotSell(instId, quantity) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cash', side: 'sell', ordType: 'market', sz: quantity.toString(), tgtCcy: 'base_ccy'
    });
  },

  // 合约市价开多
  async futuresLong(instId, quantity) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cross', side: 'buy', ordType: 'market', sz: quantity.toString(), posSide: 'long'
    });
  },

  // 合约市价开空
  async futuresShort(instId, quantity) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cross', side: 'sell', ordType: 'market', sz: quantity.toString(), posSide: 'short'
    });
  },

  // 合约平多
  async futuresCloseLong(instId, quantity) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cross', side: 'sell', ordType: 'market', sz: quantity.toString(), posSide: 'long'
    });
  },

  // 合约平空
  async futuresCloseShort(instId, quantity) {
    return this.api('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cross', side: 'buy', ordType: 'market', sz: quantity.toString(), posSide: 'short'
    });
  },

  async getPositions() {
    const res = await this.api('GET', '/api/v5/account/positions');
    if (res.code !== '0') return { error: res.msg };
    return (res.data || []).filter(p => parseFloat(p.pos) > 0);
  }
};

// ============ 深度分析工具 ============

/**
 * 计算在指定档位内能吃到的平均价格和最大金额
 * @param {Array} levels - [{price, qty}, ...]
 * @param {number} targetUsd - 目标金额（美元）
 * @returns {{ avgPrice: number, fillableUsd: number, slippageBps: number, filled: boolean }}
 */
function calcDepthFill(levels, targetUsd) {
  let filledQty = 0;
  let filledUsd = 0;
  const bestPrice = levels[0]?.price || 0;

  for (const level of levels) {
    const levelUsd = level.price * level.qty;
    const remaining = targetUsd - filledUsd;

    if (remaining <= 0) break;

    if (levelUsd >= remaining) {
      const qtyNeeded = remaining / level.price;
      filledQty += qtyNeeded;
      filledUsd += remaining;
    } else {
      filledQty += level.qty;
      filledUsd += levelUsd;
    }
  }

  const avgPrice = filledQty > 0 ? filledUsd / filledQty : 0;
  const slippageBps = bestPrice > 0 ? Math.abs(avgPrice - bestPrice) / bestPrice * 10000 : 0;

  return {
    avgPrice,
    fillableUsd: filledUsd,
    slippageBps: Math.round(slippageBps * 100) / 100,
    filled: filledUsd >= targetUsd * 0.99
  };
}

/**
 * 检查某个币对在两个交易所间是否有套利深度
 * @param {string} symbol - 交易对
 * @param {string} lowEx - 低价所
 * @param {string} highEx - 高价所  
 * @param {number} tradeUsd - 单笔金额
 * @returns {{ viable: boolean, buySlippage: number, sellSlippage: number, netSpreadBps: number }}
 */
async function checkArbDepth(symbol, lowEx, highEx, tradeUsd) {
  const exchanges = { binance, bybit, bitget, okx };
  
  // 统一symbol格式
  const symbolMap = {
    binance: symbol.replace('-', '').replace('/', ''),
    bybit: symbol.replace('-', '').replace('/', ''),
    bitget: symbol.replace('-', '').replace('/', ''),
    okx: symbol.includes('-') ? symbol : symbol.replace(/USDT$/, '-USDT')
  };

  const [buyBook, sellBook] = await Promise.all([
    exchanges[lowEx].getOrderbook(symbolMap[lowEx], 20),
    exchanges[highEx].getOrderbook(symbolMap[highEx], 20)
  ]);

  if (!buyBook || !sellBook) return { viable: false, reason: '盘口数据获取失败' };

  // 在低价所买入（吃卖盘）
  const buyFill = calcDepthFill(buyBook.asks, tradeUsd);
  // 在高价所卖出（吃买盘）
  const sellFill = calcDepthFill(sellBook.bids, tradeUsd);

  if (!buyFill.filled || !sellFill.filled) {
    return { viable: false, reason: `深度不足: 买${buyFill.fillableUsd.toFixed(0)}/${tradeUsd} 卖${sellFill.fillableUsd.toFixed(0)}/${tradeUsd}` };
  }

  // 净价差 = 卖出均价 - 买入均价（扣除滑点后）
  const netSpreadBps = (sellFill.avgPrice - buyFill.avgPrice) / buyFill.avgPrice * 10000;

  // 扣除手续费（假设 maker 0.1% = 10bps 每边，总共 20bps）
  const feesBps = 20;
  const profitBps = netSpreadBps - feesBps;

  return {
    viable: profitBps > 0,
    buyAvgPrice: buyFill.avgPrice,
    sellAvgPrice: sellFill.avgPrice,
    buySlippageBps: buyFill.slippageBps,
    sellSlippageBps: sellFill.slippageBps,
    netSpreadBps: Math.round(netSpreadBps * 100) / 100,
    profitBps: Math.round(profitBps * 100) / 100,
    estimatedProfit: tradeUsd * profitBps / 10000
  };
}

// ============ 统一接口 ============
const exchanges = { binance, bybit, bitget, okx };

function getExchange(name) {
  return exchanges[name.toLowerCase()];
}

// ============ 日志 ============
function logTrade(data) {
  const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
  fs.appendFileSync('/root/.openclaw/workspace/crypto/real_trade_log.jsonl', line + '\n');
}

// ============ 自动划转 ============

/**
 * 确保某个交易所的合约账户有足够余额，不够就从现货划转
 * @param {string} exchange - binance/bybit/bitget/okx
 * @param {number} needed - 需要的USDT金额
 * @returns {boolean} 是否有足够余额
 */
async function ensureFuturesBalance(exchange, needed) {
  try {
    // Bybit和OKX是统一账户，不需要划转
    if (exchange === 'bybit' || exchange === 'okx') return true;

    if (exchange === 'binance') {
      const fut = await binance.getFuturesBalance();
      if (fut.available >= needed) return true;
      
      const spot = await binance.getBalance();
      const transferAmount = Math.min(spot.usdt, needed - fut.available + 50); // 多划50缓冲
      if (transferAmount < 10) return false;
      
      const res = await binance.api('POST', '/sapi/v1/futures/transfer', {
        asset: 'USDT', amount: transferAmount.toFixed(2), type: '1' // 1=现货→合约
      });
      if (res.tranId) {
        console.log(`  💱 Binance 划转 $${transferAmount.toFixed(0)} 现货→合约`);
        return true;
      }
      return false;
    }

    if (exchange === 'bitget') {
      const fut = await bitget.getFuturesBalance();
      if (fut.usdt >= needed) return true;
      
      const spot = await bitget.getBalance();
      const transferAmount = Math.min(spot.usdt, needed - fut.usdt + 50);
      if (transferAmount < 10) return false;
      
      const res = await bitget.api('POST', '/api/v2/spot/wallet/transfer', null, {
        fromType: 'spot', toType: 'usdt_futures', coin: 'USDT',
        size: transferAmount.toFixed(2), amount: transferAmount.toFixed(2)
      });
      if (res.code === '00000') {
        console.log(`  💱 Bitget 划转 $${transferAmount.toFixed(0)} 现货→合约`);
        return true;
      }
      return false;
    }

    return false;
  } catch (e) {
    console.log(`  ⚠️ ${exchange} 划转失败: ${e.message}`);
    return false;
  }
}

/**
 * 确保某个交易所的现货账户有足够余额，不够就从合约划转
 */
async function ensureSpotBalance(exchange, needed) {
  try {
    if (exchange === 'bybit' || exchange === 'okx') return true;

    if (exchange === 'binance') {
      const spot = await binance.getBalance();
      if (spot.usdt >= needed) return true;
      
      const fut = await binance.getFuturesBalance();
      const transferAmount = Math.min(fut.available, needed - spot.usdt + 50);
      if (transferAmount < 10) return false;
      
      const res = await binance.api('POST', '/sapi/v1/futures/transfer', {
        asset: 'USDT', amount: transferAmount.toFixed(2), type: '2' // 2=合约→现货
      });
      if (res.tranId) {
        console.log(`  💱 Binance 划转 $${transferAmount.toFixed(0)} 合约→现货`);
        return true;
      }
      return false;
    }

    if (exchange === 'bitget') {
      const spot = await bitget.getBalance();
      if (spot.usdt >= needed) return true;
      
      const fut = await bitget.getFuturesBalance();
      const transferAmount = Math.min(fut.usdt, needed - spot.usdt + 50);
      if (transferAmount < 10) return false;
      
      const res = await bitget.api('POST', '/api/v2/spot/wallet/transfer', null, {
        fromType: 'usdt_futures', toType: 'spot', coin: 'USDT',
        size: transferAmount.toFixed(2), amount: transferAmount.toFixed(2)
      });
      if (res.code === '00000') {
        console.log(`  💱 Bitget 划转 $${transferAmount.toFixed(0)} 合约→现货`);
        return true;
      }
      return false;
    }

    return false;
  } catch (e) {
    console.log(`  ⚠️ ${exchange} 划转失败: ${e.message}`);
    return false;
  }
}

module.exports = {
  binance, bybit, bitget, okx,
  exchanges, getExchange,
  calcDepthFill, checkArbDepth,
  ensureFuturesBalance, ensureSpotBalance,
  logTrade
};

// ============ CLI测试 ============
if (require.main === module) {
  (async () => {
    console.log('=== 四所余额 ===');
    const [bn, by, bg, ok] = await Promise.all([
      binance.getBalance(), bybit.getBalance(), bitget.getBalance(), okx.getBalance()
    ]);
    console.log('Binance:', bn.error || `$${bn.usdt}`);
    console.log('Bybit:  ', by.error || `$${by.usdt}`);
    console.log('Bitget: ', bg.error || `$${bg.usdt}`);
    console.log('OKX:    ', ok.error || `$${ok.usdt} (权益:$${ok.equity})`);

    console.log('\n=== BTC盘口深度测试 ($100) ===');
    const depth = await checkArbDepth('BTCUSDT', 'binance', 'bybit', 100);
    console.log(JSON.stringify(depth, null, 2));
  })();
}
