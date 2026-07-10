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

  // === Channel 级错误：服务器端问题 ===
  [444, ErrorLevel.Channel], // nginx: No Response
  [500, ErrorLevel.Channel], // Internal Server Error
  [502, ErrorLevel.Channel], // Bad Gateway
  [503, ErrorLevel.Channel], // Service Unavailable
  [504, ErrorLevel.Channel], // Gateway Timeout
  [520, ErrorLevel.Channel], // Cloudflare: Unknown Error
  [521, ErrorLevel.Channel], // Cloudflare: Web Server Is Down
  [524, ErrorLevel.Channel], // Cloudflare: A Timeout Occurred

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
  // [优先级 1] 检测 "假 200" 错误（HTTP 200 但响应体是错误）
  // TODO: 实现假 200 检测逻辑（类似你现在的 upstream-error-detection.ts）

  // [优先级 2] 429 限流错误智能分类
  if (statusCode === 429) {
    return classify429RateLimit(headers, responseBody);
  }

  // [优先级 3] 401/403 语义分析
  if (statusCode === 401 || statusCode === 403) {
    return classify401403Auth(responseBody);
  }

  // [优先级 4] 其他状态码走表驱动
  return {
    level: getErrorLevelFromStatus(statusCode),
  };
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
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
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
    "account disabled",
    "account banned",
    "service disabled",
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

    // 常见字段名
    const resetFields = ["reset_at", "resetAt", "reset_time", "resetTime", "retry_after_time"];

    for (const field of resetFields) {
      const value = body[field] || body.error?.[field];
      if (!value) continue;

      // 尝试解析时间
      if (typeof value === "string") {
        // ISO 8601 或 中国时区格式
        const parsed = new Date(value.replace(" ", "T") + (value.includes("T") ? "" : "Z"));
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      } else if (typeof value === "number") {
        // Unix 时间戳（自动检测秒/毫秒）
        const timestamp = value < 10000000000 ? value * 1000 : value;
        const parsed = new Date(timestamp);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      }
    }
  } catch (error) {
    // JSON 解析失败，返回 null
    logger.debug("[ErrorClassifier] Failed to parse reset time from response body", { error });
  }

  return null;
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
    return {
      shouldCooldown: true,
      cooldownSeconds: seconds,
      cooldownUntil: calculateCooldownEndTime(seconds),
      reason: classification.reason || "key_error",
    };
  }

  // Channel 级错误：冷却整个 Provider（长时间）
  if (classification.level === ErrorLevel.Channel) {
    const seconds = classification.channelCooldownSeconds || COOLDOWN_DURATIONS.CHANNEL_DEFAULT;
    return {
      shouldCooldown: true,
      cooldownSeconds: seconds,
      cooldownUntil: calculateCooldownEndTime(seconds),
      reason: classification.reason || "channel_error",
    };
  }

  return null;
}
