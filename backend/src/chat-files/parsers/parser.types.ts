/**
 * 聊天附件解析器统一契约。
 *
 * 不同文件类型走不同解析器，但最终都归一化为 ParseResult：
 *   - text    ：交给模型阅读的纯文本上下文
 *   - summary ：结构化摘要（如 Excel 的工作表 / 统计信息），比整表文本更可靠
 *   - images  ：图片类附件的原始内容，供支持视觉输入的模型使用
 *   - meta    ：解析元数据（页数 / 工作表数等），用于前端展示
 */

/** 附件大类 */
export type AttachmentKind =
  | 'PDF'
  | 'DOCUMENT'
  | 'SPREADSHEET'
  | 'TEXT'
  | 'IMAGE';

export interface AttachmentImage {
  mimeType: string;
  /** 纯 base64（不含 data: 前缀） */
  base64: string;
}

export interface ParseInput {
  buffer: Buffer;
  fileName: string;
  extension: string;
  mimeType: string;
}

export interface ParseResult {
  text: string;
  summary?: string;
  meta?: Record<string, unknown>;
  images?: AttachmentImage[];
}

export interface AttachmentParser {
  /** 支持的扩展名（不含点，小写） */
  readonly supportedExtensions: string[];
  parse(input: ParseInput): Promise<ParseResult>;
}

/** 构建上下文时使用的附件精简视图（从 ChatAttachment 记录中裁剪而来） */
export interface ChatAttachmentLike {
  id: string;
  originalName: string;
  extension: string;
  kind: string;
  mimeType: string;
  storageKey: string;
  extractedText: string | null;
  summary: string | null;
}
