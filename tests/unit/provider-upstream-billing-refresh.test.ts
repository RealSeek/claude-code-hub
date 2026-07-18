import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindProviderById,
  mockClaimRefresh,
  mockUpdateSnapshot,
  mockProbe,
  mockPublishInvalidation,
  mockClearConfigCache,
} = vi.hoisted(() => ({
  mockFindProviderById: vi.fn(),
  mockClaimRefresh: vi.fn(),
  mockUpdateSnapshot: vi.fn(),
  mockProbe: vi.fn(),
  mockPublishInvalidation: vi.fn(),
  mockClearConfigCache: vi.fn(),
}));

vi.mock("@/repository/provider", () => ({
  claimProviderUpstreamBillingRefresh: mockClaimRefresh,
  findProviderById: mockFindProviderById,
  updateProviderUpstreamBillingSnapshot: mockUpdateSnapshot,
}));
vi.mock("@/lib/provider-upstream-billing", () => ({
  probeProviderUpstreamBilling: mockProbe,
}));
vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: mockPublishInvalidation,
}));
vi.mock("@/lib/circuit-breaker", () => ({ clearConfigCache: mockClearConfigCache }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  refreshProviderUpstreamBilling,
  REQUEST_TRIGGER_REFRESH_INTERVAL_MS,
} from "@/lib/provider-upstream-billing-service";

const provider = {
  id: 7,
  name: "测试供应商",
  url: "https://gateway.example.com/v1",
  key: "sk-test",
  apiKeys: [],
  costMultiplier: 1,
  upstreamBillingType: "sub2api",
  upstreamBillingAccessToken: null,
  upstreamBillingCookie: null,
  upstreamBillingUserId: null,
  upstreamBillingRefreshIntervalMinutes: 30,
  upstreamBillingSnapshot: null,
  upstreamBillingLastAttemptedAt: null,
  proxyUrl: null,
  proxyFallbackToDirect: false,
  customHeaders: null,
};

const billing = {
  providerId: 7,
  source: "sub2api",
  status: "ok",
  balanceUsd: 12.5,
  balanceRaw: 12.5,
  balanceScope: "key",
  quotaPerUnit: null,
  effectiveMultiplier: 0.5,
  observedAt: "2026-07-18T00:00:00Z",
  errorCode: null,
};

describe("provider upstream billing refresh service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProviderById.mockResolvedValue(provider);
    mockClaimRefresh.mockResolvedValue(true);
    mockUpdateSnapshot.mockResolvedValue(true);
    mockProbe.mockResolvedValue(billing);
    mockPublishInvalidation.mockResolvedValue(undefined);
  });

  it("请求触发使用固定十分钟门禁并在未抢到时直接复用快照", async () => {
    const snapshot = { ...billing, effectiveMultiplier: 0.75 };
    mockFindProviderById.mockResolvedValue({ ...provider, upstreamBillingSnapshot: snapshot });
    mockClaimRefresh.mockResolvedValue(false);

    const result = await refreshProviderUpstreamBilling(7, { source: "request" });

    expect(mockClaimRefresh).toHaveBeenCalledWith(7, REQUEST_TRIGGER_REFRESH_INTERVAL_MS, false);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockUpdateSnapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refreshed: false, billing: snapshot });
  });

  it("sub2api 成功时同时保存余额快照并同步可靠倍率", async () => {
    const result = await refreshProviderUpstreamBilling(7, { source: "request" });

    expect(mockUpdateSnapshot).toHaveBeenCalledWith(7, billing, 0.5);
    expect(mockClearConfigCache).toHaveBeenCalledWith(7);
    expect(mockPublishInvalidation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ refreshed: true, multiplierSynced: true });
  });

  it("New-API 返回可靠 Token 分组倍率时自动同步", async () => {
    const newApiProvider = {
      ...provider,
      costMultiplier: 0.1,
      upstreamBillingType: "new-api",
      upstreamBillingCookie: "session=test",
      upstreamBillingUserId: "70",
    };
    const newApiBilling = {
      ...billing,
      source: "new-api",
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    };
    mockFindProviderById.mockResolvedValue(newApiProvider);
    mockProbe.mockResolvedValue(newApiBilling);

    const result = await refreshProviderUpstreamBilling(7, { source: "request" });

    expect(mockUpdateSnapshot).toHaveBeenCalledWith(7, newApiBilling, undefined);
    expect(result).toMatchObject({ multiplierSynced: false, previousMultiplier: 0.1 });
  });

  it("New-API 当前倍率变化时更新本地成本倍率", async () => {
    const newApiBilling = {
      ...billing,
      source: "new-api",
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    };
    mockFindProviderById.mockResolvedValue({
      ...provider,
      upstreamBillingType: "new-api",
      costMultiplier: 1,
    });
    mockProbe.mockResolvedValue(newApiBilling);

    const result = await refreshProviderUpstreamBilling(7, { source: "request" });

    expect(mockUpdateSnapshot).toHaveBeenCalledWith(7, newApiBilling, 0.1);
    expect(mockClearConfigCache).toHaveBeenCalledWith(7);
    expect(mockPublishInvalidation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ multiplierSynced: true, previousMultiplier: 1 });
  });

  it("探测失败也保存错误快照，但不修改倍率", async () => {
    const failedBilling = {
      ...billing,
      status: "error",
      balanceUsd: null,
      balanceRaw: null,
      effectiveMultiplier: null,
      errorCode: "request_failed",
    };
    mockProbe.mockResolvedValue(failedBilling);

    await refreshProviderUpstreamBilling(7, { source: "request" });

    expect(mockUpdateSnapshot).toHaveBeenCalledWith(7, failedBilling, undefined);
    expect(mockClearConfigCache).not.toHaveBeenCalled();
  });
});
