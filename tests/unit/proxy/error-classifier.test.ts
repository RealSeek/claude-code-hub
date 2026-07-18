/**
 * 错误分类器测试 - 基于 ccLoad 表驱动设计
 *
 * 测试目标：
 * 1. 状态码优先级：5xx 永远是 Channel 级
 * 2. 智能 429 分类：区分 Key 级和 Channel 级限流
 * 3. 401/403 语义分析：账户封禁 vs API Key 问题
 * 4. 精确重置时间解析
 */

import { describe, expect, it } from "vitest";
import {
  ErrorLevel,
  classifyHTTPResponse,
  getErrorLevelFromStatus,
  parseResetTimeFromResponse,
  generateCooldownAdvice,
  COOLDOWN_DURATIONS,
} from "@/app/v1/_lib/proxy/error-classifier";

describe("ErrorClassifier - 状态码优先原则", () => {
  it("所有 5xx 状态码 → Channel 级", () => {
    expect(getErrorLevelFromStatus(500)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(502)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(503)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(504)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(520)).toBe(ErrorLevel.Channel); // Cloudflare
    expect(getErrorLevelFromStatus(521)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(524)).toBe(ErrorLevel.Channel);
    expect(getErrorLevelFromStatus(599)).toBe(ErrorLevel.Channel); // 未知 5xx
  });

  it("401/403 默认 → Key 级", () => {
    expect(getErrorLevelFromStatus(401)).toBe(ErrorLevel.Key);
    expect(getErrorLevelFromStatus(403)).toBe(ErrorLevel.Key);
  });

  it("429 默认 → Key 级（需语义分析）", () => {
    expect(getErrorLevelFromStatus(429)).toBe(ErrorLevel.Key);
  });

  it("客户端错误 → Client 级", () => {
    expect(getErrorLevelFromStatus(408)).toBe(ErrorLevel.Client);
    expect(getErrorLevelFromStatus(413)).toBe(ErrorLevel.Client);
    expect(getErrorLevelFromStatus(414)).toBe(ErrorLevel.Client);
  });

  it("404 → Key 级（兜底策略）", () => {
    expect(getErrorLevelFromStatus(404)).toBe(ErrorLevel.Key);
  });

  it("未知 4xx → Key 级（保守策略）", () => {
    expect(getErrorLevelFromStatus(450)).toBe(ErrorLevel.Key);
  });

  it("400 默认按 Channel，明确 invalid API key 才按 Key", () => {
    expect(classifyHTTPResponse(400, new Headers(), "bad request").level).toBe(ErrorLevel.Channel);
    expect(classifyHTTPResponse(400, new Headers(), "invalid api key").level).toBe(ErrorLevel.Key);
  });

  it("404 默认按 Channel，model not found 按 Client", () => {
    expect(classifyHTTPResponse(404, new Headers(), "route not found").level).toBe(ErrorLevel.Channel);
    expect(classifyHTTPResponse(404, new Headers(), "model not found").level).toBe(ErrorLevel.Client);
  });

  it("597 根据 SSE 内部错误类型区分 Key 与 Channel", () => {
    expect(
      classifyHTTPResponse(597, new Headers(), 'data: {"type":"error","error":{"type":"rate_limit_error"}}\n\n').level
    ).toBe(ErrorLevel.Key);
    expect(
      classifyHTTPResponse(597, new Headers(), 'data: {"type":"error","error":{"type":"api_error"}}\n\n').level
    ).toBe(ErrorLevel.Channel);
  });
});

describe("ErrorClassifier - 智能 429 限流分析", () => {
  it("Retry-After > 60s → Channel 级", () => {
    const headers = new Headers({ "Retry-After": "120" });
    const result = classifyHTTPResponse(429, headers, null);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("rate_limit_long");
    expect(result.channelCooldownSeconds).toBe(120);
  });

  it("Retry-After <= 60s → Key 级", () => {
    const headers = new Headers({ "Retry-After": "30" });
    const result = classifyHTTPResponse(429, headers, null);

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("rate_limit_short");
    expect(result.keyCooldownSeconds).toBe(30);
  });

  it("X-RateLimit-Scope: global → Channel 级", () => {
    const headers = new Headers({ "X-RateLimit-Scope": "global" });
    const result = classifyHTTPResponse(429, headers, null);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("rate_limit_global");
  });

  it("X-RateLimit-Scope: account → Channel 级", () => {
    const headers = new Headers({ "X-RateLimit-Scope": "account" });
    const result = classifyHTTPResponse(429, headers, null);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("rate_limit_account");
  });

  it("响应体包含 'ip rate limit' → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "IP rate limit exceeded" });
    const result = classifyHTTPResponse(429, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("rate_limit_body_pattern");
  });

  it("响应体包含 'account rate limit' → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Account rate limit exceeded" });
    const result = classifyHTTPResponse(429, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("rate_limit_body_pattern");
  });

  it("默认情况 → Key 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Rate limit exceeded" });
    const result = classifyHTTPResponse(429, headers, body);

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("rate_limit_key");
  });
});

