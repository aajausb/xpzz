/**
 * 离线钱包生成脚本 — 断网状态下运行
 * 生成: Solana x1 + EVM x1 (BSC/Base共用)
 * 安全: 私钥分3片，AES-256加密，分散存储
 */

const { Keypair } = require('@solana/web3.js');
const { ethers } = require('ethers');
const bs58 = require('bs58');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============ 工具函数 ============

function aesEncrypt(text, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function aesDecrypt(encText, key) {
  const [ivHex, encrypted] = encText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// 私钥分成3片 (简单XOR分片)
function splitKey(privateKeyHex) {
  const keyBuf = Buffer.from(privateKeyHex, 'hex');
  const shardA = crypto.randomBytes(keyBuf.length);
  const shardB = crypto.randomBytes(keyBuf.length);
  // shardC = key XOR shardA XOR shardB
  const shardC = Buffer.alloc(keyBuf.length);
  for (let i = 0; i < keyBuf.length; i++) {
    shardC[i] = keyBuf[i] ^ shardA[i] ^ shardB[i];
  }
  return {
    a: shardA.toString('hex'),
    b: shardB.toString('hex'),
    c: shardC.toString('hex')
  };
}

// 3片恢复私钥
function recoverKey(shardAHex, shardBHex, shardCHex) {
  const a = Buffer.from(shardAHex, 'hex');
  const b = Buffer.from(shardBHex, 'hex');
  const c = Buffer.from(shardCHex, 'hex');
  const key = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    key[i] = a[i] ^ b[i] ^ c[i];
  }
  return key.toString('hex');
}

// ============ 主逻辑 ============

console.log('=== 离线钱包生成开始 ===');
console.log('时间:', new Date().toISOString());

// 1. 生成钱包
const solKeypair = Keypair.generate();
const solAddress = solKeypair.publicKey.toBase58();
const solPrivateKeyB58 = bs58.encode(solKeypair.secretKey);
// 转hex用于分片
const solPrivateKeyHex = Buffer.from(solKeypair.secretKey).toString('hex');

const evmWallet = ethers.Wallet.createRandom();
const evmAddress = evmWallet.address;
const evmPrivateKeyHex = evmWallet.privateKey.replace('0x', '');

console.log('\nSolana 地址:', solAddress);
console.log('EVM 地址:', evmAddress, '(BSC + Base)');

// 2. 分片
const solShards = splitKey(solPrivateKeyHex);
const evmShards = splitKey(evmPrivateKeyHex);

// 3. 验证分片恢复
const solRecovered = recoverKey(solShards.a, solShards.b, solShards.c);
const evmRecovered = recoverKey(evmShards.a, evmShards.b, evmShards.c);
if (solRecovered !== solPrivateKeyHex) throw new Error('Solana 分片验证失败!');
if (evmRecovered !== evmPrivateKeyHex) throw new Error('EVM 分片验证失败!');
console.log('\n分片恢复验证: ✅ 两个钱包都通过');

// 4. 生成3把加密密钥
const encKey1 = crypto.randomBytes(32);
const encKey2 = crypto.randomBytes(32);
const encKey3 = crypto.randomBytes(32);

// 5. 构建3份加密存储
// 位置1: crypto/secrets/ — 片A + 片B的密钥
const store1 = {
  created: new Date().toISOString(),
  note: 'Shard store 1/3 - crypto/secrets/',
  solana: { address: solAddress, shard: aesEncrypt(solShards.a, encKey1) },
  evm: { address: evmAddress, shard: aesEncrypt(evmShards.a, encKey1) },
  otherKey: aesEncrypt(encKey2.toString('hex'), encKey1) // 片B的解密密钥
};

// 位置2: /opt/wallet_backup/ — 片B + 片C的密钥
const store2 = {
  created: new Date().toISOString(),
  note: 'Shard store 2/3 - /opt/wallet_backup/',
  solana: { address: solAddress, shard: aesEncrypt(solShards.b, encKey2) },
  evm: { address: evmAddress, shard: aesEncrypt(evmShards.b, encKey2) },
  otherKey: aesEncrypt(encKey3.toString('hex'), encKey2) // 片C的解密密钥
};

// 位置3: 准备推GitHub — 片C + 片A的密钥
const store3 = {
  created: new Date().toISOString(),
  note: 'Shard store 3/3 - GitHub xpzz repo',
  solana: { address: solAddress, shard: aesEncrypt(solShards.c, encKey3) },
  evm: { address: evmAddress, shard: aesEncrypt(evmShards.c, encKey3) },
  otherKey: aesEncrypt(encKey1.toString('hex'), encKey3) // 片A的解密密钥
};

// 6. 写入文件
// 位置1
const dir1 = path.join(__dirname, 'secrets');
fs.mkdirSync(dir1, { recursive: true });
fs.writeFileSync(path.join(dir1, 'wallet_shard_1.enc.json'), JSON.stringify(store1, null, 2));
fs.chmodSync(path.join(dir1, 'wallet_shard_1.enc.json'), 0o600);
fs.writeFileSync(path.join(dir1, 'enc_key_1.key'), encKey1.toString('hex'));
fs.chmodSync(path.join(dir1, 'enc_key_1.key'), 0o600);
fs.chmodSync(dir1, 0o700);

// 位置2
const dir2 = '/opt/wallet_backup';
fs.mkdirSync(dir2, { recursive: true });
fs.writeFileSync(path.join(dir2, 'wallet_shard_2.enc.json'), JSON.stringify(store2, null, 2));
fs.chmodSync(path.join(dir2, 'wallet_shard_2.enc.json'), 0o600);
fs.writeFileSync(path.join(dir2, 'enc_key_2.key'), encKey2.toString('hex'));
fs.chmodSync(path.join(dir2, 'enc_key_2.key'), 0o600);
fs.chmodSync(dir2, 0o700);

// 位置3 (先存本地，联网后推GitHub)
const dir3 = path.join(__dirname, 'github_shard');
fs.mkdirSync(dir3, { recursive: true });
fs.writeFileSync(path.join(dir3, 'wallet_shard_3.enc.json'), JSON.stringify(store3, null, 2));
fs.chmodSync(path.join(dir3, 'wallet_shard_3.enc.json'), 0o600);
fs.writeFileSync(path.join(dir3, 'enc_key_3.key'), encKey3.toString('hex'));
fs.chmodSync(path.join(dir3, 'enc_key_3.key'), 0o600);
fs.chmodSync(dir3, 0o700);

// 7. 写恢复脚本
const recoverScript = `/**
 * 钱包恢复脚本 — 从3片分片恢复私钥
 * 需要3个位置的文件都在
 */
const crypto = require('crypto');
const fs = require('fs');
const bs58 = require('bs58');

function aesDecrypt(encText, key) {
  const [ivHex, encrypted] = encText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let d = decipher.update(encrypted, 'hex', 'utf8');
  d += decipher.final('utf8');
  return d;
}

function recoverKey(a, b, c) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex'), bc = Buffer.from(c, 'hex');
  const key = Buffer.alloc(ba.length);
  for (let i = 0; i < ba.length; i++) key[i] = ba[i] ^ bb[i] ^ bc[i];
  return key.toString('hex');
}

// 读取3份存储
const s1 = JSON.parse(fs.readFileSync('${path.join(dir1, 'wallet_shard_1.enc.json')}', 'utf8'));
const k1 = Buffer.from(fs.readFileSync('${path.join(dir1, 'enc_key_1.key')}', 'utf8').trim(), 'hex');
const s2 = JSON.parse(fs.readFileSync('${path.join(dir2, 'wallet_shard_2.enc.json')}', 'utf8'));
const k2 = Buffer.from(fs.readFileSync('${path.join(dir2, 'enc_key_2.key')}', 'utf8').trim(), 'hex');
const s3 = JSON.parse(fs.readFileSync('${path.join(dir3, 'wallet_shard_3.enc.json')}', 'utf8'));
const k3 = Buffer.from(fs.readFileSync('${path.join(dir3, 'enc_key_3.key')}', 'utf8').trim(), 'hex');

// 解密分片
const solA = aesDecrypt(s1.solana.shard, k1);
const solB = aesDecrypt(s2.solana.shard, k2);
const solC = aesDecrypt(s3.solana.shard, k3);
const evmA = aesDecrypt(s1.evm.shard, k1);
const evmB = aesDecrypt(s2.evm.shard, k2);
const evmC = aesDecrypt(s3.evm.shard, k3);

// 恢复
const solKeyHex = recoverKey(solA, solB, solC);
const evmKeyHex = recoverKey(evmA, evmB, evmC);

console.log('Solana 私钥 (bs58):', bs58.encode(Buffer.from(solKeyHex, 'hex')));
console.log('EVM 私钥:', '0x' + evmKeyHex);
console.log('\\n⚠️  用完立刻删除此输出！');
`;
fs.writeFileSync(path.join(__dirname, 'recover_wallets.js'), recoverScript);
fs.chmodSync(path.join(__dirname, 'recover_wallets.js'), 0o600);

// 8. 写运行时解密模块（交易用）
const runtimeModule = `/**
 * 运行时钱包解密模块
 * 启动时从3片恢复私钥到内存，进程退出自动清除
 */
const crypto = require('crypto');
const fs = require('fs');
const bs58 = require('bs58');

function aesDecrypt(encText, key) {
  const [ivHex, encrypted] = encText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let d = decipher.update(encrypted, 'hex', 'utf8');
  d += decipher.final('utf8');
  return d;
}

function recoverKey(a, b, c) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex'), bc = Buffer.from(c, 'hex');
  const key = Buffer.alloc(ba.length);
  for (let i = 0; i < ba.length; i++) key[i] = ba[i] ^ bb[i] ^ bc[i];
  return key.toString('hex');
}

let _cache = null;

function getWallets() {
  if (_cache) return _cache;
  
  const s1 = JSON.parse(fs.readFileSync('${path.join(dir1, 'wallet_shard_1.enc.json')}', 'utf8'));
  const k1 = Buffer.from(fs.readFileSync('${path.join(dir1, 'enc_key_1.key')}', 'utf8').trim(), 'hex');
  const s2 = JSON.parse(fs.readFileSync('${path.join(dir2, 'wallet_shard_2.enc.json')}', 'utf8'));
  const k2 = Buffer.from(fs.readFileSync('${path.join(dir2, 'enc_key_2.key')}', 'utf8').trim(), 'hex');
  const s3 = JSON.parse(fs.readFileSync('${path.join(dir3, 'wallet_shard_3.enc.json')}', 'utf8'));
  const k3 = Buffer.from(fs.readFileSync('${path.join(dir3, 'enc_key_3.key')}', 'utf8').trim(), 'hex');

  const solA = aesDecrypt(s1.solana.shard, k1);
  const solB = aesDecrypt(s2.solana.shard, k2);
  const solC = aesDecrypt(s3.solana.shard, k3);
  const evmA = aesDecrypt(s1.evm.shard, k1);
  const evmB = aesDecrypt(s2.evm.shard, k2);
  const evmC = aesDecrypt(s3.evm.shard, k3);

  const solKeyHex = recoverKey(solA, solB, solC);
  const evmKeyHex = recoverKey(evmA, evmB, evmC);

  _cache = {
    solana: {
      address: s1.solana.address,
      secretKey: Buffer.from(solKeyHex, 'hex'),
      privateKeyB58: bs58.encode(Buffer.from(solKeyHex, 'hex'))
    },
    evm: {
      address: s1.evm.address,
      privateKey: '0x' + evmKeyHex
    }
  };
  
  return _cache;
}

module.exports = { getWallets };
`;
fs.writeFileSync(path.join(__dirname, 'wallet_runtime.js'), runtimeModule);
fs.chmodSync(path.join(__dirname, 'wallet_runtime.js'), 0o600);

// 9. 最终验证 — 模拟运行时解密
const testS1 = JSON.parse(fs.readFileSync(path.join(dir1, 'wallet_shard_1.enc.json'), 'utf8'));
const testK1 = encKey1;
const testS2 = JSON.parse(fs.readFileSync(path.join(dir2, 'wallet_shard_2.enc.json'), 'utf8'));
const testK2 = encKey2;
const testS3 = JSON.parse(fs.readFileSync(path.join(dir3, 'wallet_shard_3.enc.json'), 'utf8'));
const testK3 = encKey3;

const testSolA = aesDecrypt(testS1.solana.shard, testK1);
const testSolB = aesDecrypt(testS2.solana.shard, testK2);
const testSolC = aesDecrypt(testS3.solana.shard, testK3);
const testSolKey = recoverKey(testSolA, testSolB, testSolC);

const testEvmA = aesDecrypt(testS1.evm.shard, testK1);
const testEvmB = aesDecrypt(testS2.evm.shard, testK2);
const testEvmC = aesDecrypt(testS3.evm.shard, testK3);
const testEvmKey = recoverKey(testEvmA, testEvmB, testEvmC);

console.log('\n=== 端到端验证 ===');
console.log('Solana 分片→加密→解密→恢复:', testSolKey === solPrivateKeyHex ? '✅' : '❌');
console.log('EVM 分片→加密→解密→恢复:', testEvmKey === evmPrivateKeyHex ? '✅' : '❌');

console.log('\n=== 文件清单 ===');
console.log('1. crypto/secrets/wallet_shard_1.enc.json + enc_key_1.key');
console.log('2. /opt/wallet_backup/wallet_shard_2.enc.json + enc_key_2.key');
console.log('3. crypto/github_shard/wallet_shard_3.enc.json + enc_key_3.key (待推GitHub)');
console.log('4. crypto/recover_wallets.js (恢复脚本)');
console.log('5. crypto/wallet_runtime.js (运行时解密模块)');

console.log('\n=== 完成 ===');
console.log('Solana:', solAddress);
console.log('EVM (BSC+Base):', evmAddress);
