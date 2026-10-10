import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as qiniu from 'qiniu';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import axios from 'axios';

export interface UploadResult {
  /** 本地模式：绝对路径；七牛云模式：对象 Key */
  key: string;
  size: number;
}

/**
 * 统一存储服务 —— 双驱动（local / qiniu）
 *
 * 通过 STORAGE_TYPE 环境变量切换，业务方不需要感知底层实现。
 *
 * 核心方法：
 *   upload()        —— 上传 buffer，返回存储 key
 *   getLocalPath()  —— 解析为可读的本地文件路径（七牛云会先下载到临时文件）
 *   delete()        —— 删除
 *   getDownloadUrl() —— 生成可访问的下载 URL
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  /** 当前驱动类型 */
  public readonly type: 'local' | 'qiniu';

  // ===== 本地驱动 =====
  private readonly uploadDir: string;

  // ===== 七牛云驱动 =====
  private mac?: qiniu.auth.digest.Mac;
  private qiniuConfig?: qiniu.conf.Config;
  private bucket?: string;
  private domain?: string;

  constructor() {
    this.type = (process.env.STORAGE_TYPE || 'local') as 'local' | 'qiniu';
    this.uploadDir = resolve(
      process.cwd(),
      process.env.LOCAL_UPLOAD_DIR || 'uploads',
    );

    if (this.type === 'qiniu') {
      this.initQiniu();
    } else {
      this.logger.log(`[Storage] 使用本地存储，目录：${this.uploadDir}`);
    }
  }

  private initQiniu() {
    const accessKey = process.env.QINIU_ACCESS_KEY;
    const secretKey = process.env.QINIU_SECRET_KEY;
    const bucket = process.env.QINIU_BUCKET;
    const region = process.env.QINIU_REGION || 'z0';
    const domain = process.env.QINIU_DOMAIN;

    if (!accessKey || !secretKey || !bucket) {
      throw new Error(
        '七牛云存储配置不完整，请检查 QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET',
      );
    }

    this.mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
    this.bucket = bucket;
    this.domain = domain;

    // 区域映射
    const zoneMap: Record<string, qiniu.conf.Zone> = {
      z0: qiniu.zone.Zone_z0, // 华东
      z1: qiniu.zone.Zone_z1, // 华北
      z2: qiniu.zone.Zone_z2, // 华南
      na0: qiniu.zone.Zone_na0, // 北美
    };

    const zone = zoneMap[region] || qiniu.zone.Zone_z0;
    this.qiniuConfig = new qiniu.conf.Config();
    this.qiniuConfig.zone = zone;

    this.logger.log(
      `[Storage] 使用七牛云存储，Bucket：${bucket}，Region：${region}`,
    );
  }

  // ===========================================================================
  // 上传
  // ===========================================================================

  /**
   * 上传 buffer 数据
   *
   * @param buffer        文件内容
   * @param originalName  原始文件名（用于提取扩展名和生成对象 key）
   * @param subDir        子目录（local：uploads/{subDir}/xxx；qiniu：{subDir}/xxx）
   */
  async upload(
    buffer: Buffer,
    originalName: string,
    subDir = 'documents',
  ): Promise<UploadResult> {
    const extension = extname(originalName).toLowerCase();

    if (this.type === 'local') {
      return this.uploadLocal(buffer, originalName, extension, subDir);
    } else {
      return this.uploadQiniu(buffer, originalName, extension, subDir);
    }
  }

  private async uploadLocal(
    buffer: Buffer,
    _originalName: string,
    extension: string,
    subDir: string,
  ): Promise<UploadResult> {
    const key = `${randomUUID()}${extension}`;
    const storageDir = join(this.uploadDir, subDir);
    const storagePath = join(storageDir, key);

    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }

    await writeFile(storagePath, buffer);
    this.logger.debug(`[Storage] 本地落盘：${storagePath}`);

    return { key: storagePath, size: buffer.length };
  }

  private async uploadQiniu(
    buffer: Buffer,
    _originalName: string,
    extension: string,
    subDir: string,
  ): Promise<UploadResult> {
    const datePath = new Date().toISOString().slice(0, 10);
    const key = `${subDir}/${datePath}/${randomUUID()}${extension}`;

    const putPolicy = new qiniu.rs.PutPolicy({
      scope: `${this.bucket}:${key}`,
    });
    const uploadToken = putPolicy.uploadToken(this.mac!);
    const formUploader = new qiniu.form_up.FormUploader(this.qiniuConfig!);
    const putExtra = new qiniu.form_up.PutExtra();

    return new Promise<UploadResult>((resolve, reject) => {
      formUploader.put(
        uploadToken,
        key,
        buffer,
        putExtra,
        (respErr, respBody, respInfo) => {
          if (respErr) {
            reject(
              new InternalServerErrorException(
                `上传七牛云失败：${respErr.message}`,
              ),
            );
            return;
          }
          if (respInfo.statusCode !== 200) {
            reject(
              new InternalServerErrorException(
                `上传七牛云失败：HTTP ${respInfo.statusCode}`,
              ),
            );
            return;
          }
          this.logger.debug(`[Storage] 七牛云上传成功：${key}`);
          resolve({
            key: respBody.key as string,
            size: (respBody.fsize as number) ?? buffer.length,
          });
        },
      );
    });
  }

  // ===========================================================================
  // 读取 / 解析路径
  // ===========================================================================

  /**
   * 将存储 key 解析为可直接读取的本地文件路径
   *
   * - local：key 就是绝对路径，直接返回
   * - qiniu：下载到系统临时目录，返回临时路径
   */
  async getLocalPath(key: string): Promise<string> {
    if (this.type === 'local') {
      return key;
    }
    return this.downloadQiniuToTemp(key);
  }

  /** 将七牛云对象下载到临时文件，返回临时文件路径 */
  private async downloadQiniuToTemp(key: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiniu-dl-'));
    const fileName = key.split('/').pop()!;
    const tempPath = join(tempDir, fileName);

    const rawDomain = (this.domain || '').replace(/\/$/, '');
    if (!rawDomain) {
      throw new Error('七牛云下载失败：未配置 QINIU_DOMAIN');
    }

    // 规范化 domain：确保有协议前缀（签名必须带协议！）
    const withHttp = /^https?:\/\//i.test(rawDomain)
      ? rawDomain
      : `http://${rawDomain}`;
    const bareDomain = withHttp.replace(/^https?:\/\//i, '');
    const withHttps = withHttp.startsWith('https://')
      ? withHttp
      : `https://${bareDomain}`;

    // 构造候选 URL 列表
    const allUrls: string[] = [];

    // 1) 签名 URL（私有空间必须签名，放最前面）
    //    ⚠️ privateDownloadUrl 的 domain 参数必须带协议前缀，否则签名对不上！
    if (this.mac && this.qiniuConfig) {
      try {
        const bucketManager = new qiniu.rs.BucketManager(
          this.mac,
          this.qiniuConfig,
        );
        const deadline = Math.floor(Date.now() / 1000) + 3600;

        // 用 http:// 协议签名（CDN 证书可能有问题，优先 http）
        const signedHttp = bucketManager.privateDownloadUrl(
          withHttp,
          key,
          deadline,
        );
        allUrls.push(signedHttp);

        // 再用 https:// 签名一份作为兜底
        const signedHttps = bucketManager.privateDownloadUrl(
          withHttps,
          key,
          deadline,
        );
        allUrls.push(signedHttps);
      } catch {
        // 签名失败不阻塞公开下载
      }
    }

    // 2) 公开 URL（公有空间用，私有空间会 401）
    allUrls.push(`${withHttp}/${key}`);
    allUrls.push(`${withHttps}/${key}`);

    let lastError: unknown = null;
    for (const url of allUrls) {
      try {
        this.logger.debug(`[Storage] 尝试下载：${url}`);

        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          ...(url.startsWith('https:')
            ? {
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
              }
            : {}),
        });
        await writeFile(tempPath, Buffer.from(response.data));
        this.logger.debug(`[Storage] 七牛云下载成功：${url}`);
        return tempPath;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`[Storage] 下载失败 ${url}: ${msg}`);
      }
    }

    throw new InternalServerErrorException(
      `七牛云下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  // ===========================================================================
  // 删除
  // ===========================================================================

  async delete(key: string): Promise<void> {
    if (this.type === 'local') {
      try {
        await unlink(key);
        this.logger.debug(`[Storage] 本地文件已删除：${key}`);
      } catch {
        // 文件可能已不存在，静默忽略
      }
      return;
    }

    // 七牛云删除
    try {
      const bucketManager = new qiniu.rs.BucketManager(
        this.mac!,
        this.qiniuConfig!,
      );
      await bucketManager.delete(this.bucket!, key);
      this.logger.debug(`[Storage] 七牛云对象已删除：${key}`);
    } catch (err) {
      this.logger.warn(
        `[Storage] 七牛云删除失败：${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ===========================================================================
  // 生成下载 URL
  // ===========================================================================

  /**
   * 生成可访问的下载 URL
   *
   * - local：返回 null（本地存储不通过 HTTP 暴露）
   * - qiniu：如果配置了 domain 则拼接对象 key；私有空间可生成签名 URL
   */
  getDownloadUrl(key: string, expireSeconds = 3600): string | null {
    if (this.type === 'local') {
      return null;
    }
    if (!this.domain) {
      return null;
    }

    const cleanDomain = this.domain.replace(/\/$/, '');
    const publicUrl = `${cleanDomain}/${key}`;

    // 如需生成私有空间签名 URL，可开启以下逻辑：
    // if (this.mac && this.qiniuConfig) {
    //   const bucketManager = new qiniu.rs.BucketManager(this.mac, this.qiniuConfig);
    //   const deadline = Math.floor(Date.now() / 1000) + expireSeconds;
    //   return bucketManager.privateDownloadUrl(publicUrl, deadline);
    // }

    return publicUrl;
  }
}
