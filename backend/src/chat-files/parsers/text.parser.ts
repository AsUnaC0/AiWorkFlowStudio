import { Injectable } from '@nestjs/common';
import type {
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

/** 单个纯文本附件交给模型的最大字符数（超出截断，避免撑爆上下文） */
const MAX_TEXT_CHARS = 400_000;

/**
 * 纯文本解析器 —— TXT / MD / Markdown / JSON / LOG / YAML / XML 等。
 *
 * 直接按 UTF-8 读取即可，不需要额外依赖。
 */
@Injectable()
export class TextParser implements AttachmentParser {
  readonly supportedExtensions = [
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
  ];

  async parse(input: ParseInput): Promise<ParseResult> {
    const raw = input.buffer.toString('utf-8').replace(/^﻿/, '');
    const truncated = raw.length > MAX_TEXT_CHARS;
    const text = truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw;

    return {
      text,
      summary: truncated
        ? `文本共 ${raw.length} 字符，已截取前 ${MAX_TEXT_CHARS} 字符`
        : `文本共 ${raw.length} 字符`,
      meta: {
        charCount: raw.length,
        truncated,
        lines: text.split('\n').length,
      },
    };
  }
}
