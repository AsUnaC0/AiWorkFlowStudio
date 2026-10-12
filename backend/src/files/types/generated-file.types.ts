// ===========================================================================
// 生成文件统一类型定义
//
// 设计原则：
//   1. LLM 不产出二进制，只产出「结构化内容」（DocumentContent / SpreadsheetContent）
//   2. 各 Generator 负责把结构化内容转换为真实文件格式
//   3. 内容模型与格式解耦 —— 同一份内容可导出 docx / pdf / md
// ===========================================================================

/** 支持的生成格式 */
export type GeneratedFileFormat = 'docx' | 'xlsx' | 'pdf' | 'md' | 'csv';

export const GENERATED_FILE_FORMATS: GeneratedFileFormat[] = [
  'docx',
  'xlsx',
  'pdf',
  'md',
  'csv',
];

/** 前端预览组件类型 */
export type PreviewType =
  | 'pdf'
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'markdown'
  | 'text'
  | 'csv';

/** 文件状态 */
export type GeneratedFileStatus = 'PROCESSING' | 'READY' | 'FAILED';

/** 文件来源 */
export type GeneratedFileSource = 'chat' | 'agent' | 'workflow' | 'skill' | 'export';

// ===========================================================================
// 文档类内容模型（docx / pdf / md 共用）
// ===========================================================================

export type DocBlockType =
  | 'heading'
  | 'paragraph'
  | 'bullets'
  | 'numbers'
  | 'quote'
  | 'code'
  | 'table'
  | 'divider';

export interface HeadingBlock {
  type: 'heading';
  text: string;
  /** 1 ~ 6，默认 2 */
  level?: number;
}

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface BulletsBlock {
  type: 'bullets';
  items: string[];
}

export interface NumbersBlock {
  type: 'numbers';
  items: string[];
}

export interface QuoteBlock {
  type: 'quote';
  text: string;
}

export interface CodeBlock {
  type: 'code';
  text: string;
  language?: string;
}

export interface TableBlock {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface DividerBlock {
  type: 'divider';
}

export type DocBlock =
  | HeadingBlock
  | ParagraphBlock
  | BulletsBlock
  | NumbersBlock
  | QuoteBlock
  | CodeBlock
  | TableBlock
  | DividerBlock;

/** 一份文档（Word / PDF / Markdown 的通用中间表示） */
export interface DocumentContent {
  title?: string;
  subtitle?: string;
  summary?: string;
  blocks: DocBlock[];
}

// ===========================================================================
// 表格类内容模型（xlsx / csv 共用）
// ===========================================================================

export interface SheetColumn {
  header: string;
  /** 行对象取值用的 key；省略时按下标取值 */
  key?: string;
  /** 列宽（字符数） */
  width?: number;
}

/** 行数据：对象形式（配合 column.key）或数组形式（按下标） */
export type SheetRow = Record<string, unknown> | unknown[];

export interface SheetSpec {
  name: string;
  columns?: SheetColumn[];
  rows: SheetRow[];
  /** 备注 / 说明（写入工作表顶部，可选） */
  note?: string;
}

export interface SpreadsheetContent {
  sheets: SheetSpec[];
}

// ===========================================================================
// 生成请求
// ===========================================================================

/**
 * 生成文件的输入。
 *
 * 文档类（docx / pdf / md）：
 *   - 优先使用 `markdown`（LLM 最擅长），后端解析为 blocks
 *   - 也可直接给结构化 `blocks`
 *
 * 表格类（xlsx / csv）：
 *   - 优先使用 `sheets`（多工作表）
 *   - 也可给单层 `columns` + `rows`
 */
export interface GenerateFileInput {
  format: GeneratedFileFormat;
  /** 文件名（不含扩展名，扩展名由 format 决定） */
  fileName?: string;
  title?: string;
  summary?: string;

  markdown?: string;
  blocks?: DocBlock[];
  sheets?: SheetSpec[];
  columns?: string[];
  rows?: unknown[][];

  /** 生成选项（页眉页脚、纸张方向等，按需扩展） */
  options?: Record<string, unknown>;
}

/** 生成结果（二进制 + 元信息） */
export interface GeneratedBuffer {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  extension: string;
  format: GeneratedFileFormat;
  previewType: PreviewType;
}

// ===========================================================================
// 预览数据结构
// ===========================================================================

export interface PreviewSheetCell {
  value: string;
}

export interface PreviewSheet {
  name: string;
  headers: string[];
  rows: string[][];
  /** 数据是否因超出上限被截断 */
  truncated?: boolean;
}

export interface FilePreviewPayload {
  id: string;
  fileName: string;
  previewType: PreviewType;
  /** markdown / document：后端渲染并消毒后的 HTML */
  html?: string;
  /** spreadsheet / csv：工作表数据 */
  sheets?: PreviewSheet[];
  /** 纯文本（text 预览） */
  text?: string;
  /** 需要整文件预览时的原始地址（前端带鉴权抓取后转 blob） */
  rawUrl?: string;
}

// ===========================================================================
// 格式元信息映射
// ===========================================================================

export const FORMAT_META: Record<
  GeneratedFileFormat,
  { extension: string; mimeType: string; previewType: PreviewType; label: string }
> = {
  docx: {
    extension: 'docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    previewType: 'document',
    label: 'Word 文档',
  },
  xlsx: {
    extension: 'xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    previewType: 'spreadsheet',
    label: 'Excel 工作簿',
  },
  pdf: {
    extension: 'pdf',
    mimeType: 'application/pdf',
    previewType: 'pdf',
    label: 'PDF 文档',
  },
  md: {
    extension: 'md',
    mimeType: 'text/markdown',
    previewType: 'markdown',
    label: 'Markdown',
  },
  csv: {
    extension: 'csv',
    mimeType: 'text/csv',
    previewType: 'csv',
    label: 'CSV 表格',
  },
};
