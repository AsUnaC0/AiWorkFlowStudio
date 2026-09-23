import { Injectable } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class ChunkService {
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  constructor(private readonly prisma: PrismaService) {}

  async split(text: string) {
    const chunks = await this.splitter.splitText(text);

    return chunks.map((content, index) => ({
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

    const data = chunks.map((c) => ({
      documentId,
      content: c.content,
      chunkIndex: c.chunkIndex,
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
