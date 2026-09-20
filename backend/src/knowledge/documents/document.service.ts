import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Document 基础服务层——负责文档元数据 CRUD + 物理文件管理。
 *
 * 权限模型：知识库独立，文档归知识库 owner 所有。
 */
@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 获取某个知识库下的全部文档 */
  async findByKnowledgeBase(knowledgeBaseId: string) {
    return this.prisma.document.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 获取单个文档 */
  async findOne(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  /** 创建文档记录 */
  async create(data: {
    knowledgeBaseId: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    storagePath: string;
    mimeType?: string;
  }) {
    const doc = await this.prisma.document.create({
      data: {
        knowledgeBaseId: data.knowledgeBaseId,
        fileName: data.fileName,
        fileType: data.fileType,
        fileSize: data.fileSize,
        storagePath: data.storagePath,
        mimeType: data.mimeType ?? null,
        status: 'UPLOADED',
      },
    });

    // 更新知识库文档计数
    await this.prisma.knowledgeBase.update({
      where: { id: data.knowledgeBaseId },
      data: { documentCount: { increment: 1 } },
    });

    return doc;
  }

  /** 删除文档 */
  async remove(id: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      select: { id: true, knowledgeBaseId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');

    await this.prisma.document.delete({ where: { id } });

    // 重算知识库文档计数
    const count = await this.prisma.document.count({
      where: { knowledgeBaseId: doc.knowledgeBaseId },
    });
    await this.prisma.knowledgeBase.update({
      where: { id: doc.knowledgeBaseId },
      data: { documentCount: count },
    });

    return doc;
  }

  // ===========================================================================
  // 权限校验（知识库 owner 模型）
  // ===========================================================================

  /** 校验用户是知识库的 owner */
  async assertKbOwner(userId: string, knowledgeBaseId: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { ownerId: true },
    });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    if (kb.ownerId !== userId) {
      throw new ForbiddenException('You do not own this knowledge base');
    }
    return kb;
  }

  async assertDocumentOwner(userId: string, documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { knowledgeBaseId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    await this.assertKbOwner(userId, doc.knowledgeBaseId);
    return doc;
  }
}
