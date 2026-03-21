/**
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
  
  const s1 = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/crypto/secrets/wallet_shard_1.enc.json', 'utf8'));
  const k1 = Buffer.from(fs.readFileSync('/root/.openclaw/workspace/crypto/secrets/enc_key_1.key', 'utf8').trim(), 'hex');
  const s2 = JSON.parse(fs.readFileSync('/opt/wallet_backup/wallet_shard_2.enc.json', 'utf8'));
  const k2 = Buffer.from(fs.readFileSync('/opt/wallet_backup/enc_key_2.key', 'utf8').trim(), 'hex');
  const s3 = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/crypto/github_shard/wallet_shard_3.enc.json', 'utf8'));
  const k3 = Buffer.from(fs.readFileSync('/root/.openclaw/workspace/crypto/github_shard/enc_key_3.key', 'utf8').trim(), 'hex');

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
