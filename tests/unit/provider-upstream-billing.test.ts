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
