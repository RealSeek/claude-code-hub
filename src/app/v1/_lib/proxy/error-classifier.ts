/**
 * 错误分类器 - 基于 ccLoad 的表驱动设计
 *
 * 设计理念（来自 ccLoad）：
 * 1. 状态码优先：HTTP 状态码的语义优先于响应体内容
 * 2. 表驱动配置：使用 Map 统一管理所有状态码的分类规则
 * 3. 智能语义分析：对 429/401/403 等特殊状态码进行上下文分析
 * 4. 精确冷却时间：从响应体解析重置时间，实现精确的 Provider 冷却
 *
 * 核心原则：
 * - 5xx 永远是 Provider 错误，不受响应体内容影响
 * - 4xx 需要根据语义细分 Key 级和 Channel 级
 * - 客户端错误（408, 413 等）不应触发 Provider 冷却
 */

import { logger } from "@/lib/logger";
import { parseSSEData } from "@/lib/utils/sse";
import type { Provider } from "@/types/provider";

/**
 * 错误级别枚举（借鉴 ccLoad）
 *
 * 分类逻辑：
 * - Key 级错误：应该冷却当前 API Key，重试其他 Provider 的其他 Key
 * - Channel 级错误：应该冷却整个 Provider，切换到其他 Provider
 * - Client 级错误：不应该冷却，直接返回给客户端
 */
export enum ErrorLevel {
  /** 无错误（2xx 成功） */
  None = "none",
  /** Key 级错误：应该冷却当前 Provider，重试其他 Provider */
  Key = "key",
  /** Channel/Provider 级错误：应该冷却整个 Provider，切换到其他 Provider */
  Channel = "channel",
  /** 客户端错误：不应该冷却，直接返回给客户端 */
  Client = "client",
}

/**
 * 状态码元数据表（表驱动设计）
 *
 * 参考：ccLoad 的 statusCodeMetaMap
 * 来源：https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
 */
const STATUS_CODE_META_MAP = new Map<number, ErrorLevel>([
  // === 客户端取消 ===
  [499, ErrorLevel.Channel], // 上游返回的客户端关闭请求，应切换 Provider 重试

  // === Key 级错误：API Key 相关问题 ===
  [401, ErrorLevel.Key], // Unauthorized - Key invalid
  [402, ErrorLevel.Key], // Payment Required - quota/balance
  [403, ErrorLevel.Key], // Forbidden - Key permission
  [429, ErrorLevel.Key], // Too Many Requests - rate limited（默认 Key 级，需语义分析）
  [596, ErrorLevel.Key], // ccLoad: 上游 Key 级错误

  // === Channel 级错误：服务器端问题 ===
  [444, ErrorLevel.Channel], // nginx: No Response
  [500, ErrorLevel.Channel], // Internal Server Error
  [502, ErrorLevel.Channel], // Bad Gateway
  [503, ErrorLevel.Channel], // Service Unavailable
  [504, ErrorLevel.Channel], // Gateway Timeout
  [520, ErrorLevel.Channel], // Cloudflare: Unknown Error
  [521, ErrorLevel.Channel], // Cloudflare: Web Server Is Down
  [524, ErrorLevel.Channel], // Cloudflare: A Timeout Occurred
  [597, ErrorLevel.Channel], // ccLoad: SSE 错误默认按 Channel，具体类型由语义分析覆盖
  [598, ErrorLevel.Channel], // ccLoad: 首字节超时
  [599, ErrorLevel.Channel], // ccLoad: 流不完整

  // === 客户端错误：不冷却，直接返回 ===
  [408, ErrorLevel.Client], // Request Timeout
  [405, ErrorLevel.Channel], // Method Not Allowed（配置错误，应该切换 Provider）
  [406, ErrorLevel.Client], // Not Acceptable
  [410, ErrorLevel.Client], // Gone
  [413, ErrorLevel.Client], // Payload Too Large
  [414, ErrorLevel.Client], // URI Too Long
  [415, ErrorLevel.Client], // Unsupported Media Type
]);

/**
 * 获取状态码的错误级别（带兜底策略）
 *
 * 兜底规则：
 * - 所有未知 5xx → Channel 级（服务器问题）
 * - 所有未知 4xx → Key 级（保守策略，避免误判为客户端错误）
 */
export function getErrorLevelFromStatus(statusCode: number): ErrorLevel {
  // 查表
  const meta = STATUS_CODE_META_MAP.get(statusCode);
  if (meta !== undefined) {
    return meta;
  }

  // 兜底策略
  if (statusCode >= 500) {
    return ErrorLevel.Channel; // 所有未知 5xx → Channel 级
  }
  if (statusCode >= 400) {
    return ErrorLevel.Key; // 所有未知 4xx → Key 级（保守策略）
  }
  return ErrorLevel.Client;
}

