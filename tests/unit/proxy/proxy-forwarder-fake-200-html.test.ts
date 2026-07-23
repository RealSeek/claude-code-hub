import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";

const mocks = vi.hoisted(() => {
  return {
    pickRandomProviderWithExclusion: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(async () => {}),
    getCircuitState: vi.fn(() => "closed"),
    getProviderHealthInfo: vi.fn(async () => ({
      health: { failureCount: 0 },
      config: { failureThreshold: 3 },
    })),
    updateMessageRequestDetails: vi.fn(async () => {}),
    isHttp2Enabled: vi.fn(async () => false),
    getPreferredProviderEndpoints: vi.fn(async () => []),
    getEndpointFilterStats: vi.fn(async () => null),
    recordEndpointSuccess: vi.fn(async () => {}),
    recordEndpointFailure: vi.fn(async () => {}),
    isVendorTypeCircuitOpen: vi.fn(async () => false),
    recordVendorTypeAllEndpointsTimeout: vi.fn(async () => {}),
    // ErrorCategory.PROVIDER_ERROR
    categorizeErrorAsync: vi.fn(async () => 0),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: mocks.getPreferredProviderEndpoints,
  getEndpointFilterStats: mocks.getEndpointFilterStats,
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: mocks.recordEndpointSuccess,
  recordEndpointFailure: mocks.recordEndpointFailure,
}));

vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: mocks.getCircuitState,
  getProviderHealthInfo: mocks.getProviderHealthInfo,
  recordFailure: mocks.recordFailure,
  recordSuccess: mocks.recordSuccess,
  tryAcquireProviderCircuitPermit: vi.fn(async () => ({ allowed: true, permitToken: null })),
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: mocks.isVendorTypeCircuitOpen,
  recordVendorTypeAllEndpointsTimeout: mocks.recordVendorTypeAllEndpointsTimeout,
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: {
    pickRandomProviderWithExclusion: mocks.pickRandomProviderWithExclusion,
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
  };
});

import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "p1",
    url: "https://provider.example.com",
    key: "k",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 10_000,
    requestTimeoutNonStreamingMs: 1_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createSession(): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://example.com/v1/messages"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "claude-test",
      log: "(test)",
      message: {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    endpointPolicy: resolveEndpointPolicy("/v1/messages"),
    isHeaderModified: () => false,
  });

  return session as ProxySession;
}

function createChunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );
}

