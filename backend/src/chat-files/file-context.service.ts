import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { ChatFilesService } from './chat-files.service';
import type { AttachmentImage, ChatAttachmentLike } from './parsers/parser.types';

/** 单次请求中，所有附件文本的总字符预算（默认 24k 字符，约 6~8k token） */
const DEFAULT_CONTEXT_MAX_CHARS = Number(
  process.env.CHAT_FILE_CONTEXT_MAX_CHARS ?? 24_000,
);
/** 历史消息中单个附件的字符预算（更省，给最新一轮留空间） */
const HISTORY_ATTACHMENT_MAX_CHARS = Number(
  process.env.CHAT_FILE_HISTORY_ATTACHMENT_CHARS ?? 6_000,
);
/** 单张图片随消息发送的体积上限 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 常见支持视觉输入的模型关键字 */
const VISION_MODEL_HINTS = [
  'llava',
  'bakllava',
  'llama-vision',
  'vision',
  'minicpm-v',
  'moondream',
  'internvl',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'glm-4v',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4v',
  'claude-3',
  'gemini',
];

export interface BuiltContext {
  /** 注入到用户消息里的附件文本块（为空表示没有可用文本） */
  text: string;
  /** 需要随消息一起发给视觉模型的图片 */
  images: AttachmentImage[];
}

/**
 * FileContextService —— 把解析结果整理成「模型可理解」的上下文。
 *
 * 关键约束：
 *   1. 绝不能不加限制地把全文塞给模型 —— 按预算截断，并优先保留摘要；
 *   2. 图片类附件走视觉通道，不支持视觉的模型要明确降级提示，而不是静默忽略；
 *   3. 保留文件名与来源，便于模型在回答里做引用。
 */
@Injectable()
export class FileContextService {
  private readonly logger = new Logger(FileContextService.name);

  constructor(
    private readonly chatFiles: ChatFilesService,
    private readonly storage: StorageService,
  ) {}

  /** 判断某个模型是否可能支持视觉输入（用于决定图片走视觉还是降级提示） */
  supportsVision(model?: string): boolean {
    if (!model) return false;
    const extra = (process.env.CHAT_FILE_VISION_MODELS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const target = model.toLowerCase();
    return [...VISION_MODEL_HINTS, ...extra].some((hint) =>
      target.includes(hint),
    );
  }

  /**
   * 构建「用户问题 + 附件内容」的完整上下文。
   *
   * @param question   用户本轮输入
   * @param attachments 已解析完成的附件
   * @param options.model   当前实际使用的模型（决定是否启用视觉）
   * @param options.userId  当前用户（读取图片二进制时做权限校验）
   */
  async build(input: {
    question: string;
    attachments: ChatAttachmentLike[];
    model?: string;
    userId: string;
    maxChars?: number;
  }): Promise<BuiltContext> {
    const { question, attachments, model, userId } = input;
    if (!attachments.length) return { text: '', images: [] };

    const totalBudget = input.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const perFileBudget = Math.max(
      2_000,
      Math.floor(totalBudget / attachments.length),
    );

    const vision = this.supportsVision(model);
    const blocks: string[] = [];
    const images: AttachmentImage[] = [];
    let used = 0;

    for (const [index, attachment] of attachments.entries()) {
      const isImage = attachment.kind === 'IMAGE';

      if (isImage) {
        if (vision) {
          const image = await this.loadImage(userId, attachment);
          if (image) {
            images.push(image);
            blocks.push(
              `[附件 ${index + 1}：图片 ${attachment.originalName}]\n（图片已随消息一起发送给模型，请直接观察图片内容作答）`,
            );
            continue;
          }
        }
        // 不支持视觉 / 图片过大 → 明确降级提示，避免模型凭空编造
        blocks.push(
          `[附件 ${index + 1}：图片 ${attachment.originalName}]\n（当前模型不支持视觉输入或图片过大，无法读取图片内容。请提示用户更换支持视觉输入的模型，或让用文字描述图片内容。）`,
        );
        continue;
      }

      const body = this.pickText(attachment, perFileBudget);
      const head = `[附件 ${index + 1}：${attachment.originalName}｜类型：${kindLabel(
        attachment.kind,
      )}]`;

      const parts = [head];
      if (attachment.summary) parts.push(`摘要：${attachment.summary}`);
      parts.push(
        body
          ? `内容：\n${body}`
          : '内容：（未能从该文件中提取到文本内容）',
      );

      const block = parts.join('\n');
      if (used + block.length > totalBudget && blocks.length > 0) {
        blocks.push(
          `[附件 ${index + 1}：${attachment.originalName}]（因上下文长度限制已省略）`,
        );
        continue;
      }
      used += block.length;
      blocks.push(block);
    }

    const text = [
      question ? `用户问题：\n${question}` : '',
      '',
      '以下是用户上传的附件内容：',
      '',
      blocks.join('\n\n'),
      '',
      '请基于上述附件内容回答用户的问题。回答时如引用了附件中的信息，请注明文件名。若附件中没有相关信息，请明确说明而不是编造。',
    ]
      .filter(Boolean)
      .join('\n');

    return { text, images };
  }

  /**
   * 历史消息的附件上下文（用于追问）。
   * 预算更小，只保留摘要 + 前若干字符，保证多轮对话也能持续引用文件内容。
   */
  buildHistoryBlock(attachments: ChatAttachmentLike[]): string {
    if (!attachments.length) return '';

    const blocks = attachments.map((a) => {
      const body = (a.extractedText ?? '').slice(
        0,
        HISTORY_ATTACHMENT_MAX_CHARS,
      );
      const parts = [`[附件：${a.originalName}]`];
      if (a.summary) parts.push(`摘要：${a.summary}`);
      if (body) parts.push(`内容节选：\n${body}`);
      return parts.join('\n');
    });

    return `\n\n（该消息附带的附件内容）\n${blocks.join('\n\n')}`;
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  private pickText(
    attachment: ChatAttachmentLike,
    budget: number,
  ): string {
    const raw = (attachment.extractedText ?? '').trim();
    if (!raw) return '';
    if (raw.length <= budget) return raw;
    return `${raw.slice(0, budget)}\n…（内容过长，已截断，仅保留前 ${budget} 字符）`;
  }

  /** 读取图片二进制（走 ChatFilesService 做归属校验） */
  private async loadImage(
    userId: string,
    attachment: ChatAttachmentLike,
  ): Promise<AttachmentImage | null> {
    try {
      const buffer = await this.chatFiles.readImageBuffer(userId, attachment);
      if (buffer.length > MAX_IMAGE_BYTES) return null;
      return {
        mimeType: attachment.mimeType || 'image/png',
        base64: buffer.toString('base64'),
      };
    } catch (err) {
      this.logger.warn(
        `[FileContext] 读取图片附件失败：${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'PDF':
      return 'PDF 文档';
    case 'DOCUMENT':
      return 'Word 文档';
    case 'SPREADSHEET':
      return '表格';
    case 'IMAGE':
      return '图片';
    default:
      return '文本';
  }
}
