import ExcelJS from 'exceljs';
import type {
  SheetRow,
  SheetSpec,
  SpreadsheetContent,
} from '../types/generated-file.types';

/**
 * Excel（.xlsx）生成器
 *
 * 输入：SpreadsheetContent（支持多工作表）
 * 输出：xlsx 二进制 Buffer
 *
 * 样式：表头加粗 + 底色 + 冻结首行，列宽自适应内容。
 */
export async function generateExcel(
  content: SpreadsheetContent,
  meta: { title?: string } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI WorkFlow Studio';
  workbook.created = new Date();
  if (meta.title) workbook.title = meta.title;

  const sheets = (content.sheets ?? []).length
    ? content.sheets!
    : [{ name: 'Sheet1', columns: [], rows: [] }];

  sheets.forEach((sheet, index) => {
    const ws = workbook.addWorksheet(sanitizeSheetName(sheet.name, index));
    const headers = resolveHeaders(sheet);
    let rowOffset = 0;

    // 备注行（跨列合并）
    if (sheet.note) {
      ws.mergeCells(1, 1, 1, Math.max(headers.length, 1));
      const noteCell = ws.getCell(1, 1);
      noteCell.value = sheet.note;
      noteCell.font = { italic: true, color: { argb: 'FF666666' } };
      noteCell.alignment = { vertical: 'middle', wrapText: true };
      ws.getRow(1).height = 22;
      rowOffset = 1;
    }

    if (headers.length > 0) {
      const headerRow = ws.getRow(rowOffset + 1);
      headers.forEach((header, colIdx) => {
        const cell = headerRow.getCell(colIdx + 1);
        cell.value = header;
        cell.font = { bold: true, color: { argb: 'FF1F2937' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFEEF2FF' },
        };
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
      headerRow.height = 24;
      headerRow.commit();
      ws.views = [{ state: 'frozen', ySplit: rowOffset + 1 }];
    }

    for (const row of sheet.rows ?? []) {
      const values = headers.map((_, colIdx) => toCellValue(row, headers, colIdx));
      const excelRow = ws.addRow(values);
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { vertical: 'middle', wrapText: false };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFF3F4F6' } } };
      });
    }

    // 列宽自适应
    ws.columns.forEach((column, colIdx) => {
      const header = headers[colIdx] ?? '';
      let maxLen = stringWidth(header);
      for (const row of sheet.rows ?? []) {
        const v = toCellValue(row, headers, colIdx);
        maxLen = Math.max(maxLen, stringWidth(v === null ? '' : String(v)));
      }
      column.width = Math.min(Math.max(maxLen + 4, 10), 46);
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** CSV 生成器（单工作表，UTF-8 BOM 便于 Excel 正确识别中文） */
export async function generateCsv(content: SpreadsheetContent): Promise<Buffer> {
  const sheet = (content.sheets ?? [])[0] ?? { name: 'Sheet1', rows: [] };
  const headers = resolveHeaders(sheet);
  const lines: string[] = [];

  if (headers.length > 0) lines.push(headers.map(escapeCsv).join(','));
  for (const row of sheet.rows ?? []) {
    const values = headers.map((_, colIdx) => {
      const v = toCellValue(row, headers, colIdx);
      return escapeCsv(v === null || v === undefined ? '' : String(v));
    });
    lines.push(values.join(','));
  }

  // ﻿ BOM：让 Excel 以 UTF-8 打开，中文不乱码
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf-8');
}

// ===========================================================================
// 辅助函数
// ===========================================================================

/** 推断表头：显式 columns > 行对象的 key > 数组行的长度
 *  兼容两种写法：columns 既可以是 [{header}]，也可以是 ["列名"] 字符串数组
 *  （LLM 常直接给出字符串数组，需避免表头变为 undefined）。 */
export function resolveHeaders(sheet: SheetSpec): string[] {
  if (sheet.columns?.length) {
    return sheet.columns.map((c) =>
      typeof c === 'string' ? c : c.header,
    );
  }
  const first = (sheet.rows ?? [])[0];
  if (first && !Array.isArray(first) && typeof first === 'object') {
    return Object.keys(first as Record<string, unknown>);
  }
  if (Array.isArray(first)) {
    return first.map((_, i) => `列 ${i + 1}`);
  }
  return [];
}

function toCellValue(
  row: SheetRow,
  headers: string[],
  colIdx: number,
): string | number | boolean | null {
  if (Array.isArray(row)) {
    const v = row[colIdx];
    return normalizeCell(v);
  }
  const obj = row as Record<string, unknown>;
  const header = headers[colIdx];
  if (header !== undefined && header in obj) return normalizeCell(obj[header]);
  // 回退：按下标取对象的第 colIdx 个值
  const values = Object.values(obj);
  return normalizeCell(values[colIdx]);
}

function normalizeCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    // 数字字符串转为数字，便于 Excel 计算
    const trimmed = v.trim();
    if (trimmed !== '' && !/^0\d/.test(trimmed) && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
    return v;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 中文按 2 个字符宽度估算，避免列宽过窄 */
function stringWidth(text: string): number {
  let width = 0;
  for (const ch of String(text ?? '')) {
    width += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return width;
}

/** Excel 工作表名限制：≤31 字符，不含 []:*?/\ */
function sanitizeSheetName(name: string, index: number): string {
  const cleaned = (name || `Sheet${index + 1}`)
    .replace(/[[\]:*?/\\]/g, '_')
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

/** 把 LLM 给的 columns / rows 快捷形式规范化为 SpreadsheetContent */
export function normalizeSpreadsheet(input: {
  sheets?: SheetSpec[];
  columns?: string[];
  rows?: unknown[][];
  title?: string;
}): SpreadsheetContent {
  if (input.sheets?.length) {
    return { sheets: input.sheets };
  }
  const columns = (input.columns ?? []).map((header) => ({ header }));
  const rows = (input.rows ?? []) as unknown[];
  return {
    sheets: [
      {
        name: input.title?.slice(0, 31) || 'Sheet1',
        columns: columns.length ? columns : undefined,
        rows: rows as SheetRow[],
      },
    ],
  };
}
