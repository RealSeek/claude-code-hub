import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAcquireLock, mockReleaseLock, mockFindProviders, mockRefresh } = vi.hoisted(() => ({
  mockAcquireLock: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockFindProviders: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("@/lib/provider-endpoints/leader-lock", () => ({
  acquireLeaderLock: mockAcquireLock,
  releaseLeaderLock: mockReleaseLock,
  startLeaderLockKeepAlive: () => ({ stop: vi.fn() }),
}));
vi.mock("@/repository/provider", () => ({ findAllProvidersFresh: mockFindProviders }));
vi.mock("@/lib/provider-upstream-billing-service", () => ({
  mapWithConcurrency: async <T, R>(
    values: T[],
    _concurrency: number,
    fn: (value: T) => Promise<R>
  ) => Promise.all(values.map(fn)),
  refreshProviderUpstreamBilling: mockRefresh,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { runProviderUpstreamBillingRefreshCycle } from "@/lib/provider-upstream-billing-scheduler";

function makeProvider(
  id: number,
  refreshIntervalMinutes: number,
  lastAttemptedAt: Date | null,
  isEnabled = true
) {
  return {
    id,
    isEnabled,
    upstreamBillingRefreshIntervalMinutes: refreshIntervalMinutes,
    upstreamBillingLastAttemptedAt: lastAttemptedAt,
  };
}

describe("provider upstream billing scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue({ key: "test", lockId: "1", lockType: "memory" });
    mockReleaseLock.mockResolvedValue(undefined);
    mockRefresh.mockResolvedValue({ refreshed: true });
  });

  it("非 leader 不扫描供应商", async () => {
    mockAcquireLock.mockResolvedValue(null);

    await runProviderUpstreamBillingRefreshCycle();

    expect(mockFindProviders).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("只刷新启用、到期且未关闭定时兜底的供应商", async () => {
    const now = Date.now();
    mockFindProviders.mockResolvedValue([
      makeProvider(1, 30, null),
      makeProvider(2, 30, new Date(now - 31 * 60_000)),
      makeProvider(3, 30, new Date(now - 5 * 60_000)),
      makeProvider(4, 0, null),
      makeProvider(5, 30, null, false),
    ]);

    await runProviderUpstreamBillingRefreshCycle();

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ source: "scheduled", minimumIntervalMs: 1_800_000 })
    );
    expect(mockRefresh).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ source: "scheduled", minimumIntervalMs: 1_800_000 })
    );
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });
});
