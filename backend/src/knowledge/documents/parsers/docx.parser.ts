import { Injectable } from '@nestjs/common';
import { DocumentParser } from '../document-parser.service';

@Injectable()
export class DocxParser implements DocumentParser {
  readonly supportedExtensions = ['docx'];

  async parse(filePath: string): Promise<string> {
    throw new Error('DOCX 解析尚未实现');
  }
}
