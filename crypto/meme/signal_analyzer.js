#!/usr/bin/env node
/**
 * 信号分析脚本：接收引擎数据 → 调AI分析 → 发TG通知
 * 用法: echo '<json>' | node signal_analyzer.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// 从.env读取配置
const envFile = path.join(__dirname, '../../.env');
try {
  const env = fs.readFileSync(envFile, 'utf8');
  env.split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '877233818';

// 从stdin读取信号数据
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', async () => {
  try {
    const signal = JSON.parse(input);
    await processSignal(signal);
  } catch (e) {
    console.error('分析失败:', e.message);
    process.exit(1);
  }
});

async function processSignal(s) {
  // 0. 如果SM数据不完整，从pending_signals查钱包地址并查链上余额
  if (!s.smLiveTotal || s.smLiveTotal === 0) {
    try {
      const pendingPath = path.join(__dirname, 'data/v8/pending_signals.json');
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      const entries = pending[s.token];
      if (entries && Array.isArray(entries) && entries.length > 0) {
        const wallets = entries.map(e => ({
          address: e.wallet,
          rank: e.walletRank,
          status: e.walletStatus
        })).filter(w => w.address);
        
        if (wallets.length > 0) {
          // 查链上余额
          const price = await getTokenPrice(s.token);
          let totalValue = 0;
          let holdingCount = 0;
          const hunters = wallets.filter(w => w.status === 'hunter').length;
          const scouts = wallets.filter(w => w.status === 'scout').length;
          
          for (const w of wallets) {
            const bal = await queryOnChainBalance(s.chain, w.address, s.token);
            if (bal > 0 && price > 0) {
              const val = bal * price;
              totalValue += val;
              holdingCount++;
            }
          }
          
          s.hunters = s.hunters || hunters;
          s.scouts = s.scouts || scouts;
          s.smLiveTotal = Math.round(totalValue);
          s.smWallets = `${hunters}猎手+${scouts}哨兵(${holdingCount}个仍持仓)`;
          console.log(`SM链上查询: ${wallets.length}个钱包, ${holdingCount}个持仓, 总值$${Math.round(totalValue)}`);
        }
      }
    } catch (e) {
      console.log('SM链上查询跳过:', e.message);
    }
  }

  // 1. 用Jina Reader抓项目网站和推特内容 + DuckDuckGo搜叙事
  let searchContext = '';
  try {
    const fetches = [];
    if (s.website) fetches.push(jinaFetch(s.website).then(t => t ? `[网站] ${t}` : ''));
    if (s.twitter) fetches.push(jinaFetch(s.twitter).then(t => t ? `[推特] ${t}` : ''));
    // DuckDuckGo搜索叙事补充
    const chainName = s.chain === 'solana' ? 'solana' : s.chain === 'bsc' ? 'BSC' : 'base';
    const ddgQuery = `${s.symbol} ${chainName} meme coin`;
    fetches.push(ddgSearch(ddgQuery).then(t => t ? `[搜索] ${t}` : ''));
    // 如果是pump币，搜推特讨论
    if (s.token && s.token.endsWith('pump')) {
      fetches.push(ddgSearch(`${s.symbol} solana site:x.com`).then(t => t ? `[推特搜索] ${t}` : ''));
    }
    const results = await Promise.all(fetches);
    searchContext = results.filter(r => r).join('\n\n');
  } catch (e) {
    searchContext = '(抓取失败)';
  }

  // 2. 调AI分析
  const analysis = await callAI(s, searchContext);

  // 3. 组装消息
  const msg = buildMessage(s, analysis);

  // 4. 解析评分，≥70自动买入
  const scoreMatch = analysis.match(/总分[:\s]*(\d+)\/100/);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
  let buyResult = null;
  
  if (score >= 70 && s.token) {
    try {
      const dex = require('./dex_trader');
      const buyAmountUsd = 200;
      const nativePrice = await getNativePrice(s.chain);
      if (nativePrice > 0) {
        const decimals = s.chain === 'solana' ? 1e9 : 1e18;
        const amountNative = Math.floor(buyAmountUsd / nativePrice * decimals);
        console.log(`🤖 评分${score}≥70，自动买入$${buyAmountUsd} ${s.symbol}(${s.chain})...`);
        // 最多重试3次
        for (let attempt = 1; attempt <= 3; attempt++) {
          buyResult = await dex.buy(s.chain, s.token, amountNative);
          if (buyResult && buyResult.success) {
            console.log(`✅ 自动买入成功(第${attempt}次)! TX: ${buyResult.txHash}`);
            break;
          }
          console.log(`❌ 第${attempt}次买入失败: ${buyResult?.error || '未知'}, ${attempt < 3 ? '3秒后重试...' : '放弃'}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
        }
        if (buyResult && buyResult.success) {
          console.log(`✅ 自动买入成功! TX: ${buyResult.txHash}`);
          // 写入buy_queue.json，让引擎自己读取并加入positions
          const queuePath = path.join(__dirname, 'data/v8/buy_queue.json');
          const queue = (() => { try { return JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { return []; } })();
          const tokenPrice = await getTokenPrice(s.token);
          queue.push({
            token: s.token, symbol: s.symbol, chain: s.chain,
            buyPrice: tokenPrice, buyCost: buyAmountUsd,
            buyAmount: parseInt(buyResult.routerResult?.toTokenAmount || '0'),
            buyTime: Date.now(), txHash: buyResult.txHash
          });
          fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
          console.log(`📝 已写入buy_queue，等待引擎读取`);
        } else {
          console.error(`❌ 自动买入失败: ${buyResult?.error || '未知错误'}`);
        }
      } else {
        console.error('❌ 无法获取原生代币价格，跳过自动买入');
      }
    } catch (e) {
      console.error('❌ 自动买入异常:', e.message);
    }
  }

  // 5. 发TG（带重试）
  let finalMsg = msg;
  if (buyResult && buyResult.success) {
    finalMsg += `\n\n🤖 <b>自动买入$200</b> ✅`;
  } else if (score >= 70 && !buyResult?.success) {
    finalMsg += `\n\n🤖 自动买入失败 ❌`;
  }
  await sendTGWithRetry(finalMsg, score >= 70 ? [] : s.buttons, s.token, s.chain);
  console.log(`✅ ${s.symbol}(${s.chain}) 分析完成并发送`);
}

async function exaSearch(query) {
  return '(跳过搜索，用DuckDuckGo)';
}

// 查原生代币价格（SOL/BNB/ETH）
async function getNativePrice(chain) {
  // 用OKX quote接口：查USDT→wSOL/wBNB/wETH报价，从toToken.tokenUnitPrice拿价格
  try {
    const dex = require('./dex_trader');
    const CHAIN_ID = { solana: '501', bsc: '56', base: '8453' };
    const USDT = {
      solana: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      bsc: '0x55d398326f99059fF775485246999027B3197955',
      base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    };
    const WRAPPED = {
      solana: 'So11111111111111111111111111111111111111112',
      bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      base: '0x4200000000000000000000000000000000000006'
    };
    const amt = chain === 'solana' ? '1000000' : '1000000000000000000';
    const quote = await dex.okxGet('/api/v6/dex/aggregator/quote', {
      chainIndex: CHAIN_ID[chain],
      fromTokenAddress: USDT[chain],
      toTokenAddress: WRAPPED[chain],
      amount: amt
    });
    if (quote.code === '0' && quote.data?.[0]) {
      // 从路由里找toToken的unitPrice
      const routes = quote.data[0].dexRouterList || [];
      for (const r of routes) {
        const p = parseFloat(r.toToken?.tokenUnitPrice || '0');
        if (p > 0) { console.log(`OKX报价: ${chain} = $${p}`); return p; }
      }
    }
  } catch(e) {
    console.log(`OKX价格查询失败: ${e.message}`);
  }
  
  // Fallback: CoinGecko
  const ids = { solana: 'solana', bsc: 'binancecoin', base: 'ethereum' };
  const id = ids[chain] || 'solana';
  return new Promise(resolve => {
    https.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)[id]?.usd || 0); }
        catch { resolve(0); }
      });
    }).on('error', () => resolve(0));
  });
}

// 查token现价（DexScreener）
async function getTokenPrice(tokenAddress) {
  return new Promise(resolve => {
    https.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const pairs = JSON.parse(d).pairs;
          if (pairs && pairs[0]) resolve(parseFloat(pairs[0].priceUsd) || 0);
          else resolve(0);
        } catch { resolve(0); }
      });
    }).on('error', () => resolve(0));
  });
}

// 查链上token余额
async function queryOnChainBalance(chain, walletAddress, tokenAddress) {
  if (chain === 'solana') {
    return new Promise(resolve => {
      const postData = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [walletAddress, { mint: tokenAddress }, { encoding: 'jsonParsed', commitment: 'confirmed' }]
      });
      const req = https.request({ hostname: 'api.mainnet-beta.solana.com', path: '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const accs = JSON.parse(d).result?.value || [];
            if (accs.length > 0) {
              resolve(parseFloat(accs[0].account.data.parsed.info.tokenAmount.uiAmountString) || 0);
            } else resolve(0);
          } catch { resolve(0); }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(10000, () => { req.destroy(); resolve(0); });
      req.write(postData);
      req.end();
    });
  }
  // EVM (BSC/Base): 用OKX钱包API查余额
  return new Promise(resolve => {
    const chainIndex = chain === 'bsc' ? '56' : '8453';
    const apiPath = `/api/v5/wallet/asset/token-balances-by-address?chainIndex=${chainIndex}&address=${walletAddress}&tokenContractAddresses=${tokenAddress}`;
    const req = https.request({
      hostname: 'www.okx.com', path: apiPath, method: 'GET',
      headers: { 'OK-ACCESS-KEY': process.env.OKX_API_KEY || '' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(d).data;
          if (data && data[0]) {
            const raw = data[0].balance || '0';
            const decimals = parseInt(data[0].tokenContractDecimal || data[0].decimals || '18');
            const humanBalance = parseFloat(raw) / Math.pow(10, decimals);
            resolve(humanBalance);
          } else resolve(0);
        } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// DuckDuckGo HTML搜索：抓搜索结果标题+摘要
async function ddgSearch(query) {
  return new Promise((resolve) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; if (d.length > 10000) { res.destroy(); finish(d); } });
      res.on('end', () => finish(d));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(10000, () => { req.destroy(); resolve(''); });

    function finish(html) {
      // 检查是否被限流（人机验证）
      if (html.includes('Please complete the following challenge') || html.includes('select all squares')) {
        resolve('(搜索限流)');
        return;
      }
      // 提取搜索结果：标题和摘要
      const results = [];
      const titleRe = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs;
      const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      let m;
      while ((m = titleRe.exec(html)) && results.length < 5) {
        results.push(m[1].replace(/<[^>]+>/g, '').trim());
      }
      while ((m = snippetRe.exec(html)) && results.length < 10) {
        results.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim());
      }
      resolve(results.join('\n').slice(0, 2000) || '(无结果)');
    }
  });
}

// Jina Reader: 抓任意URL内容
async function jinaFetch(url) {
  if (!url || url === '-') return '';
  return new Promise((resolve) => {
    const req = https.get(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let d = ''; 
      res.on('data', c => { d += c; if (d.length > 3000) { res.destroy(); resolve(d.slice(0, 3000)); } });
      res.on('end', () => resolve(d.slice(0, 3000)));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
  });
}

async function callAI(s, searchContext) {
  // 计算辅助数据
  const mcapNum = parseFloat((s.mcapStr || '').replace(/[$,KMB]/gi, '')) || 0;
  const mcapMultiplier = (s.mcapStr || '').includes('M') ? 1000000 : (s.mcapStr || '').includes('K') ? 1000 : 1;
  const mcapUsd = mcapNum * mcapMultiplier;
  const smPct = mcapUsd > 0 ? ((s.smLiveTotal || 0) / mcapUsd * 100).toFixed(2) : '?';
  const turnoverRate = mcapUsd > 0 ? ((s.volume24h || 0) / mcapUsd * 100).toFixed(0) : '?';
  const buyRatio = (s.buys || 0) + (s.sells || 0) > 0 ? ((s.buys || 0) / ((s.buys || 0) + (s.sells || 0)) * 100).toFixed(0) : '?';

  const prompt = `你是Web3土狗meme币分析师，用链上数据思维评估信号。

核心原则：
- 这些币已通过聪明钱(SM)确认门槛，SM正在持仓，不要默认看空
- "没网站没推特"不扣分——pump.fun上90%的十倍币啥都没有，有精美网站反而可能是包装骗局
- 评分基于链上硬数据，不基于"看起来正不正规"
- 不要说"小仓试探"之类的保守建议，土狗就是高风险高回报

信号数据:
- 币名: ${s.tokenName || s.symbol} (${s.symbol})
- 链: ${s.chain}
- 猎手: ${s.hunters}, 哨兵: ${s.scouts}（总SM: ${(s.hunters || 0) + (s.scouts || 0)}个）
- SM实时持有: $${s.smLiveTotal}（占市值${smPct}%）
- SM钱包: ${s.smWallets}
- 市值: ${s.mcapStr}, 流动性: ${s.liqStr}
- 24h成交: $${Math.round(s.volume24h || 0)}（换手率${turnoverRate}%）
- 买/卖笔数: ${s.buys || 0}/${s.sells || 0}（买盘占比${buyRatio}%）
- 网站: ${s.website || '无'}
- 推特: ${s.twitter || '无'}

搜索到的叙事信息:
${searchContext || '(无法获取)'}

按以下4个维度分析，严格按权重评分：

1. SM共识（30分）— 评判标准：
   - SM数量（≥3个=高共识，2个=中等，1个=低）
   - 持仓占市值比（>1%=重仓，0.1-1%=中等，<0.1%=轻仓）
   - 猎手vs哨兵比例（猎手多=更强信号）
   参考：$1000在$50K币里=2%重仓，在$5M币里=0.02%可忽略

2. 盘面动能（25分）— 评判标准：
   - 换手率（>100%=极活跃，50-100%=活跃，<50%=冷清）
   - 买卖比（买盘>55%=买压强，45-55%=均衡，<45%=卖压）
   - 流动性占市值比（>10%=健康，5-10%=尚可，<5%=危险）

3. 叙事传播力（25分）— 评判标准：
   - 能否一句话说清概念（能=好，需要解释=差）
   - 有没有情绪触发点（搞笑/愤怒/FOMO/蹭热点）
   - 有没有催化剂（名人背书/事件驱动/病毒传播）
   - 注意：简单的概念（数字梗/emoji/动物）反而更容易传播
   - 注意：有没有网站和推特不影响这个维度的评分

4. 风险信号（20分，满分=低风险）— 评判标准：
   - LP是否burn/合约是否renounce
   - 流动性是否过低（<$10K=高危）
   - 只根据已知数据评分，没有的数据不扣分也不提

格式要求：纯文本，不要用markdown。
SM共识(x/30): 一句话
盘面(x/25): 一句话
叙事(x/25): 2-3句，说清概念+情绪触发点+催化剂
风险(x/20): 一句话
📊 总分: xx/100 🟢(≥65)/🟡(40-64)/🔴(<40)
💡 一句话总结`;

  // 读fusecode API key和配置
  let fusecodeKey = '';
  try {
    const modelsJson = JSON.parse(fs.readFileSync(path.join(process.env.HOME || '/root', '.openclaw/agents/main/agent/models.json'), 'utf8'));
    fusecodeKey = modelsJson.providers?.fusecode?.apiKey || '';
  } catch {}

  return new Promise((resolve, reject) => {
    // Anthropic Messages API格式
    const postData = JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'www.fusecode.cc',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': fusecodeKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          // Anthropic格式: content[0].text
          const text = j.content?.[0]?.text || j.choices?.[0]?.message?.content || '(AI无响应)';
          resolve(text);
        } catch { resolve('(AI解析失败: ' + d.slice(0, 100) + ')'); }
      });
    });
    req.on('error', e => resolve('(AI请求失败: ' + e.message + ')'));
    req.setTimeout(60000, () => { req.destroy(); resolve('(AI超时)'); });
    req.write(postData);
    req.end();
  });
}

function buildMessage(s, analysis) {
  // 解析AI分析内容，提取各维度
  let text = `🔔 信号达标 ${s.symbol}(${s.chain})\n`;
  
  // SM状态：显示实时持仓情况
  const smTotal = (s.hunters || 0) + (s.scouts || 0);
  const holdingInfo = s.smWallets || '';
  const holdingMatch = holdingInfo.match(/(\d+)个仍持仓/);
  const stillHolding = holdingMatch ? parseInt(holdingMatch[1]) : smTotal;
  
  if (s.smLiveTotal > 0) {
    text += `📊 SM ${stillHolding}/${smTotal}个仍持仓 | 实时持有$${s.smLiveTotal}\n`;
  } else if (smTotal > 0) {
    text += `📊 SM ${smTotal}个曾买入 | ⚠️ 全部已清仓\n`;
  } else {
    text += `📊 SM数据未知\n`;
  }
  text += `🏹 ${s.smWallets}\n`;
  text += `💰 市值: ${s.mcapStr} | 流动性: ${s.liqStr}\n`;
  
  // 池子信息
  if (s.quoteSymbol) text += `🏊 主池: ${s.symbol}/${s.quoteSymbol}\n`;
  
  // 网站/推特
  const links = [];
  if (s.website) links.push(s.website);
  if (s.twitter) links.push(s.twitter);
  if (links.length > 0) text += `🌐 ${links.join(' | ')}\n`;
  
  text += `\n🧠 AI分析:\n\n`;
  
  // 解析AI输出，格式化
  const lines = analysis.split('\n').filter(l => l.trim());
  let formatted = '';
  for (const line of lines) {
    // 去掉markdown **bold**
    let clean = line.replace(/\*\*/g, '').trim();
    // 去掉开头的数字编号 (1. 2. 等)
    clean = clean.replace(/^\d+\.\s*/, '');
    // HTML转义（防止<$500之类的被TG当标签解析）
    clean = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    formatted += clean + '\n';
  }
  text += formatted.trim();
  
  text += `\n\n📝 <code>${s.token}</code>`;
  
  return text;
}

