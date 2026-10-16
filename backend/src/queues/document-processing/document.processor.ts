import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentParserService } from '../../knowledge/documents/document-parser.service';
import { ChunkService } from '../../knowledge/documents/chunk/chunk.service';
import { EmbeddingService } from '../../knowledge/embedding/embedding.service';
import { EmbeddingVersionService } from '../../knowledge/embedding/embedding-version.service';
import { VectorStoreService } from '../../knowledge/vector/vector-store.service';
import { StorageService } from '../../storage/storage.service';
import { unlink } from 'node:fs/promises';
import { hasTextContent } from '../../common/text.util';

/** document-processing Queue 的 Job 数据结构 */
export interface ProcessDocumentJobData {
  documentId: string;
  knowledgeBaseId: string;
  storagePath: string; // local: 绝对路径；qiniu: 对象 Key
}

@Processor('document-processing')
export class DocumentProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentParserService: DocumentParserService,
    private readonly chunkService: ChunkService,
    private readonly embeddingService: EmbeddingService,
    private readonly versionService: EmbeddingVersionService,
    private readonly vectorStoreService: VectorStoreService,
    private readonly storageService: StorageService,
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

    // 七牛云模式会先下载到临时文件，需要在 finally 中清理
    let tempPath: string | null = null;
    let localPath = storagePath;

    try {
      // --- 幂等保护：重试时先清理上一次残留的 chunks ---
      // 查已有 chunks 数量（用于回退 chunkCount）
      const existingCount = await this.prisma.documentChunk.count({
        where: { documentId },
      });
      if (existingCount > 0) {
        await this.prisma.$transaction(async (tx) => {
          // 删除残留 chunks
          await tx.documentChunk.deleteMany({ where: { documentId } });
          // 回退 chunkCount（减去已删数量）
          await tx.knowledgeBase.update({
            where: { id: knowledgeBaseId },
            data: { chunkCount: { decrement: existingCount } },
          });
        });
      }
      // --- 幂等保护结束 ---

      await job.updateProgress(10);

      // 2. 解析 → 纯文本
      // 通过 StorageService 解析出可读取的本地路径（七牛云会先下载到临时文件）
      localPath = await this.storageService.getLocalPath(storagePath);
      // 如果存储类型是七牛云，localPath 是下载的临时文件，需要后续清理
      if (this.storageService.type === 'qiniu') {
        tempPath = localPath;
      }

      const text = await this.documentParserService.parse(localPath);

      // 扫描件 / 图片型 PDF 没有文本层，解析结果为空 —— 提前给出可读的失败原因，
      // 而不是静默标记 COMPLETED 让用户误以为向量化成功。
      if (!hasTextContent(text)) {
        throw new Error(
          '未能从该文件中提取到有效文本内容（可能是扫描件或图片型 PDF，需先做 OCR）',
        );
      }

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

      // 5. 查询知识库 embedding 配置（本地模型名 + 可选的自定义 Embedding 模型 id）
      const kb = await this.prisma.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
        select: {
          ownerId: true,
          embeddingModel: true,
          embeddingLlmModelId: true,
          // 用于把本次向量化归属到工作空间（写入 ModelCallLog，供仪表盘统计）
          workspaces: { select: { workspaceId: true }, take: 1 },
        },
      });
      if (!kb) {
        throw new Error('知识库不存在');
      }

      // 取激活向量版本 —— 文档向量一律写入「当前生效版本」，保证与检索时用的模型/维度一致
      const activeVersion = await this.versionService.ensureActiveVersion(
        knowledgeBaseId,
      );

      // 向量化遥测：优先用知识库关联的第一个工作空间，否则回退知识库 owner 的可见空间。
      // 没有归属就不写记录（与「无归属上下文的调用不记录」的约定一致）。
      const telemetryWorkspaceId =
        kb.workspaces[0]?.workspaceId ??
        (
          await this.prisma.workspace.findFirst({
            where: {
              OR: [
                { ownerId: kb.ownerId },
                { members: { some: { userId: kb.ownerId } } },
              ],
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        )?.id;
      const telemetry = telemetryWorkspaceId
        ? { workspaceId: telemetryWorkspaceId }
        : undefined;

      // 6. 批量向量化 —— 用「激活版本」绑定的模型（与库中已有向量同源）
      if (storedChunks.length > 0) {
        const vectors = await this.embeddingService.embedBatch(
          storedChunks.map((c) => c.content),
          activeVersion.modelId,
          activeVersion.llmModelId,
          telemetry,
        );

        // 维度校验：写入前比对版本维度，避免脏数据混进同一检索空间
        const dim = vectors[0]?.length;
        if (dim !== undefined && dim !== activeVersion.dimensions) {
          throw new Error(
            `Embedding 维度不匹配：激活版本「${activeVersion.modelId}」输出 ${dim} 维，` +
              `但该知识库当前向量版本为 ${activeVersion.dimensions} 维。` +
              `请到知识库设置里用「切换向量模型」建立新版本并重新向量化，不要直接改配置。`,
          );
        }

        await job.updateProgress(80);

        // 7. 写入激活版本的向量表
        const pairs = storedChunks.map((c, i) => ({
          chunkId: c.id,
          vector: vectors[i],
        }));
        await this.versionService.writeVectors(activeVersion.id, pairs);
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
    } finally {
      // 清理七牛云下载的临时文件
      if (tempPath) {
        try {
          await unlink(tempPath);
        } catch {
          // 临时文件可能已被清理，静默忽略
        }
      }
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
