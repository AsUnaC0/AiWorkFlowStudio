/**
 * 记忆模块的枚举、上限与过滤规则。
 *
 * 集中放在这里的原因：这些值同时被 Service（校验）、Prompt 装配（中文标签）、
 * 前端（过滤下拉）消费，散落三处一定会漂移。
 */

/** 记忆分类枚举 —— 与需求 4.3 的「偏好 / 事实 / 任务 / 事件 / 情感 / 其他」一一对应 */
export const MEMORY_CATEGORIES = [
  'PREFERENCE',
  'FACT',
  'TASK',
  'EVENT',
  'EMOTION',
  'OTHER',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  PREFERENCE: '偏好',
  FACT: '事实',
  TASK: '任务',
  EVENT: '事件',
  EMOTION: '情感',
  OTHER: '其他',
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === 'string' &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}

/** 3D 图节点上限（需求 8.3 建议 500），超出按分类聚合 */
export const MEMORY_GRAPH_NODE_LIMIT = 500;

/** 召回条数：默认 6，上限 10（需求 8.5 建议 5~10） */
export const DEFAULT_RECALL_LIMIT = 6;
export const MAX_RECALL_LIMIT = 10;

/** 召回候选池 —— 单用户记忆通常几十~几千条，取最近 N 条算相似度足够 */
export const RECALL_CANDIDATE_LIMIT = 500;

/** 单次对话最多沉淀几条（防止模型一次吐 20 条把库撑爆） */
export const MAX_CAPTURE_PER_TURN = 5;

/** 同一会话两次抽取的最小间隔（毫秒）—— 避免每轮对话都多一次 LLM 调用 */
export const CAPTURE_COOLDOWN_MS = 3 * 60 * 1000;

/** 建边的余弦阈值（超过才连线，否则 3D 图会变成一团毛线） */
export const LINK_SIMILARITY_THRESHOLD = 0.75;
/** 每个新记忆最多连出几条边 */
export const MAX_LINKS_PER_MEMORY = 4;

/** summary 长度上限（超出截断） */
export const SUMMARY_MAX_LENGTH = 120;

/**
 * 敏感信息过滤规则。
 *
 * 命中任意一条 → 该条记忆**整条丢弃**（不做脱敏保留）。
 * 理由：脱敏后的残留片段仍然可能泄露结构信息，且记忆本来就是「可选择性记住」的东西，
 * 少记一条没有损失。
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // 显式的密钥类字段赋值：password: xxx / api_key=xxx / bearer token
  /(password|passwd|pwd)\s*[:=：]/i,
  /(api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|bearer)\s*[:=：]/i,
  // 常见密钥前缀
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/,
  // 私钥
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // 身份证号（18 位，含出生日期段校验）
  /\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
  // 银行卡 / 账号（需要上下文关键词，避免误伤普通长数字）
  /(银行卡|卡号|账号|账户)\s*[:：]?\s*\d{12,19}/,
  // 中文语境下的密码表述
  /(密码|口令|密钥|私钥)\s*(是|为|:|：)/,
];

/** 文本是否包含敏感信息 */
export function containsSensitiveInfo(text: string): boolean {
  if (!text) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

/** 截断摘要，避免 3D 图 / 列表被超长文本撑破 */
export function truncateSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > SUMMARY_MAX_LENGTH
    ? `${clean.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
    : clean;
}
