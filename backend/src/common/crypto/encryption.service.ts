import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * 对称加密服务 —— 用于安全存储用户自定义的 API Key（AES-256-GCM）。
 *
 * - 主密钥来源（优先级）：`LLM_CONFIG_ENCRYPTION_KEY` → `JWT_SECRET` → 开发兜底常量。
 *   为得到稳定 32 字节密钥，最终用 SHA-256 对源字符串取摘要。
 * - 生产环境务必在 `.env` 配置 `LLM_CONFIG_ENCRYPTION_KEY`（32 字节随机串）。
 * - 密文格式：`base64(iv):base64(authTag):base64(ciphertext)`，用 `:` 分隔。
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;

  constructor() {
    const source =
      process.env.LLM_CONFIG_ENCRYPTION_KEY ||
      process.env.JWT_SECRET ||
      'dev-only-insecure-key-change-me';

    if (!process.env.LLM_CONFIG_ENCRYPTION_KEY) {
      this.logger.warn(
        '未配置 LLM_CONFIG_ENCRYPTION_KEY，已回退到 JWT_SECRET / 开发兜底密钥。' +
          '生产环境请在 .env 中设置独立的 32 字节随机密钥，否则 API Key 加密强度不足。',
      );
    }

    // SHA-256 摘要 → 固定 32 字节，满足 AES-256 密钥长度
    this.key = createHash('sha256').update(source).digest();
  }

  /** 加密明文，返回可持久化的密文串 */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  /** 解密密文串，返回明文 */
  decrypt(ciphertext: string): string {
    const [ivB64, tagB64, dataB64] = ciphertext.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error('密文格式不正确');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * 生成 API Key 脱敏预览，例如：
   *   sk-abcdefghijklmnopqrstuvwxyz1234 → sk-a****1234
   *   abcdef → ****abcd
   * 用于接口返回，避免泄露完整密钥。
   */
  maskApiKey(apiKey: string | null | undefined): string | null {
    if (!apiKey) return null;
    if (apiKey.length <= 8) return '****';
    const head = apiKey.slice(0, 4);
    const tail = apiKey.slice(-4);
    return `${head}****${tail}`;
  }
}
