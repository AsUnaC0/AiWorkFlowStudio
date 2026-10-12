import JSZip from 'jszip';

/**
 * OPC（Open Packaging Conventions）打包工具。
 *
 * 背景：Microsoft Word 的 OPC 读取器对包结构校验较严，而基于 jszip 的预览库
 * （docx-preview 等）按名读取、对顺序不敏感 —— 于是会出现「前端预览正常、
 * Word 打开报『无法读取内容』」的现象。
 *
 * 本模块只做**打包层面**的修正与重打包，不触碰任何文档内容。
 */

export const CONTENT_TYPES_ENTRY = '[Content_Types].xml';

/**
 * 规范化 OPC 包：强制把 `[Content_Types].xml` 放到 zip 第一个条目，并顺带重算 CRC。
 *
 * OPC 规范要求内容类型流是包内第一个部件；docx 库默认把它追加在末尾，
 * Word 会因此判定包结构有问题。
 */
export async function canonicalizeOpcPackage(buffer: Buffer): Promise<Buffer> {
  const src = await JSZip.loadAsync(buffer);
  const contentTypeEntry = src.file(CONTENT_TYPES_ENTRY);
  // 结构异常（没有 Content_Types）：原样返回，交由调用方处理
  if (!contentTypeEntry) return buffer;

  const contentTypes = await contentTypeEntry.async('nodebuffer');

  const out = new JSZip();
  out.file(CONTENT_TYPES_ENTRY, contentTypes);
  for (const name of Object.keys(src.files)) {
    const entry = src.files[name];
    if (entry.dir || name === CONTENT_TYPES_ENTRY) continue;
    out.file(name, await entry.async('nodebuffer'));
  }

  return out.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
}

/** 按「内容类型流置顶」的规则重新打包一份已改动的 zip 结构 */
export async function repackWithContentTypesFirst(
  zip: JSZip,
  contentTypes: Buffer | string,
): Promise<Buffer> {
  const out = new JSZip();
  out.file(CONTENT_TYPES_ENTRY, contentTypes);
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || name === CONTENT_TYPES_ENTRY) continue;
    out.file(name, await entry.async('nodebuffer'));
  }

  return out.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
}
