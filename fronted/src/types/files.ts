// ===========================================================================
// 生成文件（Word / Excel / PDF / Markdown / CSV）类型定义
// 与后端 src/files/types/generated-file.types.ts 保持一致
// ===========================================================================

export type GeneratedFileFormat = "docx" | "xlsx" | "pdf" | "md" | "csv";

/** 前端预览组件类型 */
export type PreviewType =
  | "pdf"
  | "image"
  | "document"
  | "spreadsheet"
  | "markdown"
  | "text"
  | "csv";

export type GeneratedFileStatus = "PROCESSING" | "READY" | "FAILED";

/** 文件卡片数据（后端 GeneratedFile 的序列化结果） */
export interface GeneratedFile {
  id: string;
  fileName: string;
  format: string;
  extension: string;
  mimeType: string;
  size: number;
  status: string;
  previewType: PreviewType;
  title: string | null;
  summary: string | null;
  sourceType: string;
  sessionId?: string | null;
  messageId?: string | null;
  createdAt: string;
}

// ===========================================================================
// 生成请求
// ===========================================================================

export interface SheetColumn {
  header: string;
  key?: string;
  width?: number;
}

export type SheetRow = Record<string, unknown> | unknown[];

export interface SheetSpec {
  name: string;
  columns?: SheetColumn[];
  rows: SheetRow[];
  note?: string;
}

export interface GenerateFileRequest {
  /** docx / xlsx / pdf / md / csv */
  format: GeneratedFileFormat | string;
  fileName?: string;
  title?: string;
  summary?: string;
  /** 文档类：Markdown 正文 */
  markdown?: string;
  /** 文档类：结构化块（markdown 的替代） */
  blocks?: unknown[];
  /** 表格类：多工作表 */
  sheets?: SheetSpec[];
  /** 表格类：单表快捷 */
  columns?: string[];
  rows?: unknown[][];
  sessionId?: string;
  messageId?: string;
  options?: Record<string, unknown>;
}

// ===========================================================================
// 预览数据
// ===========================================================================

export interface PreviewSheet {
  name: string;
  headers: string[];
  rows: string[][];
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
  /** text 预览 */
  text?: string;
  /** pdf / image：带鉴权的原始文件地址 */
  rawUrl?: string;
}

export interface FileFormatOption {
  format: string;
  label: string;
  extension: string;
}

// ===========================================================================
// 展示辅助
// ===========================================================================

export const FILE_FORMAT_LABELS: Record<string, string> = {
  docx: "Word 文档",
  xlsx: "Excel 工作簿",
  pdf: "PDF 文档",
  md: "Markdown",
  csv: "CSV 表格",
  png: "图片",
  jpg: "图片",
};

/** 格式化文件大小 */
export const formatFileSize = (bytes?: number): string => {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** 根据扩展名返回图标（TDesign 图标名） */
export const fileIcon = (formatOrExt?: string): string => {
  const ext = (formatOrExt ?? "").toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "pdf":
      return "file-pdf";
    case "docx":
    case "doc":
      return "file-word";
    case "xlsx":
    case "xls":
    case "csv":
      return "file-excel";
    case "md":
    case "markdown":
      return "file-copy";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
      return "file-image";
    default:
      return "file";
  }
};

/** 图标配色（按格式区分） */
export const fileColor = (formatOrExt?: string): string => {
  const ext = (formatOrExt ?? "").toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "pdf":
      return "#ef4444";
    case "docx":
    case "doc":
      return "#2563eb";
    case "xlsx":
    case "xls":
    case "csv":
      return "#16a34a";
    case "md":
    case "markdown":
      return "#7c3aed";
    default:
      return "#6366f1";
  }
};
