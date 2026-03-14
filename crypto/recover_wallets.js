/**
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
const s1 = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/crypto/secrets/wallet_shard_1.enc.json', 'utf8'));
const k1 = Buffer.from(fs.readFileSync('/root/.openclaw/workspace/crypto/secrets/enc_key_1.key', 'utf8').trim(), 'hex');
const s2 = JSON.parse(fs.readFileSync('/opt/wallet_backup/wallet_shard_2.enc.json', 'utf8'));
const k2 = Buffer.from(fs.readFileSync('/opt/wallet_backup/enc_key_2.key', 'utf8').trim(), 'hex');
const s3 = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/crypto/github_shard/wallet_shard_3.enc.json', 'utf8'));
const k3 = Buffer.from(fs.readFileSync('/root/.openclaw/workspace/crypto/github_shard/enc_key_3.key', 'utf8').trim(), 'hex');

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
console.log('\n⚠️  用完立刻删除此输出！');