/**
 * HTTP 响应分类结果
 */
export interface HTTPResponseClassification {
  level: ErrorLevel;
  reason?: string;
  /** 建议的 Key 冷却时间（秒） */
  keyCooldownSeconds?: number;
  /** 建议的 Channel 冷却时间（秒） */
  channelCooldownSeconds?: number;
  /** 精确的重置时间（ISO 8601 格式） */
  resetAt?: string;
}

/**
 * 分类 HTTP 响应（状态码 + headers + 响应体）
 *
 * 核心逻辑：
 * 1. 优先检测 "假 200" 错误（HTTP 200 但响应体是错误）
 * 2. 429 限流错误智能分类（检查响应头和响应体）
 * 3. 401/403 语义分析（区分 Key 级和 Channel 级）
 * 4. 其他状态码走表驱动
 */
export function classifyHTTPResponse(
  statusCode: number,
  headers: Headers,
  responseBody: string | null
): HTTPResponseClassification {
  if (statusCode === 400) {
    const body = responseBody?.toLowerCase() ?? "";
    const invalidKey = ["invalid api key", "invalid_api_key", "api key is invalid", "unauthorized"].some(
      (pattern) => body.includes(pattern)
    );
    return withResetTime(
      invalidKey
        ? { level: ErrorLevel.Key, reason: "invalid_api_key" }
        : { level: ErrorLevel.Channel, reason: "bad_request_channel" },
      responseBody,
      headers
    );
  }

  if (statusCode === 404) {
    const body = responseBody?.toLowerCase() ?? "";
    const modelNotFound = ["model not found", "model_not_found", "unknown model", "does not exist"].some(
      (pattern) => body.includes(pattern)
    );
    return withResetTime(
      modelNotFound
        ? { level: ErrorLevel.Client, reason: "model_not_found" }
        : { level: ErrorLevel.Channel, reason: "resource_not_found_channel" },
      responseBody,
      headers
    );
  }

  if (statusCode === 597) {
    const body = responseBody?.toLowerCase() ?? "";
    const keyScoped = ["rate_limit", "rate limit", "authentication", "auth_error", "invalid_request"].some(
      (pattern) => body.includes(pattern)
    );
    return withResetTime(
      keyScoped
        ? { level: ErrorLevel.Key, reason: "sse_key_error" }
        : { level: ErrorLevel.Channel, reason: "sse_channel_error" },
      responseBody,
      headers
    );
  }

  // [优先级 1] 检测 "假 200" 错误（HTTP 200 但响应体是错误）
  // 结构化配额错误可能以 200 或 SSE 内部错误形式返回，必须先于 HTTP 状态码判断。
  const structured = classifyStructuredQuotaError(responseBody);
  if (structured) {
    return structured;
  }

  // [优先级 2] 429 限流错误智能分类
  if (statusCode === 429) {
    return withResetTime(classify429RateLimit(headers, responseBody), responseBody, headers);
  }

  // [优先级 3] 401/403 语义分析
  if (statusCode === 401 || statusCode === 403) {
    return withResetTime(classify401403Auth(responseBody), responseBody, headers);
  }

  // [优先级 4] 其他状态码走表驱动
  return withResetTime({ level: getErrorLevelFromStatus(statusCode) }, responseBody, headers);
}

/** 兼容 ccLoad 的结构化配额错误和 1308 错误。 */
function classifyStructuredQuotaError(responseBody: string | null): HTTPResponseClassification | null {
  if (!responseBody) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    for (const event of parseSSEData(responseBody)) {
      if (typeof event.data !== "object" || event.data === null) continue;
      const classified = classifyStructuredQuotaValue(event.data, responseBody);
      if (classified) return classified;
    }
    return null;
  }

  return classifyStructuredQuotaValue(parsed, responseBody);
}

