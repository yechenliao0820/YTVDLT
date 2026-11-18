/**
 * D-250 · 封面 URL 的 scheme 升级（纯字符串规则，单职责模块）。
 *
 * 国内站点（B 站 hdslb.com 等）经 yt-dlp probe 返回的 `thumbnail` 常是纯
 * `http://` 形式（实测 bilibili 返回 `http://i0.hdslb.com/bfs/archive/…`），
 * 而缩略图抓取面是 https-only（D-137 的 `isPublicHttpsUrl` 同时做入口校验与
 * 逐跳策略）。按原样校验，整类站点会被判成「无封面」，队列卡片永远只有字母
 * 徽标。这里在**任何校验与缓存键之前**把 `http://` 升级为 `https://`：
 * CDN 侧 https 实测可达（i0.hdslb.com 直连 200、无需 Referer），升级后的 URL
 * 仍要过同一道 `isPublicHttpsUrl` 门；站点真不支持 https 时抓取失败，回到
 * 「无封面」占位，不产生任何新风险。
 *
 * `https://` 原样返回（不重编码，保持缓存键 `sha1(url)` 稳定）；其余 scheme /
 * 空串 / 非字符串一律 null，交回调用方按无封面处理。URL 的其余合法性（可解析、
 * 公网地址）由 `isPublicHttpsUrl` 的 URL 解析回答，这里只做 scheme 归一。
 */
export function upgradeThumbnailUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) return `https://${trimmed.slice(7)}`;
  return null;
}
