import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../knowledge/embedding/embedding.service';
import { LlmConfigService } from '../llm-config/llm-config.service';
import type { MemoryRecallItem } from '../assistant/platform-assistant.context';
import {
  DEFAULT_RECALL_LIMIT,
  LINK_SIMILARITY_THRESHOLD,
  MAX_LINKS_PER_MEMORY,
  MAX_RECALL_LIMIT,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_GRAPH_NODE_LIMIT,
  RECALL_CANDIDATE_LIMIT,
  isMemoryCategory,
} from './memory.constant';

/** 列表项（不含原文 —— 原文只在详情接口返回） */
export interface MemoryListItem {
  id: string;
  category: string;
  categoryLabel: string;
  summary: string;
  importance: number;
  sourceConversationId: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
}

export interface MemoryGraphNode {
  id: string;
  category: string;
  summary: string;
  importance: number;
  degree: number;
  createdAt: string;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  weight: number;
}

export interface MemoryGraphPayload {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  /** 该用户记忆总数（含未渲染的部分） */
  total: number;
  /** 是否因上限被截断 */
  truncated: boolean;
  /** 分类统计（前端图例 / 过滤条） */
  categories: Array<{ category: string; label: string; count: number }>;
}

export interface MemorySettingsPayload {
  autoCaptureEnabled: boolean;
  captureModelId: string | null;
  recallLimit: number;
}

