import { Injectable, Logger } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { Marked } from 'marked';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { FileStorageService } from './file-storage.service';
import type {
  FilePreviewPayload,
  PreviewSheet,
} from './types/generated-file.types';

/** 预览时单表最大行数 / 列数，避免超大文件拖垮前端 */
const MAX_PREVIEW_ROWS = 500;
const MAX_PREVIEW_COLS = 60;

/**
 * FilePreviewService —— 把已生成文件转换为「前端可直接渲染的预览数据」。
 *
 * 预览策略：
 *   - markdown：读取文本 → marked 渲染 → sanitize-html 消毒 → HTML
 *   - document（docx）：mammoth 转 HTML → 消毒
 *   - spreadsheet（xlsx）：exceljs 读取工作表 → 结构化表格数据
 *   - csv：解析为单表
 *   - pdf / image：不转内容，返回 rawUrl 由前端带鉴权抓取后 blob 预览
 */
@Injectable()
export class FilePreviewService {
  private readonly logger = new Logger(FilePreviewService.name);
  private readonly marked = new Marked({ gfm: true, breaks: false });

  constructor(private readonly fileStorage: FileStorageService) {}

  async buildPreview(file: {
    id: string;
    fileName: string;
    extension: string;
    previewType: string | null;
    storageKey: string;
  }): Promise<FilePreviewPayload> {
    const previewType = file.previewType ?? 'text';
    const base: FilePreviewPayload = {
      id: file.id,
      fileName: file.fileName,
      previewType: previewType as FilePreviewPayload['previewType'],
    };

    switch (previewType) {
      case 'markdown': {
        const text = (await this.fileStorage.read(file.storageKey)).toString(
          'utf-8',
        );
        return { ...base, text, html: this.renderMarkdown(text) };
      }

      case 'document': {
        const buffer = await this.fileStorage.read(file.storageKey);
        const { value } = await mammoth.convertToHtml({ buffer });
        return { ...base, html: this.sanitize(value) };
      }

      case 'spreadsheet': {
        const buffer = await this.fileStorage.read(file.storageKey);
        return { ...base, sheets: await this.readWorkbook(buffer) };
      }

      case 'csv': {
        const text = (await this.fileStorage.read(file.storageKey)).toString(
          'utf-8',
        );
        return { ...base, sheets: [this.parseCsv(text)] };
      }

      case 'text': {
        const text = (await this.fileStorage.read(file.storageKey)).toString(
          'utf-8',
        );
        return { ...base, text };
      }

      // pdf / image：交给浏览器原生渲染，只回传带鉴权的抓取地址
      case 'pdf':
      case 'image':
      default:
        return { ...base, rawUrl: `/api/files/${file.id}/raw` };
    }
  }

  // ===========================================================================
  // 内部实现
  // ===========================================================================

  private renderMarkdown(markdown: string): string {
    const raw = this.marked.parse(markdown, { async: false }) as string;
    return this.sanitize(raw);
  }

  /** HTML 消毒：防止 AI 生成内容中的脚本注入 */
  private sanitize(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'hr', 'blockquote', 'pre', 'code',
        'ul', 'ol', 'li',
        'strong', 'em', 'b', 'i', 'u', 's', 'del', 'mark',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'a', 'img', 'span', 'div', 'sup', 'sub',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        td: ['colspan', 'rowspan'],
        th: ['colspan', 'rowspan'],
        code: ['class'],
        span: ['class'],
        div: ['class'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      transformTags: {
        a: (tagName, attribs) => ({
          tagName,
          attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
        }),
      },
    });
  }

  private async readWorkbook(buffer: Buffer): Promise<PreviewSheet[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheets: PreviewSheet[] = [];
    workbook.eachSheet((worksheet) => {
      const headers: string[] = [];
      const rows: string[][] = [];
      let truncated = false;

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > MAX_PREVIEW_ROWS) {
          truncated = true;
          return;
        }
        const values = (row.values as unknown[]).slice(1).map((v) =>
          stringifyCell(v),
        );
        const limited = values.slice(0, MAX_PREVIEW_COLS);
        if (limited.length > values.length) truncated = true;

        if (rowNumber === 1) {
          headers.push(...limited);
        } else {
          rows.push(limited);
        }
      });

      sheets.push({
        name: worksheet.name,
        headers: headers.length ? headers : ['列 1'],
        rows,
        truncated,
      });
    });

    return sheets.length ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];
  }

  private parseCsv(text: string): PreviewSheet {
    const clean = text.replace(/^\uFEFF/, '');
    const lines = splitCsvLines(clean).filter((l) => l.trim() !== '');
    if (lines.length === 0) {
      return { name: 'Sheet1', headers: [], rows: [] };
    }

    const headers = splitCsvRow(lines[0]);
    const rows = lines.slice(1, MAX_PREVIEW_ROWS + 1).map(splitCsvRow);
    return {
      name: 'Sheet1',
      headers,
      rows,
      truncated: lines.length - 1 > MAX_PREVIEW_ROWS,
    };
  }
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const obj = value as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (obj.text !== undefined) return String(obj.text);
    if (obj.result !== undefined) return String(obj.result);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 按行拆分 CSV（支持引号内含换行） */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}
