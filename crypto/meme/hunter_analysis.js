const fs = require('fs');
const https = require('https');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data/v8/wallet_db.json');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const hunters = Object.values(db).filter(w => w.chain === 'solana' && w.status === 'hunter')
  .sort((a,b) => (b.winRate||0) - (a.winRate||0));

const SOL_RPC = 'https://morning-dry-market.solana-mainnet.quiknode.pro/6664c189556346b5503ea032fb269e81291957ab/';

function rpcPost(url, method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function analyzeHunter(hunter, idx) {
  const addr = hunter.address;
  console.log(`[${idx+1}/${hunters.length}] ${addr.slice(0,10)}... WR:${(hunter.winRate||0).toFixed(1)}% tokens:${hunter.tokens}`);
  
  // 拉最近50条签名
  try {
    const sigs = await rpcPost(SOL_RPC, 'getSignaturesForAddress', [addr, { limit: 50 }]);
    const signatures = sigs.result || [];
    if (signatures.length === 0) return null;
    
    // 时间分布
    const times = signatures.map(s => s.blockTime).filter(Boolean);
    const now = Math.floor(Date.now() / 1000);
    const recentDay = times.filter(t => now - t < 86400).length;
    const recentWeek = times.filter(t => now - t < 604800).length;
    
    // 活跃时段
    const hours = times.map(t => new Date(t * 1000).getUTCHours());
    const hourCounts = {};
    for (const h of hours) { hourCounts[h] = (hourCounts[h] || 0) + 1; }
    const peakHour = Object.entries(hourCounts).sort((a,b) => b[1]-a[1])[0];
    
    // 交易频率
    const oldest = Math.min(...times);
    const span = (now - oldest) / 86400; // days
    const txPerDay = signatures.length / Math.max(span, 1);
    
    // 解析前10条找swap模式
    let swapCount = 0, pumpCount = 0, rayCount = 0;
    const tokens = new Set();
    for (let i = 0; i < Math.min(10, signatures.length); i++) {
      try {
        await sleep(200);
        const tx = await rpcPost(SOL_RPC, 'getTransaction', [signatures[i].signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        const instructions = tx.result?.transaction?.message?.instructions || [];
        const programs = instructions.map(inst => inst.programId || inst.program || '');
        if (programs.some(p => p.includes('pump'))) pumpCount++;
        if (programs.some(p => p.includes('675k') || p.includes('Raydium'))) rayCount++;
        
        // 提取交易的token
        const postBals = tx.result?.meta?.postTokenBalances || [];
        for (const b of postBals) {
          if (b.owner === addr && b.mint !== 'So11111111111111111111111111111111111111112') {
            tokens.add(b.mint);
          }
        }
        swapCount++;
      } catch {}
    }
    
    return {
      address: addr.slice(0, 10),
      winRate: hunter.winRate || 0,
      totalTokens: hunter.tokens || 0,
      pnl: hunter.pnl || 0,
      recentDay, recentWeek,
      txPerDay: txPerDay.toFixed(1),
      peakHourUTC: peakHour ? parseInt(peakHour[0]) : -1,
      peakHourCST: peakHour ? (parseInt(peakHour[0]) + 8) % 24 : -1,
      pumpRatio: swapCount > 0 ? (pumpCount / swapCount * 100).toFixed(0) + '%' : '?',
      rayRatio: swapCount > 0 ? (rayCount / swapCount * 100).toFixed(0) + '%' : '?',
      uniqueTokens: tokens.size,
    };
  } catch(e) {
    return { address: addr.slice(0, 10), error: e.message?.slice(0, 30) };
  }
}

(async () => {
  console.log('=== SOL猎手行为分析 ===\n');
  const results = [];
  
  // 分析TOP20猎手（控制API调用量）
  const top = hunters.slice(0, 20);
  for (let i = 0; i < top.length; i++) {
    const r = await analyzeHunter(top[i], i);
    if (r) results.push(r);
    await sleep(500);
  }
  
  // 汇总
  console.log('\n=== 汇总 ===');
  const active = results.filter(r => !r.error);
  
  // 1. 活跃度
  const avgTxDay = active.reduce((s,r) => s + parseFloat(r.txPerDay||0), 0) / active.length;
  console.log(`平均交易频率: ${avgTxDay.toFixed(1)}笔/天`);
  
  // 2. pump.fun占比
  const pumpUsers = active.filter(r => parseInt(r.pumpRatio) > 50).length;
  console.log(`pump.fun为主: ${pumpUsers}/${active.length} (${(pumpUsers/active.length*100).toFixed(0)}%)`);
  
  // 3. 活跃时段分布
  const cstHours = active.map(r => r.peakHourCST).filter(h => h >= 0);
  const hourDist = {};
  for (const h of cstHours) { 
    const slot = h < 6 ? '凌晨0-6' : h < 12 ? '上午6-12' : h < 18 ? '下午12-18' : '晚上18-24';
    hourDist[slot] = (hourDist[slot] || 0) + 1; 
  }
  console.log('活跃时段(CST):');
  for (const [slot, cnt] of Object.entries(hourDist).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${slot}: ${cnt}个猎手`);
  }
  
  // 4. 最近活跃度
  const activeRecent = active.filter(r => r.recentDay > 0).length;
  console.log(`24h内有交易: ${activeRecent}/${active.length}`);
  
  // 5. 详细表格
  console.log('\n=== 详细数据 ===');
  console.log('地址'.padEnd(12) + 'WR%'.padStart(6) + '总币'.padStart(5) + 'PnL$'.padStart(8) + '笔/天'.padStart(6) + '24h'.padStart(4) + '7d'.padStart(4) + 'pump'.padStart(6) + '峰值(CST)'.padStart(10));
  for (const r of active) {
    console.log(
      r.address.padEnd(12) +
      r.winRate.toFixed(1).padStart(6) +
      String(r.totalTokens).padStart(5) +
      ('$'+Math.round(r.pnl)).padStart(8) +
      r.txPerDay.padStart(6) +
      String(r.recentDay).padStart(4) +
      String(r.recentWeek).padStart(4) +
      r.pumpRatio.padStart(6) +
      (r.peakHourCST + ':00').padStart(10)
    );
  }
  
  // 保存结果
  fs.writeFileSync(path.join(__dirname, 'data/v8/hunter_analysis.json'), JSON.stringify(results, null, 2));
  console.log('\n✅ 结果保存到 hunter_analysis.json');
})();
