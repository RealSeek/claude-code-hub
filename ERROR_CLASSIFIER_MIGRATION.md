# ccLoad 错误分类器完整移植方案

> 基于 ccLoad 的表驱动设计，完整移植智能错误分类系统到 CCH

## 🎯 移植目标

将 ccLoad 的核心错误分类能力移植到 CCH，实现：
1. **状态码优先原则**：HTTP 状态码的语义优先于响应体内容
2. **智能语义分析**：429/401/403 等特殊状态码的上下文分析
3. **精确冷却时间**：从响应体解析重置时间，实现精确的 Provider 冷却
4. **表驱动配置**：使用 Map 统一管理所有状态码的分类规则

## ✅ 已完成工作

### 阶段 1：核心分类器实现

**文件：** `src/app/v1/_lib/proxy/error-classifier.ts`

**核心功能：**
1. ✅ 状态码元数据表（`STATUS_CODE_META_MAP`）
   - 覆盖所有常见 HTTP 状态码
   - 三级分类：Key 级、Channel 级、Client 级
   - 支持 Cloudflare 特殊状态码（520/521/524）

2. ✅ 智能 429 限流分析
   - 检查 `Retry-After` 头：>60s → Channel 级，≤60s → Key 级
   - 检查 `X-RateLimit-Scope` 头：global/ip/account → Channel 级
   - 响应体关键词匹配：ip/account rate limit → Channel 级

3. ✅ 401/403 语义分析
   - Channel 级特征：account suspended/disabled/banned
   - Key 级特征：invalid api key/insufficient permissions

4. ✅ 精确重置时间解析
   - 支持 ISO 8601 格式
   - 支持中国时区格式（`2025-12-09 18:08:11`）
   - 支持 Unix 时间戳（秒/毫秒自动检测）
   - 支持嵌套字段（`error.reset_at`）

5. ✅ 冷却建议生成
   - Key 级错误默认冷却 5 分钟
   - Channel 级错误默认冷却 10 分钟
   - 支持自定义冷却时间（从 `Retry-After` 解析）

### 阶段 2：测试用例

**文件：** `tests/unit/proxy/error-classifier.test.ts`

**测试覆盖率：**
- ✅ 状态码优先原则（8 个测试）
- ✅ 智能 429 限流分析（7 个测试）
- ✅ 401/403 语义分析（6 个测试）
- ✅ 精确重置时间解析（7 个测试）
- ✅ 冷却建议生成（6 个测试）
- ✅ 综合场景测试（5 个测试）

**总计：** 39 个测试用例，覆盖所有核心功能

## 🔄 与现有系统的对比

### 现有 errors.ts (categorizeErrorAsync)

```typescript
// 优先级 1: 客户端中断检测
if (isClientAbortError(error)) return ErrorCategory.CLIENT_ABORT;

// 优先级 1.5: Transport 错误检测
if (isTransportError(error)) return ErrorCategory.SYSTEM_ERROR;

// 优先级 2: 显式 5xx 检查 (PR #1325 修复)
if (error instanceof ProxyError && statusCode >= 500 && statusCode < 600) {
  return ErrorCategory.PROVIDER_ERROR;
}

// 优先级 3: 客户端输入错误规则匹配
if (await isNonRetryableClientErrorAsync(error)) {
  return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
}

// 优先级 4: ProxyError 状态码检查
if (error instanceof ProxyError) {
  if (statusCode === 404) return ErrorCategory.RESOURCE_NOT_FOUND;
  return ErrorCategory.PROVIDER_ERROR;
}
```

**问题：**
- ❌ 缺乏智能 429 分析（无法区分 Key 级和 Channel 级限流）
- ❌ 缺乏精确冷却时间解析（无法从响应体提取 reset_at）
- ❌ 缺乏 401/403 语义分析（无法区分账户封禁和 Key 问题）
- ❌ 没有统一的状态码元数据表（分散在多个 if 语句中）

### 新 error-classifier.ts

