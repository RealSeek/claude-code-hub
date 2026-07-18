import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(async () => 1),
  del: vi.fn(async () => 1),
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/redis/client", () => ({ getRedisClient: mocks.getRedisClient }));

describe("smart dispatch redis store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getRedisClient.mockReturnValue({ status: "ready", eval: mocks.eval, del: mocks.del });
  });

  it("persists provider state with compare-and-set timestamp", async () => {
    const { saveSmartProviderState } = await import("@/lib/redis/smart-dispatch-store");
    const result = await saveSmartProviderState(7, {
      outcomes: [{ at: 100, ok: false }],
      cooldownUntil: 1000,
      consecutiveFailures: 1,
      lastFailureAt: 100,
      updatedAt: 100,
    });

    expect(result).toBe(true);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("incoming.outcomes"),
      1,
      "cch:smart-dispatch:provider:7",
      "100",
      expect.any(String),
      expect.stringContaining('"cooldownUntil":1000'),
      expect.any(String)
    );
    const payload = mocks.eval.mock.calls[0]?.[5] as string;
    expect(payload).toContain('"operation":"failure"');
    expect(payload).toContain('"requestStartedAt"');
  });

  it("允许调用方按智能调度窗口传递 outcome 保留截止时间", async () => {
    const { saveSmartProviderState } = await import("@/lib/redis/smart-dispatch-store");
    await saveSmartProviderState(
      8,
      {
        outcomes: [],
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        updatedAt: 10_000,
      },
      9_000,
      "success",
      1_234
    );

    expect(mocks.eval.mock.calls[0]?.[6]).toBe("1234");
  });

  it("uses operation-aware merge for endpoint success/failure and supports deletion", async () => {
    const {
      deleteSmartEndpointState,
      saveSmartEndpointState,
    } = await import("@/lib/redis/smart-dispatch-store");
    await saveSmartEndpointState(9, {
      ewmaMs: 100,
      sampleCount: 1,
      cooldownUntil: 1000,
      consecutiveFailures: 1,
      lastFailureAt: 100,
      updatedAt: 100,
    }, 90, "failure");
    await saveSmartEndpointState(9, {
      ewmaMs: 100,
      sampleCount: 2,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      updatedAt: 200,
    }, 150, "success");
    expect(mocks.eval.mock.calls[1]?.[0]).toContain("requestStartedAt");
    expect(mocks.eval.mock.calls[1]?.[5]).toContain('"operation":"success"');
    await expect(deleteSmartEndpointState(9)).resolves.toBe(true);
    expect(mocks.del).toHaveBeenCalledWith("cch:smart-dispatch:endpoint:9");
  });

  it("fails open when redis is unavailable", async () => {
    mocks.getRedisClient.mockReturnValue(null);
    const { saveSmartEndpointState } = await import("@/lib/redis/smart-dispatch-store");
    await expect(
      saveSmartEndpointState(9, {
        ewmaMs: 100,
        sampleCount: 1,
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        updatedAt: 100,
      })
    ).resolves.toBe(false);
  });
});