function classifyStructuredQuotaValue(
  parsed: unknown,
  responseBody: string
): HTTPResponseClassification | null {

  const root = objectValueForReset(parsed);
  const error = objectValueForReset(root?.error);
  const records = [root, error].filter(
    (value): value is Record<string, unknown> => value !== null
  );
  if (records.length === 0) return null;

  const valueAsString = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const prioritizedRecords = [error, root].filter(
    (value): value is Record<string, unknown> => value !== null
  );
  const code = prioritizedRecords
    .map((record) => valueAsString(record.code) || valueAsString(record.type))
    .find(Boolean)
    ?.toUpperCase();
  const status = prioritizedRecords
    .map((record) => valueAsString(record.status))
    .find(Boolean)
    ?.toUpperCase();
  const message = prioritizedRecords.map((record) => valueAsString(record.message)).find(Boolean) ?? "";
  const upperMessage = message.toUpperCase();
  const resetAt = parseResetTimeFromResponse(responseBody) ?? undefined;
  const resetSeconds = resetAt
    ? Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))
    : undefined;

  // 1308/1310 常出现在 HTTP 200 的 SSE 或 Anthropic 错误体中。
  if (code === "1308" || code === "1310") {
    const messageResetAt = parseCalendarResetTime(message);
    return {
      level: ErrorLevel.Key,
      reason: code,
      keyCooldownSeconds: resetSeconds ?? (messageResetAt ? undefined : COOLDOWN_DURATIONS.KEY_DEFAULT),
      resetAt: messageResetAt ?? resetAt,
    };
  }

  if (code === "MODEL_COOLDOWN") {
    return resetAt
      ? { level: ErrorLevel.Key, reason: "model_cooldown", keyCooldownSeconds: resetSeconds, resetAt }
      : null;
  }

  if (status === "RESOURCE_EXHAUSTED" || upperMessage.includes("RESOURCE_EXHAUSTED")) {
    const retrySeconds = parseRetryInSeconds(message);
    if (retrySeconds == null) return null;
    return {
      level: ErrorLevel.Key,
      reason: "RESOURCE_EXHAUSTED_RETRY_IN",
      keyCooldownSeconds: retrySeconds,
      resetAt: calculateCooldownEndTime(retrySeconds),
    };
  }

  if (code === "API_KEY_QUOTA_EXHAUSTED" || code === "FREE_TIER_BUDGET_EXCEEDED") {
    return {
      level: ErrorLevel.Key,
      reason: code,
      keyCooldownSeconds: resetSeconds ?? 30 * 60,
      resetAt,
    };
  }

  if (code === "DAILY_LIMIT_EXCEEDED") {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    return {
      level: ErrorLevel.Key,
      reason: code,
      keyCooldownSeconds: Math.max(1, Math.ceil((nextMidnight.getTime() - Date.now()) / 1000)),
      resetAt: nextMidnight.toISOString(),
    };
  }

  if (code === "GLOBAL_FIXED_WINDOW_QUOTA_EXHAUSTED") {
    const windowResetAt = parseFixedWindowResetTime(message);
    return windowResetAt
      ? {
          level: ErrorLevel.Channel,
          reason: code,
          channelCooldownSeconds: Math.max(
            1,
            Math.ceil((Date.parse(windowResetAt) - Date.now()) / 1000)
          ),
          resetAt: windowResetAt,
        }
      : null;
  }

  if (code === "USAGE_LIMIT_REACHED") {
    return {
      level: ErrorLevel.Key,
      reason: code,
      keyCooldownSeconds: resetSeconds ?? 30 * 60,
      resetAt,
    };
  }

  if (code === "RATE_LIMIT_EXCEEDED") {
    const retrySeconds = parseRetryAfterMessageSeconds(message);
    if (retrySeconds != null) {
      return {
        level: ErrorLevel.Key,
        reason: "RATE_LIMIT_RETRY_AFTER",
        keyCooldownSeconds: retrySeconds,
        resetAt: calculateCooldownEndTime(retrySeconds),
      };
    }
  }

  return null;
}