```typescript
// 表驱动设计：统一管理所有状态码
const STATUS_CODE_META_MAP = new Map<number, ErrorLevel>([
  [401, ErrorLevel.Key],
  [429, ErrorLevel.Key], // 默认 Key 级，需语义分析
  [500, ErrorLevel.Channel],
  [502, ErrorLevel.Channel],
  [503, ErrorLevel.Channel],
  // ... 更多状态码
]);

// 智能分类：状态码 + headers + 响应体
classifyHTTPResponse(statusCode, headers, responseBody)
```

**优势：**
- ✅ 表驱动设计，易于扩展和维护
- ✅ 智能 429 分析，区分 Key 级和 Channel 级
- ✅ 精确冷却时间解析，支持多种时间格式
- ✅ 401/403 语义分析，区分账户封禁和 Key 问题
- ✅ 完整的测试覆盖

## 🔧 集成方案

### 方案 A：增强现有 categorizeErrorAsync（推荐）

保留现有的 `ErrorCategory` 枚举，增强分类逻辑：

```typescript
// src/app/v1/_lib/proxy/errors.ts

import {
  classifyHTTPResponse,
  parseResetTimeFromResponse,
  type HTTPResponseClassification,
} from "./error-classifier";

export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  // 优先级 1: 客户端中断检测
  if (isClientAbortError(error)) {
    return ErrorCategory.CLIENT_ABORT;
  }

  // 优先级 1.5: Native transport errors
  if (isTransportError(error)) {
    return ErrorCategory.SYSTEM_ERROR;
  }

  // 优先级 2: 使用新的智能分类器（仅针对 ProxyError）
  if (error instanceof ProxyError) {
    const headers = new Headers(); // 需要从 ProxyError 提取响应头
    const body = error.upstreamError?.body || null;
    
    const classification = classifyHTTPResponse(
      error.statusCode,
      headers,
      body
    );

    // 映射 ErrorLevel → ErrorCategory
    switch (classification.level) {
      case ErrorLevel.Channel:
        return ErrorCategory.PROVIDER_ERROR;
      case ErrorLevel.Key:
        // 需要进一步区分：Key 级错误可能是 404 或其他 4xx
        if (error.statusCode === 404) {
          return ErrorCategory.RESOURCE_NOT_FOUND;
        }
        return ErrorCategory.PROVIDER_ERROR;
      case ErrorLevel.Client:
        // 客户端错误：检查是否为不可重试错误
        if (await isNonRetryableClientErrorAsync(error)) {
          return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
        }
        return ErrorCategory.PROVIDER_ERROR;
      default:
        return ErrorCategory.PROVIDER_ERROR;
    }
  }

  // 优先级 3: 不可重试的客户端输入错误检测
  if (await isNonRetryableClientErrorAsync(error)) {
    return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
  }

  // 优先级 4: 空响应错误
  if (error instanceof EmptyResponseError) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 5: 其他所有错误都是系统错误
  return ErrorCategory.SYSTEM_ERROR;
}
```

**优势：**
- ✅ 向后兼容，不破坏现有 API
- ✅ 增量集成，风险可控
- ✅ 保留现有的错误分类逻辑

**劣势：**
- ⚠️ 需要在 ProxyError 中存储响应头（目前没有）
- ⚠️ ErrorLevel 和 ErrorCategory 的映射可能不完全对应

### 方案 B：渐进式迁移（安全）

在现有系统旁边运行新分类器，对比结果：

```typescript
// src/app/v1/_lib/proxy/errors.ts

export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  const oldCategory = await categorizeErrorAsyncOld(error);

  // 实验性：同时运行新分类器
  if (error instanceof ProxyError) {
    const headers = new Headers();
    const body = error.upstreamError?.body || null;
    const newClassification = classifyHTTPResponse(error.statusCode, headers, body);
    
    // 记录差异（用于调试和验证）
    if (shouldLogClassificationDifference(oldCategory, newClassification.level)) {
      logger.debug("[ErrorClassifier] Classification difference detected", {
        oldCategory,
        newLevel: newClassification.level,
        statusCode: error.statusCode,
        reason: newClassification.reason,
      });
    }
  }

  return oldCategory; // 暂时使用旧分类器
}
```

