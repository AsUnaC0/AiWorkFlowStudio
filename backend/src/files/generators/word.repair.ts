import JSZip from 'jszip';
import { CONTENT_TYPES_ENTRY, repackWithContentTypesFirst } from './opc.util';

/**
 * .docx 兼容性修复（面向**已生成的历史文件**）。
 *
 * 修复两类会导致 Microsoft Word 报「无法读取内容 / 需要修复」的问题：
 *
 * 1. `[Content_Types].xml` 不在 zip 首位（OPC 规范要求其为第一个部件）。
 * 2. `word/document.xml` 中存在未被解析的编号占位符，例如
 *    `<w:numId w:val="{default-numbering-0}"/>`。
 *    `w:numId` 在 OOXML 中必须是正整数，占位符字符串会让 Word 直接判定文档损坏。
 *    成因：段落引用了未在 Document 的 `numbering.config` 中注册的 reference。
 *
 * 修复策略：为占位符分配一个真实存在的 numId（必要时新建 decimal 编号定义），
 * 而不是删除 `w:numPr` —— 这样列表序号不会丢失。
 *
 * 只读修复，不落盘；修复失败时原样返回原始 buffer。
 */

const NUMBERING_PART = 'word/numbering.xml';
const DOCUMENT_RELS_PART = 'word/_rels/document.xml.rels';
const NUMBERING_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const NUMBERING_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

const NUMBERING_NS = [
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
].join(' ');

/** 匹配 docx 输出的 `<w:numId w:val="..."/>`（含可能的自闭合前后空格） */
const NUM_ID_RE = /<w:numId\s+w:val="([^"]*)"\s*\/>/g;

export interface DocxRepairResult {
  buffer: Buffer;
  /** 是否实际发生了修改 */
  changed: boolean;
  /** 修复说明（用于日志） */
  notes: string[];
}

export async function repairDocx(buffer: Buffer): Promise<DocxRepairResult> {
  const notes: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { buffer, changed: false, notes: [] };
  }

  const contentTypesEntry = zip.file(CONTENT_TYPES_ENTRY);
  const documentEntry = zip.file('word/document.xml');
  if (!contentTypesEntry || !documentEntry) {
    return { buffer, changed: false, notes: [] };
  }

  const contentTypes = await contentTypesEntry.async('nodebuffer');
  let documentXml = await documentEntry.async('string');

  // -------------------------------------------------------------------------
  // 1) 修复未解析的 w:numId 占位符
  // -------------------------------------------------------------------------
  const brokenNumIds = [...documentXml.matchAll(NUM_ID_RE)]
    .map((m) => m[1])
    .filter((v) => !/^\d+$/.test(String(v ?? '').trim()));

  let numberingXml: string | null = zip.file(NUMBERING_PART)
    ? await zip.file(NUMBERING_PART)!.async('string')
    : null;

  if (brokenNumIds.length > 0) {
    // 没有 numbering.xml 时新建一个（同时补齐 Content_Types 与 rels）
    if (!numberingXml) {
      numberingXml = buildEmptyNumberingXml();
      notes.push('新建 word/numbering.xml');
    }

    const numId = nextFreeNumId(numberingXml);
    let abstractId = findDecimalAbstractId(numberingXml);

    if (abstractId === null) {
      abstractId = nextFreeAbstractId(numberingXml);
      numberingXml = insertBeforeClosingTag(
        numberingXml,
        '</w:numbering>',
        buildDecimalAbstractNum(abstractId),
      );
      notes.push(`新建 decimal abstractNum#${abstractId}`);
    }

    if (!new RegExp(`<w:num\\s+w:numId="${numId}"`).test(numberingXml)) {
      numberingXml = insertBeforeClosingTag(
        numberingXml,
        '</w:numbering>',
        `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`,
      );
    }

    documentXml = documentXml.replace(NUM_ID_RE, (match, value: string) =>
      /^\d+$/.test(String(value ?? '').trim())
        ? match
        : `<w:numId w:val="${numId}"/>`,
    );

    zip.file(NUMBERING_PART, numberingXml);
    zip.file('word/document.xml', documentXml);
    notes.push(
      `修正 ${brokenNumIds.length} 处非法 w:numId（${[...new Set(brokenNumIds)].join(', ')} → ${numId}）`,
    );

    // 补齐 numbering 部件的声明
    const nextContentTypes = ensureNumberingContentType(
      contentTypes.toString('utf8'),
    );
    if (nextContentTypes !== contentTypes.toString('utf8')) {
      zip.file(CONTENT_TYPES_ENTRY, nextContentTypes);
      notes.push('补齐 numbering 部件的 Content_Types 声明');
    }

    const relsEntry = zip.file(DOCUMENT_RELS_PART);
    if (relsEntry) {
      const relsXml = await relsEntry.async('string');
      const nextRels = ensureNumberingRelationship(relsXml);
      if (nextRels !== relsXml) {
        zip.file(DOCUMENT_RELS_PART, nextRels);
        notes.push('补齐 numbering 部件的 Relationship');
      }
    }
  }

  if (notes.length === 0) {
    // 没有内容层面的问题 —— 仍需确保 Content_Types 置顶
    const firstEntry = Object.keys(zip.files)[0];
    if (firstEntry === CONTENT_TYPES_ENTRY) {
      return { buffer, changed: false, notes: [] };
    }
    notes.push('[Content_Types].xml 置顶');
  }

  const finalContentTypes = (await zip.file(CONTENT_TYPES_ENTRY)!.async(
    'nodebuffer',
  )) as Buffer;

  const repaired = await repackWithContentTypesFirst(zip, finalContentTypes);
  return { buffer: repaired, changed: true, notes };
}

