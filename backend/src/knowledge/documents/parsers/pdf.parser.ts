import { Injectable } from '@nestjs/common';
import { DocumentParser } from '../document-parser.service';

@Injectable()
export class PdfParser implements DocumentParser {
  readonly supportedExtensions = ['pdf'];

  async parse(filePath: string): Promise<string> {
    throw new Error('PDF 解析尚未实现');
  }
}
