import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockFindProviderById,
  mockClaimRefresh,
  mockUpdateSnapshot,
  mockProbe,
  mockPublishInvalidation,
  mockClearConfigCache,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockFindProviderById: vi.fn(),
  mockClaimRefresh: vi.fn(),
  mockUpdateSnapshot: vi.fn(),
  mockProbe: vi.fn(),
  mockPublishInvalidation: vi.fn(),
  mockClearConfigCache: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mockGetSession }));
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
  getProviderUpstreamBillingBatch,
  syncProviderCostMultiplier,
} from "@/actions/provider-upstream-billing";

const provider = {
  id: 7,
  name: "测试渠道",
  url: "https://gateway.example.com/v1",
  key: "sk-test",
  costMultiplier: 1,
  upstreamBillingType: "sub2api",
  proxyUrl: null,
  proxyFallbackToDirect: false,
  customHeaders: null,
  apiKeys: [],
  upstreamBillingAccessToken: null,
  upstreamBillingCookie: null,
  upstreamBillingUserId: null,
  upstreamBillingRefreshIntervalMinutes: 30,
  upstreamBillingSnapshot: null,
  upstreamBillingLastAttemptedAt: null,
};

const billing = {
  providerId: 7,
  source: "sub2api",
  status: "ok",
  balanceUsd: null,
  balanceRaw: null,
  balanceScope: null,
  quotaPerUnit: null,
  effectiveMultiplier: 0.75,
  observedAt: "2026-07-18T00:00:00Z",
  errorCode: null,
};

