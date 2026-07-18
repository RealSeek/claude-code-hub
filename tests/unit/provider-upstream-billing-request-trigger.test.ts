import { expect, it, vi } from "vitest";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock("@/lib/provider-upstream-billing-service", () => ({
  REQUEST_TRIGGER_REFRESH_INTERVAL_MS: 600_000,
  refreshProviderUpstreamBilling: mockRefresh,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { triggerProviderUpstreamBillingRefresh } from "@/lib/provider-upstream-billing-request-trigger";

it("请求成功钩子不会等待后台刷新完成", async () => {
  mockRefresh.mockReturnValue(new Promise(() => {}));

  expect(triggerProviderUpstreamBillingRefresh(7)).toBeUndefined();
  await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
  expect(mockRefresh).toHaveBeenCalledWith(7, {
    source: "request",
    minimumIntervalMs: 600_000,
  });
});
