import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentParserService } from '../../knowledge/documents/document-parser.service';
import { ChunkService } from '../../knowledge/documents/chunk/chunk.service';
import { EmbeddingService } from '../../knowledge/embedding/embedding.service';
import { VectorStoreService } from '../../knowledge/vector/vector-store.service';

/** document-processing Queue 的 Job 数据结构 */
export interface ProcessDocumentJobData {
  documentId: string;
  knowledgeBaseId: string;
  storagePath: string;
}

@Processor('document-processing')
export class DocumentProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentParserService: DocumentParserService,
    private readonly chunkService: ChunkService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStoreService: VectorStoreService,
  ) {
    super();
  }

  async process(job: Job<ProcessDocumentJobData>): Promise<any> {
    if (job.name !== 'process-document') {
      return undefined;
    }

    const { documentId, knowledgeBaseId, storagePath } = job.data;

    // 1. 更新状态为 PROCESSING
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });

    try {
      await job.updateProgress(10);

      // 2. 解析 → 纯文本
      const text = await this.documentParserService.parse(storagePath);

      await job.updateProgress(30);

      // 3. 分块 → 入库
      const chunks = await this.chunkService.split(text);
      await this.chunkService.createMany(documentId, knowledgeBaseId, chunks);

      await job.updateProgress(50);

      // 4. 取刚写入的 chunk
      const storedChunks = await this.prisma.documentChunk.findMany({
        where: { documentId },
        select: { id: true, content: true },
      });

      // 5. 查询知识库 embeddingModel 配置
      const kb = await this.prisma.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
        select: { embeddingModel: true },
      });
      if (!kb) {
        throw new Error('知识库不存在');
      }

      // 6. 批量向量化
      if (storedChunks.length > 0) {
        const vectors = await this.embeddingService.embedBatch(
          storedChunks.map((c) => c.content),
          kb.embeddingModel,
        );

        await job.updateProgress(80);

        // 7. 批量写 pgvector
        const pairs = storedChunks.map((c, i) => ({
          chunkId: c.id,
          vector: vectors[i],
        }));
        await this.vectorStoreService.updateEmbeddingBatch(pairs);
      }

      await job.updateProgress(100);

      // 8. 全部成功 → COMPLETED
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'COMPLETED' },
      });

      return { documentId, chunkCount: chunks.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          errorMessage: message,
        },
      });

      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    console.log(
      `[DocumentProcessor] Job ${job.id} completed for document ${job.data?.documentId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.error(
      `[DocumentProcessor] Job ${job.id} failed for document ${job.data?.documentId}:`,
      error.message,
    );
  }
}
