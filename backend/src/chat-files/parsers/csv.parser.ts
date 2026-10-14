import { Injectable } from '@nestjs/common';
import type {
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

const MAX_ROWS = 500;
const MAX_COLS = 60;

/**
 * CSV 解析器 —— 自带一个支持引号 / 转义 / 多行字段的轻量实现，不额外引依赖。
 *
 * 输出与 Excel 类似：表头 + 数据行 + 数值列统计，便于模型直接做数据问答。
 */
@Injectable()
export class CsvParser implements AttachmentParser {
  readonly supportedExtensions = ['csv', 'tsv'];

  async parse(input: ParseInput): Promise<ParseResult> {
    const raw = input.buffer.toString('utf-8').replace(/^﻿/, '');
    const delimiter = input.extension === 'tsv' ? '\t' : ',';
    const lines = splitLines(raw).filter((l) => l.trim() !== '');

    if (lines.length === 0) {
      return { text: '', summary: 'CSV 文件为空', meta: { rowCount: 0 } };
    }

    const header = splitRow(lines[0], delimiter).slice(0, MAX_COLS);
    const body = lines
      .slice(1, MAX_ROWS + 1)
      .map((l) => splitRow(l, delimiter).slice(0, MAX_COLS));
    const truncated = lines.length - 1 > MAX_ROWS;

    const text = [
      `### CSV 数据（共 ${lines.length - 1} 行 × ${header.length} 列）`,
      `表头：${header.join(' | ')}`,
      '数据：',
      ...body.map((r) => r.join(' | ')),
    ].join('\n');

    const summary = [
      `CSV 共 ${lines.length - 1} 行 × ${header.length} 列`,
      `列名：${header.join('、')}`,
      describeNumericColumns(header, body),
      truncated ? `（仅展示前 ${MAX_ROWS} 行）` : '',
    ]
      .filter(Boolean)
      .join('；');

    return {
      text,
      summary,
      meta: { rowCount: lines.length - 1, columnCount: header.length, truncated },
    };
  }
}

/** 按行拆分（支持引号内的换行） */
function splitLines(text: string): string[] {
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

/** 按列拆分单行（支持引号内的分隔符） */
function splitRow(line: string, delimiter: string): string[] {
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
    } else if (ch === delimiter && !inQuote) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function describeNumericColumns(header: string[], body: string[][]): string {
  const parts: string[] = [];
  for (let col = 0; col < header.length && parts.length < 8; col++) {
    const numbers: number[] = [];
    for (const row of body) {
      const cleaned = (row[col] ?? '').replace(/[,，\s%¥$]/g, '');
      if (!cleaned) continue;
      const n = Number(cleaned);
      if (Number.isFinite(n)) numbers.push(n);
    }
    if (numbers.length === 0 || numbers.length < body.length * 0.6) continue;

    const sum = numbers.reduce((a, b) => a + b, 0);
    parts.push(
      `「${header[col] || `第 ${col + 1} 列`}」合计 ${round(sum)}、均值 ${round(
        sum / numbers.length,
      )}、最小 ${round(Math.min(...numbers))}、最大 ${round(Math.max(...numbers))}`,
    );
  }
  return parts.length ? `数值列统计：${parts.join('；')}` : '';
}

function round(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
