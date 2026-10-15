/**
 * 文本清洗工具。
 *
 * 背景：PostgreSQL 的 text / varchar 不接受 NUL（U+0000）字节，写入时会直接报错：
 *   Database error. Code: `22021`. Message: `invalid byte sequence for encoding "UTF8": 0x00`
 *
 * 常见来源：pdf-parse 从 PDF 内容流还原文本时，CID / 自定义编码字体的映射失败
 * 会产生大量 \u0000；此外还可能出现未配对的 UTF-16 代理项（同样无法编码成合法 UTF-8）。
 *
 * 所有来自外部文件、最终要落库或送去 embedding 的文本，都应先过一遍 sanitizeText()。
 */

/**
 * 非法字符：C0 / C1 控制字符（保留 \t=09 \n=0A \r=0D）+ 非字符 U+FFFE / U+FFFF。
 * 注意：这里必须剔除 U+0000，否则 Postgres 写入直接失败。
 */
const ILLEGAL_CHARS_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

/** 未配对的 UTF-16 代理项（lone surrogate），无法编码为合法 UTF-8 */
const LONE_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 清洗文本，使其可以安全写入 PostgreSQL 的 text 字段。
 * - 去除 NUL 及其它非法控制字符
 * - 去除未配对代理项
 * - 统一换行符（\r\n / \r → \n）
 */
export function sanitizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(ILLEGAL_CHARS_REGEX, '')
    .replace(LONE_SURROGATE_REGEX, '')
    .replace(/\r\n?/g, '\n');
}

/** 清洗后是否还存在可读内容（用于识别扫描件 / 空文本 PDF） */
export function hasTextContent(input: string | null | undefined): boolean {
  return sanitizeText(input).trim().length > 0;
}
