import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type {
  GeneratedBuffer,
  GeneratedFileSource,
} from './types/generated-file.types';

export interface CreateFileRecordInput {
  userId: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  sourceType?: GeneratedFileSource;
  title?: string;
  summary?: string;
}

/**
 * FileStorageService —— 生成文件的落盘与元数据持久化。
 *
 * 流程：
 *   1. 调用 StorageService 上传二进制（本地磁盘 / 七牛云）
 *   2. 写入 GeneratedFile 记录（不存二进制）
 *   3. 删除时同步清理对象存储
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** 上传 + 建记录 */
  async save(
    generated: GeneratedBuffer,
    record: CreateFileRecordInput,
  ) {
    const upload = await this.storage.upload(
      generated.buffer,
      generated.fileName,
      'generated',
    );

    const file = await this.prisma.generatedFile.create({
      data: {
        userId: record.userId,
        workspaceId: record.workspaceId ?? null,
        sessionId: record.sessionId ?? null,
        messageId: record.messageId ?? null,
        fileName: generated.fileName,
        mimeType: generated.mimeType,
        extension: generated.extension,
        size: upload.size ?? generated.buffer.length,
        storageKey: upload.key,
        format: generated.format,
        sourceType: record.sourceType ?? 'chat',
        status: 'READY',
        previewType: generated.previewType,
        title: record.title ?? null,
        summary: record.summary ?? null,
      },
    });

    this.logger.log(
      `[FileStorage] 已保存文件 ${file.id} (${file.fileName}, ${file.size}B, key=${file.storageKey})`,
    );

    return file;
  }

  /** 读取文件内容（用于预览 / 代理下载） */
  async read(storageKey: string): Promise<Buffer> {
    return this.storage.readBuffer(storageKey);
  }

  /** 删除记录 + 对象存储文件 */
  async remove(id: string, storageKey: string) {
    await this.storage.delete(storageKey);
    await this.prisma.generatedFile.delete({ where: { id } });
  }

  /** 把若干文件关联到某条聊天消息 */
  async attachToMessage(fileIds: string[], messageId: string) {
    if (!fileIds.length) return;
    await this.prisma.generatedFile.updateMany({
      where: { id: { in: fileIds } },
      data: { messageId },
    });
  }
}
