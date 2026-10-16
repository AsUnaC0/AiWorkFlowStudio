/**
 * 统一的 LLM 返回内容归一化。
 *
 * 背景：OpenAI 规范里 `choices[].message.content` 既可能是**字符串**，
 * 也可能是**多模态内容块数组**（content parts）。当调用图像生成 / 多模态模型
 * （如各类 OpenAI 兼容网关、优刻得 MaaS 等）时，服务端会直接返回：
 *
 *   [{ url: "https://…/xxx.png?Signature=…" }]
 *   [{ type: "image_url", image_url: { url: "https://…" } }]
 *   [{ type: "text", text: "…" }, { type: "image_url", image_url: { url: "…" } }]
 *
 * 而我们的 `ChatMessage.content` 与数据库 `ChatMessage.content` 字段都是 String，
 * 直接把数组/对象落库会抛：
 *   Argument `content`: Invalid value provided. Expected String, provided Object.
 *
 * 本函数在 **Provider 边界**把任意形态的内容统一成字符串，
 * 上游（Agent / 工作流 LLM 节点 / 消息落库）就都能拿到纯文本。
 * 图片 URL 会被提取为纯 URL 文本（聊天页可直接展示 / 点击）。
 */

/** 把任意形态的内容归一化为字符串 */
export function normalizeContentToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => extractPart(part))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (typeof content === 'object') {
    return extractPart(content);
  }
  return String(content);
}

/** 从单个内容块里提取可展示的文本 / 图片地址 */
function extractPart(part: unknown): string {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return String(part);

  const p = part as Record<string, unknown>;

  // 1. 文本块：{ type: 'text' | 'input_text' | 'output_text', text }
  if (typeof p.text === 'string' && p.text) return p.text;

  // 2. 图片块：{ url } / { image_url: string | { url } } / { image | source: { url } }
  const imageUrl = extractImageUrl(p);
  if (imageUrl) return imageUrl;

  // 3. 内联 base64 图片：{ b64_json }
  if (typeof p.b64_json === 'string' && p.b64_json) {
    const mime = typeof p.mime_type === 'string' ? p.mime_type : 'image/png';
    return `data:${mime};base64,${p.b64_json}`;
  }

  // 4. 兜底：块内还嵌了一层 content
  if (p.content != null) return normalizeContentToString(p.content);

  return '';
}

/** 从内容块里尽力取出图片 URL */
function extractImageUrl(p: Record<string, unknown>): string {
  if (typeof p.url === 'string' && p.url) return p.url;
  if (typeof p.image_url === 'string' && p.image_url) return p.image_url;
  if (p.image_url && typeof p.image_url === 'object') {
    const url = (p.image_url as Record<string, unknown>).url;
    if (typeof url === 'string' && url) return url;
  }
  for (const key of ['image', 'source'] as const) {
    const value = p[key];
    if (value && typeof value === 'object') {
      const url = (value as Record<string, unknown>).url;
      if (typeof url === 'string' && url) return url;
    }
  }
  return '';
}
