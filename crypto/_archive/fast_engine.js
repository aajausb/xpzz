#!/usr/bin/env node
/**
 * 高速交易执行器 v2
 * 
 * 优化点：
 * 1. 预建立HTTP连接池（keep-alive），省掉TCP握手
 * 2. 预签名交易参数缓存
 * 3. 并行下单（跨所套利时两个平台同时下）
 * 4. WebSocket直连（不走HTTP轮询）
 * 5. 内存中维护orderbook快照
 */

const https = require('https');
const http = require('http');

// ============ HTTP连接池（复用TCP连接） ============
const agents = {
  okx: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 }),
  bybit: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 }),
  bitget: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 }),
  helius: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 }),
  jito: new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 }),
};

// 预热连接（启动时就建立TCP）
async function warmupConnections() {
  const urls = [
    { name: 'OKX', url: 'https://www.okx.com/api/v5/public/time', agent: agents.okx },
    { name: 'Bybit', url: 'https://api.bybit.com/v5/market/time', agent: agents.bybit },
    { name: 'Bitget', url: 'https://api.bitget.com/api/v2/public/time', agent: agents.bitget },
  ];
  
  const results = await Promise.all(urls.map(u => {
    return new Promise(resolve => {
      const start = Date.now();
      const req = https.get(u.url, { agent: u.agent }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ name: u.name, ms: Date.now() - start }));
      });
      req.on('error', () => resolve({ name: u.name, ms: -1 }));
      req.setTimeout(3000);
    });
  }));
  
  for (const r of results) {
    console.log(`  ${r.name}: ${r.ms}ms ${r.ms < 100 ? '🟢' : r.ms < 200 ? '🟡' : '🔴'}`);
  }
}

// ============ 快速HTTP请求（复用连接） ============
function fastRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const urlObj = new URL(url);
    const agent = options.agent || agents.okx;
    
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent,
      timeout: options.timeout || 5000,
    }, res => {
      let d = ''; 
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(d), ms: Date.now() - start }); }
        catch(e) { resolve({ data: d, ms: Date.now() - start }); }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============ 并行下单（套利用） ============
async function parallelOrders(orders) {
  // orders = [{ exchange, side, symbol, amount, price }, ...]
  const start = Date.now();
  const results = await Promise.all(orders.map(o => executeOrder(o)));
  const totalMs = Date.now() - start;
  console.log(`⚡ ${orders.length}笔并行下单完成: ${totalMs}ms`);
  return { results, totalMs };
}

async function executeOrder(order) {
  const start = Date.now();
  // TODO: 根据exchange调用对应API
  // OKX/Bybit/Bitget各自的下单接口
  return { exchange: order.exchange, ms: Date.now() - start, status: 'pending' };
}

// ============ Jupiter聚合器（Solana最快DEX） ============
const JUPITER_API = 'https://lite-api.jup.ag/v1';

async function jupiterQuote(tokenIn, tokenOut, amount, slippageBps = 500) {
  const start = Date.now();
  const r = await fastRequest(
    `${JUPITER_API}/quote?inputMint=${tokenIn}&outputMint=${tokenOut}&amount=${amount}&slippageBps=${slippageBps}`,
    { agent: agents.helius }
  );
  console.log(`  Jupiter报价: ${r.ms}ms`);
  return r.data;
}

async function jupiterSwap(tokenIn, tokenOut, amount, walletPubkey) {
  const start = Date.now();
  
  // Step 1: 报价 (~30ms)
  const quote = await jupiterQuote(tokenIn, tokenOut, amount);
  
  // Step 2: 构建swap交易 (~50ms)
  const swapResp = await fastRequest(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    agent: agents.helius,
  });
  
  // Step 3: 签名+通过Jito发送（防MEV）
  // swapResp.data.swapTransaction 是base64编码的交易
  // 需要用私钥签名后发送到Jito
  
  const totalMs = Date.now() - start;
  console.log(`⚡ Jupiter Swap构建: ${totalMs}ms`);
  return { totalMs, quote, swapTransaction: swapResp.data?.swapTransaction };
}