describe("ErrorClassifier - 401/403 语义分析", () => {
  it("账户被封禁 → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Account suspended" });
    const result = classifyHTTPResponse(401, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("account_suspended");
  });

  it("账户被禁用 → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Account disabled" });
    const result = classifyHTTPResponse(403, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("account_suspended");
  });

  it("服务被禁用 → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Service disabled" });
    const result = classifyHTTPResponse(403, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("account_suspended");
  });

  it("无效 API Key → Key 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Invalid API key" });
    const result = classifyHTTPResponse(401, headers, body);

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("auth_key_error");
  });

  it("权限不足 → Key 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Insufficient permissions" });
    const result = classifyHTTPResponse(403, headers, body);

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("auth_key_error");
  });

  it("无响应体 → Key 级（默认）", () => {
    const headers = new Headers();
    const result = classifyHTTPResponse(401, headers, null);

    expect(result.level).toBe(ErrorLevel.Key);
  });
});

describe("ErrorClassifier - 精确重置时间解析", () => {
  it("ISO 8601 格式", () => {
    const body = JSON.stringify({ reset_at: "2025-12-09T18:08:11Z" });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBe("2025-12-09T18:08:11.000Z");
  });

  it("中国时区格式", () => {
    const body = JSON.stringify({ reset_time: "2025-12-09 18:08:11" });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBe("2025-12-09T18:08:11.000Z");
  });

  it("Unix 时间戳（秒）", () => {
    const body = JSON.stringify({ reset_at: 1733756891 });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBe(new Date(1733756891 * 1000).toISOString());
  });

  it("Unix 时间戳（毫秒）", () => {
    const body = JSON.stringify({ reset_at: 1733756891000 });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBe(new Date(1733756891000).toISOString());
  });

  it("嵌套在 error 对象中", () => {
    const body = JSON.stringify({ error: { reset_at: "2025-12-09T18:08:11Z" } });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBe("2025-12-09T18:08:11.000Z");
  });

  it("无重置时间 → null", () => {
    const body = JSON.stringify({ error: "Rate limit exceeded" });
    const result = parseResetTimeFromResponse(body);

    expect(result).toBeNull();
  });

  it("无效 JSON → null", () => {
    const body = "Not a JSON";
    const result = parseResetTimeFromResponse(body);

    expect(result).toBeNull();
  });
});

describe("ErrorClassifier - 冷却建议生成", () => {
  it("Client 级错误 → 不冷却", () => {
    const classification = {
      level: ErrorLevel.Client,
    };
    const result = generateCooldownAdvice(classification, {} as any);

    expect(result).toBeNull();
  });

  it("Key 级错误 → 冷却 5 分钟", () => {
    const classification = {
      level: ErrorLevel.Key,
      reason: "auth_key_error",
    };
    const result = generateCooldownAdvice(classification, {} as any);

    expect(result).not.toBeNull();
    expect(result?.shouldCooldown).toBe(true);
    expect(result?.cooldownSeconds).toBe(COOLDOWN_DURATIONS.KEY_DEFAULT);
    expect(result?.reason).toBe("auth_key_error");
  });

  it("Key 级错误（自定义冷却时间）", () => {
    const classification = {
      level: ErrorLevel.Key,
      reason: "rate_limit_short",
      keyCooldownSeconds: 30,
    };
    const result = generateCooldownAdvice(classification, {} as any);

    expect(result).not.toBeNull();
    expect(result?.cooldownSeconds).toBe(30);
    expect(result?.reason).toBe("rate_limit_short");
  });

  it("Channel 级错误 → 冷却 10 分钟", () => {
    const classification = {
      level: ErrorLevel.Channel,
      reason: "account_suspended",
    };
    const result = generateCooldownAdvice(classification, {} as any);

    expect(result).not.toBeNull();
    expect(result?.shouldCooldown).toBe(true);
    expect(result?.cooldownSeconds).toBe(COOLDOWN_DURATIONS.CHANNEL_DEFAULT);
    expect(result?.reason).toBe("account_suspended");
  });

  it("Channel 级错误（自定义冷却时间）", () => {
    const classification = {
      level: ErrorLevel.Channel,
      reason: "rate_limit_long",
      channelCooldownSeconds: 120,
    };
    const result = generateCooldownAdvice(classification, {} as any);

    expect(result).not.toBeNull();
    expect(result?.cooldownSeconds).toBe(120);
    expect(result?.reason).toBe("rate_limit_long");
  });
});

