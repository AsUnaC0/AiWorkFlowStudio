import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { FileParserService, CHAT_FILE_MAX_SIZE } from './file-parser.service';
import type {
  ChatAttachmentLike,
  ParseResult,
} from './parsers/parser.types';

/** BullMQ 队列名（异步解析 / OCR 等耗时任务） */
export const CHAT_FILE_QUEUE = 'chat-file-processing';

/** 等待附件解析完成的最长时间（毫秒）—— 用户发送问题时若仍在解析，先等一会儿 */
const READY_WAIT_TIMEOUT_MS = 30_000;
const READY_WAIT_INTERVAL_MS = 800;

/** 序列化给前端的附件视图（不含解析全文，避免把整篇文档打到响应里） */
export interface AttachmentView {
  id: string;
  originalName: string;
  mimeType: string;
  extension: string;
  size: number;
  kind: string;
  status: string;
  previewType: string;
  summary: string | null;
  parseError: string | null;
  charCount: number;
  createdAt: string;
}

@Injectable()
export class ChatFilesService {
  private readonly logger = new Logger(ChatFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly parser: FileParserService,
    @InjectQueue(CHAT_FILE_QUEUE)
    private readonly queue: Queue,
  ) {}

  // ===========================================================================
  // 上传
  // ===========================================================================

