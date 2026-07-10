# 错误分类器修复计划

## 问题分析

当前 `categorizeErrorAsync` 的优先级错误：

```
当前优先级：
1. 客户端中断检测 ✓
2. Transport 错误检测 ✓
3. 客户端输入错误规则匹配 ← 问题！会误判 5xx 响应
4. ProxyError 状态码检查 ← 太晚了！

问题场景：
- 上游返回 HTTP 503
- 响应体包含 "model_not_found" 或其他关键词
- 被步骤 3 的规则匹配，误判为 NON_RETRYABLE_CLIENT_ERROR
- 步骤 4 根本没机会运行
- 重试和故障转移逻辑无法触发！
```

## 修复方案 1：PR #1325 的最小修复（推荐优先实施）

**目标**：优先检查 HTTP 状态码，5xx 立即返回 `PROVIDER_ERROR`

### 修改 `src/app/v1/_lib/proxy/errors.ts`

在 `categorizeErrorAsync` 函数中，将 ProxyError 的 5xx 检查提前到优先级 2：

```typescript
export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  // 优先级 1: 客户端中断检测（优先级最高）
  if (isClientAbortError(error)) {
    return ErrorCategory.CLIENT_ABORT;
  }

  // 优先级 1.5: Native transport errors
  if (isTransportError(error)) {
    return ErrorCategory.SYSTEM_ERROR;
  }

  // 【新增】优先级 2: 显式上游 5xx 检查（PR #1325 核心修复）
  // 任何 ProxyError 的 5xx 状态码立即返回 PROVIDER_ERROR
  // 这个检查必须在基于消息内容的启发式规则之前运行
  if (
    error instanceof ProxyError &&
    error.statusCode >= 500 &&
    error.statusCode < 600 &&
    !error.message.startsWith("FAKE_200_")
  ) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 3: 不可重试的客户端输入错误检测（白名单模式）
  // 现在这个检查在 5xx 检查之后，不会误判上游 5xx 错误
  if (await isNonRetryableClientErrorAsync(error)) {
    return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
  }

  // 优先级 4: ProxyError = 其他 HTTP 错误（4xx）
  if (error instanceof ProxyError) {
    // 404 错误特殊处理
    if (error.statusCode === 404) {
      return ErrorCategory.RESOURCE_NOT_FOUND;
    }
    // 其他 HTTP 错误（主要是 4xx）
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 5: 空响应错误
  if (error instanceof EmptyResponseError) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 6: 其他所有错误都是系统错误
  return ErrorCategory.SYSTEM_ERROR;
}
```

### 测试用例（新建文件）

创建 `tests/unit/proxy/error-category-status-precedence.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { categorizeErrorAsync, ErrorCategory, ProxyError } from "@/app/v1/_lib/proxy/errors";

describe("categorizeErrorAsync - HTTP status precedence over message content", () => {
  it("503 with model-error body → PROVIDER_ERROR (not CLIENT_ERROR)", async () => {
    const error = new ProxyError(
      "model_not_found: No available channel for model gpt-4",
      503,
      {
        body: '{"error": {"message": "model_not_found: No available channel for model gpt-4"}}',
        parsed: { error: { message: "model_not_found: No available channel for model gpt-4" } },
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("502 with transport-like message → PROVIDER_ERROR (not SYSTEM_ERROR)", async () => {
    const error = new ProxyError(
      "Connection failed: upstream unreachable",
      502,
      {
        body: "Connection failed: upstream unreachable",
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("503 with abort-like message → PROVIDER_ERROR (not CLIENT_ABORT)", async () => {
    const error = new ProxyError(
      "Request aborted by upstream",
      503,
      {
        body: "Request aborted by upstream",
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("Native transport error → SYSTEM_ERROR (preserved)", async () => {
    const error = new Error("fetch failed");
    (error as Error & { code: string }).code = "ECONNREFUSED";

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.SYSTEM_ERROR);
  });

  it("404 with model-error body → RESOURCE_NOT_FOUND (preserved)", async () => {
    const error = new ProxyError(
      "model_not_found",
      404,
      {
        body: '{"error": "model not found"}',
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.RESOURCE_NOT_FOUND);
  });
});
```

## 修复方案 2：完整移植 ccLoad 错误分类器（可选，未来增强）

这是更全面的重构，引入 ccLoad 的表驱动设计和智能分类策略。

### 2.1 创建状态码元数据表

新建文件 `src/app/v1/_lib/proxy/error-classifier.ts`：

