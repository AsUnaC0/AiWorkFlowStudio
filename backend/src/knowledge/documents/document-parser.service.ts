import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import { DocxParser } from './parsers/docx.parser';
import { MarkdownParser } from './parsers/markdown.parser';
import { PdfParser } from './parsers/pdf.parser';
import { TxtParser } from './parsers/txt.parser';

export interface DocumentParser {
  readonly supportedExtensions: string[];
  parse(filePath: string): Promise<string>;
}

@Injectable()
export class DocumentParserService {
  private readonly parsers: Record<string, DocumentParser>;

  constructor(
    private readonly pdfParser: PdfParser,
    private readonly docxParser: DocxParser,
    private readonly txtParser: TxtParser,
    private readonly markdownParser: MarkdownParser,
  ) {
    this.parsers = {
      pdf: pdfParser,
      docx: docxParser,
      txt: txtParser,
      md: markdownParser,
      markdown: markdownParser,
    };
  }

  /** 根据文件扩展名选 parser 并提取纯文本 */
  async parse(filePath: string): Promise<string> {
    const ext = extname(filePath).slice(1).toLowerCase();
    const parser = this.parsers[ext];
    if (!parser) {
      throw new Error(`No parser for extension: .${ext}`);
    }
    return parser.parse(filePath);
  }
}