  /**
   * 上传聊天附件：
   *   校验类型 / 大小 → 上传到对象存储 → 落库（UPLOADED）→ 调度解析任务
   *
   * 解析是异步的，接口立即返回；前端通过 GET /chat/files/:id 或批量状态接口轮询。
   */
  async upload(
    userId: string,
    file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    },
    sessionId?: string,
  ): Promise<AttachmentView> {
    if (!file) throw new BadRequestException('文件不能为空');
    if (file.size > CHAT_FILE_MAX_SIZE) {
      throw new BadRequestException(
        `文件超过 ${Math.floor(CHAT_FILE_MAX_SIZE / 1024 / 1024)}MB 上限`,
      );
    }

    const extension = this.parser.assertSupported(file.originalname);

    if (sessionId) {
      const session = await this.prisma.chatSession.findFirst({
        where: { id: sessionId, userId },
        select: { id: true },
      });
      if (!session) throw new ForbiddenException('无权访问该会话');
    }

    const uploaded = await this.storage.upload(
      file.buffer,
      file.originalname,
      'chat-attachments',
    );

    const attachment = await this.prisma.chatAttachment.create({
      data: {
        userId,
        sessionId: sessionId ?? null,
        originalName: file.originalname,
        mimeType: file.mimetype || 'application/octet-stream',
        extension,
        size: uploaded.size || file.size,
        storageKey: uploaded.key,
        kind: this.parser.classify(extension),
        status: 'UPLOADED',
      },
    });

    await this.scheduleProcessing(attachment.id);
    return this.toView(attachment);
  }

  // ===========================================================================
  // 解析调度
  // ===========================================================================

  /**
   * 调度解析任务。
   *
   * 优先走 BullMQ（Redis 可用时）；Redis 不可用时降级为进程内后台解析，
   * 保证「Redis 没起来，聊天附件照样能用」。
   */
  private async scheduleProcessing(attachmentId: string): Promise<void> {
    const useQueue = process.env.CHAT_FILE_USE_QUEUE !== 'false';

    if (useQueue) {
      try {
        await withTimeout(
          this.queue.add(
            'parse-attachment',
            { attachmentId },
            {
              attempts: 2,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: 100,
              removeOnFail: 200,
            },
          ),
          1500,
        );
        await this.prisma.chatAttachment.update({
          where: { id: attachmentId },
          data: { status: 'PROCESSING' },
        });
        return;
      } catch (err) {
        this.logger.warn(
          `[ChatFiles] 入队失败，降级为进程内解析：${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 降级：不 await，避免阻塞上传响应
    void this.process(attachmentId).catch((err) =>
      this.logger.error(`[ChatFiles] 后台解析失败：${String(err)}`),
    );
  }

  /** 重新处理（失败或需要刷新解析结果时使用） */
  async reprocess(userId: string, id: string): Promise<AttachmentView> {
    await this.assertOwner(userId, id);
    void this.process(id).catch(() => undefined);
    const updated = await this.prisma.chatAttachment.update({
      where: { id },
      data: { status: 'PROCESSING', parseError: null },
    });
    return this.toView(updated);
  }

  /** 执行解析：读取对象存储 → 调用解析器 → 更新状态 */
  async process(attachmentId: string): Promise<void> {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) return;

    await this.prisma.chatAttachment.update({
      where: { id: attachmentId },
      data: { status: 'PROCESSING', parseError: null },
    });

    try {
      const buffer = await this.storage.readBuffer(attachment.storageKey);
      const result = await this.parser.parse({
        buffer,
        fileName: attachment.originalName,
        extension: attachment.extension,
        mimeType: attachment.mimeType,
      });

      await this.prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: {
          status: 'READY',
          extractedText: result.text ?? '',
          summary: result.summary ?? null,
          meta: (result.meta ?? undefined) as never,
          charCount: (result.text ?? '').length,
          parseError: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[ChatFiles] 解析附件 ${attachmentId} 失败：${message}`,
      );
      await this.prisma.chatAttachment.update({
        where: { id: attachmentId },
        data: { status: 'FAILED', parseError: message.slice(0, 500) },
      });
    }
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  async findOne(userId: string, id: string): Promise<AttachmentView> {
    const attachment = await this.assertOwner(userId, id);
    return this.toView(attachment);
  }

  async list(userId: string, sessionId?: string): Promise<AttachmentView[]> {
    const rows = await this.prisma.chatAttachment.findMany({
      where: { userId, ...(sessionId ? { sessionId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toView(r));
  }

  /** 批量查询状态（前端轮询多个附件的解析进度） */
  async getStatuses(userId: string, ids: string[]): Promise<AttachmentView[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.chatAttachment.findMany({
      where: { id: { in: ids }, userId },
    });
    return rows.map((r) => this.toView(r));
  }

  async remove(userId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    const attachment = await this.assertOwner(userId, id);
    await this.storage.delete(attachment.storageKey);
    await this.prisma.chatAttachment.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** 预览用：取存储 key（已校验归属） */
  async getStorageKey(userId: string, id: string): Promise<string> {
    const attachment = await this.assertOwner(userId, id);
    return attachment.storageKey;
  }

  /** 读取原始文件（鉴权后代理给前端，私有对象存储不暴露永久地址） */
  async readRaw(
    userId: string,
    id: string,
  ): Promise<{ attachment: { originalName: string; mimeType: string }; buffer: Buffer }> {
    const attachment = await this.assertOwner(userId, id);
    const buffer = await this.storage.readBuffer(attachment.storageKey);
    return {
      attachment: {
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
      },
      buffer,
    };
  }

  // ===========================================================================
  // 聊天侧能力
  // ===========================================================================

  /**
   * 校验并取出本次要用的附件：
   *   - 必须是当前用户的（防止传入他人 attachmentId）
   *   - 必须解析完成（READY）；仍在解析时先等待一段时间
   */
  async resolveForChat(
    userId: string,
    ids: string[],
    sessionId?: string,
  ): Promise<ChatAttachmentLike[]> {
    if (!ids.length) return [];
    if (ids.length > 10) {
      throw new BadRequestException('单条消息最多携带 10 个附件');
    }

    const rows = await this.prisma.chatAttachment.findMany({
      where: { id: { in: ids }, userId },
      select: {
        id: true,
        originalName: true,
        extension: true,
        kind: true,
        mimeType: true,
        storageKey: true,
        extractedText: true,
        summary: true,
        status: true,
        parseError: true,
        sessionId: true,
      },
    });

    // 存在不属于当前用户的 ID —— 直接拒绝，而不是静默忽略
    if (rows.length !== new Set(ids).size) {
      throw new ForbiddenException('存在无权访问的附件');
    }

    // 会话归属一致性：附件必须属于当前会话（或未绑定会话）
    if (sessionId) {
      const mismatched = rows.filter(
        (r) => r.sessionId && r.sessionId !== sessionId,
      );
      if (mismatched.length) {
        throw new ForbiddenException('附件不属于当前会话');
      }
    }

    await this.waitUntilReady(ids);

    // 重新读取一次，拿最新的解析结果
    const fresh = await this.prisma.chatAttachment.findMany({
      where: { id: { in: ids }, userId },
      select: {
        id: true,
        originalName: true,
        extension: true,
        kind: true,
        mimeType: true,
        storageKey: true,
        extractedText: true,
        summary: true,
        status: true,
        parseError: true,
      },
    });

    const failed = fresh.filter((r) => r.status === 'FAILED');
    if (failed.length) {
      throw new BadRequestException(
        `附件解析失败：${failed
          .map((f) => `${f.originalName}（${f.parseError ?? '未知错误'}）`)
          .join('；')}`,
      );
    }

    const pending = fresh.filter((r) => r.status !== 'READY');
    if (pending.length) {
      throw new BadRequestException(
        `附件仍在解析中，请稍后再试：${pending
          .map((p) => p.originalName)
          .join('、')}`,
      );
    }

    return fresh;
  }

  /** 把附件挂到某条用户消息上（便于回看历史时知道当时发了哪些文件） */
  async attachToMessage(
    userId: string,
    ids: string[],
    messageId: string,
    sessionId?: string,
  ): Promise<void> {
    if (!ids.length) return;
    await this.prisma.chatAttachment.updateMany({
      where: { id: { in: ids }, userId },
      data: { messageId, sessionId: sessionId ?? undefined },
    });
  }

  /** 读取图片附件的原始内容（视觉模型用） */
  async readImageBuffer(
    userId: string,
    attachment: { id: string; storageKey: string },
  ): Promise<Buffer> {
    await this.assertOwner(userId, attachment.id);
    return this.storage.readBuffer(attachment.storageKey);
  }

  /**
   * 取出某会话中「已绑定到消息」的附件，按 messageId 分组。
   * 用于多轮对话时，把历史用户消息里附带的附件上下文重新注入，
   * 这样后续追问也能继续基于之前上传的文件。
   */
  async getAttachmentsByMessages(
    userId: string,
    sessionId: string,
  ): Promise<Map<string, ChatAttachmentLike[]>> {
    const rows = await this.prisma.chatAttachment.findMany({
      where: {
        userId,
        sessionId,
        messageId: { not: null },
        status: 'READY',
      },
      select: {
        messageId: true,
        id: true,
        originalName: true,
        extension: true,
        kind: true,
        mimeType: true,
        storageKey: true,
        extractedText: true,
        summary: true,
      },
    });

    const map = new Map<string, ChatAttachmentLike[]>();
    for (const r of rows) {
      const mid = r.messageId!;
      const list = map.get(mid) ?? [];
      list.push({
        id: r.id,
        originalName: r.originalName,
        extension: r.extension,
        kind: r.kind,
        mimeType: r.mimeType,
        storageKey: r.storageKey,
        extractedText: r.extractedText,
        summary: r.summary,
      });
      map.set(mid, list);
    }
    return map;
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  /** 等待若干附件解析完成（轮询，最长 30 秒） */
  private async waitUntilReady(ids: string[]): Promise<void> {
    const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const rows = await this.prisma.chatAttachment.findMany({
        where: { id: { in: ids } },
        select: { status: true },
      });
      const allSettled = rows.every(
        (r) => r.status === 'READY' || r.status === 'FAILED',
      );
      if (allSettled) return;
      await sleep(READY_WAIT_INTERVAL_MS);
    }
  }

  private async assertOwner(userId: string, id: string) {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id },
    });
    if (!attachment) throw new NotFoundException('附件不存在');
    if (attachment.userId !== userId) {
      throw new ForbiddenException('无权访问此附件');
    }
    return attachment;
  }

  private toView(attachment: {
    id: string;
    originalName: string;
    mimeType: string;
    extension: string;
    size: number;
    kind: string;
    status: string;
    summary: string | null;
    parseError: string | null;
    charCount: number;
    createdAt: Date;
  }): AttachmentView {
    return {
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      extension: attachment.extension,
      size: attachment.size,
      kind: attachment.kind,
      status: attachment.status,
      previewType: this.parser.previewTypeOf(attachment.extension),
      summary: attachment.summary,
      parseError: attachment.parseError,
      charCount: attachment.charCount,
      createdAt: attachment.createdAt.toISOString(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给 Promise 加超时，避免 Redis 不可用时请求被无限挂起 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('queue timeout')), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
