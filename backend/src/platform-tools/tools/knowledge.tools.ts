import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { DocumentService } from '../../knowledge/documents/document.service';
import { StorageService } from '../../storage/storage.service';
import { ChatFilesService } from '../../chat-files/chat-files.service';
import type { AttachmentView } from '../../chat-files/chat-files.service';
import { LlmConfigService } from '../../llm-config/llm-config.service';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import { asInt, asOptionalString, asString } from '../platform-tool.interface';
import { knowledgeBaseLink } from '../workflow-definition.util';

/** 文档处理队列名（与 documents.controller.ts 保持一致） */
const DOCUMENT_QUEUE = 'document-processing';

/** pgvector 列固定为 vector(768)，因此维度必须与之一致 */
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_EMBEDDING_DIMENSION = 768;

/** 知识库允许入库的文件类型（与 documents.controller.ts 白名单一致） */
const KB_ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'];

const EXT_TO_TYPE: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  md: 'MARKDOWN',
  markdown: 'MARKDOWN',
};

/**
 * 知识库 / 文档相关平台工具。
 *
 * 「文件转知识库」这条链路完全复用既有能力：
 *   聊天附件（ChatAttachment，已解析）
 *     → 读原始字节（StorageService.readBuffer）
 *     → 重新上传到知识库目录（StorageService.upload）
 *     → 建 Document 记录（DocumentService.create）
 *     → 入 document-processing 队列（解析 → 分块 → Embedding → pgvector）
 *
 * 关键点：**入队成功 ≠ 向量化完成**。因此返回值明确告诉模型「已排队」，
 * 并提供 get_document_processing_status 让用户后续查询真实进度。
 */
@Injectable()
export class KnowledgeTools {
  private readonly logger = new Logger(KnowledgeTools.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledgeService: KnowledgeService,
    private readonly documentService: DocumentService,
    private readonly storageService: StorageService,
    private readonly chatFiles: ChatFilesService,
    private readonly llmConfigService: LlmConfigService,
    @InjectQueue(DOCUMENT_QUEUE) private readonly documentQueue: Queue,
  ) {}

  readonly tools: PlatformTool[] = [
    {
      name: 'list_knowledge_bases',
      meta: {
        label: '查询知识库',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'knowledge_base',
      },
      definition: {
        type: 'function',
        function: {
          name: 'list_knowledge_bases',
          description:
            '查询当前用户的知识库列表（含文档数、分块数、索引完成情况）。' +
            '当用户问「我有哪些知识库」「哪些知识库还没索引完」时使用。',
          parameters: {
            type: 'object',
            properties: {
              keyword: {
                type: 'string',
                description: '可选：按名称模糊筛选',
              },
              onlyIncomplete: {
                type: 'boolean',
                description:
                  '可选：只返回存在未完成处理文档的知识库（有文档处于 UPLOADED/PROCESSING/FAILED）',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.listKnowledgeBases(args, ctx),
    },

    {
      name: 'create_knowledge_base',
      meta: {
        label: '创建知识库',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'knowledge_base',
      },
      definition: {
        type: 'function',
        function: {
          name: 'create_knowledge_base',
          description:
            '为当前用户创建一个新的知识库（空库，创建后需要再上传文档才会产生向量）。' +
            '用户说「把这份文档做成知识库」时，先创建知识库，再调用 attach_document_to_knowledge_base 关联文件。',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: '知识库名称',
              },
              description: {
                type: 'string',
                description: '可选：用途说明',
              },
              embeddingLlmModelId: {
                type: 'string',
                description:
                  '可选：使用用户在「模型管理」中添加的 Embedding 模型 id；不传则用本地默认向量模型',
              },
            },
            required: ['name'],
          },
        },
      },
      execute: (args, ctx) => this.createKnowledgeBase(args, ctx),
    },

    {
      name: 'attach_document_to_knowledge_base',
      meta: {
        label: '文档加入知识库',
        action: 'CREATE',
        riskLevel: 'MEDIUM',
        targetType: 'document',
      },
      definition: {
        type: 'function',
        function: {
          name: 'attach_document_to_knowledge_base',
          description: [
            '把用户已上传的聊天附件加入指定知识库，并启动解析 / 分块 / 向量化流程。',
            'attachmentId 来自聊天附件（用户上传后系统返回的 id），不是文件名 —— 不要凭文件名猜测。',
            `支持的类型：${KB_ALLOWED_EXTENSIONS.join(' / ')}。`,
            '返回后文档处于排队 / 处理中状态，用 get_document_processing_status 查询进度。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              attachmentId: {
                type: 'string',
                description: '要加入知识库的聊天附件 id',
              },
              knowledgeBaseId: {
                type: 'string',
                description: '目标知识库 id',
              },
            },
            required: ['attachmentId', 'knowledgeBaseId'],
          },
        },
      },
      execute: (args, ctx) => this.attachDocument(args, ctx),
    },

    {
      name: 'get_document_processing_status',
      meta: {
        label: '查询文档处理进度',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'document',
      },
      definition: {
        type: 'function',
        function: {
          name: 'get_document_processing_status',
          description:
            '查询知识库中文档的解析 / 向量化进度与失败原因。' +
            '不传 knowledgeBaseId 时，汇总当前用户所有知识库的文档状态。',
          parameters: {
            type: 'object',
            properties: {
              knowledgeBaseId: {
                type: 'string',
                description: '可选：限定某个知识库',
              },
              limit: {
                type: 'integer',
                description: '返回条数，默认 20，最大 100',
              },
            },
          },
        },
      },
      execute: (args, ctx) => this.getProcessingStatus(args, ctx),
    },
  ];