/**
 * MemoryService —— 记忆的存储、召回、可视化数据。
 *
 * 三条不可动摇的约束：
 *   1. 一切查询都带 `userId`（来自 JWT），不存在「按 id 查任意记忆」的路径。
 *   2. 列表 / 图数据只返回摘要与元信息，**原文只走详情接口**（需求 4.5）。
 *   3. 向量用 Float[] + 应用层余弦（见 schema.prisma 中 Memory 的注释），
 *      不引入 pgvector —— 换 Embedding 模型时不需要重建列。
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  /** 没有绑定云端 Embedding 模型时的本地兜底模型名 */
  private static readonly DEFAULT_LOCAL_EMBEDDING = 'nomic-embed-text';

  /**
   * 向量化熔断时间戳。
   *
   * 场景：用户没配 Embedding 模型、本地 Ollama 也没起 —— 每次调用都会等到超时，
   * 而召回发生在**每轮对话**的关键路径上，会把聊天拖成几秒才出第一个字。
   * 所以失败一次就熔断 5 分钟，期间直接走关键词召回。
   */
  private embeddingDisabledUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  // ===========================================================================
  // 列表 / 详情 / 删除
  // ===========================================================================

  async list(
    userId: string,
    options: { page?: number; pageSize?: number; category?: string } = {},
  ) {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    const where = {
      userId,
      ...(isMemoryCategory(options.category)
        ? { category: options.category }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.memory.count({ where }),
      this.prisma.memory.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // 显式 select，避免 content / embedding 被顺手带出去
        select: {
          id: true,
          category: true,
          summary: true,
          importance: true,
          sourceConversationId: true,
          lastAccessedAt: true,
          accessCount: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /** 详情（含原文）—— 只有这里会返回 content */
  async detail(userId: string, id: string) {
    const memory = await this.prisma.memory.findFirst({
      where: { id, userId },
    });
    if (!memory) throw new NotFoundException('记忆不存在');

    return {
      ...this.toListItem(memory),
      content: memory.content,
      sourceMessageId: memory.sourceMessageId,
      embeddingModel: memory.embeddingModel,
      updatedAt: memory.updatedAt.toISOString(),
    };
  }

  async remove(userId: string, id: string) {
    const memory = await this.prisma.memory.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!memory) throw new NotFoundException('记忆不存在');

    await this.prisma.$transaction([
      this.prisma.memoryLink.deleteMany({
        where: { userId, OR: [{ sourceId: id }, { targetId: id }] },
      }),
      this.prisma.memory.delete({ where: { id } }),
    ]);
    return { success: true, id };
  }

  /** 清空全部（前端需二次确认，后端只做归属过滤，不接受指定用户） */
  async clearAll(userId: string) {
    const [links, memories] = await this.prisma.$transaction([
      this.prisma.memoryLink.deleteMany({ where: { userId } }),
      this.prisma.memory.deleteMany({ where: { userId } }),
    ]);
    this.logger.log(
      `用户 ${userId} 清空记忆：${memories.count} 条记忆 / ${links.count} 条关联`,
    );
    return { success: true, deleted: memories.count };
  }

  // ===========================================================================
  // 3D 图数据
  // ===========================================================================

  /**
   * 返回 3D 网络所需的节点与连线。
   *
   * 节点按「重要度 → 新近度」排序后截断到上限（而不是简单取最新 N 条），
   * 保证用户看到的宇宙里留下的是「重要的记忆」，而不是「最近的流水账」。
   */
  async graph(
    userId: string,
    options: { category?: string; limit?: number } = {},
  ): Promise<MemoryGraphPayload> {
    const limit = Math.min(
      MEMORY_GRAPH_NODE_LIMIT,
      Math.max(1, options.limit ?? MEMORY_GRAPH_NODE_LIMIT),
    );
    const categoryFilter = isMemoryCategory(options.category)
      ? options.category
      : undefined;

    const [total, allRows] = await Promise.all([
      this.prisma.memory.count({ where: { userId } }),
      this.prisma.memory.findMany({
        where: { userId },
        orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: {
          id: true,
          category: true,
          summary: true,
          importance: true,
          createdAt: true,
        },
      }),
    ]);

    const filtered = categoryFilter
      ? allRows.filter((r) => r.category === categoryFilter)
      : allRows;
    const idSet = new Set(filtered.map((r) => r.id));

    const rawLinks = await this.prisma.memoryLink.findMany({
      where: {
        userId,
        sourceId: { in: [...idSet] },
        targetId: { in: [...idSet] },
      },
      select: { sourceId: true, targetId: true, weight: true },
    });

    const degree = new Map<string, number>();
    for (const link of rawLinks) {
      degree.set(link.sourceId, (degree.get(link.sourceId) ?? 0) + 1);
      degree.set(link.targetId, (degree.get(link.targetId) ?? 0) + 1);
    }

    const counts = new Map<string, number>();
    for (const row of allRows) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }

    return {
      nodes: filtered.map((r) => ({
        id: r.id,
        category: r.category,
        summary: r.summary,
        importance: r.importance,
        degree: degree.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
      })),
      links: rawLinks.map((l) => ({
        source: l.sourceId,
        target: l.targetId,
        weight: l.weight,
      })),
      total,
      truncated: total > allRows.length,
      categories: MEMORY_CATEGORIES.map((c) => ({
        category: c,
        label: MEMORY_CATEGORY_LABELS[c],
        count: counts.get(c) ?? 0,
      })),
    };
  }

  // ===========================================================================
  // 召回
  // ===========================================================================

  /**
   * 召回若干条记忆，供 System Prompt 注入。
   *
   * 打分：0.6 * 相关度 + 0.2 * 重要度 + 0.2 * 新近度
   *   相关度优先用向量余弦；向量不可用（没配 Embedding 模型 / 调用失败）时
   *   退回关键词重合度 —— 宁可粗一点，也不能因为向量服务挂了就完全不召回。
   */
  async recall(
    userId: string,
    agentId: string,
    query: string,
    limit?: number,
  ): Promise<MemoryRecallItem[]> {
    const settings = await this.getSettings(userId);
    const take = Math.min(
      MAX_RECALL_LIMIT,
      Math.max(1, limit ?? settings.recallLimit ?? DEFAULT_RECALL_LIMIT),
    );

    const candidates = await this.prisma.memory.findMany({
      where: { userId, agentId },
      orderBy: { createdAt: 'desc' },
      take: RECALL_CANDIDATE_LIMIT,
      select: {
        id: true,
        category: true,
        summary: true,
        importance: true,
        embedding: true,
        createdAt: true,
      },
    });
    if (candidates.length === 0) return [];

    const queryVector =
      query.trim() && candidates.some((m) => m.embedding.length > 0)
        ? await this.tryEmbed(userId, query)
        : null;
    const queryGrams = query.trim() ? gramSet(query) : new Set<string>();

    const now = Date.now();
    const scored = candidates.map((m) => {
      let relevance = 0;
      if (queryVector && m.embedding.length === queryVector.length) {
        relevance = cosine(queryVector, m.embedding);
      } else if (queryGrams.size > 0) {
        relevance = jaccard(queryGrams, gramSet(m.summary));
      }

      const ageDays = (now - m.createdAt.getTime()) / 86400000;
      const recency = Math.exp(-ageDays / 30);
      const score =
        0.6 * Math.max(0, relevance) + 0.2 * m.importance + 0.2 * recency;
      return { memory: m, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, take);

    // 命中即更新访问记录（fire-and-forget，失败不影响对话）
    void this.touch(userId, picked.map((p) => p.memory.id));

    return picked.map((p) => ({
      category: p.memory.category,
      summary: p.memory.summary,
      importance: p.memory.importance,
      createdAt: p.memory.createdAt,
    }));
  }

  private async touch(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.prisma.memory.updateMany({
        where: { id: { in: ids }, userId },
        data: { lastAccessedAt: new Date(), accessCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `更新记忆访问时间失败（已忽略）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ===========================================================================
  // 写入（供 MemoryWriterService 使用）
  // ===========================================================================

  async create(input: {
    userId: string;
    agentId: string;
    category: string;
    summary: string;
    content: string;
    importance: number;
    sourceConversationId?: string;
    sourceMessageId?: string;
  }) {
    const embedding = await this.tryEmbed(
      input.userId,
      `${input.summary}\n${input.content}`,
    );
    const embeddingModel = embedding ? await this.resolveEmbeddingModelName(input.userId) : null;

    return this.prisma.memory.create({
      data: {
        userId: input.userId,
        agentId: input.agentId,
        category: isMemoryCategory(input.category) ? input.category : 'OTHER',
        summary: input.summary,
        content: input.content,
        importance: Math.min(1, Math.max(0, input.importance)),
        embedding: embedding ?? [],
        embeddingModel,
        sourceConversationId: input.sourceConversationId,
        sourceMessageId: input.sourceMessageId,
      },
      select: { id: true, category: true, summary: true, embedding: true },
    });
  }

  /**
   * 为新记忆建边。
   *
   * 只在「同类或语义相近」时连线：同类 0.6 分起步、跨类必须真的相似。
   * 不连边的话 3D 图会是一堆孤立的点；连太多又会糊成一团，所以限制每个节点最多 4 条。
   */
  async buildLinks(
    userId: string,
    memory: { id: string; category: string; embedding: number[] },
  ): Promise<number> {
    if (memory.embedding.length === 0) return 0;

    const candidates = await this.prisma.memory.findMany({
      where: { userId, id: { not: memory.id } },
      orderBy: { createdAt: 'desc' },
      take: RECALL_CANDIDATE_LIMIT,
      select: { id: true, category: true, embedding: true },
    });

    const scored = candidates
      .filter((c) => c.embedding.length === memory.embedding.length)
      .map((c) => ({
        id: c.id,
        weight: cosine(memory.embedding, c.embedding),
      }))
      .filter((c) => c.weight >= LINK_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_LINKS_PER_MEMORY);

    if (scored.length === 0) return 0;

    let created = 0;
    for (const c of scored) {
      try {
        await this.prisma.memoryLink.create({
          data: {
            userId,
            sourceId: memory.id,
            targetId: c.id,
            weight: Number(c.weight.toFixed(3)),
          },
        });
        created++;
      } catch {
        // 唯一约束冲突（重复连线）直接跳过
      }
    }
    return created;
  }

  // ===========================================================================
  // 设置
  // ===========================================================================

  async getSettings(userId: string): Promise<MemorySettingsPayload> {
    const row = await this.prisma.memorySetting.findUnique({
      where: { userId },
    });
    return {
      autoCaptureEnabled: row?.autoCaptureEnabled ?? true,
      captureModelId: row?.captureModelId ?? null,
      recallLimit: row?.recallLimit ?? DEFAULT_RECALL_LIMIT,
    };
  }

  async updateSettings(
    userId: string,
    dto: {
      autoCaptureEnabled?: boolean;
      captureModelId?: string | null;
      recallLimit?: number;
    },
  ): Promise<MemorySettingsPayload> {
    const recallLimit =
      typeof dto.recallLimit === 'number'
        ? Math.min(MAX_RECALL_LIMIT, Math.max(1, dto.recallLimit))
        : undefined;

    const row = await this.prisma.memorySetting.upsert({
      where: { userId },
      create: {
        userId,
        autoCaptureEnabled: dto.autoCaptureEnabled ?? true,
        captureModelId: dto.captureModelId ?? null,
        recallLimit: recallLimit ?? DEFAULT_RECALL_LIMIT,
      },
      update: {
        ...(dto.autoCaptureEnabled !== undefined
          ? { autoCaptureEnabled: dto.autoCaptureEnabled }
          : {}),
        ...(dto.captureModelId !== undefined
          ? { captureModelId: dto.captureModelId || null }
          : {}),
        ...(recallLimit !== undefined ? { recallLimit } : {}),
      },
    });

    return {
      autoCaptureEnabled: row.autoCaptureEnabled,
      captureModelId: row.captureModelId,
      recallLimit: row.recallLimit,
    };
  }

  // ===========================================================================
  // 向量辅助
  // ===========================================================================

  /**
   * 尽力生成向量：没有 Embedding 模型、调用超时、维度异常都返回 null。
   * 记忆功能不能因为向量服务不可用就整体失效。
   */
  private async tryEmbed(
    userId: string,
    text: string,
  ): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    // 熔断中：不再尝试，直接走关键词召回
    if (Date.now() < this.embeddingDisabledUntil) return null;

    try {
      const models = await this.llmConfigService.listModels(userId, 'EMBEDDING');
      const model = models[0];
      const vectors = await this.embeddingService.embedBatch(
        [trimmed.slice(0, 2000)],
        MemoryService.DEFAULT_LOCAL_EMBEDDING,
        model?.id ?? null,
      );
      const vector = vectors[0];
      return Array.isArray(vector) && vector.length > 0 ? vector : null;
    } catch (e) {
      this.embeddingDisabledUntil = Date.now() + 5 * 60 * 1000;
      this.logger.warn(
        `记忆向量化失败，5 分钟内改用关键词召回：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  private async resolveEmbeddingModelName(
    userId: string,
  ): Promise<string | null> {
    try {
      const models = await this.llmConfigService.listModels(userId, 'EMBEDDING');
      return models[0]?.modelId ?? MemoryService.DEFAULT_LOCAL_EMBEDDING;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // 序列化
  // ===========================================================================

  private toListItem(row: {
    id: string;
    category: string;
    summary: string;
    importance: number;
    sourceConversationId: string | null;
    lastAccessedAt: Date | null;
    accessCount: number;
    createdAt: Date;
  }): MemoryListItem {
    return {
      id: row.id,
      category: row.category,
      categoryLabel:
        MEMORY_CATEGORY_LABELS[
          row.category as keyof typeof MEMORY_CATEGORY_LABELS
        ] ?? row.category,
      summary: row.summary,
      importance: row.importance,
      sourceConversationId: row.sourceConversationId,
      lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null,
      accessCount: row.accessCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// ===========================================================================
// 数学工具（导出给 MemoryWriterService 复用）
// ===========================================================================

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 中文按 2-gram 切、英文按单词切，得到用于重合度比较的集合。
 * 不引入分词库 —— 记忆召回只需要「粗相关」，不值得为它加一个词典依赖。
 */
export function gramSet(text: string): Set<string> {
  const set = new Set<string>();
  const normalized = text.toLowerCase();
  for (const word of normalized.match(/[a-z0-9_]{2,}/g) ?? []) {
    set.add(word);
  }
  const cjk = normalized.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const segment of cjk.split(/\s+/)) {
    for (let i = 0; i < segment.length - 1; i++) {
      set.add(segment.slice(i, i + 2));
    }
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter++;
  }
  return inter / (a.size + b.size - inter);
}
