import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(async () => 1),
  del: vi.fn(async () => 1),
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/redis/client", () => ({ getRedisClient: mocks.getRedisClient }));

describe("provider key dispatch redis store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    mocks.getRedisClient.mockReturnValue({
      status: "ready",
      eval: mocks.eval,
      del: mocks.del,
    });
  });

  it("将失败事件标记为单调合并操作", async () => {
    const { saveProviderKeyState } = await import("@/lib/redis/provider-key-dispatch-store");
    await expect(
      saveProviderKeyState(
        11,
        { cooldownUntil: 5000, consecutiveFailures: 2, lastFailureAt: 1000, updatedAt: 1000 },
        1000,
        "failure"
      )
    ).resolves.toBe(true);

    const payload = JSON.parse(mocks.eval.mock.calls[0]?.[5] as string) as Record<string, unknown>;
    expect(payload.operation).toBe("failure");
    expect(payload.requestStartedAt).toBe(1000);
  });

  it("成功事件保留请求开始后出现的新失败", async () => {
    const { saveProviderKeyState } = await import("@/lib/redis/provider-key-dispatch-store");
    await saveProviderKeyState(
      11,
      { cooldownUntil: 0, consecutiveFailures: 0, lastFailureAt: 0, updatedAt: 2000 },
      1500,
      "success"
    );

    const script = mocks.eval.mock.calls[0]?.[0] as string;
    expect(script).toContain("incoming.operation == 'failure'");
    expect(script).toContain("incoming.requestStartedAt");
    const payload = JSON.parse(mocks.eval.mock.calls[0]?.[5] as string) as Record<string, unknown>;
    expect(payload.operation).toBe("success");
  });

  it("可以删除已移除 Key 的 Redis 状态", async () => {
    const { deleteProviderKeyState } = await import("@/lib/redis/provider-key-dispatch-store");
    await expect(deleteProviderKeyState(11)).resolves.toBe(true);
    expect(mocks.del).toHaveBeenCalledWith("cch:provider-key:state:11");
  });
});