```typescript
/**
 * 错误级别枚举（借鉴 ccLoad）
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
 */
const STATUS_CODE_META_MAP = new Map<number, ErrorLevel>([
  // === 客户端取消 ===
  [499, ErrorLevel.Channel], // 上游返回的客户端关闭请求，应切换 Provider 重试

  // === Key 级错误：API Key 相关问题 ===
  [401, ErrorLevel.Key], // Unauthorized - Key invalid
  [402, ErrorLevel.Key], // Payment Required - quota/balance
  [403, ErrorLevel.Key], // Forbidden - Key permission
  [429, ErrorLevel.Key], // Too Many Requests - rate limited

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
  [405, ErrorLevel.Channel], // Method Not Allowed（配置错误）
  [406, ErrorLevel.Client], // Not Acceptable
  [410, ErrorLevel.Client], // Gone
  [413, ErrorLevel.Client], // Payload Too Large
  [414, ErrorLevel.Client], // URI Too Long
  [415, ErrorLevel.Client], // Unsupported Media Type
]);

/**
 * 获取状态码的错误级别（带兜底策略）
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
  keyCooldownUntil?: Date;
  channelCooldownUntil?: Date;
  reason?: string;
}

/**
 * 分类 HTTP 响应（状态码 + headers + 响应体）
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
 * 分类 429 限流错误
 */
function classify429RateLimit(headers: Headers, responseBody: string | null): HTTPResponseClassification {
  // 检查 Retry-After 头
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 60) {
      // 长时间限流 → Channel 级
      return { level: ErrorLevel.Channel, reason: "rate_limit_long" };
    }
  }

  // 检查 X-RateLimit-Scope 头
  const scope = headers.get("x-ratelimit-scope")?.toLowerCase();
  if (scope === "global" || scope === "ip" || scope === "account") {
    return { level: ErrorLevel.Channel, reason: `rate_limit_${scope}` };
  }

  // 检查响应体
  if (responseBody) {
    const bodyLower = responseBody.toLowerCase();
    const channelPatterns = ["ip rate limit", "account rate limit", "global rate limit", "organization limit"];
    if (channelPatterns.some((pattern) => bodyLower.includes(pattern))) {
      return { level: ErrorLevel.Channel, reason: "rate_limit_body_pattern" };
    }
  }

  // 默认：Key 级限流
  return { level: ErrorLevel.Key, reason: "rate_limit_key" };
}

/**
 * 分类 401/403 认证错误
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
      return { level: ErrorLevel.Channel, reason: "account_suspended" };
    }
  }

  // 默认：Key 级错误
  return { level: ErrorLevel.Key, reason: "auth_key_error" };
}
```

### 2.2 集成到现有代码

修改 `src/app/v1/_lib/proxy/errors.ts`，使用新的分类器：

```typescript
import { classifyHTTPResponse, ErrorLevel, getErrorLevelFromStatus } from "./error-classifier";

export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  // 优先级 1: 客户端中断检测
  if (isClientAbortError(error)) {
    return ErrorCategory.CLIENT_ABORT;
  }

  // 优先级 1.5: Native transport errors
  if (isTransportError(error)) {
    return ErrorCategory.SYSTEM_ERROR;
  }

  // 优先级 2: ProxyError 的智能分类（使用 ccLoad 风格的分类器）
  if (error instanceof ProxyError) {
    // 构建响应体字符串
    const responseBody = error.upstreamError?.body || null;
    
    // 构建 Headers 对象（如果有）
    const headers = new Headers();
    // TODO: 如果你的 ProxyError 存储了原始响应头，这里需要填充
    
    // 使用智能分类器
    const classification = classifyHTTPResponse(error.statusCode, headers, responseBody);
    
    // 映射 ErrorLevel 到 ErrorCategory
    switch (classification.level) {
      case ErrorLevel.Channel:
        // 5xx、上游 499、长时间限流等 → PROVIDER_ERROR
        return ErrorCategory.PROVIDER_ERROR;
      
      case ErrorLevel.Key:
        // 429、401、403 等 Key 级错误 → PROVIDER_ERROR（仍然触发故障转移）
        return ErrorCategory.PROVIDER_ERROR;
      
      case ErrorLevel.Client:
        // 408、413 等真正的客户端错误
        // 但需要先检查是否匹配客户端输入错误规则
        if (await isNonRetryableClientErrorAsync(error)) {
          return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
        }
        return ErrorCategory.PROVIDER_ERROR; // 保守：仍然尝试故障转移
      
      default:
        return ErrorCategory.PROVIDER_ERROR;
    }
  }

  // 优先级 3: 客户端输入错误规则匹配
  if (await isNonRetryableClientErrorAsync(error)) {
    return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
  }

  // 优先级 4: 空响应错误
  if (error instanceof EmptyResponseError) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 5: 其他所有错误
  return ErrorCategory.SYSTEM_ERROR;
}
```

## 测试验证

运行测试：

```bash
bun run test tests/unit/proxy/error-category-status-precedence.test.ts
```

确保所有测试通过！

## 总结

### 方案 1（推荐）：最小修复
- ✅ 简单直接，修改量小
- ✅ 直接解决 PR #1325 的问题
- ✅ 向后兼容，不影响现有逻辑
- ⏱️ 预计 30 分钟完成

### 方案 2（可选）：完整重构
- ✅ 引入 ccLoad 的表驱动设计
- ✅ 更智能的 429/401/403 分类
- ✅ 更好的可维护性和可扩展性
- ⚠️ 需要更多测试
- ⏱️ 预计 2-3 小时完成

建议：**先实施方案 1**，验证问题解决后，再逐步引入方案 2 的增强功能！
