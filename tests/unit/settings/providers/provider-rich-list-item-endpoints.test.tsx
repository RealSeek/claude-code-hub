/**
 * @vitest-environment happy-dom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderRichListItem } from "@/app/[locale]/settings/providers/_components/provider-rich-list-item";
import type { ProviderDisplay } from "@/types/provider";
import type { User } from "@/types/user";
import enMessages from "../../../../messages/en";

// Mock dependencies
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock actions
const providerEndpointsActionMocks = vi.hoisted(() => ({
  getProviderVendors: vi.fn(async () => [
    {
      id: 101,
      displayName: "Anthropic",
      websiteDomain: "anthropic.com",
      websiteUrl: "https://anthropic.com",
      faviconUrl: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ]),
  getProviderEndpointsByVendor: vi.fn(async () => []),
}));
vi.mock("@/actions/provider-endpoints", () => providerEndpointsActionMocks);

const providersActionMocks = vi.hoisted(() => ({
  editProvider: vi.fn(async () => ({ ok: true })),
  removeProvider: vi.fn(async () => ({ ok: true })),
  getUnmaskedProviderKey: vi.fn(async () => ({ ok: true, data: { key: "sk-test" } })),
  resetProviderCircuit: vi.fn(async () => ({ ok: true })),
  resetProviderTotalUsage: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/actions/providers", () => providersActionMocks);

// Mock tooltip to simplify testing
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Mock ProviderEndpointHover to avoid complex children rendering if needed,
// but we want to check if it's rendered.
// Actually, let's NOT mock it fully, or mock it to render a simple test id.
vi.mock("@/app/[locale]/settings/providers/_components/provider-endpoint-hover", () => ({
  ProviderEndpointHover: ({ vendorId }: { vendorId: number }) => (
    <div data-testid="mock-endpoint-hover">Endpoints for Vendor {vendorId}</div>
  ),
}));

const ADMIN_USER: User = {
  id: 1,
  name: "admin",
  description: "",
  role: "admin",
  rpm: null,
  dailyQuota: null,
  providerGroup: null,
  tags: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  dailyResetMode: "fixed",
  dailyResetTime: "00:00",
  isEnabled: true,
};

function makeProviderDisplay(overrides: Partial<ProviderDisplay> = {}): ProviderDisplay {
  return {
    id: 1,
    name: "Claude 3.5 Sonnet",
    url: "https://api.anthropic.com",
    maskedKey: "sk-***",
    isEnabled: true,
    weight: 1,
    priority: 1,
    costMultiplier: 1,
    groupTag: null,
    upstreamBillingType: "auto",
    hasUpstreamBillingAccessToken: false,
    hasUpstreamBillingRefreshToken: false,
    hasUpstreamBillingCookie: false,
    upstreamBillingUserId: null,
    upstreamBillingRefreshIntervalMinutes: 30,
    providerType: "claude",
    providerVendorId: null, // Default to null for legacy check
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    limitConcurrentSessions: 1,
    maxRetryAttempts: null,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerOpenDuration: 60,
    circuitBreakerHalfOpenSuccessThreshold: 1,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 0,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    tpm: null,
    rpm: null,
    rpd: null,
    cc: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderWithProviders(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = (nextNode: ReactNode) => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
          {nextNode}
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
  };

  act(() => {
    render(node);
  });

  return {
    rerender: (nextNode: ReactNode) => {
      act(() => render(nextNode));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    container,
  };
}

async function flushTicks(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("ProviderRichListItem Endpoint Display", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.clearAllMocks();
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  test("renders legacy URL when providerVendorId is null", async () => {
    const provider = makeProviderDisplay({
      providerVendorId: null,
      url: "https://api.legacy.com",
    });

    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks(5);

    expect(document.body.textContent).toContain("https://api.legacy.com");
    expect(document.body.textContent).not.toContain("Anthropic");
    expect(document.querySelector('[data-testid="mock-endpoint-hover"]')).toBeNull();

    unmount();
  });

  test("renders vendor name and endpoint hover when providerVendorId exists", async () => {
    const provider = makeProviderDisplay({
      providerVendorId: 101,
      url: "https://api.anthropic.com",
    });

    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        vendor={{
          id: 101,
          websiteDomain: "anthropic.com",
          displayName: "Anthropic",
          websiteUrl: "https://anthropic.com",
          faviconUrl: null,
          createdAt: new Date("2026-02-01T00:00:00Z"),
          updatedAt: new Date("2026-02-01T00:00:00Z"),
        }}
        currentUser={ADMIN_USER}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks(5); // Wait for query to resolve

    // Should show vendor name (mocked as "Anthropic")
    expect(document.body.textContent).toContain("Anthropic");

    // Should NOT show the raw URL in the main label position (though it might be in tooltip, but here we check main text replacement)
    // The implementation replaces the URL span with the vendor/hover block

    // Should render the mock endpoint hover
    expect(document.querySelector('[data-testid="mock-endpoint-hover"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Endpoints for Vendor 101");

    unmount();
  });

  test("renders timeout summary as 0s when provider timeouts are disabled", async () => {
    const provider = makeProviderDisplay({
      firstByteTimeoutStreamingMs: 0,
      streamingIdleTimeoutMs: 0,
      requestTimeoutNonStreamingMs: 0,
    });

    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks(5);

    expect(document.body.textContent).toContain("First byte: 0s");
    expect(document.body.textContent).toContain("Stream interval: 0s");
    expect(document.body.textContent).toContain("Non-streaming: 0s");

    unmount();
  });

  test("余额查询完成后会从骨架屏更新为真实余额", async () => {
    const provider = makeProviderDisplay();
    const initial = (
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        upstreamBillingLoading={true}
        enableMultiProviderTypes={true}
      />
    );
    const { rerender, unmount } = renderWithProviders(initial);

    await flushTicks();
    expect(document.body.textContent).not.toContain("$12.50");

    rerender(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        upstreamBillingLoading={false}
        upstreamBilling={{
          providerId: provider.id,
          source: "sub2api",
          status: "ok",
          balanceUsd: 12.5,
          balanceRaw: 12.5,
          balanceScope: "account",
          quotaPerUnit: null,
          effectiveMultiplier: 0.02,
          observedAt: "2026-07-18T00:00:00.000Z",
          errorCode: null,
          balanceAggregation: "single_key",
        }}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks();
    expect(document.body.textContent).toContain("$12.50");
    expect(document.body.textContent).toContain("sub2api · 0.02x");

    unmount();
  });

  test("New-API 显示有限账户余额与 Token 分组倍率", async () => {
    const provider = makeProviderDisplay({ upstreamBillingType: "new-api" });
    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        upstreamBillingLoading={false}
        upstreamBilling={{
          providerId: provider.id,
          source: "new-api",
          status: "ok",
          balanceUsd: 2.5,
          balanceRaw: 1_250_000,
          balanceScope: "account",
          quotaPerUnit: 500_000,
          effectiveMultiplier: 0.1,
          observedAt: "2026-07-18T00:00:00.000Z",
          errorCode: null,
          balanceAggregation: "single_key",
        }}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks();
    expect(document.body.textContent).toContain("$2.50");
    expect(document.body.textContent).toContain("new-api · 0.1x");
    expect(document.body.textContent).not.toContain("Unlimited quota");

    unmount();
  });

  test("New-API Cookie 失效时显示明确告警", async () => {
    const provider = makeProviderDisplay({
      upstreamBillingType: "new-api",
      hasUpstreamBillingCookie: true,
      upstreamBillingUserId: "42",
    });
    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        upstreamBilling={{
          providerId: provider.id,
          source: "new-api",
          status: "error",
          balanceUsd: null,
          balanceRaw: null,
          quotaPerUnit: null,
          effectiveMultiplier: null,
          observedAt: "2026-07-19T00:00:00.000Z",
          errorCode: "new_api_cookie_invalid",
          balanceAggregation: "unavailable",
        }}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks();
    expect(document.body.textContent).toContain(
      "New-API cookie has expired or authentication was rejected"
    );
    expect(document.body.textContent).not.toContain("Query failed");

    unmount();
  });

  test("官方渠道不渲染上游余额与倍率区域", async () => {
    const provider = makeProviderDisplay({ upstreamBillingType: "official" });
    const { unmount } = renderWithProviders(
      <ProviderRichListItem
        provider={provider}
        currentUser={ADMIN_USER}
        upstreamBillingLoading={false}
        upstreamBilling={{
          providerId: provider.id,
          source: "sub2api",
          status: "ok",
          balanceUsd: 12.5,
          balanceRaw: 12.5,
          quotaPerUnit: null,
          effectiveMultiplier: 0.02,
          observedAt: "2026-07-19T00:00:00.000Z",
          errorCode: null,
        }}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks();
    expect(document.body.textContent).not.toContain("$12.50");
    expect(document.body.textContent).not.toContain("sub2api");

    unmount();
  });

  test("桌面指标组使用稳定宽度并靠右对齐", async () => {
    const { unmount, container } = renderWithProviders(
      <ProviderRichListItem
        provider={makeProviderDisplay()}
        currentUser={ADMIN_USER}
        enableMultiProviderTypes={true}
      />
    );

    await flushTicks();
    const metrics = Array.from(container.querySelectorAll("div")).find(
      (element) =>
        element.classList.contains("ml-auto") &&
        element.classList.contains("min-w-[270px]") &&
        element.classList.contains("grid-cols-3")
    );
    expect(metrics).toBeDefined();

    unmount();
  });
});
