import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { DocBlock, DocumentContent } from '../types/generated-file.types';

// ===========================================================================
// PDF 生成器
//
// 采用「结构化内容 → PDFKit 直接绘制」方案，不依赖 Chromium / Puppeteer，
// 部署无需下载浏览器。中文通过系统字体（优先 simhei / msyh / simsun）嵌入。
// ===========================================================================

/** 已解析到的中文字体（进程内缓存） */
let cachedCjkFont: { path: string; family?: string } | null | undefined;

/**
 * 查找可用的中文字体。
 *
 * 优先顺序：
 *   1. 环境变量 PDF_CJK_FONT_PATH（可指向 .ttf / .ttc；.ttc 用 PDF_CJK_FONT_FAMILY 指定子字体）
 *   2. 系统字体目录中的 simhei.ttf / msyh.ttc / simsun.ttc / Deng.ttf
 */
function resolveCjkFont(): { path: string; family?: string } | null {
  if (cachedCjkFont !== undefined) return cachedCjkFont;

  const candidates: Array<{ path: string; family?: string }> = [];

  const envPath = process.env.PDF_CJK_FONT_PATH;
  if (envPath && existsSync(envPath)) {
    candidates.push({ path: envPath, family: process.env.PDF_CJK_FONT_FAMILY });
  }

  const fontDir = join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const fontFamilyDir = '/usr/share/fonts';
  candidates.push(
    { path: join(fontDir, 'simhei.ttf') },
    { path: join(fontDir, 'msyh.ttc'), family: 'Microsoft YaHei' },
    { path: join(fontDir, 'simsun.ttc'), family: 'SimSun' },
    { path: join(fontDir, 'Deng.ttf') },
    { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
    { path: join(fontFamilyDir, 'truetype/noto/NotoSansCJK-Regular.ttc'), family: 'Noto Sans CJK SC' },
    { path: join(fontFamilyDir, 'opentype/noto/NotoSansCJK-Regular.ttc'), family: 'Noto Sans CJK SC' },
  );

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      cachedCjkFont = candidate;
      return candidate;
    }
  }

  cachedCjkFont = null;
  return null;
}

