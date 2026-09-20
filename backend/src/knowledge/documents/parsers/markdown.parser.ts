import { Injectable } from '@nestjs/common';
import { DocumentParser } from '../document-parser.service';
import { promises as fs } from 'node:fs';

@Injectable()
export class MarkdownParser implements DocumentParser {
  readonly supportedExtensions = ['md', 'markdown'];

  async parse(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
}