function parseCalendarResetTime(message: string): string | undefined {
  const match = message.match(/\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\b/);
  if (!match) return undefined;
  const parsed = new Date(`${match[1].replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > Date.now()
    ? parsed.toISOString()
    : undefined;
}

function parseFixedWindowResetTime(message: string): string | undefined {
  const match = message.match(/\b(today|tomorrow|今天|明天)\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/i);
  if (!match) return undefined;
  const resetAt = new Date();
  resetAt.setHours(Number(match[2]), Number(match[3]), 0, 0);
  if (/tomorrow|明天/i.test(match[1])) resetAt.setDate(resetAt.getDate() + 1);
  if (resetAt.getTime() <= Date.now()) resetAt.setDate(resetAt.getDate() + 1);
  return resetAt.toISOString();
}

function parseRetryInSeconds(message: string): number | null {
  const match = message.match(/retry\s+in\s+([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "h" ? 3600 : unit === "m" ? 60 : unit === "ms" ? 0.001 : unit === "us" || unit === "µs" ? 0.000001 : unit === "ns" ? 0.000000001 : 1;
  const seconds = amount * multiplier;
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds)) : null;
}

function parseRetryAfterMessageSeconds(message: string): number | null {
  const match = message.match(/retry\s+after\s+([0-9]+)\s*seconds?/i);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function withResetTime(
  classification: HTTPResponseClassification,
  responseBody: string | null,
  headers?: Headers
): HTTPResponseClassification {
  const bodyResetAt = parseResetTimeFromResponse(responseBody);
  const headerResetAt = parseRetryAfterResetTime(headers?.get("retry-after"));
  const resetAt = [bodyResetAt, headerResetAt].find((value) => {
    if (!value) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > Date.now();
  });
  return resetAt ? { ...classification, resetAt } : classification;
}

/**
 * 分类 429 限流错误（智能分析）
 *
 * 检测逻辑：
 * 1. 检查 Retry-After 头：长时间限流（>60s）→ Channel 级
 * 2. 检查 X-RateLimit-Scope 头：global/ip/account → Channel 级
 * 3. 检查响应体关键词：ip rate limit/account rate limit → Channel 级
 * 4. 默认：Key 级限流
 */
function classify429RateLimit(
  headers: Headers,
  responseBody: string | null
): HTTPResponseClassification {
  // 检查 Retry-After 头
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseRetryAfterSeconds(retryAfter);
    if (seconds != null && seconds > 0) {
      if (seconds > 60) {
        // 长时间限流 → Channel 级
        return {
          level: ErrorLevel.Channel,
          reason: "rate_limit_long",
          channelCooldownSeconds: seconds,
        };
      }
      // 短时间限流 → Key 级
      return {
        level: ErrorLevel.Key,
        reason: "rate_limit_short",
        keyCooldownSeconds: seconds,
      };
    }
  }

  // 检查 X-RateLimit-Scope 头
  const scope = headers.get("x-ratelimit-scope")?.toLowerCase();
  if (scope === "global" || scope === "ip" || scope === "account") {
    return {
      level: ErrorLevel.Channel,
      reason: `rate_limit_${scope}`,
    };
  }

  // 检查响应体
  if (responseBody) {
    const bodyLower = responseBody.toLowerCase();
    const channelPatterns = [
      "ip rate limit",
      "account rate limit",
      "global rate limit",
      "organization limit",
    ];
    if (channelPatterns.some((pattern) => bodyLower.includes(pattern))) {
      return {
        level: ErrorLevel.Channel,
        reason: "rate_limit_body_pattern",
      };
    }
  }

  // 默认：Key 级限流
  return {
    level: ErrorLevel.Key,
    reason: "rate_limit_key",
  };
}

/**
 * 分类 401/403 认证错误（语义分析）
 *
 * Channel 级错误特征：
 * - account suspended/disabled/banned（账户被封禁，不可逆）
 * - service disabled（服务被禁用）
 *
 * Key 级错误特征：
 * - invalid api key（Key 无效）
 * - insufficient permissions（权限不足）
 * - quota exceeded（配额超限）
 */
function classify401403Auth(responseBody: string | null): HTTPResponseClassification {
  if (!responseBody) {
    return { level: ErrorLevel.Key };
  }

  const bodyLower = responseBody.toLowerCase();

  // Channel 级错误特征：仅限账户级不可逆错误
  const channelErrorPatterns = [
    "account suspended",
    "account has been suspended",
    "account disabled",
    "account has been disabled",
    "account banned",
    "account has been banned",
    "service disabled",
    "service has been disabled",
  ];

  for (const pattern of channelErrorPatterns) {
    if (bodyLower.includes(pattern)) {
      return {
        level: ErrorLevel.Channel,
        reason: "account_suspended",
      };
    }
  }

  // 默认：Key 级错误
  return {
    level: ErrorLevel.Key,
    reason: "auth_key_error",
  };
}

/**
 * 冷却时间配置（秒）
 */
export const COOLDOWN_DURATIONS = {
  /** Key 级错误默认冷却时间（5 分钟） */
  KEY_DEFAULT: 300,
  /** Channel 级错误默认冷却时间（10 分钟） */
  CHANNEL_DEFAULT: 600,
  /** 429 短时间限流冷却时间（根据 Retry-After 动态调整） */
  RATE_LIMIT_SHORT: 60,
  /** 429 长时间限流冷却时间（根据 Retry-After 动态调整） */
  RATE_LIMIT_LONG: 600,
} as const;

/**
 * 计算冷却结束时间
 *
 * @param seconds - 冷却时长（秒）
 * @returns ISO 8601 格式的时间字符串
 */
export function calculateCooldownEndTime(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * 从响应体解析精确的重置时间（ccLoad 特色功能）
 *
 * 支持格式：
 * - ISO 8601: "2025-12-09T18:08:11Z"
 * - 中国时区格式: "2025-12-09 18:08:11"
 * - Unix 时间戳（秒）: 1733756891
 * - Unix 时间戳（毫秒）: 1733756891000
 *
 * @param responseBody - 响应体（JSON 字符串）
 * @returns 精确的重置时间（ISO 8601 格式），如果解析失败则返回 null
 */
export function parseResetTimeFromResponse(responseBody: string | null): string | null {
  if (!responseBody) {
    return null;
  }

  try {
    const body = JSON.parse(responseBody);

    const records = [
      objectValueForReset(body),
      objectValueForReset(objectValueForReset(body)?.error),
    ].filter((value): value is Record<string, unknown> => value !== null);
    const absoluteFields = [
      "reset_at",
      "resetAt",
      "resets_at",
      "reset_time",
      "resetTime",
      "retry_after_time",
    ];
    const relativeFields = [
      "reset_seconds",
      "resetSeconds",
      "resets_in_seconds",
      "resetsInSeconds",
      "retry_after_seconds",
      "retryAfterSeconds",
    ];
    const durationFields = ["reset_time", "resetTime"];

    for (const record of records) {
      for (const field of absoluteFields) {
        const parsed = parseAbsoluteResetValue(record[field]);
        if (parsed) return parsed;
      }
      for (const field of relativeFields) {
        const seconds = finiteResetNumber(record[field]);
        if (seconds != null && seconds > 0) {
          return new Date(Date.now() + seconds * 1000).toISOString();
        }
      }
      for (const field of durationFields) {
        const parsed = parseResetDuration(record[field]);
        if (parsed) return parsed;
      }
    }
  } catch (error) {
    // JSON 解析失败，返回 null
    logger.debug("[ErrorClassifier] Failed to parse reset time from response body", { error });
  }

  return null;
}

function objectValueForReset(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteResetNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAbsoluteResetValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized =
    value.includes(" ") && !value.includes("T") ? `${value.replace(" ", "T")}Z` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseResetDuration(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
    if (!match?.[0] || !match.slice(1).some(Boolean)) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

function parseRetryAfterResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now()
    ? new Date(timestamp).toISOString()
    : null;
}

function parseRetryAfterSeconds(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

/**
 * Provider 冷却建议
 */
export interface ProviderCooldownAdvice {
  /** 是否应该冷却此 Provider */
  shouldCooldown: boolean;
  /** 冷却时长（秒） */
  cooldownSeconds: number;
  /** 冷却结束时间（ISO 8601 格式） */
  cooldownUntil: string;
  /** 冷却原因 */
  reason: string;
}

/**
 * 生成 Provider 冷却建议
 *
 * @param classification - HTTP 响应分类结果
 * @param provider - Provider 信息
 * @returns 冷却建议
 */
export function generateCooldownAdvice(
  classification: HTTPResponseClassification,
  provider: Provider
): ProviderCooldownAdvice | null {
  // 客户端错误不冷却
  if (classification.level === ErrorLevel.Client) {
    return null;
  }

  // Key 级错误：冷却当前 Provider（短时间）
  if (classification.level === ErrorLevel.Key) {
    const seconds = classification.keyCooldownSeconds || COOLDOWN_DURATIONS.KEY_DEFAULT;
    const resetAt = validFutureResetAt(classification.resetAt);
    return {
      shouldCooldown: true,
      cooldownSeconds: seconds,
      cooldownUntil: resetAt ?? calculateCooldownEndTime(seconds),
      reason: classification.reason || "key_error",
    };
  }

  // Channel 级错误：冷却整个 Provider（长时间）
  if (classification.level === ErrorLevel.Channel) {
    const seconds = classification.channelCooldownSeconds || COOLDOWN_DURATIONS.CHANNEL_DEFAULT;
    const resetAt = validFutureResetAt(classification.resetAt);
    return {
      shouldCooldown: true,
      cooldownSeconds: seconds,
      cooldownUntil: resetAt ?? calculateCooldownEndTime(seconds),
      reason: classification.reason || "channel_error",
    };
  }

  return null;
}

function validFutureResetAt(resetAt: string | undefined): string | null {
  if (!resetAt) return null;
  const timestamp = Date.parse(resetAt);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? new Date(timestamp).toISOString() : null;
}
