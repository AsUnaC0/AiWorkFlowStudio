import { Injectable, Logger } from '@nestjs/common';
import { FilesService } from '../../files/files.service';
import type { ToolDefinition } from '../../ai/ai-provider.interface';
import type { GenerateFileInput } from '../../files/types/generated-file.types';
import type { ToolContext } from './agent-tool.interface';

/** generate_file 工具的固定函数名 */
export const GENERATE_FILE_TOOL_NAME = 'generate_file';

/**
 * GenerateFileTool —— 让 Agent 真正产出可下载的文件。
 *
 * 关键点：
 *   - 不让模型编造文件路径或下载链接；由后端真实生成 + 上传 + 落库
 *   - 工具返回值里带上 fileId，Agent 可在回复中引用
 *   - 生成的文件通过 context.files 回传给 AgentService，用于推送 SSE 事件
 */
@Injectable()
export class GenerateFileTool {
  private readonly logger = new Logger(GenerateFileTool.name);

  constructor(private readonly filesService: FilesService) {}

  /** generate_file 的 LLM 可见 schema */
  buildDefinition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: GENERATE_FILE_TOOL_NAME,
        description: [
          '生成并返回一份真实文件（Word / Excel / PDF / Markdown / CSV），用户可在聊天中预览和下载。',
          '当用户明确要求"生成/导出/给我一份/输出 xx 文件/报告"时使用本工具。',
          '',
          '用法：',
          '- 文档类（docx / pdf / md）：提供 markdown 字段（推荐，支持标题、列表、表格、代码块），或 blocks 结构化数组。',
          '- 表格类（xlsx / csv）：提供 sheets（可多工作表），或 columns + rows。',
          '- 一次只能生成一种格式；用户要多种格式时，连续多次调用本工具。',
          '',
          '注意：内容必须基于真实数据或用户提供的信息，不得编造指标数值。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              description: '目标格式：docx / xlsx / pdf / md / csv',
              enum: ['docx', 'xlsx', 'pdf', 'md', 'csv'],
            },
            fileName: {
              type: 'string',
              description: '文件名（不含扩展名），例如「2026年10月销售分析报告」',
            },
            title: {
              type: 'string',
              description: '文档标题，会渲染在文件开头',
            },
            summary: {
              type: 'string',
              description: '一句话摘要 / 副标题（可选）',
            },
            markdown: {
              type: 'string',
              description:
                'Markdown 正文（docx / pdf / md 推荐）。支持 # 标题、- 列表、| 表格 |、``` 代码块',
            },
            blocks: {
              type: 'array',
              description:
                '结构化文档块数组（markdown 的替代方案）。每项形如 {"type":"heading","text":"标题","level":2}',
              items: { type: 'object' },
            },
            sheets: {
              type: 'array',
              description:
                '工作表数组（xlsx / csv 推荐）。每项形如 {"name":"汇总","columns":[{"header":"月份"}],"rows":[{"月份":"1月"}]}',
              items: { type: 'object' },
            },
            columns: {
              type: 'array',
              description: '单表快捷方式：列名数组',
              items: { type: 'string' },
            },
            rows: {
              type: 'array',
              description: '单表快捷方式：行数据二维数组',
              items: { type: 'array' },
            },
          },
          required: ['format'],
        },
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const input: GenerateFileInput = {
      format: String(args.format ?? '') as GenerateFileInput['format'],
      fileName: args.fileName ? String(args.fileName) : undefined,
      title: args.title ? String(args.title) : undefined,
      summary: args.summary ? String(args.summary) : undefined,
      markdown: args.markdown ? String(args.markdown) : undefined,
      blocks: args.blocks as GenerateFileInput['blocks'],
      sheets: args.sheets as unknown as GenerateFileInput['sheets'],
      columns: args.columns as string[] | undefined,
      rows: args.rows as unknown[][] | undefined,
    };

    try {
      const file = await this.filesService.generate(input, {
        userId: context.userId,
        sessionId: context.sessionId,
        sourceType: 'agent',
      });

      // 回传给 AgentService：用于推送 SSE file 事件 + 关联到聊天消息
      context.files?.push(file);

      this.logger.log(
        `[GenerateFileTool] 生成成功 ${file.id} ${file.fileName} (${file.format}, ${file.size}B)`,
      );

      return [
        `文件已生成成功，用户可以直接预览和下载。`,
        `- 文件 ID：${file.id}`,
        `- 文件名：${file.fileName}`,
        `- 格式：${file.format}（${file.extension}）`,
        `- 大小：${file.size} 字节`,
        `- 状态：${file.status}`,
        '',
        '请在回复中简要说明文件内容，并提示用户可点击文件卡片预览或下载。不要编造下载链接。',
      ].join('\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[GenerateFileTool] 生成失败：${message}`);
      return `文件生成失败：${message}。请检查参数（format 是否支持、内容是否为空），修正后重试。`;
    }
  }
}