describe("provider upstream billing actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { role: "admin" } });
    mockFindProviderById.mockResolvedValue(provider);
    mockClaimRefresh.mockResolvedValue(true);
    mockUpdateSnapshot.mockResolvedValue(true);
    mockProbe.mockResolvedValue(billing);
    mockPublishInvalidation.mockResolvedValue(undefined);
  });

  it("批量查询会去重渠道编号", async () => {
    const result = await getProviderUpstreamBillingBatch([7, 7]);

    expect(result).toEqual({ ok: true, data: [billing] });
    expect(mockFindProviderById).toHaveBeenCalledTimes(1);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamBillingType: "sub2api" })
    );
  });

  it("同步倍率会写入现有 costMultiplier 并清理缓存", async () => {
    const result = await syncProviderCostMultiplier(7);

    expect(result).toMatchObject({
      ok: true,
      data: { previousMultiplier: 1, synced: true, effectiveMultiplier: 0.75 },
    });
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(7, billing, 0.75);
    expect(mockClearConfigCache).toHaveBeenCalledWith(7);
    expect(mockPublishInvalidation).toHaveBeenCalledOnce();
  });

  it("批量探测会分别请求每个启用 Key 并汇总余额", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) => ({
      ...billing,
      balanceUsd: config.keyId === 11 ? 1 : 2,
      balanceRaw: config.keyId === 11 ? 100 : 200,
      keyId: config.keyId,
      keyLabel: config.keyId === 11 ? "A" : "B",
    }));

    const result = await getProviderUpstreamBillingBatch([7]);
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          balanceUsd: 3,
          balanceRaw: 300,
          effectiveMultiplier: 0.75,
          keys: [
            { keyId: 11, balanceUsd: 1 },
            { keyId: 12, balanceUsd: 2 },
          ],
        },
      ],
    });
    expect(mockProbe).toHaveBeenCalledTimes(2);
    expect(mockProbe.mock.calls.map(([config]) => config.key)).toEqual(["key-a", "key-b"]);
  });

  it("上游没有倍率时不更新渠道", async () => {
    mockProbe.mockResolvedValue({ ...billing, effectiveMultiplier: null });

    const result = await syncProviderCostMultiplier(7);

    expect(result).toMatchObject({ ok: false });
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ effectiveMultiplier: null }),
      undefined
    );
  });

  it("New-API 使用账户级凭据一次探测全部 Key 并允许同步一致倍率", async () => {
    const newApiProvider = {
      ...provider,
      upstreamBillingType: "new-api",
      upstreamBillingCookie: "session=test-cookie",
      upstreamBillingUserId: "42",
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(newApiProvider);
    mockProbe.mockResolvedValue({
      ...billing,
      source: "new-api",
      balanceUsd: 2.5,
      balanceRaw: 1_250_000,
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    });

    const batch = await getProviderUpstreamBillingBatch([7]);
    expect(batch).toMatchObject({
      ok: true,
      data: [{ source: "new-api", balanceUsd: 2.5, effectiveMultiplier: 0.1 }],
    });
    expect(mockProbe).toHaveBeenCalledOnce();
    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: null,
        upstreamBillingCookie: "session=test-cookie",
        upstreamBillingUserId: "42",
        providerKeys: [
          expect.objectContaining({ id: 11, key: "key-a" }),
          expect.objectContaining({ id: 12, key: "key-b" }),
        ],
      })
    );

    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { role: "admin" } });
    mockFindProviderById.mockResolvedValue(newApiProvider);
    mockClaimRefresh.mockResolvedValue(true);
    mockUpdateSnapshot.mockResolvedValue(true);
    mockProbe.mockResolvedValue({
      ...billing,
      source: "new-api",
      balanceUsd: 2.5,
      balanceRaw: 1_250_000,
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    });
    mockPublishInvalidation.mockResolvedValue(undefined);
    const sync = await syncProviderCostMultiplier(7);
    expect(sync).toMatchObject({
      ok: true,
      data: { source: "new-api", effectiveMultiplier: 0.1, synced: true },
    });
    expect(mockProbe).toHaveBeenCalledOnce();
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ source: "new-api", effectiveMultiplier: 0.1 }),
      0.1
    );
  });

  it("部分 Key 探测成功时不伪造完整余额，也不允许同步倍率", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) =>
      config.keyId === 11
        ? { ...billing, keyId: 11, balanceUsd: 1, balanceRaw: 100 }
        : {
            ...billing,
            keyId: 12,
            status: "error",
            effectiveMultiplier: null,
            errorCode: "timeout",
          }
    );

    const batch = await getProviderUpstreamBillingBatch([7]);
    expect(batch).toMatchObject({
      ok: true,
      data: [
        { status: "partial", balanceUsd: null, balanceRaw: null, errorCode: "partial_key_probe" },
      ],
    });
    const sync = await syncProviderCostMultiplier(7);
    expect(sync).toMatchObject({ ok: false });
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "partial" }),
      undefined
    );
  });

  it("所有 Key 探测成功但有 Key 没有余额时不汇总余额", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) =>
      config.keyId === 11
        ? { ...billing, keyId: 11, balanceUsd: 1, balanceRaw: 100 }
        : { ...billing, keyId: 12, balanceUsd: null, balanceRaw: null }
    );

    const result = await getProviderUpstreamBillingBatch([7]);
    expect(result).toMatchObject({
      ok: true,
      data: [
        { status: "ok", balanceUsd: null, balanceRaw: null, balanceAggregation: "unavailable" },
      ],
    });
  });

  it("sub2api 余额探测失败但倍率完整时仍允许同步倍率", async () => {
    mockProbe.mockResolvedValue({
      ...billing,
      status: "partial",
      balanceUsd: null,
      balanceRaw: null,
      effectiveMultiplier: 0.75,
      errorCode: "balance_upstream_http_503",
    });

    const result = await syncProviderCostMultiplier(7);

    expect(result).toMatchObject({
      ok: true,
      data: { status: "partial", effectiveMultiplier: 0.75, synced: true },
    });
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: "partial", effectiveMultiplier: 0.75 }),
      0.75
    );
  });

  it("多 Key 的账户级余额不会被重复相加", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) => ({
      ...billing,
      keyId: config.keyId,
      balanceUsd: 20,
      balanceRaw: 20,
      balanceScope: "account",
    }));

    const result = await getProviderUpstreamBillingBatch([7]);

    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          status: "ok",
          balanceUsd: null,
          balanceRaw: null,
          balanceAggregation: "unavailable",
        },
      ],
    });
  });

  it("拒绝非管理员访问", async () => {
    mockGetSession.mockResolvedValue({ user: { role: "user" } });

    const result = await getProviderUpstreamBillingBatch([7]);

    expect(result).toEqual({ ok: false, error: "无权限执行此操作" });
    expect(mockFindProviderById).not.toHaveBeenCalled();
  });
});