describe("ErrorClassifier - 综合场景测试", () => {
  it("场景 1: 上游 503 + 'model_not_found' 响应体 → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "model_not_found: No available channel" });
    const result = classifyHTTPResponse(503, headers, body);

    // 状态码优先：503 → Channel 级，不管响应体内容
    expect(result.level).toBe(ErrorLevel.Channel);
  });

  it("场景 2: 429 + Retry-After: 300 → Channel 级 + 精确冷却", () => {
    const headers = new Headers({ "Retry-After": "300" });
    const body = JSON.stringify({
      error: "Rate limit exceeded",
      reset_at: "2025-12-09T18:08:11Z",
    });
    const result = classifyHTTPResponse(429, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.channelCooldownSeconds).toBe(300);

    const resetAt = parseResetTimeFromResponse(body);
    expect(resetAt).toBe("2025-12-09T18:08:11.000Z");
  });

  it("场景 3: 401 + 'account suspended' → Channel 级（不是 Key 级）", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Your account has been suspended" });
    const result = classifyHTTPResponse(401, headers, body);

    // 语义分析：账户封禁 → Channel 级
    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("account_suspended");
  });

  it("场景 3b: 401 + 'account has been suspended' → Channel 级", () => {
    const result = classifyHTTPResponse(
      401,
      new Headers(),
      JSON.stringify({ error: "Your account has been suspended" })
    );

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("account_suspended");
  });

  it("场景 3c: reset_at 应进入分类结果和冷却建议", () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const body = JSON.stringify({ error: { reset_at: resetAt } });
    const result = classifyHTTPResponse(429, new Headers(), body);
    const advice = generateCooldownAdvice(result, {} as any);

    expect(result.resetAt).toBe(resetAt);
    expect(advice?.cooldownUntil).toBe(resetAt);
  });

  it("场景 3d: ccLoad 结构化 reset_seconds 和相对 reset_time 应可解析", () => {
    const secondsResult = parseResetTimeFromResponse(
      JSON.stringify({ error: { reset_seconds: 90 } })
    );
    const durationResult = parseResetTimeFromResponse(
      JSON.stringify({ error: { reset_time: "1h30m" } })
    );

    expect(secondsResult).not.toBeNull();
    expect(durationResult).not.toBeNull();
    expect(Date.parse(secondsResult!) - Date.now()).toBeGreaterThan(80_000);
    expect(Date.parse(durationResult!) - Date.now()).toBeGreaterThan(5_000_000);
  });

  it("场景 3e: Retry-After HTTP-date 应按剩余时间分类并保留截止时间", () => {
    const retryAt = new Date(Date.now() + 120_000).toUTCString();
    const result = classifyHTTPResponse(429, new Headers({ "retry-after": retryAt }), null);

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.channelCooldownSeconds).toBeGreaterThan(60);
    expect(result.resetAt).not.toBeUndefined();
  });

  it("场景 3f: HTTP 200 的 1308 错误应触发精确 Key 冷却", () => {
    const resetAt = new Date(Date.now() + 90_000);
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "1308",
        message: `usage limit resets at ${resetAt.toISOString().replace("T", " ").replace(".000Z", "")}`,
      },
    });
    const result = classifyHTTPResponse(200, new Headers(), body);

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("1308");
    expect(result.resetAt).toBeDefined();
  });

  it("场景 3g: RESOURCE_EXHAUSTED 的 retry in 应转换为 Key 冷却", () => {
    const result = classifyHTTPResponse(
      429,
      new Headers(),
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "Please retry in 2.5s",
        },
      })
    );

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("RESOURCE_EXHAUSTED_RETRY_IN");
    expect(result.keyCooldownSeconds).toBe(3);
  });

  it("场景 3h: USAGE_LIMIT_REACHED 无重置字段时使用保守默认冷却", () => {
    const result = classifyHTTPResponse(
      200,
      new Headers(),
      JSON.stringify({ code: "USAGE_LIMIT_REACHED", message: "usage limit reached" })
    );

    expect(result.level).toBe(ErrorLevel.Key);
    expect(result.reason).toBe("USAGE_LIMIT_REACHED");
    expect(result.keyCooldownSeconds).toBe(1800);
  });

  it("场景 3i: 全局固定窗口配额应冷却整个 Provider", () => {
    const result = classifyHTTPResponse(
      429,
      new Headers(),
      JSON.stringify({
        code: "GLOBAL_FIXED_WINDOW_QUOTA_EXHAUSTED",
        message: "Please retry today 23:59",
      })
    );

    expect(result.level).toBe(ErrorLevel.Channel);
    expect(result.reason).toBe("GLOBAL_FIXED_WINDOW_QUOTA_EXHAUSTED");
    expect(result.resetAt).toBeDefined();
  });

  it("场景 4: 500 Internal Server Error → Channel 级", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Internal server error" });
    const result = classifyHTTPResponse(500, headers, body);

    expect(result.level).toBe(ErrorLevel.Channel);
  });

  it("场景 5: 413 Payload Too Large → Client 级（不冷却）", () => {
    const headers = new Headers();
    const body = JSON.stringify({ error: "Request entity too large" });
    const result = classifyHTTPResponse(413, headers, body);

    expect(result.level).toBe(ErrorLevel.Client);

    const advice = generateCooldownAdvice(result, {} as any);
    expect(advice).toBeNull(); // 客户端错误不冷却
  });
});
