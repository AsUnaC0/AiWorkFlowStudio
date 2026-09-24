import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 向量检索结果 */
export interface VectorHit {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  content: string;
  distance: number;
}

/** 关键词检索结果 */
export interface KeywordHit {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  content: string;
  rank: number;
}

/**
 * pgvector 封装层
 * ⚠️ 表名/列名全部用 Prisma 自动生成的双引号 PascalCase：
 *   Prisma 生成的 SQL migration 里是 "DocumentChunk" / "Document" / "documentId"
 *   PostgreSQL 双引号标识符区分大小写，不能用 snake_case。
 */
@Injectable()
export class VectorStoreService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // 写入 / 更新
  // =========================================================================

  /** 更新单个 chunk 的 embedding */
  async updateEmbedding(chunkId: string, vector: number[]): Promise<void> {
    const vectorString = JSON.stringify(vector);
    await this.prisma.$executeRaw`
      UPDATE "DocumentChunk"
      SET "embedding" = ${vectorString}::vector
      WHERE "id" = ${chunkId}::text
    `;
  }

  /**
   * 批量更新 embedding —— unnest 一次灌进去
   * 比一条条 UPDATE 快一个数量级
   */
  async updateEmbeddingBatch(
    pairs: { chunkId: string; vector: number[] }[],
  ): Promise<void> {
    if (pairs.length === 0) return;

    const ids = pairs.map((p) => p.chunkId);
    const vectors = pairs.map((p) => JSON.stringify(p.vector));

    // 所有 ID 列在数据库中都是 TEXT（Prisma String 映射为 text，非原生 uuid）
    // 这里必须用 ::text[]，否则会出现 text = uuid 类型不匹配
    const sql = `
      UPDATE "DocumentChunk" AS dc
      SET "embedding" = v.vec::vector
      FROM unnest($1::text[], $2::text[]) AS v(id, vec)
      WHERE dc."id" = v.id
    `;
    await this.prisma.$executeRawUnsafe(sql, ids, vectors);
  }

  // =========================================================================
  // 检索
  // =========================================================================

  /**
   * 向量检索 —— pgvector 余弦距离（<=>）
   * 距离越小越相似。threshold 是距离阈值（≤ 保留，> 丢弃），通常 0.5~0.8。
   */
  async vectorSearch(
    knowledgeBaseIds: string[],
    queryVector: number[],
    topK = 10,
    threshold = 0.8,
  ): Promise<VectorHit[]> {
    if (knowledgeBaseIds.length === 0) return [];

    const vectorString = JSON.stringify(queryVector);
    const rows = await this.prisma.$queryRaw<VectorHit[]>`
      SELECT
        dc."id"              AS "chunkId",
        dc."documentId",
        d."knowledgeBaseId",
        dc.content,
        dc."embedding" <=> ${vectorString}::vector AS distance
      FROM "DocumentChunk" dc
      JOIN "Document" d ON d."id" = dc."documentId"
      WHERE d."knowledgeBaseId" = ANY(${knowledgeBaseIds}::text[])
        AND dc."embedding" IS NOT NULL
        AND dc."embedding" <=> ${vectorString}::vector <= ${threshold}
      ORDER BY dc."embedding" <=> ${vectorString}::vector ASC
      LIMIT ${topK}
    `;
    return rows;
  }

  /**
   * 关键词检索 —— PostgreSQL 原生 tsvector 全文检索
   * 用 simple 分词器（兼容中英文，不依赖 zhparser 扩展）。
   */
  async keywordSearch(
    knowledgeBaseIds: string[],
    query: string,
    topK = 10,
  ): Promise<KeywordHit[]> {
    if (knowledgeBaseIds.length === 0 || !query.trim()) return [];

    const rows = await this.prisma.$queryRaw<KeywordHit[]>`
      SELECT
        dc."id"              AS "chunkId",
        dc."documentId",
        d."knowledgeBaseId",
        dc.content,
        ts_rank(to_tsvector('simple', dc.content), plainto_tsquery('simple', ${query})) AS rank
      FROM "DocumentChunk" dc
      JOIN "Document" d ON d."id" = dc."documentId"
      WHERE d."knowledgeBaseId" = ANY(${knowledgeBaseIds}::text[])
        AND to_tsvector('simple', dc.content) @@ plainto_tsquery('simple', ${query})
      ORDER BY rank DESC
      LIMIT ${topK}
    `;
    return rows;
  }

  /** 混合检索：向量 + 关键词，RRF 加权合并 */
  async hybridSearch(
    knowledgeBaseIds: string[],
    query: string,
    queryVector: number[],
    topK = 10,
  ): Promise<(VectorHit & { score: number })[]> {
    const [vectorHits, keywordHits] = await Promise.all([
      this.vectorSearch(knowledgeBaseIds, queryVector, topK * 2, 1.0),
      this.keywordSearch(knowledgeBaseIds, query, topK * 2),
    ]);

    const k = 60; // RRF 常数，业界默认值
    const scores = new Map<string, number>();
    const hitMap = new Map<string, Record<string, unknown>>();

    vectorHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + 1 / (k + rank + 1));
      hitMap.set(h.chunkId, { ...hitMap.get(h.chunkId), ...h });
    });
    keywordHits.forEach((h, rank) => {
      scores.set(h.chunkId, (scores.get(h.chunkId) ?? 0) + 1 / (k + rank + 1));
      hitMap.set(h.chunkId, { ...hitMap.get(h.chunkId), ...h });
    });

    const merged = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(
        ([id, score]) =>
          ({ ...hitMap.get(id)!, score }) as VectorHit & { score: number },
      );

    return merged;
  }
}
