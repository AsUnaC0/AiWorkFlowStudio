import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type {
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

/** 单工作簿最多解析的工作表数 */
const MAX_SHEETS = 10;
/** 单个工作表最多输出的行数（含表头） */
const MAX_ROWS = 300;
/** 单行最多输出的列数 */
const MAX_COLS = 40;
/** 最多统计的数值列数 */
const MAX_STAT_COLUMNS = 8;

/**
 * Excel 解析器 —— 基于 ExcelJS 读取 .xlsx / .xlsm。
 *
 * 设计要点（比「整表转一大段文本」更可靠）：
 *   1. 程序先读取单元格，得到结构化数据；
 *   2. 顺带完成基础统计（行数、列数、数值列的求和/均值/极值）；
 *   3. 文本与统计一起交给模型，让 AI 基于可信数字做分析，而不是让它自己数格子。
 */
@Injectable()
export class ExcelParser implements AttachmentParser {
  readonly supportedExtensions = ['xlsx', 'xlsm'];

  async parse(input: ParseInput): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input.buffer as unknown as ArrayBuffer);

    const blocks: string[] = [];
    const sheetSummaries: string[] = [];
    let sheetCount = 0;
    let truncated = false;

    workbook.eachSheet((worksheet) => {
      sheetCount++;
      if (sheetCount > MAX_SHEETS) {
        truncated = true;
        return;
      }

      const rows: string[][] = [];
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          return;
        }
        const values = ((row.values as unknown[]) ?? [])
          .slice(1)
          .slice(0, MAX_COLS)
          .map((v) => stringifyCell(v));
        // 整行都是空单元格时跳过
        if (values.some((v) => v !== '')) rows.push(values);
      });

      const name = worksheet.name || `Sheet${sheetCount}`;
      const header = rows[0] ?? [];
      const body = rows.slice(1);

      blocks.push(
        [
          `### 工作表：${name}（共 ${worksheet.rowCount} 行 × ${worksheet.columnCount} 列）`,
          header.length ? `表头：${header.join(' | ')}` : '（无表头）',
          body.length
            ? ['数据：', ...body.map((r) => r.join(' | '))].join('\n')
            : '（无数据行）',
        ].join('\n'),
      );

      sheetSummaries.push(
        [
          `工作表「${name}」：${worksheet.rowCount} 行 × ${worksheet.columnCount} 列`,
          header.length ? `列名：${header.join('、')}` : null,
          describeNumericColumns(header, body),
        ]
          .filter(Boolean)
          .join('；'),
      );
    });

    if (sheetCount === 0) {
      return {
        text: '',
        summary: '工作簿中没有可读取的工作表',
        meta: { sheetCount: 0 },
      };
    }

    return {
      text: blocks.join('\n\n'),
      summary: sheetSummaries.join('\n'),
      meta: {
        sheetCount,
        parsedSheets: Math.min(sheetCount, MAX_SHEETS),
        truncated,
      },
    };
  }
}

/** 单元格值 → 字符串（兼容日期、富文本、公式结果、超链接） */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const obj = value as {
      text?: unknown;
      result?: unknown;
      hyperlink?: unknown;
    };
    if (obj.text !== undefined) return String(obj.text);
    if (obj.result !== undefined) return String(obj.result);
    if (obj.hyperlink !== undefined) return String(obj.hyperlink);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 对数值列做基础统计，输出中文描述 */
function describeNumericColumns(header: string[], body: string[][]): string {
  if (header.length === 0 || body.length === 0) return '';

  const parts: string[] = [];
  for (let col = 0; col < header.length && parts.length < MAX_STAT_COLUMNS; col++) {
    const numbers: number[] = [];
    for (const row of body) {
      const n = toNumber(row[col]);
      if (n !== null) numbers.push(n);
    }
    // 只有「绝大多数行都是数字」才认为是数值列
    if (numbers.length === 0 || numbers.length < body.length * 0.6) continue;

    const sum = numbers.reduce((a, b) => a + b, 0);
    const avg = sum / numbers.length;
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const label = header[col] || `第 ${col + 1} 列`;
    parts.push(
      `「${label}」合计 ${round(sum)}、均值 ${round(avg)}、最小 ${round(min)}、最大 ${round(max)}`,
    );
  }

  return parts.length ? `数值列统计：${parts.join('；')}` : '';
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[,，\s%¥$]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function round(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
