import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KnowledgeRetrievalService } from '../../knowledge/retrieval/knowledge-retrieval.service';
import type { ToolContext } from './agent-tool.interface';
import type { ToolDefinition } from '../../ai/ai-provider.interface';

/**
 * KnowledgeTool —— Agent 通过它检索绑定的知识库。
 *
 * 设计要点：
 *   - 一个 Agent 可以绑多个知识库，合成一个 tool，参数里让 LLM 指定想查哪个
 *   - 底层走已有的 KnowledgeRetrievalService（hybrid 模式）
 *   - 返回 topK 条结果，格式化成 LLM 易读的文本
 *
 * 注意：它不 implements AgentTool，因为 definition 依赖 knowledgeBaseIds
 * 动态生成（把可用 KB 列表写进 tool description）。
 */
@Injectable()
export class KnowledgeTool {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
  ) {}

  /** 根据 Agent 绑定的 knowledgeBaseIds 动态生成 ToolDefinition */
  async buildDefinitions(
    knowledgeBaseIds: string[],
  ): Promise<ToolDefinition[]> {
    if (knowledgeBaseIds.length === 0) return [];

    const kbList = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: knowledgeBaseIds } },
      select: { id: true, name: true, description: true },
    });

    // 合成一个综合 Knowledge Tool
    const kbInfo = kbList
      .map(
        (kb) =>
          `- ${kb.id.substring(0, 8)} (${kb.name})${
            kb.description ? `：${kb.description}` : ''
          }`,
      )
      .join('\n');

    return [
      {
        type: 'function',
        function: {
          name: 'knowledge_search',
          description: [
            '从绑定的知识库中检索相关信息。',
            `可用知识库：\n${kbInfo}`,
            'LLM 可以通过 knowledgeBaseIds 参数指定检索范围；留空则全部检索。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '检索查询（自然语言）',
              },
              knowledgeBaseIds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '指定要检索的知识库 ID 列表（ID 前 8 位即可）；留空则检索 Agent 绑定的全部知识库',
              },
              topK: {
                type: 'integer',
                description: '返回 Top N 条结果，默认 5',
              },
            },
            required: ['query'],
          },
        },
      },
    ];
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext & { knowledgeBaseIds?: string[] },
  ): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) return '错误：query 不能为空';

    // 优先用 context 里传的 knowledgeBaseIds（Agent 从 Agent 配置里拿的）
    // LLM 也可能在 args 里指定，两者合并
    const llmSpecifiedIds = Array.isArray(args.knowledgeBaseIds)
      ? (args.knowledgeBaseIds as string[])
      : [];
    const allBoundIds = context.knowledgeBaseIds ?? [];
    // LLM 可以用前 8 位缩写匹配完整 UUID
    const resolvedIds =
      llmSpecifiedIds.length > 0
        ? allBoundIds.filter((boundId) =>
            llmSpecifiedIds.some((short) =>
              boundId.toLowerCase().startsWith(short.toLowerCase()),
            ),
          )
        : allBoundIds;

    const topK = Number(args.topK ?? 5);

    console.log(
      `[KnowledgeTool] query="${query}" kbs=${resolvedIds.length} topK=${topK}`,
    );

    const results = await this.knowledgeRetrievalService.search({
      knowledgeBaseIds: resolvedIds,
      query,
      topK,
      mode: 'hybrid',
    });

    if (results.length === 0) {
      return `知识库中未检索到与「${query}」相关的内容。`;
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}]${r.fileName ? ` (来源：${r.fileName})` : ''} 相似度=${(r.score ?? 0).toFixed(3)}\n${r.content}`,
      )
      .join('\n\n');

    return `检索到 ${results.length} 条结果：\n\n${formatted}`;
  }
}
