import { describe, expect, it } from "vitest";
import {
  createInitialState,
  providerFormReducer,
} from "@/app/[locale]/settings/providers/_components/forms/provider-form/provider-form-context";

// ---------------------------------------------------------------------------
// createInitialState("batch")
// ---------------------------------------------------------------------------

describe("createInitialState - batch mode", () => {
  it("returns batch state with isEnabled set to no_change", () => {
    const state = createInitialState("batch");

    expect(state.batch.isEnabled).toBe("no_change");
  });

  it("returns neutral routing defaults (no provider source)", () => {
    const state = createInitialState("batch");

    expect(state.routing.priority).toBe(0);
    expect(state.routing.weight).toBe(1);
    expect(state.routing.costMultiplier).toBe(1.0);
    expect(state.routing.groupTag).toEqual([]);
    expect(state.routing.preserveClientIp).toBe(false);
    expect(state.routing.modelRedirects).toEqual([]);
    expect(state.routing.allowedModels).toEqual([]);
    expect(state.routing.cacheTtlPreference).toBe("inherit");
    expect(state.routing.swapCacheTtlBilling).toBe(false);
    expect(state.routing.anthropicAdaptiveThinking).toBeNull();
  });

  it("returns neutral rate limit defaults", () => {
    const state = createInitialState("batch");
    const rateLimit = state.rateLimit as typeof state.rateLimit & {
      limit5hResetMode?: "fixed" | "rolling";
    };

    expect(state.rateLimit.limit5hUsd).toBeNull();
    expect(rateLimit.limit5hResetMode).toBe("rolling");
    expect(state.rateLimit.limitDailyUsd).toBeNull();
    expect(state.rateLimit.dailyResetMode).toBe("fixed");
    expect(state.rateLimit.dailyResetTime).toBe("00:00");
    expect(state.rateLimit.limitWeeklyUsd).toBeNull();
    expect(state.rateLimit.limitMonthlyUsd).toBeNull();
    expect(state.rateLimit.limitTotalUsd).toBeNull();
    expect(state.rateLimit.limitConcurrentSessions).toBeNull();
  });

  it("returns neutral circuit breaker defaults", () => {
    const state = createInitialState("batch");

    expect(state.circuitBreaker.failureThreshold).toBeUndefined();
    expect(state.circuitBreaker.openDurationMinutes).toBeUndefined();
    expect(state.circuitBreaker.halfOpenSuccessThreshold).toBeUndefined();
    expect(state.circuitBreaker.maxRetryAttempts).toBeNull();
  });

  it("returns neutral network defaults", () => {
    const state = createInitialState("batch");

    expect(state.network.proxyUrl).toBe("");
    expect(state.network.proxyFallbackToDirect).toBe(false);
    expect(state.network.firstByteTimeoutStreamingSeconds).toBeUndefined();
    expect(state.network.streamingIdleTimeoutSeconds).toBeUndefined();
    expect(state.network.requestTimeoutNonStreamingSeconds).toBeUndefined();
  });

  it("returns neutral MCP defaults", () => {
    const state = createInitialState("batch");

    expect(state.mcp.mcpPassthroughType).toBe("none");
    expect(state.mcp.mcpPassthroughUrl).toBe("");
  });

  it("ignores provider and cloneProvider arguments in batch mode", () => {
    const fakeProvider = {
      id: 99,
      name: "Ignored",
      url: "https://ignored.example.com",
      maskedKey: "xxxx****xxxx",
      isEnabled: false,
      weight: 50,
      priority: 99,
      groupPriorities: null,
      costMultiplier: 3.0,
      groupTag: "prod",
      providerType: "claude" as const,
      providerVendorId: null,
      preserveClientIp: true,
      modelRedirects: null,
      allowedModels: null,
      mcpPassthroughType: "none" as const,
      mcpPassthroughUrl: null,
      limit5hUsd: null,
      limit5hResetMode: "fixed" as const,
      limitDailyUsd: null,
      dailyResetMode: "fixed" as const,
      dailyResetTime: "00:00",
      limitWeeklyUsd: null,
      limitMonthlyUsd: null,
      limitTotalUsd: null,
      limitConcurrentSessions: 10,
      maxRetryAttempts: null,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerOpenDuration: 30000,
      circuitBreakerHalfOpenSuccessThreshold: 2,
      proxyUrl: null,
      proxyFallbackToDirect: false,
      firstByteTimeoutStreamingMs: 30000,
      streamingIdleTimeoutMs: 120000,
      requestTimeoutNonStreamingMs: 120000,
      websiteUrl: null,
      faviconUrl: null,
      cacheTtlPreference: null,
      swapCacheTtlBilling: false,
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
      tpm: null,
      rpm: null,
      rpd: null,
      cc: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const state = createInitialState("batch", fakeProvider, fakeProvider);

    // Should still be batch defaults, not the provider values
    expect(state.routing.priority).toBe(0);
    expect(state.routing.weight).toBe(1);
    expect(state.routing.costMultiplier).toBe(1.0);
    expect(state.batch.isEnabled).toBe("no_change");
  });
});

describe("createInitialState - 上游账户凭据", () => {
  it("编辑时回填用户 ID 但绝不回填任何账户令牌", () => {
    const state = createInitialState("edit", {
      id: 7,
      name: "New-API",
      url: "https://gateway.example.com",
      upstreamBillingType: "new-api",
      hasUpstreamBillingAccessToken: true,
      hasUpstreamBillingRefreshToken: true,
      hasUpstreamBillingCookie: true,
      upstreamBillingUserId: "42",
    } as Parameters<typeof createInitialState>[1]);

    expect(state.basic.upstreamBillingType).toBe("new-api");
    expect(state.basic.upstreamBillingUserId).toBe("42");
    expect(state.basic.upstreamBillingAccessToken).toBe("");
    expect(state.basic.upstreamBillingRefreshToken).toBe("");
    expect(state.basic.upstreamBillingCookie).toBe("");
  });

  it("reducer 可以分别更新 sub2api 令牌、Session Cookie 和用户 ID", () => {
    const initial = createInitialState("create");
    const withAccessToken = providerFormReducer(initial, {
      type: "SET_UPSTREAM_BILLING_ACCESS_TOKEN",
      payload: "access-test",
    });
    const withRefreshToken = providerFormReducer(withAccessToken, {
      type: "SET_UPSTREAM_BILLING_REFRESH_TOKEN",
      payload: "refresh-test",
    });
    const withCookie = providerFormReducer(withRefreshToken, {
      type: "SET_UPSTREAM_BILLING_COOKIE",
      payload: "session=test-cookie",
    });
    const withUserId = providerFormReducer(withCookie, {
      type: "SET_UPSTREAM_BILLING_USER_ID",
      payload: "42",
    });

    expect(withUserId.basic.upstreamBillingAccessToken).toBe("access-test");
    expect(withUserId.basic.upstreamBillingRefreshToken).toBe("refresh-test");
    expect(withUserId.basic.upstreamBillingCookie).toBe("session=test-cookie");
    expect(withUserId.basic.upstreamBillingUserId).toBe("42");

    const cleared = providerFormReducer(withUserId, {
      type: "SET_UPSTREAM_BILLING_REFRESH_TOKEN",
      payload: null,
    });
    expect(cleared.basic.upstreamBillingRefreshToken).toBeNull();
  });

  it("主动更新间隔默认 30 分钟并可设置为 0", () => {
    const initial = createInitialState("create");
    expect(initial.basic.upstreamBillingRefreshIntervalMinutes).toBe(30);

    const disabled = providerFormReducer(initial, {
      type: "SET_UPSTREAM_BILLING_REFRESH_INTERVAL_MINUTES",
      payload: 0,
    });
    expect(disabled.basic.upstreamBillingRefreshIntervalMinutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// providerFormReducer - SET_BATCH_IS_ENABLED
// ---------------------------------------------------------------------------

describe("providerFormReducer - SET_BATCH_IS_ENABLED", () => {
  const baseState = createInitialState("batch");

  it("sets isEnabled to true", () => {
    const next = providerFormReducer(baseState, {
      type: "SET_BATCH_IS_ENABLED",
      payload: "true",
    });

    expect(next.batch.isEnabled).toBe("true");
  });

  it("sets isEnabled to false", () => {
    const next = providerFormReducer(baseState, {
      type: "SET_BATCH_IS_ENABLED",
      payload: "false",
    });

    expect(next.batch.isEnabled).toBe("false");
  });

  it("sets isEnabled back to no_change", () => {
    const modified = providerFormReducer(baseState, {
      type: "SET_BATCH_IS_ENABLED",
      payload: "true",
    });
    const reverted = providerFormReducer(modified, {
      type: "SET_BATCH_IS_ENABLED",
      payload: "no_change",
    });

    expect(reverted.batch.isEnabled).toBe("no_change");
  });

  it("does not mutate other state sections", () => {
    const next = providerFormReducer(baseState, {
      type: "SET_BATCH_IS_ENABLED",
      payload: "true",
    });

    expect(next.routing).toEqual(baseState.routing);
    expect(next.rateLimit).toEqual(baseState.rateLimit);
    expect(next.circuitBreaker).toEqual(baseState.circuitBreaker);
    expect(next.network).toEqual(baseState.network);
    expect(next.mcp).toEqual(baseState.mcp);
    expect(next.ui).toEqual(baseState.ui);
  });
});

describe("providerFormReducer - SET_LIMIT_5H_RESET_MODE", () => {
  it("stores the selected 5h reset mode", () => {
    const baseState = createInitialState("batch");

    const next = providerFormReducer(baseState, {
      type: "SET_LIMIT_5H_RESET_MODE",
      payload: "fixed",
    } as never);

    const rateLimit = next.rateLimit as typeof next.rateLimit & {
      limit5hResetMode?: "fixed" | "rolling";
    };

    expect(rateLimit.limit5hResetMode).toBe("fixed");
  });
});