export async function generatePdf(
  content: DocumentContent,
  meta: { title?: string; author?: string } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 56,
        bufferPages: true,
        info: {
          Title: content.title ?? meta.title ?? '未命名文档',
          Author: meta.author ?? 'AI WorkFlow Studio',
          CreationDate: new Date(),
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ---- 字体 ----
      const cjk = resolveCjkFont();
      let bodyFont = 'Helvetica';
      let boldFont = 'Helvetica-Bold';
      if (cjk) {
        try {
          if (cjk.family) doc.registerFont('cjk', cjk.path, cjk.family);
          else doc.registerFont('cjk', cjk.path);
          bodyFont = 'cjk';
          boldFont = 'cjk';
        } catch {
          /* 字体注册失败则回退 Helvetica（中文会缺字，但不阻塞生成） */
        }
      }

      const M = { left: 56, right: 56, top: 56, bottom: 56 };
      const pageWidth = doc.page.width;
      const contentWidth = pageWidth - M.left - M.right;

      let y = doc.y;

      const ensureSpace = (needed: number) => {
        if (y + needed > doc.page.height - M.bottom) {
          doc.addPage();
          y = M.top;
        }
      };

      const writeText = (
        text: string,
        opts: {
          size?: number;
          font?: string;
          color?: string;
          lineGap?: number;
          indent?: number;
          align?: 'left' | 'center' | 'right';
          oblique?: boolean;
        } = {},
      ) => {
        const size = opts.size ?? 11;
        const indent = opts.indent ?? 0;
        doc.font(opts.font ?? bodyFont);
        doc.fontSize(size);
        doc.fillColor(opts.color ?? '#1F2937');

        const height = doc.heightOfString(text, {
          width: contentWidth - indent,
          lineGap: opts.lineGap ?? 3,
        });
        ensureSpace(height);

        doc.text(text, M.left + indent, y, {
          width: contentWidth - indent,
          align: opts.align ?? 'left',
          lineGap: opts.lineGap ?? 3,
          oblique: opts.oblique ?? false,
        });
        y = doc.y;
      };

      // ---- 标题区 ----
      const title = content.title ?? meta.title;
      if (title) {
        writeText(title, {
          size: 21,
          font: boldFont,
          color: '#111827',
          align: 'center',
          lineGap: 6,
        });
        y += 8;
      }

      if (content.subtitle) {
        writeText(content.subtitle, {
          size: 11,
          color: '#6B7280',
          align: 'center',
        });
        y += 6;
      }

      if (content.summary) {
        y += 4;
        const summaryHeight = doc
          .font(bodyFont)
          .fontSize(10.5)
          .heightOfString(content.summary, {
            width: contentWidth - 20,
            lineGap: 3,
          });
        ensureSpace(summaryHeight + 16);
        doc.save();
        doc
          .rect(M.left, y, 3, summaryHeight + 12)
          .fill('#4F46E5')
          .restore();
        doc.font(bodyFont).fontSize(10.5).fillColor('#374151');
        doc.text(content.summary, M.left + 14, y + 6, {
          width: contentWidth - 20,
          lineGap: 3,
        });
        y = doc.y + 10;
      }

      // ---- 正文块 ----
      for (const block of content.blocks ?? []) {
        renderBlock(doc, block, {
          bodyFont,
          boldFont,
          contentWidth,
          marginLeft: M.left,
          writeText,
          ensureSpace,
          getY: () => y,
          setY: (v: number) => {
            y = v;
          },
        });
        y = doc.y;
      }

      // ---- 页脚页码 ----
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.font(bodyFont).fontSize(8).fillColor('#9CA3AF');
        doc.text(
          `${(content.title ?? meta.title ?? '').slice(0, 40)}　·　第 ${i + 1} / ${range.count} 页`,
          M.left,
          doc.page.height - M.bottom + 18,
          { width: contentWidth, align: 'center', lineBreak: false },
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

interface RenderCtx {
  bodyFont: string;
  boldFont: string;
  contentWidth: number;
  marginLeft: number;
  writeText: (text: string, opts?: Record<string, unknown>) => void;
  ensureSpace: (needed: number) => void;
  getY: () => number;
  setY: (v: number) => void;
}

function renderBlock(
  doc: PDFKit.PDFDocument,
  block: DocBlock,
  ctx: RenderCtx,
) {
  const { bodyFont, boldFont, contentWidth, marginLeft, ensureSpace } = ctx;

  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 2, 1), 6);
      const sizeMap = [20, 17, 14.5, 13, 12, 11.5];
      const size = sizeMap[level - 1] ?? 13;
      ctx.setY(ctx.getY() + (level <= 2 ? 10 : 6));
      ctx.writeText(block.text, {
        size,
        font: boldFont,
        color: level <= 2 ? '#111827' : '#1F2937',
        lineGap: 4,
      });
      ctx.setY(ctx.getY() + 2);
      break;
    }

    case 'paragraph': {
      ctx.setY(ctx.getY() + 2);
      ctx.writeText(block.text, { size: 11, lineGap: 4 });
      ctx.setY(ctx.getY() + 4);
      break;
    }

    case 'bullets':
    case 'numbers': {
      ctx.setY(ctx.getY() + 2);
      block.items.forEach((item, idx) => {
        const bullet = block.type === 'bullets' ? '•' : `${idx + 1}.`;
        doc.font(bodyFont).fontSize(11);
        const height = doc.heightOfString(item, {
          width: contentWidth - 20,
          lineGap: 4,
        });
        ensureSpace(height);
        const y = ctx.getY();
        doc.fillColor('#4F46E5').text(bullet, marginLeft, y, {
          width: 14,
          lineBreak: false,
        });
        doc.fillColor('#1F2937').text(item, marginLeft + 16, y, {
          width: contentWidth - 18,
          lineGap: 4,
        });
        ctx.setY(doc.y + 2);
      });
      ctx.setY(ctx.getY() + 4);
      break;
    }

    case 'quote': {
      ctx.setY(ctx.getY() + 4);
      doc.font(bodyFont).fontSize(10.5);
      const height = doc.heightOfString(block.text, {
        width: contentWidth - 22,
        lineGap: 3,
      });
      ensureSpace(height + 12);
      const y = ctx.getY();
      doc.save();
      doc.rect(marginLeft, y, 3, height + 10).fill('#9CA3AF').restore();
      doc.fillColor('#4B5563').text(block.text, marginLeft + 14, y + 5, {
        width: contentWidth - 22,
        lineGap: 3,
        oblique: true,
      });
      ctx.setY(doc.y + 8);
      break;
    }

    case 'code': {
      ctx.setY(ctx.getY() + 4);
      const lines = block.text.split('\n');
      doc.font('Courier').fontSize(9.5);
      const lineHeight = 13;
      const totalHeight = lines.length * lineHeight + 12;

      if (totalHeight > doc.page.height - 112) {
        // 超长代码块：分页逐行绘制
        for (const line of lines) {
          ensureSpace(lineHeight + 12);
          const y = ctx.getY();
          doc.save();
          doc
            .rect(marginLeft, y, contentWidth, lineHeight + 2)
            .fill('#F3F4F6')
            .restore();
          doc.fillColor('#374151').text(line || ' ', marginLeft + 8, y + 3, {
            width: contentWidth - 16,
            lineBreak: false,
          });
          ctx.setY(y + lineHeight + 2);
        }
      } else {
        ensureSpace(totalHeight);
        const y = ctx.getY();
        doc.save();
        doc
          .rect(marginLeft, y, contentWidth, totalHeight)
          .fill('#F3F4F6')
          .restore();
        doc.fillColor('#374151');
        lines.forEach((line, idx) => {
          doc.text(line || ' ', marginLeft + 8, y + 6 + idx * lineHeight, {
            width: contentWidth - 16,
            lineBreak: false,
          });
        });
        ctx.setY(y + totalHeight);
      }
      ctx.setY(ctx.getY() + 6);
      break;
    }

    case 'table': {
      ctx.setY(ctx.getY() + 6);
      renderTable(doc, block.headers, block.rows ?? [], ctx);
      ctx.setY(ctx.getY() + 6);
      break;
    }

    case 'divider': {
      ctx.setY(ctx.getY() + 8);
      ensureSpace(12);
      const y = ctx.getY();
      doc.save();
      doc
        .moveTo(marginLeft, y)
        .lineTo(marginLeft + contentWidth, y)
        .lineWidth(0.8)
        .strokeColor('#D1D5DB')
        .stroke()
        .restore();
      ctx.setY(y + 10);
      break;
    }
  }
}

function renderTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  ctx: RenderCtx,
) {
  const { bodyFont, boldFont, contentWidth, marginLeft, ensureSpace } = ctx;
  if (!headers.length) return;

  const colCount = headers.length;
  const colWidth = contentWidth / colCount;
  const cellPadding = 5;
  const rowLineHeight = 13;

  const drawRow = (cells: string[], isHeader: boolean) => {
    // 先算行高（取最高单元格）
    doc.font(isHeader ? boldFont : bodyFont).fontSize(isHeader ? 10 : 9.5);
    let maxHeight = rowLineHeight;
    for (const cell of cells) {
      maxHeight = Math.max(
        maxHeight,
        doc.heightOfString(String(cell ?? ''), {
          width: colWidth - cellPadding * 2,
        }) + 6,
      );
    }

    ensureSpace(maxHeight);
    let y = ctx.getY();

    // 背景
    doc.save();
    doc
      .rect(marginLeft, y, contentWidth, maxHeight)
      .fill(isHeader ? '#EEF2FF' : '#FFFFFF')
      .restore();

    // 单元格文本（超出一页时按顶部截断，避免错位）
    cells.forEach((cell, colIdx) => {
      doc
        .font(isHeader ? boldFont : bodyFont)
        .fontSize(isHeader ? 10 : 9.5)
        .fillColor(isHeader ? '#1F2937' : '#374151');
      doc.text(String(cell ?? ''), marginLeft + colIdx * colWidth + cellPadding, y + 4, {
        width: colWidth - cellPadding * 2,
        height: maxHeight - 6,
        ellipsis: true,
        lineBreak: true,
      });
    });

    // 边框
    doc.save();
    doc
      .rect(marginLeft, y, contentWidth, maxHeight)
      .lineWidth(0.6)
      .strokeColor('#D1D5DB')
      .stroke();
    for (let i = 1; i < colCount; i++) {
      doc
        .moveTo(marginLeft + i * colWidth, y)
        .lineTo(marginLeft + i * colWidth, y + maxHeight)
        .lineWidth(0.6)
        .strokeColor('#E5E7EB')
        .stroke();
    }
    doc.restore();

    ctx.setY(y + maxHeight);
    y = ctx.getY();
  };

  drawRow(headers, true);
  for (const row of rows) {
    drawRow(headers.map((_, i) => String(row?.[i] ?? '')), false);
  }
}
