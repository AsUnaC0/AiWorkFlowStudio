/**
 * 把异常归一化为机器可读的错误码（用于运行详情 / 失败列表展示与统计）。
 * 与 AI_PROVIDER_* 体系保持一致。
 */
export function toErrorCode(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    if (m.includes('timeout') || m.includes('超时')) return 'AI_PROVIDER_TIMEOUT';
    if (m.includes('rate') || m.includes('429')) return 'AI_PROVIDER_RATE_LIMIT';
    if (
      m.includes('unauthorized') ||
      m.includes('401') ||
      m.includes('api key') ||
      m.includes('auth')
    ) {
      return 'AI_PROVIDER_AUTH';
    }
    if (
      m.includes('network') ||
      m.includes('econn') ||
      m.includes('enotfound') ||
      m.includes('connection')
    ) {
      return 'AI_PROVIDER_NETWORK';
    }
    if (m.includes('embedding')) return 'EMBEDDING_ERROR';
  }
  return 'AI_PROVIDER_ERROR';
}
