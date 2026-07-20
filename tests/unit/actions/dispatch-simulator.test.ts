import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  recordProviderApiKeyFailure,
  resetProviderKeyDispatchState,
} from "@/lib/provider-key-dispatch";
import {
  recordSmartProviderFailure,
  recordSmartProviderSuccess,
  resetSmartDispatchState,
} from "@/lib/smart-dispatch";
import type { Provider } from "@/types/provider";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
  tryAcquireProviderCircuitPermit: vi.fn(async () => ({ allowed: true, permitToken: null })),
}));

const vendorCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));

const rateLimitMocks = vi.hoisted(() => ({
  checkCostLimits: vi.fn(async () => ({ allowed: true })),
  checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
  checkTotalCostLimit: vi.fn(async () => ({ allowed: true })),
}));

const endpointSelectorMocks = vi.hoisted(() => ({
  getEndpointFilterStats: vi.fn(async () => ({
    total: 2,
    enabled: 2,
    circuitOpen: 0,
    available: 2,
  })),
}));

const timezoneMocks = vi.hoisted(() => ({
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));

const repositoryMocks = vi.hoisted(() => ({
  findAllProvidersFresh: vi.fn(async () => []),
}));

const providerGroupMocks = vi.hoisted(() => ({
  getGroupBillingPolicy: vi.fn(async () => ({
    groupName: "alpha",
    costMultiplier: 1.5,
    maxUpstreamMultiplier: null,
  })),
}));

vi.mock("@/lib/auth", () => authMocks);
vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);
vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorCircuitMocks);
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  getAllEndpointHealthStatusAsync: vi.fn(async () => ({})),
}));
vi.mock("@/lib/provider-endpoints/endpoint-selector", () => endpointSelectorMocks);
vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: rateLimitMocks,
}));
vi.mock("@/lib/utils/timezone", () => timezoneMocks);
vi.mock("@/repository/provider", () => repositoryMocks);
vi.mock("@/repository/provider-groups", () => providerGroupMocks);

function createProvider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider-${id}`,
    url: `https://provider-${id}.example.com`,
    key: `sk-${id}`,
    providerVendorId: id,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: "alpha",
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
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerOpenDuration: 60_000,
    circuitBreakerHalfOpenSuccessThreshold: 1,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 60_000,
    requestTimeoutNonStreamingMs: 120_000,
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Provider;
}