**优势：**
- ✅ 零风险，不影响现有功能
- ✅ 可以收集数据，验证新分类器的准确性
- ✅ 可以逐步切换（通过 feature flag）

**劣势：**
- ⚠️ 需要维护两套代码
- ⚠️ 迁移周期较长

### 方案 C：完全重写（激进）

替换整个 `categorizeErrorAsync` 函数：

```typescript
// src/app/v1/_lib/proxy/errors.ts

export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  // 优先级 1: 客户端中断检测
  if (isClientAbortError(error)) {
    return ErrorCategory.CLIENT_ABORT;
  }

  // 优先级 2: Native transport errors
  if (isTransportError(error)) {
    return ErrorCategory.SYSTEM_ERROR;
  }

  // 优先级 3: ProxyError → 使用新分类器
  if (error instanceof ProxyError) {
    const headers = new Headers(); // 需要从 ProxyError 提取
    const body = error.upstreamError?.body || null;
    const classification = classifyHTTPResponse(error.statusCode, headers, body);

    return mapErrorLevelToCategory(classification, error);
  }

  // 优先级 4: 不可重试的客户端输入错误
  if (await isNonRetryableClientErrorAsync(error)) {
    return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
  }

  // 优先级 5: 空响应错误
  if (error instanceof EmptyResponseError) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 6: 默认系统错误
  return ErrorCategory.SYSTEM_ERROR;
}

function mapErrorLevelToCategory(
  classification: HTTPResponseClassification,
  error: ProxyError
): ErrorCategory {
  // TODO: 实现映射逻辑
}
```

**优势：**
- ✅ 充分利用新分类器的所有功能
- ✅ 代码更简洁，易于维护

**劣势：**
- ❌ 高风险，可能破坏现有功能
- ❌ 需要大量测试验证

## 🎯 推荐方案：方案 A（增强现有系统）

### 第一步：扩展 ProxyError 存储响应头

```typescript
// src/app/v1/_lib/proxy/errors.ts

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamError?: {
      body: string;
      parsed?: unknown;
      providerId?: number;
      providerName?: string;
      requestId?: string;
      rawBody?: string;
      rawBodyTruncated?: boolean;
      statusCodeInferred?: boolean;
      statusCodeInferenceMatcherId?: string;
      safeClientMessageCandidate?: string;
      // 新增：响应头
      headers?: Record<string, string>; // ✨ 新增字段
    },
    isLocalAbort: boolean = false
  ) {
    super(message);
    this.name = "ProxyError";
    this.isLocalAbort = isLocalAbort;
  }

  static async fromUpstreamResponse(
    response: Response,
    provider: { id: number; name: string }
  ): Promise<ProxyError> {
    // ... 现有逻辑 ...

    // ✨ 提取响应头
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return new ProxyError(message, response.status, {
      body: truncatedBody,
      parsed,
      providerId: provider.id,
      providerName: provider.name,
      requestId,
      headers, // ✨ 保存响应头
    });
  }
}
```

### 第二步：集成新分类器

