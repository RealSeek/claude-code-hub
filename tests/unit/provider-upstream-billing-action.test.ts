import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockFindProviderById,
  mockClaimRefresh,
  mockUpdateSnapshot,
  mockUpdateTokens,
  mockProbe,
  mockPublishInvalidation,
  mockClearConfigCache,
  mockDisableAtLimit,
  mockGetGroupBillingPolicy,
  mockEmitActionAudit,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockFindProviderById: vi.fn(),
  mockClaimRefresh: vi.fn(),
  mockUpdateSnapshot: vi.fn(),
  mockUpdateTokens: vi.fn(),
  mockProbe: vi.fn(),
  mockPublishInvalidation: vi.fn(),
  mockClearConfigCache: vi.fn(),
  mockDisableAtLimit: vi.fn(),
  mockGetGroupBillingPolicy: vi.fn(),
  mockEmitActionAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mockGetSession }));
vi.mock("@/repository/provider", () => ({
  claimProviderUpstreamBillingRefresh: mockClaimRefresh,
  findProviderById: mockFindProviderById,
  updateProviderUpstreamBillingSnapshot: mockUpdateSnapshot,
  updateProviderUpstreamBillingTokens: mockUpdateTokens,
  disableProviderAtUpstreamMultiplierLimit: mockDisableAtLimit,
}));
vi.mock("@/repository/provider-groups", () => ({
  getGroupBillingPolicy: mockGetGroupBillingPolicy,
}));
vi.mock("@/lib/provider-upstream-billing", () => ({
  probeProviderUpstreamBilling: mockProbe,
}));
vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: mockPublishInvalidation,
}));
vi.mock("@/lib/circuit-breaker", () => ({ clearConfigCache: mockClearConfigCache }));
vi.mock("@/lib/audit/emit", () => ({ emitActionAudit: mockEmitActionAudit }));
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
  upstreamBillingRefreshToken: null,
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
    mockUpdateTokens.mockResolvedValue(true);
    mockProbe.mockResolvedValue(billing);
    mockPublishInvalidation.mockResolvedValue(undefined);
    mockDisableAtLimit.mockResolvedValue(false);
    mockGetGroupBillingPolicy.mockResolvedValue({
      groupName: "default",
      costMultiplier: 1,
      maxUpstreamMultiplier: null,
    });
  });

  it("批量查询会去重渠道编号", async () => {
    const result = await getProviderUpstreamBillingBatch([7, 7]);

    expect(result).toMatchObject({
      ok: true,
      data: [{ ...billing, balanceAggregation: "unavailable", successfulKeyCount: 1 }],
    });
    expect(mockFindProviderById).toHaveBeenCalledTimes(1);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamBillingType: "sub2api" })
    );
  });

  it("已有余额快照时仍会重新探测并返回新结果", async () => {
    mockFindProviderById.mockResolvedValue({
      ...provider,
      upstreamBillingSnapshot: { ...billing, balanceUsd: 1 },
    });
    mockProbe.mockResolvedValue({ ...billing, balanceUsd: 9 });

    const result = await getProviderUpstreamBillingBatch([7]);

    expect(result).toMatchObject({ ok: true, data: [{ balanceUsd: 9 }] });
    expect(mockProbe).toHaveBeenCalledOnce();
  });

  it("同步倍率会写入现有 costMultiplier 并清理缓存", async () => {
    const result = await syncProviderCostMultiplier(7);

    expect(result).toMatchObject({
      ok: true,
      data: { previousMultiplier: 1, synced: true, effectiveMultiplier: 0.75 },
    });
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        ...billing,
        balanceAggregation: "unavailable",
        successfulKeyCount: 1,
      }),
      0.75
    );
    expect(mockClearConfigCache).toHaveBeenCalledWith(7);
    expect(mockPublishInvalidation).toHaveBeenCalledOnce();
  });

  it("sub2api 轮换令牌通过独立仓库路径持久化", async () => {
    mockProbe.mockImplementation(
      async (config: {
        persistSub2ApiTokens?: (accessToken: string, refreshToken: string) => Promise<void>;
      }) => {
        await config.persistSub2ApiTokens?.("access-new", "refresh-new");
        return billing;
      }
    );

    const result = await getProviderUpstreamBillingBatch([7]);

    expect(result).toMatchObject({ ok: true, data: [billing] });
    expect(mockUpdateTokens).toHaveBeenCalledWith(7, "access-new", "refresh-new");
    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      7,
      expect.not.objectContaining({
        upstreamBillingAccessToken: expect.anything(),
        upstreamBillingRefreshToken: expect.anything(),
      }),
      0.75
    );
  });

  it("Sub2API 多 Key 供应商会探测全部启用 Key 并汇总余额", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 10 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 0 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) => ({
      ...billing,
      balanceUsd: 2,
      balanceRaw: 200,
      keyId: config.keyId,
      keyLabel: "B",
    }));

    const result = await getProviderUpstreamBillingBatch([7]);
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          balanceUsd: 4,
          balanceRaw: 400,
          effectiveMultiplier: 0.75,
          balanceAggregation: "sum_of_keys",
          keys: [
            { keyId: 12, balanceUsd: 2 },
            { keyId: 11, balanceUsd: 2 },
          ],
        },
      ],
    });
    expect(mockProbe).toHaveBeenCalledTimes(2);
    expect(mockProbe).toHaveBeenCalledWith(expect.objectContaining({ key: "key-b", keyId: 12 }));
    expect(mockProbe).toHaveBeenCalledWith(expect.objectContaining({ key: "key-a", keyId: 11 }));
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

  it("New-API 使用账户级凭据并在单次探测中解析全部 Key 的倍率", async () => {
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
        keyId: 11,
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

  it("Sub2API 任一 Key 探测失败时返回部分成功且不伪造总余额", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockImplementation(async (config: { keyId: number }) => {
      if (config.keyId === 12) {
        return { ...billing, keyId: 12, status: "error", errorCode: "upstream_http_401" };
      }
      return { ...billing, keyId: 11, balanceUsd: 1, balanceRaw: 100 };
    });

    const batch = await getProviderUpstreamBillingBatch([7]);
    expect(batch).toMatchObject({
      ok: true,
      data: [
        {
          status: "partial",
          balanceUsd: null,
          balanceRaw: null,
          balanceAggregation: "unavailable",
        },
      ],
    });
    expect(mockProbe).toHaveBeenCalledTimes(2);
  });

  it("Sub2API 所有 Key 部分成功且余额完整时仍汇总余额", async () => {
    const multiKeyProvider = {
      ...provider,
      apiKeys: [
        { id: 11, providerId: 7, key: "key-a", label: "A", isEnabled: true, sortOrder: 0 },
        { id: 12, providerId: 7, key: "key-b", label: "B", isEnabled: true, sortOrder: 1 },
      ],
    };
    mockFindProviderById.mockResolvedValue(multiKeyProvider);
    mockProbe.mockResolvedValue({
      ...billing,
      keyId: 11,
      status: "partial",
      balanceUsd: 1,
      balanceRaw: 100,
      effectiveMultiplier: null,
      errorCode: "sub2api_account_credentials_missing",
    });

    const result = await getProviderUpstreamBillingBatch([7]);
    expect(result).toMatchObject({
      ok: true,
      data: [
        { status: "partial", balanceUsd: 2, balanceRaw: 200, balanceAggregation: "sum_of_keys" },
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

  it("官方渠道不会进入批量探测或手动倍率同步", async () => {
    mockFindProviderById.mockResolvedValue({ ...provider, upstreamBillingType: "official" });

    const batch = await getProviderUpstreamBillingBatch([7]);
    const sync = await syncProviderCostMultiplier(7);

    expect(batch).toEqual({ ok: true, data: [] });
    expect(sync).toEqual({ ok: false, error: "官方渠道不查询上游余额和倍率" });
    expect(mockClaimRefresh).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("拒绝非管理员访问", async () => {
    mockGetSession.mockResolvedValue({ user: { role: "user" } });

    const result = await getProviderUpstreamBillingBatch([7]);

    expect(result).toEqual({ ok: false, error: "无权限执行此操作" });
    expect(mockFindProviderById).not.toHaveBeenCalled();
  });
});
