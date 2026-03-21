# 钱包私钥恢复指南

## 备份位置
- **加密分片**：GitHub历史（Private仓库 aajausb/xpzz）
- **解密Key**：GitHub历史 + 跑步哥手上有 enc_key_1（2f927...adcdf1）

## 恢复步骤

### 1. 从GitHub历史提取分片
```bash
git clone git@github.com:aajausb/xpzz.git recovery
cd recovery

# 提取3个加密分片
git show 4a54bc7:crypto/secrets/wallet_shard_1.enc.json > wallet_shard_1.enc.json
git show 69b4b6d:crypto/github_backup_shard2/wallet_shard_2.enc.json > wallet_shard_2.enc.json
git show 4a54bc7:crypto/github_shard/wallet_shard_3.enc.json > wallet_shard_3.enc.json

# 提取2个解密key
git show a7c49db:crypto/github_backup_shard2/enc_key_1.key > enc_key_1.key
git show a268151:crypto/git_backup_shard/enc_key_3.key > enc_key_3.key
```

### 2. 解密分片
用对应的enc_key解密每个分片（AES-256）

### 3. XOR合并
3个解密后的分片做XOR运算 = 原始私钥

## 注意
- 仓库必须是Private
- enc_key_1 跑步哥手上有备份
- 两把钥匙：enc_key_1（分片1/2）、enc_key_3（分片3）
- 恢复需要：GitHub访问权限 + 至少一个enc_key
