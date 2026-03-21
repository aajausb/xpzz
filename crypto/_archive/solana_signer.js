/**
 * Solana 交易签名+广播模块
 * 解密私钥 → 签名 → 广播 → 清除内存
 */

const { Keypair, Transaction, VersionedTransaction } = require('@solana/web3.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');

const WALLET_FILE = path.join(__dirname, 'wallet_encrypted.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

/**
 * 从 .env 读取加密密钥
 */
function getEncryptionKey() {
  const env = fs.readFileSync(ENV_FILE, 'utf8');
  const match = env.match(/WALLET_ENCRYPTION_KEY=(.+)/);
  if (!match) throw new Error('WALLET_ENCRYPTION_KEY not found in .env');
  return match[1].trim();
}

/**
 * 解密私钥（用完立刻清除）
 */
function decryptPrivateKey(chain = 'solana') {
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
  const wallet = data[chain];
  if (!wallet) throw new Error(`No wallet found for chain: ${chain}`);
  
  const keyHex = getEncryptionKey();
  const ivHex = wallet.iv;
  const encrypted = wallet.encrypted_key;
  
  // 用 openssl 解密
  const result = execSync(
    `echo "${encrypted}" | openssl enc -aes-256-cbc -d -a -K ${keyHex} -iv ${ivHex}`,
    { encoding: 'utf8' }
  ).trim();
  
  return result;
}

/**
 * 获取 Solana Keypair
 */
function getSolanaKeypair() {
  const pk = decryptPrivateKey('solana');
  const decoded = bs58.decode(pk);
  return Keypair.fromSecretKey(decoded);
}

/**
 * 签名 Solana 交易
 * @param {string} txData - base58 编码的交易数据（onchainos swap swap 返回的 tx.data）
 * @returns {string} - base58 编码的已签名交易
 */
function signSolanaTransaction(txData) {
  let keypair;
  try {
    keypair = getSolanaKeypair();
    
    // onchainos 返回的 tx.data 是 base58 编码的序列化交易
    const txBuffer = Buffer.from(bs58.decode(txData));
    
    // 尝试作为 VersionedTransaction 反序列化
    let signedTxBase58;
    try {
      const vtx = VersionedTransaction.deserialize(txBuffer);
      vtx.sign([keypair]);
      signedTxBase58 = bs58.encode(vtx.serialize());
    } catch (e) {
      // 回退到 legacy Transaction
      const tx = Transaction.from(txBuffer);
      tx.sign(keypair);
      signedTxBase58 = bs58.encode(tx.serialize());
    }
    
    return signedTxBase58;
  } finally {
    // 清除内存中的密钥
    if (keypair) {
      keypair.secretKey.fill(0);
    }
  }
}

/**
 * 完整的 swap 流程：获取报价 → 签名 → 广播
 * @param {object} params - { from, to, amount, slippage, chain }
 * @returns {object} - { success, orderId, txHash, error }
 */
async function executeSwap({ from, to, amount, slippage = 5, chain = 'solana' }) {
  const wallet = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'))[chain];
  if (!wallet) throw new Error(`No wallet for chain: ${chain}`);
  
  const address = wallet.address;
  
  console.log(`[SWAP] ${chain} | ${amount} lamports | ${from} → ${to}`);
  
  // Step 1: 获取交易数据
  console.log('[SWAP] Step 1: 获取交易数据...');
  const swapResult = execSync(
    `onchainos swap swap --chain ${chain} --from ${from} --to ${to} --amount ${amount} --slippage ${slippage} --wallet ${address}`,
    { encoding: 'utf8', timeout: 15000 }
  );
  
  const swapData = JSON.parse(swapResult);
  if (!swapData.ok || !swapData.data || !swapData.data[0]) {
    return { success: false, error: 'Swap quote failed: ' + JSON.stringify(swapData) };
  }
  
  const tx = swapData.data[0].tx;
  const routerResult = swapData.data[0].routerResult;
  console.log(`[SWAP] 报价: ${routerResult.fromTokenAmount} ${routerResult.fromToken.tokenSymbol} → ${routerResult.toTokenAmount} ${routerResult.toToken.tokenSymbol}`);
  console.log(`[SWAP] 价格影响: ${routerResult.priceImpactPercent}%`);
  
  // 安全检查：价格影响过大
  if (Math.abs(parseFloat(routerResult.priceImpactPercent)) > 10) {
    return { success: false, error: `Price impact too high: ${routerResult.priceImpactPercent}%` };
  }
  
  // Step 2: 签名
  console.log('[SWAP] Step 2: 签名交易...');
  let signedTx;
  try {
    signedTx = signSolanaTransaction(tx.data);
  } catch (e) {
    return { success: false, error: 'Sign failed: ' + e.message };
  }
  
  // Step 3: 广播
  console.log('[SWAP] Step 3: 广播交易...');
  const broadcastResult = execSync(
    `onchainos gateway broadcast --chain ${chain} --signed-tx "${signedTx}" --address ${address}`,
    { encoding: 'utf8', timeout: 15000 }
  );
  
  const broadcastData = JSON.parse(broadcastResult);
  if (!broadcastData.ok || !broadcastData.data || !broadcastData.data[0]) {
    return { success: false, error: 'Broadcast failed: ' + JSON.stringify(broadcastData) };
  }
  
  const orderId = broadcastData.data[0].orderId;
  console.log(`[SWAP] 广播成功! orderId: ${orderId}`);
  
  // Step 4: 等待确认
  console.log('[SWAP] Step 4: 等待链上确认...');
  await new Promise(r => setTimeout(r, 3000));
  
  const orderResult = execSync(
    `onchainos gateway orders --address ${address} --chain ${chain}`,
    { encoding: 'utf8', timeout: 10000 }
  );
  
  const orderData = JSON.parse(orderResult);
  if (orderData.ok && orderData.data && orderData.data[0]) {
    const orders = orderData.data[0].orders || [];
    const myOrder = orders.find(o => o.orderId === orderId);
    if (myOrder) {
      // txStatus: 1=pending, 2=success, 3=failed
      if (myOrder.txStatus === '2') {
        console.log(`[SWAP] ✅ 交易成功! txHash: ${myOrder.txHash}`);
        return { success: true, orderId, txHash: myOrder.txHash };
      } else if (myOrder.txStatus === '3') {
        console.log(`[SWAP] ❌ 交易失败: ${myOrder.failReason}`);
        return { success: false, orderId, error: myOrder.failReason };
      } else {
        console.log(`[SWAP] ⏳ 交易pending, orderId: ${orderId}`);
        return { success: true, orderId, txHash: 'pending', status: 'pending' };
      }
    }
  }
  
  return { success: true, orderId, txHash: 'pending', status: 'checking' };
}

module.exports = { signSolanaTransaction, executeSwap, getSolanaKeypair, decryptPrivateKey };

// 如果直接运行则做测试
if (require.main === module) {
  (async () => {
    try {
      // 测试解密
      console.log('测试解密私钥...');
      const kp = getSolanaKeypair();
      console.log('地址:', kp.publicKey.toBase58());
      kp.secretKey.fill(0);
      console.log('✅ 解密成功，内存已清除');
    } catch (e) {
      console.error('❌ 错误:', e.message);
    }
  })();
}
