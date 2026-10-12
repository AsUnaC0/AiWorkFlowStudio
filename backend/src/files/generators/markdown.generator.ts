import type { DocumentContent } from '../types/generated-file.types';
import { blocksToMarkdown } from './markdown.util';

/**
 * Markdown（.md）生成器
 *
 * 输入：统一文档模型 DocumentContent（可选附带原始 markdown 字符串）
 * 输出：UTF-8 Markdown 文本 Buffer
 *
 * 关键：当调用方提供了「原始 markdown」时，直接输出原文，
 * 以完整保留行内标记（**粗体**、[链接]、(行内代码)、表格等）。
 * 否则回退到 blocksToMarkdown（结构化内容 → 文本）。
 */
export async function generateMarkdown(
  content: DocumentContent,
  rawMarkdown?: string,
): Promise<Buffer> {
  const useRaw =
    typeof rawMarkdown === 'string' && rawMarkdown.trim().length > 0;

  let body = useRaw ? rawMarkdown.trim() : blocksToMarkdown(content);

  // 标题：体现在首个标题上（保留层级），无标题时前置为 H1，避免重复标题
  if (content.title) {
    body = applyTitleToRaw(body, content.title);
  }

  // 摘要：raw 路径下作为正文前的段落（blocks 路径已由 blocksToMarkdown 处理）
  if (useRaw && content.summary && !body.startsWith(content.summary)) {
    body = `${content.summary}\n\n${body}`;
  }

  return Buffer.from(body.endsWith('\n') ? body : `${body}\n`, 'utf-8');
}

/**
 * 把标题落到 Markdown 正文：
 *   - 若正文首个非空行已经是 H1 标题，则保留原文（避免覆盖/丢失原标题文本）
 *   - 否则在文首前置一个 H1 标题
 * 这样既不重复标题，也不丢失正文里的原标题。
 */
function applyTitleToRaw(body: string, title: string): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // 首个非空行已是 H1 标题：原文保留，标题由文件名/元数据体现
    if (/^#\s+/.test(trimmed)) {
      return body;
    }
    // 首个非空行不是 H1（是 H2+ 或普通段落）：前置一个 H1 标题
    return `# ${title}\n\n${body.trimStart()}`;
  }
  // 正文为空：仅输出标题
  return `# ${title}`;
}
