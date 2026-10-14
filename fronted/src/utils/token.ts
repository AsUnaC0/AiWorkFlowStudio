/**
 * JWT 有效期判断（只在前端做一次粗略预检，真正的校验仍在后端）。
 *
 * 解析不出 exp（例如 token 不是 JWT、格式异常）时一律返回 false —— 交给后端
 * 最终判定，避免前端误杀导致正常用户被踢到登录页。
 */
export function isTokenExpired(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;

  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = JSON.parse(json)?.exp;
    return typeof exp === "number" ? exp * 1000 <= Date.now() : false;
  } catch {
    return false;
  }
}
