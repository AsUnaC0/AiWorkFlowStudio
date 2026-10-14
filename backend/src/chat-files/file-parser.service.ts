import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { extname } from 'node:path';
import { TextParser } from './parsers/text.parser';
import { PdfParser } from './parsers/pdf.parser';
import { DocxParser } from './parsers/docx.parser';
import { ExcelParser } from './parsers/excel.parser';
import { CsvParser } from './parsers/csv.parser';
import { ImageParser } from './parsers/image.parser';
import type {
  AttachmentKind,
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parsers/parser.types';

/** 单个附件大小上限（50MB） */
export const CHAT_FILE_MAX_SIZE = 50 * 1024 * 1024;
/** 单条消息最多携带的附件数 */
export const CHAT_FILE_MAX_PER_MESSAGE = 10;

/** 允许上传的扩展名（第一版：PDF / DOCX / XLSX / CSV / TXT / MD / 常见图片 / 纯文本类） */
export const ALLOWED_EXTENSIONS = [
  'pdf',
  'docx',
  'xlsx',
  'xlsm',
  'csv',
  'tsv',
  'txt',
  'md',
  'markdown',
  'json',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'sql',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
] as const;

const EXT_TO_KIND: Record<string, AttachmentKind> = {
  pdf: 'PDF',
  docx: 'DOCUMENT',
  xlsx: 'SPREADSHEET',
  xlsm: 'SPREADSHEET',
  csv: 'SPREADSHEET',
  tsv: 'SPREADSHEET',
  png: 'IMAGE',
  jpg: 'IMAGE',
  jpeg: 'IMAGE',
  webp: 'IMAGE',
  gif: 'IMAGE',
  bmp: 'IMAGE',
};

/** 前端预览组件类型（复用 GeneratedFile 的 previewType 语义） */
export const EXT_TO_PREVIEW_TYPE: Record<string, string> = {
  pdf: 'pdf',
  docx: 'document',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  csv: 'csv',
  tsv: 'csv',
  md: 'markdown',
  markdown: 'markdown',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
};

/**
 * FileParserService —— 按文件类型分发到对应解析器。
 *
 * 不同文件用不同解析器，统一返回 ParseResult（文本 + 摘要 + 元数据 + 图片）。
 * 解析失败时抛错，由调用方把附件标记为 FAILED 并记录可展示的错误信息。
 */
@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);
  private readonly parsers: AttachmentParser[];
  private readonly extToParser = new Map<string, AttachmentParser>();

  constructor(
    textParser: TextParser,
    pdfParser: PdfParser,
    docxParser: DocxParser,
    excelParser: ExcelParser,
    csvParser: CsvParser,
    imageParser: ImageParser,
  ) {
    this.parsers = [
      textParser,
      pdfParser,
      docxParser,
      excelParser,
      csvParser,
      imageParser,
    ];
    for (const parser of this.parsers) {
      for (const ext of parser.supportedExtensions) {
        this.extToParser.set(ext.toLowerCase(), parser);
      }
    }
  }

  /** 上传策略（前端用于做前置校验与提示） */
  getPolicy() {
    return {
      maxSizeBytes: CHAT_FILE_MAX_SIZE,
      maxFilesPerMessage: CHAT_FILE_MAX_PER_MESSAGE,
      allowedExtensions: [...ALLOWED_EXTENSIONS],
      /** accept 属性，供 <input type="file"> 使用 */
      accept: ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(','),
    };
  }

  /** 提取并归一化扩展名（不含点，小写） */
  static extensionOf(fileName: string): string {
    return extname(fileName).slice(1).toLowerCase();
  }

  isSupported(extension: string): boolean {
    return this.extToParser.has(extension.toLowerCase());
  }

  /** 文件大类（PDF / DOCUMENT / SPREADSHEET / TEXT / IMAGE） */
  classify(extension: string): AttachmentKind {
    const ext = extension.toLowerCase();
    return EXT_TO_KIND[ext] ?? 'TEXT';
  }

  previewTypeOf(extension: string): string {
    return EXT_TO_PREVIEW_TYPE[extension.toLowerCase()] ?? 'text';
  }

  /** 校验扩展名，不通过直接抛 400（含可展示的提示文案） */
  assertSupported(fileName: string): string {
    const ext = FileParserService.extensionOf(fileName);
    if (!ext) {
      throw new BadRequestException(`文件「${fileName}」缺少扩展名，无法识别类型`);
    }
    if (!this.isSupported(ext)) {
      throw new BadRequestException(
        `不支持的文件类型 .${ext}；当前支持：PDF、Word(.docx)、Excel(.xlsx)、CSV、TXT、Markdown 和常见图片格式`,
      );
    }
    return ext;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const ext = input.extension.toLowerCase();
    const parser = this.extToParser.get(ext);
    if (!parser) {
      throw new BadRequestException(`没有可处理 .${ext} 的解析器`);
    }

    const result = await parser.parse(input);
    // 统一兜底：任何解析器都不应返回 undefined 文本
    return { ...result, text: result.text ?? '' };
  }
}