describe("dispatch simulator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetProviderKeyDispatchState();
    resetSmartDispatchState();
    endpointSelectorMocks.getEndpointFilterStats.mockResolvedValue({
      total: 2,
      enabled: 2,
      circuitOpen: 0,
      available: 2,
    });
    providerGroupMocks.getGroupBillingPolicy.mockResolvedValue({
      groupName: "alpha",
      costMultiplier: 1.5,
      maxUpstreamMultiplier: null,
    });
  });

  test("simulates the decision chain and priority tiers end-to-end", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    rateLimitMocks.checkCostLimits.mockImplementation(async (entityId: number) =>
      entityId === 3
        ? { allowed: false, reason: "Provider daily cost limit reached" }
        : { allowed: true }
    );

    const providers: Provider[] = [
      createProvider(1, { name: "group-miss", groupTag: "beta" }),
      createProvider(2, { name: "format-miss", providerType: "openai-compatible" }),
      createProvider(3, {
        name: "rate-limited",
        priority: 1,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
      }),
      createProvider(4, {
        name: "winner",
        priority: 0,
        weight: 3,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
        modelRedirects: [{ matchType: "prefix", source: "claude-opus-", target: "glm-4.6" }],
      }),
      createProvider(5, {
        name: "backup",
        priority: 2,
        weight: 1,
        allowedModels: [{ matchType: "prefix", pattern: "claude-" }],
        providerVendorId: null,
      }),
    ];

    const result = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps.map((step) => step.stepName)).toEqual([
      "groupFilter",
      "formatCompatibility",
      "enabledCheck",
      "activeTime",
      "modelAllowlist",
      "healthAndLimits",
      "priorityTiers",
      "modelRedirect",
      "endpointSummary",
    ]);

    expect(result.steps[0].outputCount).toBe(4);
    expect(result.steps[1].outputCount).toBe(3);
    expect(result.steps[5].outputCount).toBe(2);
    expect(result.steps[7].outputCount).toBe(1);
    expect(result.steps[8].outputCount).toBe(1);
    expect(result.priorityTiers).toHaveLength(2);
    expect(result.selectedPriority).toBe(0);
    expect(result.finalCandidateCount).toBe(1);
    expect(result.priorityTiers[0].providers[0].name).toBe("winner");
    expect(
      result.steps[7].surviving.find((provider) => provider.name === "winner")?.redirectedModel
    ).toBe("glm-4.6");
    expect(
      result.steps[8].surviving.find((provider) => provider.name === "winner")?.endpointStats
    ).toEqual({
      total: 2,
      enabled: 2,
      circuitOpen: 0,
      available: 2,
    });
  });

  test("按当前可用 Key 数展示 Provider 的实际调度权重", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");
    const key = (id: number, providerId: number) => ({
      id,
      providerId,
      key: `key-${id}`,
      label: null,
      isEnabled: true,
      sortOrder: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const providers = [
      createProvider(21, {
        keyStrategy: "sequential",
        apiKeys: [key(211, 21), key(212, 21), key(213, 21)],
      }),
      createProvider(22, {
        keyStrategy: "sequential",
        apiKeys: [key(221, 22)],
      }),
    ];

    const result = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.priorityTiers[0].providers).toEqual([
      expect.objectContaining({
        id: 21,
        readyKeyCount: 3,
        effectiveWeight: 3,
        weightPercent: 75,
      }),
      expect.objectContaining({
        id: 22,
        readyKeyCount: 1,
        effectiveWeight: 1,
        weightPercent: 25,
      }),
    ]);
  });

  test("排除冷却候选，并在全池冷却时只展示最早恢复的 Provider", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");
    const key = (id: number, providerId: number) => ({
      id,
      providerId,
      key: `key-${id}`,
      label: null,
      isEnabled: true,
      sortOrder: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const providers = [
      createProvider(31, {
        keyStrategy: "sequential",
        apiKeys: [key(311, 31)],
      }),
      createProvider(32, {
        keyStrategy: "sequential",
        apiKeys: [key(321, 32)],
      }),
    ];
    const now = Date.now();
    recordProviderApiKeyFailure(311, now + 120_000);

    const oneReady = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );
    expect(oneReady.priorityTiers[0].providers.map((provider) => provider.id)).toEqual([32]);

    recordProviderApiKeyFailure(321, now + 30_000);
    const earliestKeyRecovery = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );
    expect(earliestKeyRecovery.priorityTiers[0].providers.map((provider) => provider.id)).toEqual([
      32,
    ]);

    recordSmartProviderFailure(32, now + 180_000);
    const earliestCombinedRecovery = await simulateDispatchDecisionTree(
      providers,
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );
    expect(
      earliestCombinedRecovery.priorityTiers[0].providers.map((provider) => provider.id)
    ).toEqual([31]);
  });

  test("按运行时健康分数划分候选层，而不是只看基础优先级", async () => {
    vi.stubEnv("SMART_DISPATCH_HEALTH_SCORE_ENABLED", "true");
    vi.stubEnv("SMART_DISPATCH_MIN_CONFIDENT_SAMPLE", "1");
    vi.stubEnv("SMART_DISPATCH_SUCCESS_RATE_PENALTY_WEIGHT", "1");
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");
    const degraded = createProvider(41);
    const healthy = createProvider(42);
    recordSmartProviderFailure(degraded.id);
    recordSmartProviderSuccess(degraded.id);
    recordSmartProviderSuccess(healthy.id);

    const result = await simulateDispatchDecisionTree(
      [degraded, healthy],
      {
        clientFormat: "claude",
        modelName: "claude-opus-4-1",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.priorityTiers[0].providers.map((provider) => provider.id)).toEqual([42]);
    expect(result.priorityTiers[0].isSelected).toBe(true);
    expect(result.priorityTiers[1].providers.map((provider) => provider.id)).toEqual([41]);
    expect(result.priorityTiers[1].isSelected).toBe(false);
    expect(result.finalCandidateCount).toBe(1);
  });

  test("skips model allowlist filtering for resource-style requests without model", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      [
        createProvider(10, {
          groupTag: "default",
          providerType: "openai-compatible",
          allowedModels: [{ matchType: "exact", pattern: "guarded-model" }],
        }),
      ],
      {
        clientFormat: "openai",
        modelName: "",
        groupTags: [],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps[0].stepName).toBe("groupFilter");
    expect(result.steps[0].outputCount).toBe(1);
    expect(result.steps[4].stepName).toBe("modelAllowlist");
    expect(result.steps[4].note).toBe("model_filter_skipped_for_resource_request");
    expect(result.steps[4].outputCount).toBe(1);
  });

  test("accepts gemini-cli format and keeps gemini-cli providers eligible", async () => {
    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");

    const result = await simulateDispatchDecisionTree(
      [
        createProvider(20, {
          groupTag: "default",
          providerType: "gemini-cli",
          allowedModels: [{ matchType: "exact", pattern: "gemini-2.5-pro" }],
        }),
      ],
      {
        clientFormat: "gemini-cli",
        modelName: "",
        groupTags: [],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps[0].stepName).toBe("groupFilter");
    expect(result.steps[0].outputCount).toBe(1);
    expect(result.steps[1].stepName).toBe("formatCompatibility");
    expect(result.steps[1].outputCount).toBe(1);
    expect(result.finalCandidateCount).toBe(1);
  });

  test("filters providers that reach the configured group upstream limit", async () => {
    providerGroupMocks.getGroupBillingPolicy.mockResolvedValueOnce({
      groupName: "alpha",
      costMultiplier: 1.5,
      maxUpstreamMultiplier: 1.2,
    });

    const { simulateDispatchDecisionTree } = await import("@/actions/dispatch-simulator");
    const result = await simulateDispatchDecisionTree(
      [createProvider(30, { costMultiplier: 1.2 }), createProvider(31, { costMultiplier: 1.19 })],
      {
        clientFormat: "claude",
        modelName: "",
        groupTags: ["alpha"],
      },
      { systemTimezone: "UTC" }
    );

    expect(result.steps[2].stepName).toBe("enabledCheck");
    expect(result.steps[2].outputCount).toBe(1);
    expect(result.steps[2].filteredOut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 30,
          details: "group_cost_multiplier_exceeded",
        }),
      ])
    );
  });

  test("server action rejects non-admin callers", async () => {
    const { simulateDispatchAction } = await import("@/actions/dispatch-simulator");

    authMocks.getSession.mockResolvedValue(null);

    const result = await simulateDispatchAction({
      clientFormat: "claude",
      modelName: "claude-opus-4-1",
      groupTags: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PERMISSION_DENIED");
  });
});
