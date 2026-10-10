/**
 * 统一的 LLM tool_call 入参解析。
 *
 * 背景：OpenAI 规范要求 `tool_calls[].function.arguments` 是 **JSON 字符串**，
 * 但部分 OpenAI 兼容服务（例如经 SiliconFlow 转发的 DeepSeek）会直接返回
 * **JSON 对象**。若下游直接 `JSON.parse(arguments)`，遇到对象会抛
 * `SyntaxError`（`JSON.parse("[object Object]")`），参数被整体丢弃。
 *
 * 本函数把任意形态的 arguments 归一化为普通对象：
 *   - null/undefined        → {}
 *   - 对象                  → 原样返回
 *   - JSON 字符串           → parse 后返回
 *   - 非 JSON 字符串        → 包成 { input: <字符串> }（对以 input 为入参的工具友好）
 *   - 其他标量              → { input: <值> }
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};

  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? { input: raw }
      : (raw as Record<string, unknown>);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed == null) return {};
      return typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { input: parsed };
    } catch {
      // 不是合法 JSON：当作纯文本输入
      return { input: raw };
    }
  }

  return { input: raw };
}

/**
 * 把任意形态的 arguments 归一化为「JSON 字符串」。
 * 用于在 Provider 边界统一输出形态（`ToolCall.function.arguments` 声明为 string）。
 */
export function stringifyToolArguments(raw: unknown): string {
  if (raw == null) return '{}';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return '{}';
  }
}
