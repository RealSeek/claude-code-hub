import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSmartDispatchState, recordSmartProviderFailure } from "@/lib/smart-dispatch";
import type { Provider } from "@/types/provider";

const circuitBreakerMocks = vi.hoisted(() => ({
  getCircuitState: vi.fn(() => "closed"),
  isCircuitOpen: vi.fn(async () => false),
  tryAcquireProviderCircuitPermit: vi.fn(async () => ({ allowed: true, permitToken: null })),
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn(async () => "UTC") }));

function provider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider-${id}`,
    url: `https://provider-${id}.example.com`,
    key: `sk-${id}`,
    keyStrategy: "round_robin",
    apiKeys: [],
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: "testing",
    providerType: "claude",
    preserveClientIp: false,
    disableSessionReuse: false,
    isPinned: false,
    modelRedirects: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    limit5hUsd: null,
    limit5hResetMode: "rolling",
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    ...overrides,
  } as unknown as Provider;
}

function session(providers: Provider[]) {
  return {
    originalFormat: "claude",
    authState: {
      key: { id: 1, providerGroup: "testing" },
      user: { id: 1, providerGroup: "testing" },
    },
    getProvidersSnapshot: async () => providers,
    getOriginalModel: () => "claude-sonnet-4-20250514",
    getCurrentModel: () => "claude-sonnet-4-20250514",
    recordProviderCircuitPermit: vi.fn(),
  } as any;
}

describe("ProxyProviderResolver pinned provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSmartDispatchState();
  });

  it("only bypasses session reuse for requests in the pinned provider's group", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const pinned = provider(2, { isPinned: true, groupTag: "other" });

    const hasPinnedCandidate = await (ProxyProviderResolver as any).hasPinnedCandidate(
      session([pinned]),
      null
    );

    expect(hasPinnedCandidate).toBe(false);
  });

  it("tries the pinned provider before smart dispatch even while it is in smart cooldown", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
      async (providers: Provider[]) => providers
    );
    const regular = provider(1, { priority: 0, weight: 100 });
    const pinned = provider(2, { priority: 99, isPinned: true });
    recordSmartProviderFailure(pinned.id);

    const result = await (ProxyProviderResolver as any).pickRandomProvider(
      session([regular, pinned]),
      []
    );

    expect(result.provider.id).toBe(pinned.id);
    expect(result.context.candidatesAtPriority.map((item: { id: number }) => item.id)).toEqual([
      pinned.id,
    ]);
  });

  it("returns to normal smart dispatch after the pinned provider is excluded by a failed attempt", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
      async (providers: Provider[]) => providers
    );
    const regular = provider(1, { priority: 0 });
    const pinned = provider(2, { priority: 99, isPinned: true });

    const result = await (ProxyProviderResolver as any).pickRandomProvider(
      session([regular, pinned]),
      [pinned.id]
    );

    expect(result.provider.id).toBe(regular.id);
  });

  it("falls back when the pinned provider fails hard availability checks", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
      async (providers: Provider[]) => providers.filter((candidate) => !candidate.isPinned)
    );
    const regular = provider(1, { priority: 0 });
    const pinned = provider(2, { priority: 99, isPinned: true });

    const result = await (ProxyProviderResolver as any).pickRandomProvider(
      session([regular, pinned]),
      []
    );

    expect(result.provider.id).toBe(regular.id);
  });
});
