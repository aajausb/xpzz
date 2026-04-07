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
  // 1. 搜索项目信息（Exa）
  let searchContext = '';
  try {
    const query = `${s.tokenName || s.symbol} ${s.chain === 'solana' ? 'solana' : s.chain} meme token`;
    searchContext = await exaSearch(query);
  } catch (e) {
    searchContext = '(搜索失败)';
  }

  // 2. 调AI分析
  const analysis = await callAI(s, searchContext);

  // 3. 组装消息
  const msg = buildMessage(s, analysis);

  // 4. 发TG
  await sendTG(msg, s.buttons);
  console.log(`✅ ${s.symbol}(${s.chain}) 分析完成并发送`);
}

async function exaSearch(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      query,
      numResults: 3,
      type: 'neural',
      useAutoprompt: true,
      contents: { text: { maxCharacters: 500 } }
    });
    const req = https.request({
      hostname: 'api.exa.ai',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.EXA_API_KEY || '',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const snippets = (j.results || []).map(r => `${r.title}: ${r.text?.slice(0, 200) || ''}`).join('\n');
          resolve(snippets || '(无结果)');
        } catch { resolve('(解析失败)'); }
      });
    });
    req.on('error', e => resolve('(请求失败)'));
    req.setTimeout(10000, () => { req.destroy(); resolve('(超时)'); });
    req.write(postData);
    req.end();
  });
}

async function callAI(s, searchContext) {
  const prompt = `你是土狗meme币分析师。用中文分析这个信号，简洁有力，不要说"小仓试探"之类的保守建议。

信号数据:
- 币名: ${s.tokenName || s.symbol} (${s.symbol})
- 链: ${s.chain}
- 猎手: ${s.hunters}, 哨兵: ${s.scouts}
- SM实时持有: $${s.smLiveTotal}
- SM钱包: ${s.smWallets}
- 市值: ${s.mcapStr}, 流动性: ${s.liqStr}
- 24h成交: $${Math.round(s.volume24h || 0)}
- 买/卖笔数: ${s.buys || 0}/${s.sells || 0}
- 网站: ${s.website || '无'}
- 推特: ${s.twitter || '无'}

搜索结果:
${searchContext}

请按以下5个维度分析，每个维度1-2句话：
1. 叙事（宏大性/唯一性/热点关联）
2. SM态度（持仓力度/钱包级别）
3. 盘面（市值/流动性/成交量）
4. 社区（网站/推特/运营投入）
5. 推特热度（🟢高/🟡中/🔴低）

最后给评分 xx/100 和一句话总结。不要评价24h涨跌和币龄。

格式要求：纯文本，不要用markdown（不要#标题、不要**加粗**、不要---分割线）。每个维度用"叙事:"、"SM态度:"、"盘面:"、"社区:"、"推特热度:"开头，评分用"📊 评分: xx/100 🟢/🟡/🔴"格式，最后一行"💡"开头写总结。`;

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
    formatted += clean + '\n';
  }
  text += formatted.trim();
  
  text += `\n\n📝 <code>${s.token}</code>`;
  
  return text;
}

async function sendTG(text, buttons) {
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
    req.on('error', e => { console.error('TG请求失败:', e.message); resolve({}); });
    req.write(postData);
    req.end();
  });
}
