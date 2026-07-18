const mocks = vi.hoisted(() => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mocks.getRedisClient,
}));

import { acquireProviderRequest } from "@/lib/provider-request-limiter";
import { ACQUIRE_PROVIDER_REQUEST } from "@/lib/redis/lua-scripts";

describe("Provider request limiter Redis 路径", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("使用相同 hash tag 的 Redis Cluster key，并保留 Lua 幂等 RPM 检查", async () => {
    const redis = {
      status: "ready",
      eval: vi.fn(async () => [1, 0, 1, 1, 0]),
    };
    mocks.getRedisClient.mockReturnValue(redis);

    const result = await acquireProviderRequest({
      providerId: 42,
      rpmLimit: 10,
      concurrencyLimit: 2,
      requestId: "request-1",
      now: 1000,
    });

    expect(result.allowed).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      ACQUIRE_PROVIDER_REQUEST,
      2,
      "provider:{42}:active_requests",
      "provider:{42}:rpm_window",
      "request-1",
      "10",
      "2",
      "1000",
      expect.any(String),
      expect.any(String)
    );
    expect(ACQUIRE_PROVIDER_REQUEST).toContain("not already_rpm");
    expect(ACQUIRE_PROVIDER_REQUEST).toContain("rpm_count = rpm_count + 1");
  });
});
