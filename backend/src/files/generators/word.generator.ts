import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { canonicalizeOpcPackage } from './opc.util';
import type { DocBlock, DocumentContent } from '../types/generated-file.types';

/**
 * Word（.docx）生成器
 *
 * 输入：统一文档模型 DocumentContent
 * 输出：docx 二进制 Buffer
 */
export async function generateWord(
  content: DocumentContent,
  meta: { title?: string; author?: string } = {},
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  const title = content.title ?? meta.title;
  if (title) {
    children.push(
      new Paragraph({
        text: title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
    );
  }

  if (content.subtitle) {
    children.push(
      new Paragraph({
        text: content.subtitle,
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        run: { color: '666666', size: 22 },
      }),
    );
  }

  if (content.summary) {
    children.push(
      new Paragraph({
        spacing: { after: 300 },
        border: {
          left: {
            style: BorderStyle.SINGLE,
            size: 6,
            color: '4F46E5',
            space: 8,
          },
        },
        children: [new TextRun({ text: content.summary, italics: false })],
      }),
    );
  }

  for (const block of content.blocks ?? []) {
    children.push(...renderBlock(block));
  }

  const doc = new Document({
    creator: meta.author ?? 'AI WorkFlow Studio',
    title: title ?? '未命名文档',
    description: content.summary ?? '',
    // numbers 段落通过 numbering: { reference: 'default-numbering' } 引用此定义；
    // 若不显式注册，Word 会因引用不存在的 numId 判定「内容有问题」而拒绝打开。
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });

  const raw = await Packer.toBuffer(doc);
  // Word 的 OPC 读取器要求 `[Content_Types].xml` 是包内第一个部件；
  // docx 库默认追加在末尾，需重打包置顶，否则 Word 报「无法读取内容」。
  return canonicalizeOpcPackage(raw);
}

function renderBlock(block: DocBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 2, 1), 6);
      const headingMap = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ];
      return [
        new Paragraph({
          text: block.text,
          heading: headingMap[level - 1],
          spacing: { before: 240, after: 120 },
        }),
      ];
    }

    case 'paragraph':
      return [
        new Paragraph({
          children: [new TextRun({ text: block.text })],
          spacing: { after: 120, line: 320 },
        }),
      ];

    case 'bullets':
      return block.items.map(
        (item) =>
          new Paragraph({
            text: item,
            bullet: { level: 0 },
            spacing: { after: 60 },
          }),
      );

    case 'numbers':
      return block.items.map(
        (item) =>
          new Paragraph({
            text: item,
            numbering: { reference: 'default-numbering', level: 0 },
            spacing: { after: 60 },
          }),
      );

    case 'quote':
      return [
        new Paragraph({
          spacing: { after: 120 },
          indent: { left: 360 },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: '999999',
              space: 8,
            },
          },
          children: [
            new TextRun({ text: block.text, italics: true, color: '555555' }),
          ],
        }),
      ];

    case 'code':
      return block.text.split('\n').map(
        (line) =>
          new Paragraph({
            spacing: { after: 0, line: 260 },
            shading: { fill: 'F5F5F5' },
            children: [
              new TextRun({
                text: line || ' ',
                font: 'Consolas',
                size: 20,
                color: '333333',
              }),
            ],
          }),
      );

    case 'table':
      return [renderTable(block.headers, block.rows)];

    case 'divider':
      return [
        new Paragraph({
          spacing: { before: 120, after: 120 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 4,
              color: 'DDDDDD',
              space: 1,
            },
          },
          children: [new TextRun({ text: '' })],
        }),
      ];

    default:
      return [];
  }
}

function renderTable(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h) =>
        new TableCell({
          shading: { fill: 'EEF2FF' },
          children: [
            new Paragraph({
              children: [new TextRun({ text: h, bold: true, size: 21 })],
            }),
          ],
        }),
    ),
  });

  const bodyRows = (rows ?? []).map(
    (row) =>
      new TableRow({
        children: headers.map(
          (_, colIdx) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: String(row?.[colIdx] ?? ''), size: 21 }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}
