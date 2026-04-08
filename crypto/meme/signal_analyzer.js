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

  // 4. 发TG（带重试）
  await sendTGWithRetry(msg, s.buttons, s.token, s.chain);
  console.log(`✅ ${s.symbol}(${s.chain}) 分析完成并发送`);
}

async function exaSearch(query) {
  return '(跳过搜索，用DuckDuckGo)';
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
   - 持仓是否过于集中

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
  text += `📊 猎手${s.hunters}+哨兵${s.scouts} | SM实时持有$${s.smLiveTotal}\n`;
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
