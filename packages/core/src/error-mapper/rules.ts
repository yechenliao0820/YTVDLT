/**
 * Ordered keyword → ErrorCode rule table (ARCHITECTURE §4.7).
 * `map()` returns on the FIRST hit, which makes the four network classes
 * (429 / 403 / DNS / TIMEOUT) mutually exclusive (A-4.5-05).
 * Pure data: no I/O, no imports beyond the shared ErrorCode type.
 */
import type { ErrorCode } from '@ytvdlt/shared';

export interface ErrorRule {
  code: ErrorCode;
  patterns: readonly RegExp[];
  retryable: boolean;
  message: string;
}

export const ORDERED_RULES: readonly ErrorRule[] = [
  {
    code: 'HTTP_429',
    patterns: [/HTTP Error 429/i, /Too Many Requests/i, /\b429\b/],
    retryable: true,
    message: '请求过于频繁，请稍后重试',
  },
  {
    code: 'HTTP_403',
    patterns: [/HTTP Error 403/i, /403:\s*Forbidden/i],
    retryable: false,
    message: '该内容当前不可访问',
  },
  {
    code: 'DNS_FAILURE',
    patterns: [
      /getaddrinfo/i, /Name or service not known/i,
      /Temporary failure in name resolution/i, /\bDNS\b/i,
    ],
    retryable: true,
    message: '域名解析失败，请检查网络连接',
  },
  {
    code: 'NETWORK_TIMEOUT',
    patterns: [/timed out/i, /Read timed out/i, /socket\.timeout/i, /\btimeout\b/i],
    retryable: true,
    message: '网络超时，可重试',
  },
  {
    code: 'UNSUPPORTED_SITE',
    patterns: [
      /Unsupported URL/i, /is not a valid URL/i, /unsupported site/i,
      /no suitable extractor/i, /example\.invalid/i,
    ],
    retryable: false,
    message: '不支持的链接或站点',
  },
  {
    code: 'FORMAT_UNAVAILABLE',
    patterns: [/Requested format is not available/i, /format not available/i],
    retryable: false,
    message: '所选格式不可用',
  },
  {
    code: 'ALREADY_DOWNLOADED',
    patterns: [/already been recorded in the archive/i, /already downloaded/i],
    retryable: false,
    message: '已下载过（归档去重）',
  },
  {
    code: 'DISK_FULL',
    patterns: [/No space left on device/i, /disk full/i],
    retryable: false,
    message: '磁盘空间不足',
  },
  {
    code: 'PERMISSION_DENIED',
    patterns: [/Permission denied/i, /Access is denied/i, /\bEACCES\b/, /\bEPERM\b/],
    retryable: false,
    message: '无写入权限',
  },
  {
    code: 'ENGINE_MISSING',
    patterns: [/yt-dlp\.exe[^\n]*not found/i, /\bENOENT\b/, /yt-dlp[^\n]*is not installed/i],
    retryable: false,
    message: '下载引擎缺失，请前往运行时自检',
  },
  {
    code: 'JS_RUNTIME_MISSING',
    patterns: [/No JS runtime/i, /JS runtime/i, /node\.exe[^\n]*missing/i],
    retryable: false,
    message: 'JS 运行时缺失，请前往运行时自检',
  },
  {
    code: 'EJS_FAILED',
    patterns: [/\bEJS\b/i, /remote component[^\n]*failed/i],
    retryable: true,
    message: 'EJS 组件失败，可重试或升级引擎',
  },
  {
    code: 'FFMPEG_MISSING',
    patterns: [
      /ffmpeg[^\n]*(?:not found|not installed)/i,
      /ffprobe[^\n]*(?:not found|not installed)/i,
      /(?:not found|not installed)[^\n]*ffmpeg/i,
    ],
    retryable: false,
    message: 'FFmpeg 缺失，请前往运行时自检',
  },
  {
    code: 'CUSTOM_COMMAND_REJECTED',
    patterns: [/CUSTOM_COMMAND_REJECTED/],
    retryable: false,
    message: '命令含禁用选项，已拒绝执行',
  },
  {
    code: 'ARTIFACT_INCOMPLETE',
    patterns: [/ARTIFACT_INCOMPLETE/],
    retryable: true,
    message: '产物不完整，可重试',
  },
  {
    code: 'INVALID_URL',
    patterns: [/^__YTVDLT_INVALID_URL_PRECHECK__$/],
    retryable: false,
    message: '请输入合法的 http(s) 链接',
  },
] as const;

/** Fallback for unmatched stderr. */
export const UNKNOWN_RULE: ErrorRule = {
  code: 'UNKNOWN',
  patterns: [],
  retryable: true,
  message: '未知错误，详见错误报告',
};

/** Metadata for ALL 17 codes, used by `fromCode()` (no patterns needed). */
export const CODE_META: Readonly<Record<ErrorCode, { message: string; retryable: boolean }>> = {
  INVALID_URL: { message: '请输入合法的 http(s) 链接', retryable: false },
  UNSUPPORTED_SITE: { message: '不支持的链接或站点', retryable: false },
  FORMAT_UNAVAILABLE: { message: '所选格式不可用', retryable: false },
  NETWORK_TIMEOUT: { message: '网络超时，可重试', retryable: true },
  DNS_FAILURE: { message: '域名解析失败，请检查网络连接', retryable: true },
  HTTP_403: { message: '该内容当前不可访问', retryable: false },
  HTTP_429: { message: '请求过于频繁，请稍后重试', retryable: true },
  ALREADY_DOWNLOADED: { message: '已下载过（归档去重）', retryable: false },
  DISK_FULL: { message: '磁盘空间不足', retryable: false },
  PERMISSION_DENIED: { message: '无写入权限', retryable: false },
  ENGINE_MISSING: { message: '下载引擎缺失，请前往运行时自检', retryable: false },
  JS_RUNTIME_MISSING: { message: 'JS 运行时缺失，请前往运行时自检', retryable: false },
  FFMPEG_MISSING: { message: 'FFmpeg 缺失，请前往运行时自检', retryable: false },
  EJS_FAILED: { message: 'EJS 组件失败，可重试或升级引擎', retryable: true },
  ARTIFACT_INCOMPLETE: { message: '产物不完整，可重试', retryable: true },
  CUSTOM_COMMAND_REJECTED: { message: '命令含禁用选项，已拒绝执行', retryable: false },
  UNKNOWN: { message: '未知错误，详见错误报告', retryable: true },
};