```typescript
// src/app/v1/_lib/proxy/errors.ts

import {
  classifyHTTPResponse,
  ErrorLevel,
  parseResetTimeFromResponse,
  type HTTPResponseClassification,
} from "./error-classifier";

export async function categorizeErrorAsync(error: Error): Promise<ErrorCategory> {
  // 优先级 1: 客户端中断检测
  if (isClientAbortError(error)) {
    return ErrorCategory.CLIENT_ABORT;
  }

  // 优先级 1.5: Native transport errors
  if (isTransportError(error)) {
    return ErrorCategory.SYSTEM_ERROR;
  }

  // 优先级 2: ProxyError → 使用新智能分类器
  if (error instanceof ProxyError) {
    // 构建 Headers 对象
    const headers = new Headers();
    if (error.upstreamError?.headers) {
      for (const [key, value] of Object.entries(error.upstreamError.headers)) {
        headers.set(key, value);
      }
    }

    const body = error.upstreamError?.body || null;

    // 调用新分类器
    const classification = classifyHTTPResponse(error.statusCode, headers, body);

    // ✨ 可选：解析精确重置时间（用于冷却）
    const resetAt = parseResetTimeFromResponse(body);
    if (resetAt) {
      logger.debug("[ErrorClassifier] Precise reset time detected", {
        providerId: error.upstreamError?.providerId,
        resetAt,
        reason: classification.reason,
      });
      // TODO: 将 resetAt 存储到 Provider 冷却系统中
    }

    // 映射 ErrorLevel → ErrorCategory
    return mapErrorLevelToCategory(classification, error);
  }

  // 优先级 3: 不可重试的客户端输入错误
  if (await isNonRetryableClientErrorAsync(error)) {
    return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;
  }

  // 优先级 4: 空响应错误
  if (error instanceof EmptyResponseError) {
    return ErrorCategory.PROVIDER_ERROR;
  }

  // 优先级 5: 默认系统错误
  return ErrorCategory.SYSTEM_ERROR;
}

/**
 * 映射 ErrorLevel → ErrorCategory
 */
function mapErrorLevelToCategory(
  classification: HTTPResponseClassification,
  error: ProxyError
): ErrorCategory {
  switch (classification.level) {
    case ErrorLevel.Channel:
      // Channel 级错误 → PROVIDER_ERROR（触发重试和故障转移）
      return ErrorCategory.PROVIDER_ERROR;

    case ErrorLevel.Key:
      // Key 级错误需要进一步区分
      if (error.statusCode === 404) {
        return ErrorCategory.RESOURCE_NOT_FOUND;
      }
      // 其他 Key 级错误 → PROVIDER_ERROR
      return ErrorCategory.PROVIDER_ERROR;

    case ErrorLevel.Client:
      // Client 级错误 → 直接返回给客户端，不重试
      return ErrorCategory.NON_RETRYABLE_CLIENT_ERROR;

    default:
      return ErrorCategory.PROVIDER_ERROR;
  }
}
```

### 第三步：集成冷却系统（可选）

```typescript
// src/app/v1/_lib/proxy/circuit-breaker.ts (假设这是熔断器文件)

import {
  classifyHTTPResponse,
  generateCooldownAdvice,
  parseResetTimeFromResponse,
} from "./error-classifier";

export async function handleProviderError(
  error: ProxyError,
  provider: Provider
): Promise<void> {
  // 构建 Headers
  const headers = new Headers();
  if (error.upstreamError?.headers) {
    for (const [key, value] of Object.entries(error.upstreamError.headers)) {
      headers.set(key, value);
    }
  }

  const body = error.upstreamError?.body || null;

  // 分类错误
  const classification = classifyHTTPResponse(error.statusCode, headers, body);

  // 生成冷却建议
  const advice = generateCooldownAdvice(classification, provider);

  if (advice) {
    logger.info("[CircuitBreaker] Cooling down provider", {
      providerId: provider.id,
      providerName: provider.name,
      cooldownSeconds: advice.cooldownSeconds,
      cooldownUntil: advice.cooldownUntil,
      reason: advice.reason,
    });

    // TODO: 将 Provider 加入冷却列表
    // await cooldownProvider(provider.id, advice.cooldownUntil);
  }
}
```

## 📊 数据结构对比

### ccLoad 的 ErrorLevel

```typescript
enum ErrorLevel {
  None = "none",        // 无错误（2xx）
  Key = "key",          // Key 级错误（冷却当前 Key）
  Channel = "channel",  // Channel 级错误（冷却整个 Provider）
  Client = "client",    // 客户端错误（不冷却）
}
```

### CCH 的 ErrorCategory

