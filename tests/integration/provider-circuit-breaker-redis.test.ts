import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeRedis, getRedisClient } from "@/lib/redis/client";
import {
  acquireProviderCircuitPermit,
  clearProviderCircuitRuntime,
  recordProviderCircuitOutcome,
  resetProviderCircuitRuntime,
} from "@/lib/redis/provider-circuit-breaker-store";
import type { ProviderCircuitPolicy } from "@/lib/provider-circuit-policy";

const runRedisTests = process.env.REDIS_URL ? describe : describe.skip;
const providerId = 900_000_000 + Math.floor(Math.random() * 10_000_000);
const policy: ProviderCircuitPolicy = {
  enabled: true,
  windowMs: 60_000,
  minimumSamples: 20,
  failureRateThreshold: 0.4,
  consecutiveFailureThreshold: 8,
  baseOpenDurationMs: 100,
  maxOpenDurationMs: 500,
  halfOpenSuccessThreshold: 2,
  halfOpenMaxConcurrency: 2,
  halfOpenLeaseMs: 5_000,
};

async function waitForRedis(): Promise<void> {
  const client = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!client) throw new Error("Redis client is unavailable");
  if (client.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Redis did not become ready")), 5_000);
    client.once("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once("error", reject);
  });
}

async function outcome(value: "success" | "failure", permitToken?: string | null) {
  const state = await recordProviderCircuitOutcome({
    providerId,
    outcome: value,
    policy,
    requestStartedAt: Date.now(),
    permitToken,
  });
  if (!state) throw new Error("Atomic circuit outcome was not persisted");
  return state;
}

runRedisTests("provider circuit breaker Redis state machine", () => {
  beforeAll(async () => {
    process.env.ENABLE_RATE_LIMIT = "true";
    await waitForRedis();
    await clearProviderCircuitRuntime(providerId);
  });

  afterAll(async () => {
    await clearProviderCircuitRuntime(providerId);
    await closeRedis();
  });

  test("opens on the eighth consecutive failure and rejects admission while open", async () => {
    for (let index = 0; index < 7; index++) {
      expect((await outcome("failure")).circuitState).toBe("closed");
    }
    const opened = await outcome("failure");
    expect(opened.circuitState).toBe("open");
    expect(opened.failureCount).toBe(8);
    expect(opened.opened).toBe(true);

    const admission = await acquireProviderCircuitPermit(providerId, policy);
    expect(admission).toMatchObject({ allowed: false, permitToken: null });
  });

  test("limits half-open probes and requires owned permits for recovery", async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const admissions = await Promise.all([
      acquireProviderCircuitPermit(providerId, policy),
      acquireProviderCircuitPermit(providerId, policy),
      acquireProviderCircuitPermit(providerId, policy),
    ]);
    const allowed = admissions.filter((admission) => admission?.allowed);
    expect(allowed).toHaveLength(2);
    expect(admissions.filter((admission) => !admission?.allowed)).toHaveLength(1);

    const stale = await outcome("success", "not-an-owned-permit");
    expect(stale.circuitState).toBe("half-open");
    expect(stale.halfOpenSuccessCount).toBe(0);

    const first = await outcome("success", allowed[0]?.permitToken);
    expect(first.circuitState).toBe("half-open");
    expect(first.halfOpenSuccessCount).toBe(1);

    const recovered = await outcome("success", allowed[1]?.permitToken);
    expect(recovered.circuitState).toBe("closed");
    expect(recovered.halfOpenSuccessCount).toBe(0);
  });

  test("opens at forty percent failures after the minimum sample count", async () => {
    await resetProviderCircuitRuntime(providerId);
    let state = await outcome("success");
    const failureIndexes = new Set([2, 4, 6, 8, 10, 12, 14, 16]);
    for (let index = 1; index < 20; index++) {
      state = await outcome(failureIndexes.has(index) ? "failure" : "success");
    }
    expect(state.windowRequestCount).toBe(20);
    expect(state.windowFailureCount).toBe(8);
    expect(state.windowFailureRate).toBeCloseTo(0.4);
    expect(state.circuitState).toBe("open");
  });

  test("reset clears rolling events, leases, and backoff state atomically", async () => {
    await resetProviderCircuitRuntime(providerId);
    const state = await outcome("success");
    expect(state).toMatchObject({
      circuitState: "closed",
      failureCount: 0,
      windowRequestCount: 1,
      windowFailureCount: 0,
      openCount: 0,
      halfOpenInFlight: 0,
    });
  });
});