describe("ProxyForwarder - fake 200 HTML body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("200 + text/html 的 HTML 页面应视为失败并切换供应商", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const htmlBody = [
      "<!doctype html>",
      "<html><head><title>New API</title></head>",
      "<body>blocked</body></html>",
    ].join("\n");
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(htmlBody, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(htmlBody.length),
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls[0][1].id).toBe(1);
    expect(doForward.mock.calls[1][1].id).toBe(2);

    expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "FAKE_200_HTML_BODY" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );
    const failure1 = mocks.recordFailure.mock.calls[0]?.[1];
    expect(failure1).toBeInstanceOf(ProxyError);
    expect((failure1 as ProxyError).getClientSafeMessage()).toContain("HTML document");
    expect((failure1 as ProxyError).getClientSafeMessage()).toContain("Upstream detail:");
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
  });

  test("200 + text/html 但 body 是 JSON error 也应视为失败并切换供应商", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const jsonErrorBody = JSON.stringify({ error: "upstream blocked" });
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(jsonErrorBody, {
        status: 200,
        headers: {
          // 故意使用 text/html：模拟部分上游 Content-Type 错配但 body 仍为错误 JSON 的情况
          "content-type": "text/html; charset=utf-8",
          "content-length": String(jsonErrorBody.length),
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls[0][1].id).toBe(1);
    expect(doForward.mock.calls[1][1].id).toBe(2);

    expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "FAKE_200_JSON_ERROR_NON_EMPTY" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );
    const failure2 = mocks.recordFailure.mock.calls[0]?.[1];
    expect(failure2).toBeInstanceOf(ProxyError);
    expect((failure2 as ProxyError).getClientSafeMessage()).toContain("JSON body");
    expect((failure2 as ProxyError).getClientSafeMessage()).toContain("`error`");
    expect((failure2 as ProxyError).getClientSafeMessage()).toContain("upstream blocked");
    expect((failure2 as ProxyError).upstreamError?.rawBody).toBe(jsonErrorBody);
    expect((failure2 as ProxyError).upstreamError?.rawBodyTruncated).toBe(false);
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
  });

  test("200 + application/json 且有 Content-Length 的 JSON error 也应视为失败并切换供应商", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const jsonErrorBody = JSON.stringify({ error: "upstream blocked" });
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(jsonErrorBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(jsonErrorBody.length),
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls[0][1].id).toBe(1);
    expect(doForward.mock.calls[1][1].id).toBe(2);

    expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "FAKE_200_JSON_ERROR_NON_EMPTY" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );
    const failure3 = mocks.recordFailure.mock.calls[0]?.[1];
    expect(failure3).toBeInstanceOf(ProxyError);
    expect((failure3 as ProxyError).getClientSafeMessage()).toContain("JSON body");
    expect((failure3 as ProxyError).getClientSafeMessage()).toContain("`error`");
    expect((failure3 as ProxyError).getClientSafeMessage()).toContain("upstream blocked");
    expect((failure3 as ProxyError).upstreamError?.rawBody).toBe(jsonErrorBody);
    expect((failure3 as ProxyError).upstreamError?.rawBodyTruncated).toBe(false);
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
  });

  test("假200 JSON error 命中 rate limit 关键字时，应推断为 429 并在决策链中标记为推断", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const jsonErrorBody = JSON.stringify({ error: "Rate limit exceeded" });
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(jsonErrorBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(jsonErrorBody.length),
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "FAKE_200_JSON_ERROR_NON_EMPTY" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );

    const failure = mocks.recordFailure.mock.calls[0]?.[1];
    expect(failure).toBeInstanceOf(ProxyError);
    expect((failure as ProxyError).statusCode).toBe(429);
    expect((failure as ProxyError).upstreamError?.statusCodeInferred).toBe(true);

    const chain = session.getProviderChain();
    expect(
      chain.some(
        (item) =>
          item.id === 1 &&
          item.reason === "retry_failed" &&
          item.statusCode === 429 &&
          item.statusCodeInferred === true
      )
    ).toBe(true);
  });

  test("SSE 首事件为跨 chunk 的 fake-200 限流错误时，应在提交响应前重试", async () => {
    const provider = createProvider({
      id: 1,
      name: "p1",
      key: "k1",
      maxRetryAttempts: 2,
      firstByteTimeoutStreamingMs: 0,
    });
    const session = createSession();
    session.request.message.stream = true;
    session.setProvider(provider);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");
    doForward.mockResolvedValueOnce(
      createChunkedSseResponse([
        ": keep-alive\n\n",
        'data: {"error":{"message":"Upstream rate ',
        'limit exceeded, please retry later"}}\n\n',
      ])
    );
    const successfulBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"ok"}}\n\n';
    doForward.mockResolvedValueOnce(createChunkedSseResponse([successfulBody]));

    const response = await ProxyForwarder.send(session);

    expect(await response.text()).toBe(successfulBody);
    expect(doForward).toHaveBeenCalledTimes(2);
    expect(mocks.pickRandomProviderWithExclusion).not.toHaveBeenCalled();
    const retryFailure = session
      .getProviderChain()
      .find((item) => item.reason === "retry_failed");
    expect(retryFailure).toMatchObject({
      id: 1,
      statusCode: 429,
      statusCodeInferred: true,
      attemptNumber: 1,
    });
  });

  test("SSE 首事件正常时，后续同一 chunk 中的错误不得触发透明重试", async () => {
    const provider = createProvider({
      id: 1,
      name: "p1",
      key: "k1",
      maxRetryAttempts: 2,
      firstByteTimeoutStreamingMs: 0,
    });
    const session = createSession();
    session.request.message.stream = true;
    session.setProvider(provider);

    const body = [
      'event: response.created\ndata: {"type":"response.created"}\n\r\n',
      'data: {"error":{"message":"Upstream rate limit exceeded"}}\n\n',
    ].join("");
    const doForward = vi
      .spyOn(ProxyForwarder as any, "doForward")
      .mockResolvedValueOnce(createChunkedSseResponse([body]));

    const response = await ProxyForwarder.send(session);

    expect(await response.text()).toBe(body);
    expect(doForward).toHaveBeenCalledTimes(1);
    expect(session.getProviderChain().some((item) => item.reason === "retry_failed")).toBe(false);
  });

  test("SSE 首事件不完整时，应按 streaming idle timeout 失败并重试", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider({
        id: 1,
        name: "p1",
        key: "k1",
        maxRetryAttempts: 2,
        firstByteTimeoutStreamingMs: 0,
        streamingIdleTimeoutMs: 25,
      });
      const session = createSession();
      session.request.message.stream = true;
      session.setProvider(provider);

      const encoder = new TextEncoder();
      const cancel = vi.fn();
      const incompleteResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"response.created"'));
          },
          cancel,
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
      const successfulBody = 'data: {"type":"response.created"}\n\n';
      const doForward = vi.spyOn(ProxyForwarder as any, "doForward");
      doForward.mockResolvedValueOnce(incompleteResponse);
      doForward.mockResolvedValueOnce(createChunkedSseResponse([successfulBody]));

      const responsePromise = ProxyForwarder.send(session);
      await vi.runAllTimersAsync();
      const response = await responsePromise;

      expect(await response.text()).toBe(successfulBody);
      expect(doForward).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledWith("streaming_preflight_failed");
      expect(session.getProviderChain()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "retry_failed", statusCode: 524 }),
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("200 + 非法 Content-Length 时应按缺失处理，避免漏检 HTML 假200", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const htmlErrorBody = "<!doctype html><html><body>blocked</body></html>";
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(htmlErrorBody, {
        status: 200,
        headers: {
          // 故意不提供 html/json 的 Content-Type，覆盖“仅靠 body 嗅探”的假200检测分支
          "content-type": "text/plain; charset=utf-8",
          // 非法 Content-Length：parseInt("12abc") 会返回 12；修复后应视为非法并进入 body 检查分支
          "content-length": "12abc",
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls[0][1].id).toBe(1);
    expect(doForward.mock.calls[1][1].id).toBe(2);

    expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "FAKE_200_HTML_BODY" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );

    const failure = mocks.recordFailure.mock.calls[0]?.[1];
    expect(failure).toBeInstanceOf(ProxyError);
    expect((failure as ProxyError).upstreamError?.rawBody).toBe(htmlErrorBody);
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
  });

  test("缺少 content 字段（missing_content）不应被 JSON 解析 catch 吞掉，应触发切换供应商", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", key: "k1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", key: "k2", maxRetryAttempts: 1 });

    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(provider2);

    const doForward = vi.spyOn(ProxyForwarder as any, "doForward");

    const missingContentJson = JSON.stringify({ type: "message", content: [] });
    const okJson = JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] });

    doForward.mockResolvedValueOnce(
      new Response(missingContentJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          // 故意不提供 content-length：覆盖 forwarder 的 clone + JSON 内容结构检查分支
        },
      })
    );

    doForward.mockResolvedValueOnce(
      new Response(okJson, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(okJson.length),
        },
      })
    );

    const response = await ProxyForwarder.send(session);
    expect(await response.text()).toContain("ok");

    expect(doForward).toHaveBeenCalledTimes(2);
    expect(doForward.mock.calls[0][1].id).toBe(1);
    expect(doForward.mock.calls[1][1].id).toBe(2);

    expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
    expect(mocks.recordFailure).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reason: "missing_content" }),
      expect.objectContaining({ requestStartedAt: expect.any(Number) })
    );
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
  });
});

describe("ProxyError.getClientSafeMessage - FAKE_200 sanitization", () => {
  test("upstream body 包含 JWT 和 email 时应被脱敏为 [JWT] / [EMAIL]", () => {
    const jwtToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const email = "admin@example.com";
    const body = `Authentication failed for ${email} with token ${jwtToken}`;

    const error = new ProxyError("FAKE_200_JSON_ERROR_NON_EMPTY", 502, {
      body,
      providerId: 1,
      providerName: "p1",
    });

    const msg = error.getClientSafeMessage();
    expect(msg).toContain("[JWT]");
    expect(msg).toContain("[EMAIL]");
    expect(msg).not.toContain(jwtToken);
    expect(msg).not.toContain(email);
    expect(msg).toContain("Upstream detail:");
  });

  test("upstream body 包含 password=xxx 时应被脱敏", () => {
    const body = "Config error: password=s3cretValue in /etc/app.json";

    const error = new ProxyError("FAKE_200_HTML_BODY", 502, {
      body,
      providerId: 1,
      providerName: "p1",
    });

    const msg = error.getClientSafeMessage();
    expect(msg).not.toContain("s3cretValue");
    expect(msg).toContain("[PATH]");
    expect(msg).toContain("Upstream detail:");
  });
});
