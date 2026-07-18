import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireProviderRequest,
  clearLocalProviderRequestLimiter,
  wrapProviderResponseBody,
} from "@/lib/provider-request-limiter";

describe("Provider request limiter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearLocalProviderRequestLimiter();
  });

  it("在途请求达到上限时拒绝，body 读完后释放槽位", async () => {
    vi.stubEnv("ENABLE_RATE_LIMIT", "false");
    vi.stubEnv("REDIS_URL", "");

    const first = await acquireProviderRequest({
      providerId: 7,
      concurrencyLimit: 1,
      requestId: "first",
      now: 1_000,
    });
    expect(first.allowed).toBe(true);

    const blocked = await acquireProviderRequest({
      providerId: 7,
      concurrencyLimit: 1,
      requestId: "second",
      now: 1_001,
    });
    expect(blocked).toMatchObject({ allowed: false, reason: "concurrency" });

    const response = wrapProviderResponseBody(
      new Response("stream-body"),
      first.allowed ? first.lease : { requestId: "missing", release: async () => undefined }
    );
    await response.arrayBuffer();

    const allowedAfterClose = await acquireProviderRequest({
      providerId: 7,
      concurrencyLimit: 1,
      requestId: "third",
      now: 1_002,
    });
    expect(allowedAfterClose.allowed).toBe(true);
  });

  it("RPM 计数在释放并发槽位后仍保留到窗口结束", async () => {
    vi.stubEnv("ENABLE_RATE_LIMIT", "false");
    vi.stubEnv("REDIS_URL", "");

    const first = await acquireProviderRequest({
      providerId: 8,
      rpmLimit: 2,
      requestId: "one",
      now: 10_000,
    });
    const second = await acquireProviderRequest({
      providerId: 8,
      rpmLimit: 2,
      requestId: "two",
      now: 10_001,
    });
    expect(first.allowed && second.allowed).toBe(true);
    if (first.allowed) await first.lease.release();
    if (second.allowed) await second.lease.release();

    const blocked = await acquireProviderRequest({
      providerId: 8,
      rpmLimit: 2,
      requestId: "three",
      now: 10_002,
    });
    expect(blocked).toMatchObject({ allowed: false, reason: "rpm" });

    const afterWindow = await acquireProviderRequest({
      providerId: 8,
      rpmLimit: 2,
      requestId: "four",
      now: 70_003,
    });
    expect(afterWindow.allowed).toBe(true);
  });

  it("同一个 requestId 重试时不会重复占用 RPM 或并发额度", async () => {
    vi.stubEnv("ENABLE_RATE_LIMIT", "false");
    vi.stubEnv("REDIS_URL", "");

    const first = await acquireProviderRequest({
      providerId: 9,
      rpmLimit: 1,
      concurrencyLimit: 1,
      requestId: "duplicate",
      now: 20_000,
    });
    const retry = await acquireProviderRequest({
      providerId: 9,
      rpmLimit: 1,
      concurrencyLimit: 1,
      requestId: "duplicate",
      now: 20_001,
    });

    expect(first.allowed).toBe(true);
    expect(retry).toMatchObject({ allowed: true, current: 1, rpmCurrent: 1 });
  });
});
