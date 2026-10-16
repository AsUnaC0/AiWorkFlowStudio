import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { LlmConfigService } from '../../llm-config/llm-config.service';

/** 版本状态机 */
export const VERSION_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type VersionStatus = (typeof VERSION_STATUS)[keyof typeof VERSION_STATUS];

const VERSION_SELECT = {
  id: true,
  knowledgeBaseId: true,
  modelId: true,
  llmModelId: true,
  dimensions: true,
  vectorTable: true,
  status: true,
  isActive: true,
  chunkTotal: true,
  chunkDone: true,
  chunkFailed: true,
  error: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 知识库「向量版本」管理。
 *
 * 核心原则：知识库配置里的模型，必须和实际参与检索的向量一致。
 * 因此切换模型 / 维度的正确姿势是：
 *   建新版本 → 后台重新向量化（复用已有文本块，不重复解析原文件）
 *   → 全部完成并校验维度 → 原子激活；旧版本保留可回滚。
 */
@Injectable()
export class EmbeddingVersionService {
  private readonly logger = new Logger(EmbeddingVersionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  /** 版本专属物理表名（全局唯一，且不在 Prisma schema 内，避免被 migrate 误删） */
  static vectorTable(versionId: string): string {
    return `EmbeddingVector_${versionId.replace(/-/g, '')}`;
  }

  // ===========================================================================
  // 物理向量表（每个版本一张，列固定 vector(dimensions) 才能建 HNSW 索引）
  // ===========================================================================

  async ensureVectorTable(versionId: string, dimensions: number): Promise<string> {
    const table = EmbeddingVersionService.vectorTable(versionId);
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         "chunkId" TEXT NOT NULL PRIMARY KEY REFERENCES "DocumentChunk"("id") ON DELETE CASCADE,
         "embedding" vector(${dimensions}) NOT NULL
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "hnsw_${table}" ON "${table}" USING hnsw (embedding vector_cosine_ops)`,
    );
    return table;
  }

  async dropVectorTable(versionId: string): Promise<void> {
    const table = EmbeddingVersionService.vectorTable(versionId);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }

  // ===========================================================================
  // 版本查询
  // ===========================================================================

  async listVersions(userId: string, kbId: string) {
    await this.assertKbOwner(userId, kbId);
    return this.prisma.knowledgeBaseEmbeddingVersion.findMany({
      where: { knowledgeBaseId: kbId },
      select: VERSION_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async getVersion(userId: string, kbId: string, versionId: string) {
    await this.assertKbOwner(userId, kbId);
    const version = await this.prisma.knowledgeBaseEmbeddingVersion.findFirst({
      where: { id: versionId, knowledgeBaseId: kbId },
      select: VERSION_SELECT,
    });
    if (!version) throw new NotFoundException('向量版本不存在');
    return version;
  }

  /** 取激活版本（内部使用，不做 owner 校验） */
  async getActiveVersion(kbId: string) {
    return this.prisma.knowledgeBaseEmbeddingVersion.findFirst({
      where: { knowledgeBaseId: kbId, isActive: true },
      select: VERSION_SELECT,
    });
  }

  /** 取激活版本；没有则按知识库当前配置补建一个（兼容历史知识库） */
  async ensureActiveVersion(kbId: string) {
    const existing = await this.getActiveVersion(kbId);
    if (existing) return existing;

    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { embeddingModel: true, embeddingLlmModelId: true, embeddingDimension: true },
    });
    if (!kb) throw new NotFoundException('知识库不存在');

    return this.createVersionRecord({
      knowledgeBaseId: kbId,
      modelId: kb.embeddingModel,
      llmModelId: kb.embeddingLlmModelId,
      dimensions: kb.embeddingDimension || 768,
      status: VERSION_STATUS.READY,
      isActive: true,
      activatedAt: new Date(),
      /** 补建时把已有文本块登记为待处理，由重新向量化任务补上 */
      seedChunks: true,
    });
  }

  // ===========================================================================
  // 创建版本（切换目标模型）
  // ===========================================================================

  /**
   * 为知识库创建一个新的目标向量版本。
   * 不直接改现有向量：新版本生成完成后需显式 activate 才生效。
   */
  async createTargetVersion(
    userId: string,
    kbId: string,
    dto: { modelId?: string; llmModelId?: string | null; dimensions?: number },
  ) {
    await this.assertKbOwner(userId, kbId);

    let modelId = dto.modelId?.trim();
    let dimensions = dto.dimensions;

    // 指定了模型管理里的模型：以它的实测维度为准（不靠名字猜）
    if (dto.llmModelId) {
      const model = await this.prisma.llmModel.findUnique({
        where: { id: dto.llmModelId },
        select: {
          id: true,
          modelId: true,
          capabilities: true,
          embeddingDimensions: true,
        },
      });
      if (!model) throw new NotFoundException('模型不存在');
      if (!model.capabilities.includes('EMBEDDING')) {
        throw new BadRequestException('所选模型没有 EMBEDDING（向量化）能力');
      }
      if (!model.embeddingDimensions) {
        throw new BadRequestException(
          '该模型尚未实测输出维度，请先到「模型管理」点「验证模型」',
        );
      }
      modelId = model.modelId;
      dimensions = model.embeddingDimensions;
    }

    if (!modelId) throw new BadRequestException('必须指定目标模型');
    if (!dimensions || dimensions <= 0) {
      throw new BadRequestException('无法确定目标模型的输出维度');
    }

    return this.createVersionRecord({
      knowledgeBaseId: kbId,
      modelId,
      llmModelId: dto.llmModelId ?? null,
      dimensions,
      status: VERSION_STATUS.PENDING,
      isActive: false,
      seedChunks: true,
    });
  }

  private async createVersionRecord(params: {
    knowledgeBaseId: string;
    modelId: string;
    llmModelId: string | null;
    dimensions: number;
    status: VersionStatus;
    isActive: boolean;
    activatedAt?: Date;
    seedChunks?: boolean;
  }) {
    const version = await this.prisma.knowledgeBaseEmbeddingVersion.create({
      data: {
        knowledgeBaseId: params.knowledgeBaseId,
        modelId: params.modelId,
        llmModelId: params.llmModelId,
        dimensions: params.dimensions,
        vectorTable: '', // 依赖 id，下面回填
        status: params.status,
        isActive: params.isActive,
        activatedAt: params.activatedAt ?? null,
      },
      select: VERSION_SELECT,
    });

    const table = EmbeddingVersionService.vectorTable(version.id);
    await this.prisma.knowledgeBaseEmbeddingVersion.update({
      where: { id: version.id },
      data: { vectorTable: table },
    });
    await this.ensureVectorTable(version.id, params.dimensions);

    if (params.seedChunks) {
      await this.seedPendingChunks(version.id, params.knowledgeBaseId);
    }

    return this.prisma.knowledgeBaseEmbeddingVersion.findUniqueOrThrow({
      where: { id: version.id },
      select: VERSION_SELECT,
    });
  }

  /** 把该知识库下已有文本块登记为待向量化（用于进度统计与失败重试） */
  private async seedPendingChunks(versionId: string, kbId: string) {
    const chunks = await this.prisma.documentChunk.findMany({
      where: { document: { knowledgeBaseId: kbId } },
      select: { id: true },
    });
    if (chunks.length === 0) return 0;

    // 分批插入，避免单次 SQL 过大
    const BATCH = 500;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      await this.prisma.documentChunkEmbedding.createMany({
        data: batch.map((c) => ({
          chunkId: c.id,
          embeddingVersionId: versionId,
          status: 'PENDING',
        })),
        skipDuplicates: true,
      });
    }
    await this.prisma.knowledgeBaseEmbeddingVersion.update({
      where: { id: versionId },
      data: { chunkTotal: chunks.length },
    });
    return chunks.length;
  }

  // ===========================================================================
  // 写入向量（由文档处理 / 重新向量化任务调用）
  // ===========================================================================

  /**
   * 批量写入向量到版本专属表，并同步 DocumentChunkEmbedding 状态。
   * 逐条校验维度 —— 维度不符直接判为失败，绝不让脏数据混进同一检索空间。
   */
  async writeVectors(
    versionId: string,
    items: { chunkId: string; vector: number[] }[],
  ) {
    if (items.length === 0) return { done: 0, failed: 0 };

    const version = await this.prisma.knowledgeBaseEmbeddingVersion.findUnique({
      where: { id: versionId },
      select: { id: true, vectorTable: true, dimensions: true },
    });
    if (!version) throw new NotFoundException('向量版本不存在');

    const ok: { chunkId: string; vector: number[] }[] = [];
    const bad: { chunkId: string; error: string }[] = [];
    for (const item of items) {
      if (item.vector?.length === version.dimensions) {
        ok.push(item);
      } else {
        bad.push({
          chunkId: item.chunkId,
          error: `向量维度 ${item.vector?.length ?? 0} 与目标维度 ${version.dimensions} 不符`,
        });
      }
    }

    if (ok.length > 0) {
      const table = version.vectorTable;
      const ids = ok.map((i) => i.chunkId);
      const vecs = ok.map((i) => JSON.stringify(i.vector));

      // 先登记状态行（新上传的 chunk 之前没有记录）
      await this.prisma.documentChunkEmbedding.createMany({
        data: ids.map((id) => ({
          chunkId: id,
          embeddingVersionId: versionId,
          status: 'DONE',
        })),
        skipDuplicates: true,
      });
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "${table}" ("chunkId", "embedding")
         SELECT v.id, v.vec::vector
         FROM unnest($1::text[], $2::text[]) AS v(id, vec)
         ON CONFLICT ("chunkId") DO UPDATE SET "embedding" = EXCLUDED."embedding"`,
        ids,
        vecs,
      );
      await this.prisma.documentChunkEmbedding.updateMany({
        where: { embeddingVersionId: versionId, chunkId: { in: ids } },
        data: { status: 'DONE', error: null },
      });
    }

    if (bad.length > 0) {
      await this.prisma.documentChunkEmbedding.createMany({
        data: bad.map((b) => ({
          chunkId: b.chunkId,
          embeddingVersionId: versionId,
          status: 'FAILED',
          error: b.error,
        })),
        skipDuplicates: true,
      });
      for (const b of bad) {
        await this.prisma.documentChunkEmbedding.updateMany({
          where: { embeddingVersionId: versionId, chunkId: b.chunkId },
          data: { status: 'FAILED', error: b.error },
        });
      }
    }

    await this.refreshStats(versionId);
    return { done: ok.length, failed: bad.length };
  }

  async markChunksFailed(
    versionId: string,
    chunkIds: string[],
    error: string,
  ) {
    if (chunkIds.length === 0) return;
    await this.prisma.documentChunkEmbedding.updateMany({
      where: { embeddingVersionId: versionId, chunkId: { in: chunkIds } },
      data: { status: 'FAILED', error: error.slice(0, 500) },
    });
    await this.refreshStats(versionId);
  }

  /** 重算版本的进度统计 */
  async refreshStats(versionId: string) {
    const grouped = await this.prisma.documentChunkEmbedding.groupBy({
      by: ['status'],
      where: { embeddingVersionId: versionId },
      _count: { _all: true },
    });
    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const done =
      grouped.find((g) => g.status === 'DONE')?._count._all ?? 0;
    const failed =
      grouped.find((g) => g.status === 'FAILED')?._count._all ?? 0;

    const status: VersionStatus =
      failed > 0 && done + failed >= total
        ? VERSION_STATUS.FAILED
        : done >= total && total > 0
          ? VERSION_STATUS.READY
          : VERSION_STATUS.PROCESSING;

    await this.prisma.knowledgeBaseEmbeddingVersion.update({
      where: { id: versionId },
      data: {
        chunkTotal: total,
        chunkDone: done,
        chunkFailed: failed,
        status,
      },
    });
  }

  /** 取该版本下还需要处理的文本块（PENDING / FAILED） */
  async pendingChunks(versionId: string) {
    const rows = await this.prisma.documentChunkEmbedding.findMany({
      where: {
        embeddingVersionId: versionId,
        status: { in: ['PENDING', 'FAILED'] },
      },
      select: { chunkId: true },
    });
    if (rows.length === 0) return [];
    const chunks = await this.prisma.documentChunk.findMany({
      where: { id: { in: rows.map((r) => r.chunkId) } },
      select: { id: true, content: true },
    });
    return chunks;
  }

  // ===========================================================================
  // 激活 / 归档
  // ===========================================================================

  /** 原子切换：只有 READY 的版本才允许激活，避免中途失败的版本顶上来 */
  async activateVersion(userId: string, kbId: string, versionId: string) {
    await this.assertKbOwner(userId, kbId);
    const version = await this.getVersion(userId, kbId, versionId);

    if (version.status !== VERSION_STATUS.READY) {
      throw new BadRequestException(
        `该版本尚未就绪（当前状态 ${version.status}），完成后才能激活`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.knowledgeBaseEmbeddingVersion.updateMany({
        where: { knowledgeBaseId: kbId, isActive: true },
        data: { isActive: false, status: VERSION_STATUS.ARCHIVED },
      }),
      this.prisma.knowledgeBaseEmbeddingVersion.update({
        where: { id: versionId },
        data: { isActive: true, activatedAt: new Date() },
      }),
      // 知识库主记录同步展示用的模型 / 维度，保证「配置」与「实际检索向量」一致
      this.prisma.knowledgeBase.update({
        where: { id: kbId },
        data: {
          embeddingModel: version.modelId,
          embeddingLlmModelId: version.llmModelId,
          embeddingDimension: version.dimensions,
        },
      }),
    ]);

    return this.getVersion(userId, kbId, versionId);
  }

  /** 归档并删除某个版本（不允许删除正在激活的版本） */
  async deleteVersion(userId: string, kbId: string, versionId: string) {
    await this.assertKbOwner(userId, kbId);
    const version = await this.getVersion(userId, kbId, versionId);
    if (version.isActive) {
      throw new BadRequestException('不能删除正在生效的版本，请先切换到其它版本');
    }

    await this.prisma.knowledgeBaseEmbeddingVersion.delete({
      where: { id: versionId },
    });
    // 物理表由数据库级联关系无关，需显式删除
    await this.dropVectorTable(versionId);
    return { id: versionId, deleted: true };
  }

  // ===========================================================================
  // 权限
  // ===========================================================================

  private async assertKbOwner(userId: string, kbId: string) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { ownerId: true },
    });
    if (!kb) throw new NotFoundException('知识库不存在');
    if (kb.ownerId !== userId) {
      throw new ForbiddenException('无权访问该知识库');
    }
  }
}
