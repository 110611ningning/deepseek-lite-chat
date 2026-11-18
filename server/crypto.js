import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 生成或读取服务端主密钥。
 *
 * - 设置 APP_SECRET 时，用 scrypt 从口令派生（适合 Railway 上固定密钥）。
 * - 未设置时，自动生成随机密钥并保存到数据目录。数据目录必须挂载持久卷。
 */
export function loadMasterKey(dataDir, appSecret) {
  if (appSecret) {
    return crypto.scryptSync(String(appSecret), 'deepseek-lite-chat/master/v1', 32);
  }

  const file = path.join(dataDir, 'master.key');
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    const key = Buffer.from(saved, 'base64');
    if (key.length === 32) return key;
    throw new Error('master.key 内容无效');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

export class KeyVault {
  constructor(masterKey) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new Error('主密钥必须是 32 字节');
    }
    this.masterKey = masterKey;
  }

  encrypt(plaintext, userId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`user:${userId}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: encrypted.toString('base64'),
      updatedAt: new Date().toISOString()
    };
  }

  decrypt(record, userId) {
    if (!record || record.v !== 1) return null;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        Buffer.from(record.iv, 'base64')
      );
      decipher.setAAD(Buffer.from(`user:${userId}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(record.ct, 'base64')),
        decipher.final()
      ]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newId() {
  return crypto.randomUUID();
}