async function sendTG(text, buttons, token, chain) {
  // 如果没传buttons但有token，自动生成买入按钮
  if ((!buttons || buttons.length === 0) && token) {
    const shortToken = token.slice(0, 20);
    const c = chain === 'solana' ? 's' : chain === 'bsc' ? 'b' : 'a';
    buttons = [
      { text: '买$100', callback_data: `b_${c}_${shortToken}_100` },
      { text: '买$200', callback_data: `b_${c}_${shortToken}_200` },
      { text: '买$300', callback_data: `b_${c}_${shortToken}_300` },
      { text: '跳过', callback_data: `b_${c}_${shortToken}_0` },
    ];
  }
  const inlineKeyboard = [];
  if (buttons && buttons.length >= 3) {
    inlineKeyboard.push([
      { text: buttons[0].text, callback_data: buttons[0].callback_data },
      { text: buttons[1].text, callback_data: buttons[1].callback_data },
      { text: buttons[2].text, callback_data: buttons[2].callback_data },
    ]);
    if (buttons[3]) {
      inlineKeyboard.push([{ text: buttons[3].text, callback_data: buttons[3].callback_data }]);
    }
  }

  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
  };
  if (inlineKeyboard.length > 0) {
    payload.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (!r.ok) console.error('TG发送失败:', d.slice(0, 200));
          resolve(r);
        } catch { resolve({}); }
      });
    });
    req.on('error', e => { console.error('TG请求失败:', e.message); resolve({ ok: false, retryable: true }); });
    req.write(postData);
    req.end();
  });
}

// 带重试的TG发送
async function sendTGWithRetry(text, buttons, token, chain) {
  let result = await sendTG(text, buttons, token, chain);
  if (!result.ok) {
    console.log('TG发送失败，3秒后重试...');
    await new Promise(r => setTimeout(r, 3000));
    result = await sendTG(text, buttons, token, chain);
    if (!result.ok) console.error('TG重试仍失败');
  }
  return result;
}