  // =========================================================================
  // 实现
  // =========================================================================

  private async listKnowledgeBases(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const keyword = asOptionalString(args.keyword);
    const onlyIncomplete =
      args.onlyIncomplete === true || args.onlyIncomplete === 'true';

    const kbs = await this.prisma.knowledgeBase.findMany({
      where: {
        ownerId: ctx.userId,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        documentCount: true,
        chunkCount: true,
        embeddingModel: true,
        updatedAt: true,
        documents: {
          select: { status: true },
        },
      },
    });

    const withStats = kbs.map((kb) => {
      const counts: Record<string, number> = {};
      for (const doc of kb.documents) {
        counts[doc.status] = (counts[doc.status] ?? 0) + 1;
      }
      const pending = (counts.UPLOADED ?? 0) + (counts.PROCESSING ?? 0);
      const failed = counts.FAILED ?? 0;
      return {
        id: kb.id,
        name: kb.name,
        description: kb.description,
        documentCount: kb.documentCount,
        chunkCount: kb.chunkCount,
        embeddingModel: kb.embeddingModel,
        pending,
        failed,
        completed: counts.COMPLETED ?? 0,
      };
    });

    const filtered = onlyIncomplete
      ? withStats.filter((kb) => kb.pending > 0 || kb.failed > 0)
      : withStats;

    if (filtered.length === 0) {
      return {
        text: onlyIncomplete
          ? '所有知识库的文档都已处理完成，没有待处理或失败的文档。'
          : '当前用户还没有知识库。',
        targetType: 'knowledge_base',
        summary: onlyIncomplete
          ? '没有未完成索引的知识库'
          : '查询知识库（0 个）',
      };
    }

    const lines = filtered.map((kb) =>
      [
        `- ${kb.name}｜id=${kb.id}`,
        `  文档=${kb.documentCount}｜分块=${kb.chunkCount}｜已完成=${kb.completed}｜处理中=${kb.pending}｜失败=${kb.failed}｜向量模型=${kb.embeddingModel}`,
        kb.description ? `  说明=${kb.description}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return {
      text: `共 ${filtered.length} 个知识库：\n${lines.join('\n')}`,
      targetType: 'knowledge_base',
      summary: `查询知识库（${filtered.length} 个）`,
    };
  }

  private async createKnowledgeBase(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const name = asString(args.name);
    if (!name) {
      return {
        text: '错误：name 不能为空。',
        status: 'FAILED',
        summary: '缺少知识库名称',
      };
    }

    const embeddingLlmModelId = asOptionalString(args.embeddingLlmModelId);
    let embeddingModel = DEFAULT_EMBEDDING_MODEL;

    if (embeddingLlmModelId) {
      const owned = await this.llmConfigService.listOwnedModelIds(ctx.userId);
      if (!owned.includes(embeddingLlmModelId)) {
        return {
          text: `错误：Embedding 模型配置 ${embeddingLlmModelId} 不存在或不属于当前用户。`,
          status: 'DENIED',
          summary: '无权使用该模型配置',
        };
      }
      const realName =
        await this.llmConfigService.getModelName(embeddingLlmModelId);
      if (realName) embeddingModel = realName;
    }

    const kb = await this.knowledgeService.create(ctx.userId, {
      name,
      description: asOptionalString(args.description),
      embeddingModel,
      embeddingDimension: DEFAULT_EMBEDDING_DIMENSION,
      embeddingLlmModelId,
    });

    return {
      text: [
        `✅ 已创建知识库「${kb.name}」（id=${kb.id}）`,
        `向量模型：${kb.embeddingModel}（${kb.embeddingDimension} 维）`,
        '知识库当前为空。可调用 attach_document_to_knowledge_base 把已上传的附件加入进来。',
        `管理入口：${knowledgeBaseLink(kb.id)}`,
      ].join('\n'),
      targetType: 'knowledge_base',
      targetId: kb.id,
      targetName: kb.name,
      summary: `创建知识库「${kb.name}」`,
      link: knowledgeBaseLink(kb.id),
    };
  }

  private async attachDocument(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const attachmentId = asString(args.attachmentId);
    const knowledgeBaseId = asString(args.knowledgeBaseId);

    if (!attachmentId || !knowledgeBaseId) {
      return {
        text: '错误：attachmentId 与 knowledgeBaseId 都必填。',
        status: 'FAILED',
        summary: '入参不完整',
      };
    }

    // 1) 知识库归属校验（owner 模型）
    let kbName: string;
    try {
      await this.documentService.assertKbOwner(ctx.userId, knowledgeBaseId);
      const detail = await this.knowledgeService.findOne(
        ctx.userId,
        knowledgeBaseId,
      );
      kbName = detail.name;
    } catch (err) {
      return {
        text: `错误：${err instanceof Error ? err.message : '知识库校验失败'}`,
        status: 'DENIED',
        summary: '无权访问该知识库',
      };
    }

    // 2) 附件归属 + 解析状态校验
    let attachment: AttachmentView;
    try {
      attachment = await this.chatFiles.findOne(ctx.userId, attachmentId);
    } catch {
      return {
        text: `错误：找不到附件 ${attachmentId}，或它不属于当前用户。请确认 attachmentId 来自用户实际上传的文件。`,
        status: 'DENIED',
        summary: '附件不存在或无权访问',
      };
    }

    if (attachment.status !== 'READY') {
      return {
        text: `错误：附件「${attachment.originalName}」当前状态为 ${attachment.status}，还没有解析完成，暂时无法加入知识库。请稍后重试。`,
        status: 'FAILED',
        targetType: 'document',
        targetName: attachment.originalName,
        summary: '附件尚未解析完成',
      };
    }

    const ext = attachment.extension.toLowerCase().replace(/^\./, '');
    if (!KB_ALLOWED_EXTENSIONS.includes(ext)) {
      return {
        text: `错误：知识库暂不支持 .${ext} 类型（支持 ${KB_ALLOWED_EXTENSIONS.join(' / ')}）。`,
        status: 'FAILED',
        targetType: 'document',
        targetName: attachment.originalName,
        summary: `不支持的文件类型 .${ext}`,
      };
    }

    // 3) 把附件二进制复制到知识库目录（附件的存储 key 归会话所有，不能直接复用）
    let storagePath: string;
    let fileSize: number;
    try {
      const sourceKey = await this.chatFiles.getStorageKey(
        ctx.userId,
        attachmentId,
      );
      const buffer = await this.storageService.readBuffer(sourceKey);
      const uploaded = await this.storageService.upload(
        buffer,
        attachment.originalName,
        `documents/${knowledgeBaseId}`,
      );
      storagePath = uploaded.key;
      fileSize = uploaded.size;
    } catch (err) {
      this.logger.warn(
        `复制附件 ${attachmentId} 到知识库 ${knowledgeBaseId} 失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        text: `错误：文件复制失败（${err instanceof Error ? err.message : '未知错误'}），没有创建文档记录。`,
        status: 'FAILED',
        targetType: 'document',
        targetName: attachment.originalName,
        summary: '文件复制失败',
      };
    }

    // 4) 建 Document 记录
    const doc = await this.documentService.create({
      knowledgeBaseId,
      fileName: attachment.originalName,
      fileType: EXT_TO_TYPE[ext] ?? ext.toUpperCase(),
      fileSize,
      storagePath,
      mimeType: attachment.mimeType,
      status: 'UPLOADED',
    });

    // 5) 入队异步处理（解析 → 分块 → Embedding → pgvector）
    await this.documentQueue.add(
      'process-document',
      {
        documentId: doc.id,
        knowledgeBaseId,
        storagePath,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );

    return {
      text: [
        `✅ 已把「${attachment.originalName}」加入知识库「${kbName}」`,
        `documentId=${doc.id}，状态=UPLOADED（已进入后台处理队列）`,
        '处理包含：文本解析 → 分块 → Embedding → 向量入库。',
        '⚠️ 入队成功不代表向量化已完成，可用 get_document_processing_status 查询真实进度。',
        `管理入口：${knowledgeBaseLink(knowledgeBaseId)}`,
      ].join('\n'),
      targetType: 'document',
      targetId: doc.id,
      targetName: attachment.originalName,
      summary: `将「${attachment.originalName}」加入知识库「${kbName}」并启动处理`,
      link: knowledgeBaseLink(knowledgeBaseId),
    };
  }

  private async getProcessingStatus(
    args: Record<string, unknown>,
    ctx: PlatformToolContext,
  ): Promise<PlatformToolOutcome> {
    const knowledgeBaseId = asOptionalString(args.knowledgeBaseId);
    const limit = Math.min(Math.max(asInt(args.limit, 20), 1), 100);

    const docs = await this.prisma.document.findMany({
      where: {
        ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
        knowledgeBase: { ownerId: ctx.userId },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        fileName: true,
        status: true,
        errorMessage: true,
        fileSize: true,
        pageCount: true,
        createdAt: true,
        updatedAt: true,
        knowledgeBase: { select: { id: true, name: true } },
        _count: { select: { chunks: true } },
      },
    });

    if (docs.length === 0) {
      return {
        text: '没有查询到文档记录。',
        targetType: 'document',
        summary: '查询文档进度（0 条）',
      };
    }

    const statusLabel: Record<string, string> = {
      UPLOADED: '已上传（等待处理）',
      PROCESSING: '处理中',
      COMPLETED: '已完成',
      FAILED: '失败',
    };

    const lines = docs.map((doc) =>
      [
        `- ${doc.fileName}｜${statusLabel[doc.status] ?? doc.status}`,
        `  知识库=${doc.knowledgeBase.name}｜分块=${doc._count.chunks}｜大小=${Math.round(doc.fileSize / 1024)}KB`,
        doc.errorMessage ? `  ⚠️ 失败原因：${doc.errorMessage}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    const pending = docs.filter(
      (d) => d.status === 'UPLOADED' || d.status === 'PROCESSING',
    ).length;
    const failed = docs.filter((d) => d.status === 'FAILED').length;

    return {
      text: [
        `共 ${docs.length} 个文档（处理中 ${pending}，失败 ${failed}）：`,
        ...lines,
      ].join('\n'),
      targetType: 'document',
      targetId: knowledgeBaseId,
      summary: `查询文档进度（${docs.length} 个，处理中 ${pending}，失败 ${failed}）`,
    };
  }
}
