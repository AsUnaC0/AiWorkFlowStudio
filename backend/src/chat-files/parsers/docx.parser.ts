import { Injectable } from '@nestjs/common';
import mammoth from 'mammoth';
import type {
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

const MAX_TEXT_CHARS = 400_000;

/**
 * Word 解析器 —— 基于 mammoth 提取 .docx 的纯文本。
 *
 * mammoth 只支持 OOXML（.docx）；旧版二进制 .doc 无法解析，
 * 上传阶段就已拦截，这里不再兜底。
 */
@Injectable()
export class DocxParser implements AttachmentParser {
  readonly supportedExtensions = ['docx'];

  async parse(input: ParseInput): Promise<ParseResult> {
    const { value } = await mammoth.extractRawText({ buffer: input.buffer });
    const normalized = (value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const truncated = normalized.length > MAX_TEXT_CHARS;
    return {
      text: truncated ? normalized.slice(0, MAX_TEXT_CHARS) : normalized,
      summary: `Word 文档提取文本 ${normalized.length} 字符${
        truncated ? `（已截取前 ${MAX_TEXT_CHARS} 字符）` : ''
      }`,
      meta: { charCount: normalized.length, truncated },
    };
  }
}