```typescript
enum ErrorCategory {
  PROVIDER_ERROR,                  // 供应商问题 → 计入熔断器 + 直接切换
  SYSTEM_ERROR,                    // 系统/网络问题 → 不计入熔断器 + 先重试1次
  CLIENT_ABORT,                    // 客户端主动中断 → 不计入熔断器 + 不重试
  NON_RETRYABLE_CLIENT_ERROR,     // 客户端输入错误 → 不计入熔断器 + 不重试
  RESOURCE_NOT_FOUND,             // 404 错误 → 不计入熔断器 + 直接切换
}
```

### 映射关系

| ErrorLevel | ErrorCategory | 说明 |
|------------|---------------|------|
| `Channel` | `PROVIDER_ERROR` | Provider 级错误，触发重试和故障转移 |
| `Key` | `PROVIDER_ERROR` 或 `RESOURCE_NOT_FOUND` | 需要根据状态码细分（404 → RESOURCE_NOT_FOUND） |
| `Client` | `NON_RETRYABLE_CLIENT_ERROR` | 客户端错误，不重试 |

## 🚀 下一步行动计划

### 立即可做（低风险）

1. ✅ **运行测试** - 验证新分类器的正确性
   ```bash
   npm test tests/unit/proxy/error-classifier.test.ts
   ```

2. ✅ **扩展 ProxyError** - 添加 `headers` 字段（第一步）

3. ✅ **集成新分类器** - 在 `categorizeErrorAsync` 中使用（第二步）

### 中期目标（需要测试）

4. ⏳ **集成冷却系统** - 将精确重置时间应用到 Provider 冷却
   - 在 circuit-breaker 或 provider-selector 中使用 `generateCooldownAdvice()`

5. ⏳ **A/B 测试** - 对比新旧分类器的准确性
   - 记录分类差异
   - 分析误判率

### 长期优化（可选）

6. 🔮 **假 200 检测** - 实现 HTTP 200 但响应体是错误的检测
   - 参考 `upstream-error-detection.ts` 的逻辑
   - 集成到 `classifyHTTPResponse()` 的优先级 1

7. 🔮 **Provider 冷却持久化** - 将冷却状态存储到数据库
   - 避免重启后丢失冷却信息

8. 🔮 **冷却策略优化** - 根据历史数据动态调整冷却时间
   - 频繁失败的 Provider → 更长冷却时间
   - 偶尔失败的 Provider → 更短冷却时间

## 📝 注意事项

### 兼容性

- ✅ 新分类器完全独立，不影响现有代码
- ✅ 可以逐步集成，风险可控
- ⚠️ 需要扩展 ProxyError 数据结构（添加 headers 字段）

### 性能

- ✅ 表驱动设计，O(1) 查找
- ✅ 智能分析仅在必要时执行（429/401/403）
- ✅ 无额外网络请求

### 测试覆盖

- ✅ 39 个单元测试覆盖所有核心功能
- ⏳ 需要集成测试验证与现有系统的兼容性
- ⏳ 需要端到端测试验证实际场景

## 🎓 ccLoad 的核心设计理念

1. **状态码优先**：HTTP 状态码的语义是最可靠的错误分类依据
2. **表驱动配置**：使用 Map 统一管理状态码元数据，易于扩展
3. **智能语义分析**：对特殊状态码（429/401/403）进行上下文分析
4. **精确冷却时间**：从响应体解析重置时间，避免过度冷却或冷却不足
5. **三级分类**：Key 级、Channel 级、Client 级，对应不同的重试策略

## 📚 参考资料

- ccLoad 源码：`/v1/models` 上游模型列表为空的问题 (FIX_PLAN.md)
- HTTP 状态码规范：https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
- Anthropic API 错误码：https://docs.anthropic.com/claude/reference/errors

---

**移植完成度：60%**
- ✅ 核心分类器实现
- ✅ 测试用例编写
- ⏳ 集成到现有系统
- ⏳ 冷却系统集成
- ⏳ 生产环境验证
