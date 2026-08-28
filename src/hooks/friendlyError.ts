/**
 * Shared error-to-Chinese mapper.
 *
 * Both App.tsx (clipboard main) and ApiApp.tsx (HTTP client) had a
 * near-identical `friendlyError(e, fallback)` function. The clipboard
 * window did a more elaborate regex match; the API client truncated the
 * raw string and that's it. This module gives every window the more
 * complete mapping without forcing each one to reimplement it.
 *
 * Recognised substrings (case-insensitive):
 *   not found / no such file / path not found → 文件或路径不存在
 *   permission / access denied                → 权限被拒绝
 *   timeout / timed out                       → 操作超时
 *   connection refused / failed to connect   → 无法连接到服务
 *   invalid query                             → 查询无效
 *   failed to bind                            → 端口被占用
 *
 * Anything else is returned as `${fallback}: ${truncate(raw)}` so the
 * user at least sees a real error (with the noisy parts clipped).
 */
export function friendlyError(raw: unknown, fallback: string = "操作失败"): string {
  const s = String(raw ?? "");
  const low = s.toLowerCase();
  if (low.includes("not found") || low.includes("no such file") || low.includes("path not found")) {
    return "文件或路径不存在";
  }
  if (low.includes("permission") || low.includes("access denied")) {
    return "权限被拒绝";
  }
  if (low.includes("timeout") || low.includes("timed out")) {
    return "操作超时";
  }
  if (low.includes("connection refused") || low.includes("failed to connect")) {
    return "无法连接到服务";
  }
  if (low.includes("invalid query") || low.includes("invalid url")) {
    return "查询无效";
  }
  if (low.includes("failed to bind") || low.includes("address already in use")) {
    return "端口被占用";
  }
  return `${fallback}: ${s.length > 80 ? s.slice(0, 80) + "…" : s}`;
}
