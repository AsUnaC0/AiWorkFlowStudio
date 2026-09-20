import { Injectable } from '@nestjs/common';

export interface DocumentParser {
  readonly supportedExtensions: string[];
  parse(filePath: string): Promise<string>;
}

@Injectable()
export class DocumentParserService {}
