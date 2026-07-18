import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider, ProviderEndpoint } from "@/types/provider";
import {
  filterSmartCooldown,
  isSmartEndpointCooled,
  isSmartProviderCooled,
  rankSmartEndpoints,
  recordSmartEndpointFailure,
  recordSmartEndpointSuccess,
  recordSmartProviderFailure,
  recordSmartProviderSuccess,
  resetSmartDispatchState,
  selectSmartProvider,
  smartEndpointReadyAt,
  smartProviderEffectiveWeight,
  smartProviderReadyAt,
  smartProviderEffectivePriority,
  smoothWeightedOrder,
} from "@/lib/smart-dispatch";

function endpoint(id: number): ProviderEndpoint {
  return {
    id,
    vendorId: 1,
    providerType: "claude",
    url: `https://endpoint-${id}.example.com`,
    label: null,
    sortOrder: id,
    isEnabled: true,
    lastProbedAt: null,
    lastProbeOk: true,
    lastProbeStatusCode: 200,
    lastProbeLatencyMs: 100,
    lastProbeErrorType: null,
    lastProbeErrorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function provider(id: number, priority = 1, weight = 1): Provider {
  return {
    id,
    name: `p${id}`,
    url: "https://example.com",
    key: "key",
    providerVendorId: null,
    isEnabled: true,
    weight,
    priority,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    disableSessionReuse: false,
    modelRedirects: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limit5hResetMode: "rolling",
    limitDailyUsd: null,
    dailyResetMode: "rolling",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenDuration: 300000,
    circuitBreakerHalfOpenSuccessThreshold: 1,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    firstByteTimeoutStreamingMs: 30000,
    streamingIdleTimeoutMs: 30000,
    requestTimeoutNonStreamingMs: 30000,
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
    codexServiceTierPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: null,
    rpm: null,
    rpd: null,
    cc: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("smart dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSmartDispatchState();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("uses smooth weighted round robin for enabled dispatch", () => {
    const items = [provider(1, 1, 2), provider(2, 1, 1)];
    const picks = Array.from({ length: 3 }, () => smoothWeightedOrder(items, "test")[0].id);
    expect(picks).toEqual([1, 2, 1]);
  });

  it("按配置权重乘以有效 Key 数执行 Provider 平滑轮转", () => {
    const providers = [provider(1, 1, 1), provider(2, 1, 1)];
    const weights = new Map([
      [1, smartProviderEffectiveWeight(providers[0], 3)],
      [2, smartProviderEffectiveWeight(providers[1], 1)],
    ]);

    const picks = Array.from({ length: 4 }, () => selectSmartProvider(providers, null, weights).id);

    expect(picks).toEqual([1, 1, 2, 1]);
  });

  it("保留人工配置权重，并为全 Key 冷却兜底保留最小容量", () => {
    const source = provider(1, 1, 2);
    expect(smartProviderEffectiveWeight(source, 3)).toBe(6);
    expect(smartProviderEffectiveWeight(source, 0)).toBe(2);
    expect(smartProviderEffectiveWeight(source, 3, false)).toBe(2);
  });

  it("filters cooled providers and falls back to the earliest recovery", () => {
    vi.useFakeTimers();
    vi.stubEnv("SMART_DISPATCH_COOLDOWN_BASE_MS", "1000");
    vi.stubEnv("SMART_DISPATCH_COOLDOWN_MAX_MS", "8000");
    recordSmartProviderFailure(1);
    recordSmartProviderFailure(2);
    expect(filterSmartCooldown([provider(1), provider(2)])).toHaveLength(1);
    expect(isSmartProviderCooled(1)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(filterSmartCooldown([provider(1), provider(2)]).length).toBeGreaterThan(0);
  });

  it("uses the supplied priority tie-breaker when cooled providers recover together", () => {
    vi.useFakeTimers();
    recordSmartProviderFailure(1, Date.now() + 1000);
    recordSmartProviderFailure(2, Date.now() + 1000);
    const selected = filterSmartCooldown(
      [provider(1, 1), provider(2, 9)],
      Date.now(),
      (a, b) => b.priority - a.priority
    );
    expect(selected.map((item) => item.id)).toEqual([2]);
  });

  it("applies failure confidence and TTFB penalties when enabled", () => {
    vi.stubEnv("SMART_DISPATCH_HEALTH_SCORE_ENABLED", "true");
    vi.stubEnv("SMART_DISPATCH_ENABLE_TTFB_SCORE", "true");
    vi.stubEnv("SMART_DISPATCH_MIN_CONFIDENT_SAMPLE", "1");
    vi.stubEnv("SMART_DISPATCH_TTFB_MIN_CONFIDENT_SAMPLE", "1");
    recordSmartProviderFailure(1);
    recordSmartProviderSuccess(2, 100);
    recordSmartProviderSuccess(2, 100);
    recordSmartProviderSuccess(1, 500);
    const candidates = [provider(1), provider(2)];
    expect(smartProviderEffectivePriority(candidates[1], candidates)).toBeGreaterThan(
      smartProviderEffectivePriority(candidates[0], candidates)
    );
    expect(selectSmartProvider(candidates, null).id).toBe(2);
  });

  it("clears cooldown after a successful request", () => {
    recordSmartProviderFailure(1);
    expect(isSmartProviderCooled(1)).toBe(true);
    recordSmartProviderSuccess(1);
    expect(isSmartProviderCooled(1)).toBe(false);
  });

  it("honors an upstream reset deadline without shortening an existing cooldown", () => {
    vi.useFakeTimers();
    const now = Date.now();
    recordSmartProviderFailure(1, now + 10_000);
    expect(smartProviderReadyAt(1)).toBe(now + 10_000);
    recordSmartProviderFailure(1, now + 1_000);
    expect(smartProviderReadyAt(1)).toBe(now + 10_000);
  });

  it("does not let an older in-flight success clear a newer failure cooldown", () => {
    vi.useFakeTimers();
    const requestStartedAt = Date.now();
    vi.advanceTimersByTime(10);
    recordSmartProviderFailure(1);
    recordSmartProviderSuccess(1, 100, requestStartedAt);
    expect(isSmartProviderCooled(1)).toBe(true);
  });

  it("only releases the earliest endpoint when all endpoints are cooled", () => {
    vi.useFakeTimers();
    vi.stubEnv("SMART_DISPATCH_COOLDOWN_BASE_MS", "1000");
    recordSmartEndpointFailure(1);
    vi.advanceTimersByTime(100);
    recordSmartEndpointFailure(2);
    expect(rankSmartEndpoints([endpoint(1), endpoint(2)]).map((item) => item.id)).toEqual([1]);
  });

  it("clears endpoint cooldown when a successful request has no latency sample", () => {
    recordSmartEndpointFailure(1);
    expect(isSmartEndpointCooled(1)).toBe(true);
    recordSmartEndpointSuccess(1);
    expect(isSmartEndpointCooled(1)).toBe(false);
  });

  it("honors an upstream endpoint cooldown deadline instead of shortening it", () => {
    const requestedCooldownUntil = Date.now() + 120_000;
    recordSmartEndpointFailure(1, requestedCooldownUntil);
    expect(smartEndpointReadyAt(1)).toBeGreaterThanOrEqual(requestedCooldownUntil);
  });

  it("restores legacy cost and weighted selection when smart dispatch is disabled", () => {
    vi.stubEnv("SMART_DISPATCH_ENABLED", "false");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const expensive = provider(1);
    expensive.costMultiplier = 2;
    const cheap = provider(2);
    cheap.costMultiplier = 0.5;
    recordSmartProviderFailure(expensive.id);
    expect(filterSmartCooldown([expensive, cheap])).toEqual([expensive, cheap]);
    expect(selectSmartProvider([expensive, cheap], null).id).toBe(cheap.id);
  });
});
