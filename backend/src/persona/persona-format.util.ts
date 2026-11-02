/**
 * 人格输出格式清洗。
 *
 * 背景：早期人格模板是从「QQ 机器人」搬过来的，里面写着「用 ||| 分隔多条消息」
 * 「发 <sticker:开心> 加表情」。本平台**没有任何解析这些标记的逻辑**
 * （全仓搜不到 split('|||')，也没有 sticker/voice 渲染），
 * 模型照做只会把标记原样打进气泡：`白米饭啊|||热腾腾的那种 最香了 <sticker:开心>`。
 *
 * 只靠改 Prompt 不够 —— 会话历史里那些旧消息本身就是 few-shot 样例，
 * 模型会继续照着模仿。所以在**输出侧**做一次兜底清洗，并把清洗后的文本落库，
 * 让历史也逐步干净下来。
 *
 * 设计边界：
 *   - 只处理这三个标记，不做任何其它内容改写（不删字、不改语气）。
 *   - **代码块内原样保留** —— 用户问 XML / 模板语法时，`<voice>` 是内容不是标记。
 *   - 纯函数、幂等：同一段文本清洗两次结果相同（流式累积推送依赖这一点）。
 */

/** 需要剥掉的标签：`<sticker:开心>` / `<voice:...>`（半角或全角冒号） */
const TAG_WITH_ARG = /<\s*(?:sticker|voice)\s*[:：][^>]*>/gi;

/** 成对出现的语音标签：`<voice>...</voice>` —— 只去标签，保留里面的文字 */
const VOICE_PAIR = /<\s*\/?\s*voice\s*>/gi;

/** 分条分隔符：连续 3 个以上竖线（半角 / 全角），连同两侧空白一起换成空行 */
const PIPE_SEPARATOR = /[ \t]*(?:\|{3,}|｜{3,})[ \t]*/g;

/** 连续 3 个以上换行压成 1 个空行（分条替换后可能叠出来） */
const EXTRA_BLANK_LINES = /\n{3,}/g;

/** 行尾残留的空格 / 制表符（剥掉标签后常留一个） */
const TRAILING_SPACES = /[ \t]+$/gm;

/**
 * 清洗一段**非代码块**文本。
 *
 * 单独抽出来是为了让 `stripPersonaMarks` 能按代码块切分后逐段处理。
 */
function sanitizeSegment(segment: string): string {
  return segment
    .replace(VOICE_PAIR, '')
    .replace(TAG_WITH_ARG, '')
    .replace(PIPE_SEPARATOR, '\n\n')
    .replace(EXTRA_BLANK_LINES, '\n\n')
    .replace(TRAILING_SPACES, '');
}

/**
 * 去掉平台不认识的标记，并把 `|||` 还原成空行分条。
 *
 * @example
 * stripPersonaMarks('白米饭啊|||热腾腾的那种 最香了 <sticker:开心>')
 * // => '白米饭啊\n\n热腾腾的那种 最香了'
 */
export function stripPersonaMarks(text: string): string {
  if (!text) return text;

  // 按 ``` 围栏切分：split 带捕获组时，奇数下标一定是代码块本体，原样保留
  const segments = text.split(/(```[\s\S]*?```)/g);
  let result = '';
  for (let i = 0; i < segments.length; i++) {
    result += i % 2 === 1 ? segments[i] : sanitizeSegment(segments[i]);
  }
  return result.replace(TRAILING_SPACES, '');
}
