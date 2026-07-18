import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/proxy-agent", () => ({
  getGlobalAgentPool: vi.fn(() => ({ releaseAgent: vi.fn() })),
  getProxyAgentForProvider: vi.fn(async () => null),
}));

import {
  probeProviderUpstreamBilling,
  resolveProviderBillingBaseUrl,
  type ProviderUpstreamBillingConfig,
} from "@/lib/provider-upstream-billing";

const config: ProviderUpstreamBillingConfig = {
  id: 7,
  name: "测试渠道",
  url: "https://gateway.example.com/v1",
  key: "sk-test",
  proxyUrl: null,
  proxyFallbackToDirect: false,
  customHeaders: null,
  upstreamBillingType: "auto",
  upstreamBillingAccessToken: "account-access-token",
  upstreamBillingRefreshToken: null,
  upstreamBillingCookie: "session=test-cookie",
  upstreamBillingUserId: "42",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provider upstream billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("从常见 API 后缀还原服务根地址", () => {
    expect(resolveProviderBillingBaseUrl("https://example.com/v1/")).toBe("https://example.com");
    expect(resolveProviderBillingBaseUrl("https://example.com/prefix/anthropic")).toBe(
      "https://example.com/prefix"
    );
    expect(resolveProviderBillingBaseUrl("https://example.com/api/v1")).toBe("https://example.com");
  });

  it("读取 sub2api 官方有效倍率", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) {
        return jsonResponse({
          object: "sub2api.key_billing",
          schema_version: 1,
          billing_scope: "token",
          effective_rate_multiplier: 0.75,
          observed_at: "2026-07-18T00:00:00Z",
        });
      }
      if (url.endsWith("/v1/usage")) {
        return jsonResponse({ mode: "unrestricted", balance: 12.5, remaining: 12.5 });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({
      providerId: 7,
      source: "sub2api",
      status: "ok",
      balanceUsd: 12.5,
      balanceScope: "account",
      effectiveMultiplier: 0.75,
      observedAt: "2026-07-18T00:00:00Z",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/api/v1/keys")])
    );
  });

  it("sub2api 新版倍率接口缺失时仍保留首 Key 余额", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({}, 404);
      if (url.endsWith("/v1/usage")) {
        return jsonResponse({ mode: "quota_limited", remaining: 8.5 });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(
      {
        ...config,
        upstreamBillingType: "sub2api",
        upstreamBillingAccessToken: null,
        upstreamBillingRefreshToken: null,
      },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "sub2api",
      status: "partial",
      balanceUsd: 8.5,
      balanceScope: "key",
      effectiveMultiplier: null,
      errorCode: "sub2api_account_credentials_missing",
    });
  });

  it("sub2api 新版倍率接口缺失时通过 JWT 精确匹配当前 Key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({}, 404);
      if (url.endsWith("/v1/usage")) return jsonResponse({ balance: 20 });

      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer account-access-token");
      if (url.includes("/api/v1/keys?")) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              { id: 1, key: "sk-other", group_id: 3 },
              { id: 9, key: "sk-test", group_id: 5 },
            ],
            total: 2,
          },
        });
      }
      if (url.endsWith("/api/v1/groups/available")) {
        return jsonResponse({
          code: 0,
          data: [{ id: 5, rate_multiplier: 0.1, peak_rate_enabled: false }],
        });
      }
      if (url.endsWith("/api/v1/groups/rates")) {
        return jsonResponse({ code: 0, data: { "5": 0.06 } });
      }
      if (url.includes("/api/v1/usage?api_key_id=9")) {
        return jsonResponse({
          code: 0,
          data: { items: [{ rate_multiplier: 0.02 }], total: 1 },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "sub2api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "sub2api",
      status: "ok",
      balanceUsd: 20,
      effectiveMultiplier: 0.02,
      errorCode: null,
    });
  });

  it("sub2api JWT 过期时只刷新一次并持久化轮换后的令牌", async () => {
    const persistTokens = vi.fn(async () => undefined);
    let keyRequestCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({}, 404);
      if (url.endsWith("/v1/usage")) return jsonResponse({ balance: 4 });
      if (url.endsWith("/api/v1/auth/refresh")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "refresh-old" });
        return jsonResponse({
          code: 0,
          data: {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
            token_type: "Bearer",
          },
        });
      }

      const authorization = new Headers(init?.headers).get("authorization");
      if (url.includes("/api/v1/keys?")) {
        keyRequestCount += 1;
        if (keyRequestCount === 1) {
          expect(authorization).toBe("Bearer access-old");
          return jsonResponse({ code: 401, message: "expired" }, 401);
        }
        expect(authorization).toBe("Bearer access-new");
        return jsonResponse({
          code: 0,
          data: { items: [{ id: 9, key: "sk-test", group_id: 5 }], total: 1 },
        });
      }
      expect(authorization).toBe("Bearer access-new");
      if (url.endsWith("/api/v1/groups/available")) {
        return jsonResponse({
          code: 0,
          data: [{ id: 5, rate_multiplier: 0.02, peak_rate_enabled: false }],
        });
      }
      if (url.endsWith("/api/v1/groups/rates")) return jsonResponse({ code: 0, data: null });
      if (url.includes("/api/v1/usage?")) {
        return jsonResponse({ code: 0, data: { items: [], total: 0 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(
      {
        ...config,
        upstreamBillingType: "sub2api",
        upstreamBillingAccessToken: "access-old",
        upstreamBillingRefreshToken: "refresh-old",
        persistSub2ApiTokens: persistTokens,
      },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({ status: "ok", effectiveMultiplier: 0.02 });
    expect(persistTokens).toHaveBeenCalledOnce();
    expect(persistTokens).toHaveBeenCalledWith("access-new", "refresh-new");
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/v1/auth/refresh"))
    ).toHaveLength(1);
  });

  it("官方渠道完全跳过上游探测", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "official" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: null,
      status: "unsupported",
      errorCode: "official_billing_disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("拒绝 sub2api 返回的负余额", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("/v1/sub2api/billing")
        ? jsonResponse({
            object: "sub2api.key_billing",
            effective_rate_multiplier: 1,
          })
        : jsonResponse({ mode: "unrestricted", remaining: -1 });
    });

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({
      source: "sub2api",
      status: "partial",
      effectiveMultiplier: 1,
      errorCode: "invalid_balance",
    });
  });

  it("通过账户凭据读取 New-API 账户余额与 Token 分组倍率", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({}, 404);
      if (url.endsWith("/api/user/self")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("session=test-cookie");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("new-api-user")).toBe("42");
        expect(headers.get("user-agent")).toBe("cc-switch/1.0");
        return jsonResponse({
          success: true,
          data: { quota: 1_250_000, used_quota: 250_000, group: "default" },
        });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({
          success: true,
          data: { default: { desc: "default", ratio: 0.1 } },
        });
      }
      if (url.includes("/api/token/?")) {
        return jsonResponse({
          success: true,
          data: { total: 1, items: [{ key: "****", group: "default" }] },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({
      source: "new-api",
      status: "ok",
      balanceRaw: 1_250_000,
      quotaPerUnit: 500_000,
      balanceUsd: 2.5,
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/usage/token"),
        expect.stringContaining("/api/log/token"),
      ])
    );
  });

  it("拒绝 New-API 返回的负余额", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({}, 404);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: -1 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({ status: "error", errorCode: "invalid_balance" });
  });

  it("New-API Cookie 被拒绝时返回明确的失效错误", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: false, message: "unauthorized" }, 401)
    );

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "new-api",
      status: "error",
      errorCode: "new_api_cookie_invalid",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("New-API 返回 HTML 登录页时判定 Cookie 已失效", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html><body>login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
    );

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({ status: "error", errorCode: "new_api_cookie_invalid" });
  });

  it("New-API 后续账户接口拒绝 Cookie 时不保留为部分成功", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({
          success: true,
          data: { quota: 500_000, group: "default" },
        });
      }
      return jsonResponse({ success: false, message: "unauthorized" }, 403);
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "new_api_cookie_invalid",
    });
  });

  it("New-API Bearer 凭据被拒绝时返回独立错误", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: false }, 401));

    const result = await probeProviderUpstreamBilling(
      {
        ...config,
        upstreamBillingType: "new-api",
        upstreamBillingCookie: null,
      },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "new_api_access_token_invalid",
    });
  });

  it("对不支持 billing 接口的上游返回 unsupported", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({
      source: null,
      status: "unsupported",
      effectiveMultiplier: null,
      errorCode: "unsupported_upstream",
    });
  });

  it("sub2api 探测的陌生错误响应不会阻断 New-API 回退", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: 500_000, group: "default" } });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({ success: true, data: { default: { ratio: 0.1 } } });
      }
      if (url.includes("/api/token/?")) {
        return jsonResponse({
          success: true,
          data: { total: 1, items: [{ key: "****", group: "default" }] },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(config, fetchMock as typeof fetch);

    expect(result).toMatchObject({
      source: "new-api",
      status: "ok",
      balanceUsd: 1,
      effectiveMultiplier: 0.1,
    });
  });

  it("缺少 New-API 账户凭据时返回明确错误且不发起请求", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));

    const result = await probeProviderUpstreamBilling(
      {
        ...config,
        upstreamBillingType: "new-api",
        upstreamBillingAccessToken: null,
        upstreamBillingCookie: null,
        upstreamBillingUserId: null,
      },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "new-api",
      status: "error",
      balanceRaw: null,
      quotaPerUnit: null,
      balanceUsd: null,
      errorCode: "missing_new_api_account_credentials",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("显式指定 New-API 时不会请求 sub2api", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: 500_000, group: "default" } });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({ success: true, data: { default: { ratio: 0.1 } } });
      }
      if (url.includes("/api/token/?")) {
        return jsonResponse({
          success: true,
          data: { total: 1, items: [{ key: "****", group: "default" }] },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({ source: "new-api", status: "ok", balanceUsd: 1 });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/sub2api/"))).toBe(false);
  });

  it("未配置 Cookie 时兼容 Bearer Access Token", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBe("Bearer account-access-token");
      expect(headers.get("new-api-user")).toBe("42");
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: 500_000, group: "default" } });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({ success: true, data: { default: { ratio: 0.1 } } });
      }
      return jsonResponse({
        success: true,
        data: { total: 1, items: [{ key: "****", group: "default" }] },
      });
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api", upstreamBillingCookie: null },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({ source: "new-api", status: "ok", balanceUsd: 1 });
  });

  it("sub2api 余额接口失败时保留倍率并返回部分成功", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sub2api/billing")) {
        return jsonResponse({
          object: "sub2api.key_billing",
          effective_rate_multiplier: 0.2,
        });
      }
      return jsonResponse({ error: "temporary" }, 503);
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "sub2api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "sub2api",
      status: "partial",
      balanceUsd: null,
      effectiveMultiplier: 0.2,
      errorCode: "balance_upstream_http_503",
    });
  });

  it("New-API 多 Key 绑定组倍率不一致时拒绝同步", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: 500_000, group: "default" } });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({
          success: true,
          data: { group_a: { ratio: 0.1 }, group_b: { ratio: 0.2 } },
        });
      }
      return jsonResponse({
        success: true,
        data: {
          total: 2,
          items: [
            { key: "alph**********1111", group: "group_a" },
            { key: "beta**********2222", group: "group_b" },
          ],
        },
      });
    });

    const result = await probeProviderUpstreamBilling(
      {
        ...config,
        upstreamBillingType: "new-api",
        providerKeys: [
          { id: 1, key: "sk-alpha-token-1111", label: "A" },
          { id: 2, key: "sk-beta-token-2222", label: "B" },
        ],
      },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "new-api",
      status: "partial",
      balanceUsd: 1,
      effectiveMultiplier: null,
      errorCode: "inconsistent_multipliers",
    });
  });

  it("New-API Token 使用 auto 组时不伪造固定倍率", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({ success: true, data: { quota: 500_000, group: "default" } });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({ success: true, data: { auto: { ratio: "自动" } } });
      }
      return jsonResponse({
        success: true,
        data: { total: 1, items: [{ key: "****", group: "auto" }] },
      });
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      status: "partial",
      effectiveMultiplier: null,
      errorCode: "new_api_token_group_dynamic",
    });
  });

  it("New-API 账户余额为零时仍返回有限余额与 Token 分组倍率", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/user/self")) {
        return jsonResponse({
          success: true,
          data: { quota: 0, used_quota: 5_000_000, group: "default" },
        });
      }
      if (url.endsWith("/api/user/self/groups")) {
        return jsonResponse({ success: true, data: { default: { ratio: 0.1 } } });
      }
      if (url.includes("/api/token/?")) {
        return jsonResponse({
          success: true,
          data: { total: 1, items: [{ key: "****", group: "default" }] },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeProviderUpstreamBilling(
      { ...config, upstreamBillingType: "new-api" },
      fetchMock as typeof fetch
    );

    expect(result).toMatchObject({
      source: "new-api",
      status: "ok",
      balanceRaw: 0,
      balanceUsd: 0,
      balanceScope: "account",
      effectiveMultiplier: 0.1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
