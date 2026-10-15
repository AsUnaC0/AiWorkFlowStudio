import { Injectable } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PrismaService } from '../../../prisma/prisma.service';
import { sanitizeText } from '../../../common/text.util';

@Injectable()
export class ChunkService {
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 100,
    chunkOverlap: 50,
  });

  constructor(private readonly prisma: PrismaService) {}

  async split(text: string) {
    // 先整体清洗（去 NUL 等非法字符），再切分；切分后逐块再清洗一次并丢弃空块，
    // 避免「整块都是 0x00」的碎片进入数据库和 embedding。
    const chunks = await this.splitter.splitText(sanitizeText(text));

    return chunks
      .map((content) => sanitizeText(content).trim())
      .filter((content) => content.length > 0)
      .map((content, index) => ({
        content,
        chunkIndex: index,
      }));
  }

  /**
   * 批量存储文档分块，并原子性地更新知识库 chunkCount。
   */
  async createMany(
    documentId: string,
    knowledgeBaseId: string,
    chunks: { content: string; chunkIndex: number }[],
  ) {
    if (chunks.length === 0) return [];

    // 兜底清洗：即使调用方没走 split()，也不会把非法字符写进 Postgres
    const data = chunks
      .map((c) => ({ ...c, content: sanitizeText(c.content) }))
      .filter((c) => c.content.trim().length > 0)
      .map((c, index) => ({
        documentId,
        content: c.content,
        chunkIndex: c.chunkIndex ?? index,
      }));

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.documentChunk.createMany({
        data,
      });

      await tx.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: { chunkCount: { increment: created.count } },
      });

      return created;
    });
  }
}
