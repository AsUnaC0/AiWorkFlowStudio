import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../../knowledge/embedding/embedding.service';
import { EmbeddingVersionService } from '../../knowledge/embedding/embedding-version.service';

export interface ReEmbedJobData {
  knowledgeBaseId: string;
  versionId: string;
  /** 仅重试失败项时为 true */
  retryFailedOnly?: boolean;
}

/** 每批向量化的文本块数量 */
const BATCH_SIZE = 64;

/**
 * 重新向量化任务：复用已有文本块，重新生成目标版本的向量。
 *
 * 关键约束：
 *   - 不重复解析原文件（DocumentChunk 保持不变，只写新版本）；
 *   - 每条向量写入前校验维度，维度不符判为失败并记原因；
 *   - 全部完成（无失败）后才允许激活，失败项可单独重试。
 */
@Processor('knowledge-reembed')
export class ReEmbeddingProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly versionService: EmbeddingVersionService,
  ) {
    super();
  }

  async process(job: Job<ReEmbedJobData>): Promise<any> {
    const { knowledgeBaseId, versionId, retryFailedOnly } = job.data;

    const version = await this.prisma.knowledgeBaseEmbeddingVersion.findFirst({
      where: { id: versionId, knowledgeBaseId },
      select: {
        id: true,
        modelId: true,
        llmModelId: true,
        dimensions: true,
        status: true,
      },
    });
    if (!version) {
      return { skipped: true, reason: '版本不存在' };
    }

    await this.prisma.knowledgeBaseEmbeddingVersion.update({
      where: { id: versionId },
      data: { status: 'PROCESSING', error: null },
    });

    // 目标文本块：全部未完成项（PENDING / FAILED）
    const chunks = await this.versionService.pendingChunks(versionId);
    if (chunks.length === 0) {
      await this.versionService.refreshStats(versionId);
      return { processed: 0, done: 0, failed: 0 };
    }

    // 遥测归属：优先知识库关联的第一个工作空间
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { workspaces: { select: { workspaceId: true }, take: 1 } },
    });
    const telemetry = kb?.workspaces[0]?.workspaceId
      ? { workspaceId: kb.workspaces[0].workspaceId }
      : undefined;

    await job.updateProgress(5);

    let done = 0;
    let failed = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      try {
        const vectors = await this.embeddingService.embedBatch(
          batch.map((c) => c.content),
          version.modelId,
          version.llmModelId,
          telemetry,
        );

        // embedBatch 可能返回与输入不等长（异常 provider），逐条对齐写入
        const pairs = batch
          .map((c, idx) => ({ chunkId: c.id, vector: vectors[idx] }))
          .filter((p) => Array.isArray(p.vector));

        const result = await this.versionService.writeVectors(versionId, pairs);
        done += result.done;
        failed += result.failed;

        // 没有返回向量的条目单独标记为失败
        const missing = batch
          .map((c, idx) => ({ c, v: vectors[idx] }))
          .filter((x) => !Array.isArray(x.v))
          .map((x) => x.c.id);
        if (missing.length > 0) {
          await this.versionService.markChunksFailed(
            versionId,
            missing,
            '模型未返回向量',
          );
          failed += missing.length;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.versionService.markChunksFailed(
          versionId,
          batch.map((c) => c.id),
          message,
        );
        failed += batch.length;
        await this.prisma.knowledgeBaseEmbeddingVersion.update({
          where: { id: versionId },
          data: { error: message.slice(0, 500) },
        });
      }

      await job.updateProgress(
        Math.min(95, Math.round(((i + batch.length) / chunks.length) * 95)),
      );
    }

    await this.versionService.refreshStats(versionId);
    await job.updateProgress(100);

    return {
      processed: chunks.length,
      done,
      failed,
      retryFailedOnly: retryFailedOnly ?? false,
    };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    console.log(
      `[ReEmbed] Job ${job.id} completed for version ${job.data?.versionId}:`,
      JSON.stringify(job.returnvalue),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.error(
      `[ReEmbed] Job ${job.id} failed for version ${job.data?.versionId}:`,
      error.message,
    );
  }
}
