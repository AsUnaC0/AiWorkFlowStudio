import { Injectable, Logger } from '@nestjs/common';
import pdfParse from 'pdf-parse';
import type {
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

const MAX_TEXT_CHARS = 400_000;

/**
 * PDF 解析器 —— 基于 pdf-parse 提取文本层。
 *
 * 注意：扫描版 PDF（图片型）没有文本层，提取结果会为空或极少，
 * 此时会给出明确提示，前端可引导用户改走 OCR / 视觉模型（后续阶段）。
 */
@Injectable()
export class PdfParser implements AttachmentParser {
  private readonly logger = new Logger(PdfParser.name);
  readonly supportedExtensions = ['pdf'];

  async parse(input: ParseInput): Promise<ParseResult> {
    const { text, numpages } = await pdfParse(input.buffer);
    const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();

    // 文本层过少 → 大概率是扫描件
    if (normalized.length < 20) {
      return {
        text: '',
        summary: `PDF 共 ${numpages ?? 0} 页，但未提取到有效文本（可能是扫描版图片 PDF，需要 OCR）`,
        meta: { pageCount: numpages ?? 0, scanned: true },
      };
    }

    const truncated = normalized.length > MAX_TEXT_CHARS;
    return {
      text: truncated ? normalized.slice(0, MAX_TEXT_CHARS) : normalized,
      summary: `PDF 共 ${numpages ?? 0} 页，提取文本 ${normalized.length} 字符${
        truncated ? `（已截取前 ${MAX_TEXT_CHARS} 字符）` : ''
      }`,
      meta: { pageCount: numpages ?? 0, charCount: normalized.length, truncated },
    };
  }
}