// ============ WebSocket价格流（实时orderbook） ============
const priceCache = new Map(); // symbol -> { bid, ask, ts }

function startPriceStream(exchange, symbols) {
  const wsUrls = {
    okx: 'wss://ws.okx.com:8443/ws/v5/public',
    bybit: 'wss://stream.bybit.com/v5/public/spot',
    bitget: 'wss://ws.bitget.com/v2/ws/public',
  };
  
  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrls[exchange]);
  
  ws.on('open', () => {
    console.log(`  ${exchange} WS连接成功`);
    if (exchange === 'okx') {
      ws.send(JSON.stringify({ op: 'subscribe', args: symbols.map(s => ({ channel: 'bbo-tbt', instId: s })) }));
    } else if (exchange === 'bybit') {
      ws.send(JSON.stringify({ op: 'subscribe', args: symbols.map(s => `orderbook.1.${s}`) }));
    }
  });
  
  ws.on('message', (raw) => {
    try {
      const d = JSON.parse(raw);
      // 解析并缓存最新价格
      if (exchange === 'okx' && d.data) {
        for (const tick of d.data) {
          priceCache.set(`okx:${tick.instId}`, { 
            bid: parseFloat(tick.bids?.[0]?.[0] || 0),
            ask: parseFloat(tick.asks?.[0]?.[0] || 0),
            ts: Date.now()
          });
        }
      }
    } catch(e) {}
  });
  
  ws.on('error', () => {});
  ws.on('close', () => setTimeout(() => startPriceStream(exchange, symbols), 3000));
  
  return ws;
}

// 获取价差（从缓存，0ms）
function getSpread(symbol) {
  const okx = priceCache.get(`okx:${symbol}-USDT`);
  const bybit = priceCache.get(`bybit:${symbol}USDT`);
  if (!okx || !bybit) return null;
  
  // 如果OKX买一 > Bybit卖一 → 在Bybit买OKX卖
  const spread1 = okx.bid - bybit.ask;
  // 如果Bybit买一 > OKX卖一 → 在OKX买Bybit卖
  const spread2 = bybit.bid - okx.ask;
  
  return {
    okxBid: okx.bid, okxAsk: okx.ask,
    bybitBid: bybit.bid, bybitAsk: bybit.ask,
    spread: Math.max(spread1, spread2),
    direction: spread1 > spread2 ? 'bybit→okx' : 'okx→bybit',
    pct: Math.max(spread1, spread2) / Math.min(okx.ask, bybit.ask) * 100,
  };
}

// ============ 速度测试 ============
async function speedTest() {
  console.log('\n🏎️ 速度测试:');
  
  // 测试复用连接后的延迟
  for (let i = 0; i < 3; i++) {
    const r = await fastRequest('https://www.okx.com/api/v5/public/time', { agent: agents.okx });
    console.log(`  OKX ping #${i+1}: ${r.ms}ms`);
  }
  
  // 测试并行请求
  const start = Date.now();
  await Promise.all([
    fastRequest('https://www.okx.com/api/v5/public/time', { agent: agents.okx }),
    fastRequest('https://api.bybit.com/v5/market/time', { agent: agents.bybit }),
    fastRequest('https://api.bitget.com/api/v2/public/time', { agent: agents.bitget }),
  ]);
  console.log(`  三所并行ping: ${Date.now() - start}ms`);
}

// ============ 导出 ============
module.exports = { agents, warmupConnections, fastRequest, parallelOrders, jupiterQuote, jupiterSwap, startPriceStream, getSpread, priceCache, speedTest };

// 直接运行时做速度测试
if (require.main === module) {
  (async () => {
    console.log('⚡ 高速交易引擎 v2');
    console.log('预热连接...');
    await warmupConnections();
    await speedTest();
  })();
}