// ===========================================================================
// 内部工具
// ===========================================================================

function nextFreeNumId(numberingXml: string): number {
  const ids = [...numberingXml.matchAll(/<w:num\s+w:numId="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function nextFreeAbstractId(numberingXml: string): number {
  const ids = [
    ...numberingXml.matchAll(/<w:abstractNum\s+w:abstractNumId="(\d+)"/g),
  ].map((m) => Number(m[1]));
  return ids.length ? Math.max(...ids) + 1 : 1;
}

/** 找出已存在的「十进制编号」定义（numFmt=decimal） */
function findDecimalAbstractId(numberingXml: string): number | null {
  const blocks = [
    ...numberingXml.matchAll(
      /<w:abstractNum\s+w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g,
    ),
  ];
  for (const block of blocks) {
    if (/<w:numFmt\s+w:val="decimal"/.test(block[0])) return Number(block[1]);
  }
  return null;
}

function buildDecimalAbstractNum(id: number): string {
  const levels = [0, 1, 2]
    .map(
      (lv) =>
        `<w:lvl w:ilvl="${lv}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="%${lv + 1}."/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (lv + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
    )
    .join('');
  return (
    `<w:abstractNum w:abstractNumId="${id}">` +
    `<w:multiLevelType w:val="hybridMultilevel"/>${levels}` +
    `</w:abstractNum>`
  );
}

function buildEmptyNumberingXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering mc:Ignorable="w14 w15 wp14" ${NUMBERING_NS}></w:numbering>`
  );
}

function insertBeforeClosingTag(xml: string, closingTag: string, insert: string) {
  const idx = xml.lastIndexOf(closingTag);
  if (idx < 0) return xml;
  return xml.slice(0, idx) + insert + xml.slice(idx);
}

function ensureNumberingContentType(contentTypes: string): string {
  if (contentTypes.includes('/word/numbering.xml')) return contentTypes;
  const override =
    `<Override ContentType="${NUMBERING_CONTENT_TYPE}" PartName="/word/numbering.xml"/>`;
  const idx = contentTypes.lastIndexOf('</Types>');
  if (idx < 0) return contentTypes;
  return contentTypes.slice(0, idx) + override + contentTypes.slice(idx);
}

function ensureNumberingRelationship(relsXml: string): string {
  if (relsXml.includes(NUMBERING_REL_TYPE)) return relsXml;
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  const rel =
    `<Relationship Id="rId${nextId}" Type="${NUMBERING_REL_TYPE}" Target="numbering.xml"/>`;
  const idx = relsXml.lastIndexOf('</Relationships>');
  if (idx < 0) return relsXml;
  return relsXml.slice(0, idx) + rel + relsXml.slice(idx);
}
