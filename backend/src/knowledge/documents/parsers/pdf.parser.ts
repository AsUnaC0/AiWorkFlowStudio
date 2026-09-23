import { Injectable } from '@nestjs/common';
import { DocumentParser } from '../document-parser.service';
import { readFile } from 'fs/promises';
import pdfParse from 'pdf-parse';

@Injectable()
export class PdfParser implements DocumentParser {
  readonly supportedExtensions = ['pdf'];

  async parse(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    const { text } = await pdfParse(buffer);
    return text;
  }
}
