import type { DocBlock, DocumentContent } from '../types/generated-file.types';

// ===========================================================================
// Markdown ↔ DocBlock 互转
//
// 作用：
//   LLM 最擅长输出 Markdown，因此 `generate_file` 允许直接给 markdown；
//   后端解析为统一的 DocBlock[] 后，Word / PDF / Markdown 生成器共用同一份内容。
//
// 支持的 Markdown 子集：
//   # / ## / ### ... 标题
//   - / * / + 无序列表
//   1. 有序列表
//   > 引用
//   ``` 代码块
//   | a | b | 表格
//   --- / *** 分隔线
//   其余为段落
// ===========================================================================

/** 把 Markdown 文本解析为 DocBlock[] */
export function parseMarkdownToBlocks(markdown: string): DocBlock[] {
  if (!markdown?.trim()) return [];

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: DocBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块（ fences ``` 或 ~~~ ）
    const fence = trimmed.match(/^(`{3,}|~{3,})\s*([\w-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 fence
      blocks.push({ type: 'code', text: body.join('\n'), language });
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: stripInline(heading[2]),
      });
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    // 表格（| a | b | + | --- | --- |）
    if (trimmed.startsWith('|') && i + 1 < lines.length) {
      const headerCells = splitTableRow(trimmed);
      const next = lines[i + 1].trim();
      if (headerCells.length > 0 && /^\|?[\s:-]+\|/.test(next) && next.includes('-')) {
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(splitTableRow(lines[i].trim()));
          i++;
        }
        blocks.push({ type: 'table', headers: headerCells, rows });
        continue;
      }
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        body.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: stripInline(body.join(' ')) });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(stripInline(lines[i].trim().replace(/^[-*+]\s+/, '')));
        i++;
      }
      blocks.push({ type: 'bullets', items });
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(stripInline(lines[i].trim().replace(/^\d+[.)]\s+/, '')));
        i++;
      }
      blocks.push({ type: 'numbers', items });
      continue;
    }

    // 普通段落：连续非空且不属于以上类型的行合并为一段
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isBlockStart(lines[i].trim())
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: stripInline(paragraph.join('\n')) });
    } else {
      // 兜底，避免死循环
      blocks.push({ type: 'paragraph', text: stripInline(trimmed) });
      i++;
    }
  }

  return blocks;
}

function isBlockStart(trimmed: string): boolean {
  return (
    /^(#{1,6})\s+/.test(trimmed) ||
    /^(`{3,}|~{3,})/.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed) ||
    trimmed.startsWith('>') ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
  );
}

function splitTableRow(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripInline(c.trim()));
}

/** 去掉行内 Markdown 标记（粗体 / 斜体 / 行内代码 / 链接），保留纯文本 */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1') // 斜体
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

// ===========================================================================
// DocBlock[] → Markdown（用于 md 生成器，以及把结构化内容回退为文本）
// ===========================================================================

export function blocksToMarkdown(content: DocumentContent): string {
  const parts: string[] = [];

  if (content.title) parts.push(`# ${content.title}`, '');
  if (content.subtitle) parts.push(`> ${content.subtitle}`, '');
  if (content.summary) parts.push(content.summary, '');

  for (const block of content.blocks ?? []) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(Math.max(block.level ?? 2, 1), 6);
        parts.push(`${'#'.repeat(level)} ${block.text}`, '');
        break;
      }
      case 'paragraph':
        parts.push(block.text, '');
        break;
      case 'bullets':
        for (const item of block.items) parts.push(`- ${item}`);
        parts.push('');
        break;
      case 'numbers':
        block.items.forEach((item, idx) => parts.push(`${idx + 1}. ${item}`));
        parts.push('');
        break;
      case 'quote':
        parts.push(`> ${block.text}`, '');
        break;
      case 'code':
        parts.push(`\`\`\`${block.language ?? ''}`, block.text, '```', '');
        break;
      case 'table': {
        parts.push(`| ${block.headers.join(' | ')} |`);
        parts.push(`| ${block.headers.map(() => '---').join(' | ')} |`);
        for (const row of block.rows) {
          parts.push(`| ${row.join(' | ')} |`);
        }
        parts.push('');
        break;
      }
      case 'divider':
        parts.push('---', '');
        break;
    }
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 统一把任意输入（markdown / blocks）规范化为 DocumentContent */
export function normalizeDocument(input: {
  title?: string;
  summary?: string;
  markdown?: string;
  blocks?: DocBlock[];
}): DocumentContent {
  let blocks: DocBlock[] = [];

  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    blocks = input.blocks.filter(Boolean);
  } else if (input.markdown?.trim()) {
    blocks = parseMarkdownToBlocks(input.markdown);
  }

  // 若 markdown 首个块就是一级标题，提取为 title，避免正文重复
  let title = input.title?.trim();
  if (!title && blocks[0]?.type === 'heading' && blocks[0].level === 1) {
    title = (blocks[0] as { text: string }).text;
    blocks = blocks.slice(1);
  }

  return {
    title,
    summary: input.summary?.trim() || undefined,
    blocks,
  };
}
