import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileGeneratorService } from './file-generator.service';
import { FileStorageService } from './file-storage.service';
import { FilePreviewService } from './file-preview.service';
import type {
  FilePreviewPayload,
  GenerateFileInput,
  GeneratedFileSource,
} from './types/generated-file.types';

export interface GenerateFileContext {
  userId: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  sourceType?: GeneratedFileSource;
}

/**
 * FilesService —— 生成文件业务的门面。
 *
 * 对外暴露：生成 / 查询 / 预览 / 读取 / 删除。
 * 所有的权限校验都在这里完成，Controller 只做参数转发。
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: FileGeneratorService,
    private readonly storage: FileStorageService,
    private readonly preview: FilePreviewService,
  ) {}

  // ===========================================================================
  // 生成
  // ===========================================================================

  /**
   * 生成并持久化一个文件。
   *
   * 注意：只有后端真正生成 + 上传 + 落库成功，才返回 READY 状态。
   * 不允许「模型说了生成就算生成」。
   */
  async generate(input: GenerateFileInput, ctx: GenerateFileContext) {
    const generated = await this.generator.generate(input, {
      title: input.title,
      author: ctx.userId,
    });

    const file = await this.storage.save(generated, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId ?? input.options?.sessionId?.toString(),
      messageId: ctx.messageId,
      sourceType: ctx.sourceType ?? 'chat',
      title: input.title,
      summary: input.summary,
    });

    return this.toDto(file);
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  async list(userId: string, params: { sessionId?: string; messageId?: string }) {
    return this.prisma.generatedFile.findMany({
      where: {
        userId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.messageId ? { messageId: params.messageId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(userId: string, id: string) {
    const file = await this.assertOwned(userId, id);
    return this.toDto(file);
  }

  /** 读取文件二进制（代理下载 / 预览用） */
  async readRaw(userId: string, id: string) {
    const file = await this.assertOwned(userId, id);
    const buffer = await this.storage.read(file.storageKey);
    return { file, buffer };
  }

  async getPreview(userId: string, id: string): Promise<FilePreviewPayload> {
    const file = await this.assertOwned(userId, id);
    return this.preview.buildPreview(file);
  }

  async remove(userId: string, id: string) {
    const file = await this.assertOwned(userId, id);
    await this.storage.remove(file.id, file.storageKey);
    return { id: file.id, deleted: true };
  }

  /** 把若干文件挂到指定消息（Agent 生成完成后回填 messageId） */
  async attachToMessage(fileIds: string[], messageId: string) {
    return this.storage.attachToMessage(fileIds, messageId);
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  private async assertOwned(userId: string, id: string) {
    const file = await this.prisma.generatedFile.findUnique({
      where: { id },
    });
    if (!file) throw new NotFoundException('文件不存在');
    if (file.userId !== userId) {
      throw new ForbiddenException('无权访问此文件');
    }
    return file;
  }

  /** 统一输出格式（前端文件卡片消费） */
  private toDto(file: {
    id: string;
    fileName: string;
    format: string;
    extension: string;
    mimeType: string;
    size: number;
    status: string;
    previewType: string | null;
    title: string | null;
    summary: string | null;
    sourceType: string;
    createdAt: Date;
    sessionId: string | null;
    messageId: string | null;
  }) {
    return {
      id: file.id,
      fileName: file.fileName,
      format: file.format,
      extension: file.extension,
      mimeType: file.mimeType,
      size: Number(file.size),
      status: file.status,
      previewType: file.previewType ?? 'text',
      title: file.title,
      summary: file.summary,
      sourceType: file.sourceType,
      sessionId: file.sessionId,
      messageId: file.messageId,
      createdAt: file.createdAt,
    };
  }
}
