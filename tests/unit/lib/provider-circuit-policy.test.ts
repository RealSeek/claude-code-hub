import { describe, expect, test } from "vitest";
import {
  calculateProviderCircuitOpenDuration,
  isProviderCircuitEligibleFailure,
  resolveProviderCircuitPolicy,
  shouldOpenProviderCircuit,
} from "@/lib/provider-circuit-policy";

const defaultConfig = {
  failureThreshold: 5,
  openDuration: 1_800_000,
  halfOpenSuccessThreshold: 2,
};

describe("provider circuit policy", () => {
  test("uses a high-concurrency rolling window while preserving legacy controls", () => {
    const policy = resolveProviderCircuitPolicy(defaultConfig);

    expect(policy).toMatchObject({
      enabled: true,
      windowMs: 60_000,
      minimumSamples: 20,
      failureRateThreshold: 0.4,
      consecutiveFailureThreshold: 8,
      baseOpenDurationMs: 60_000,
      maxOpenDurationMs: 1_800_000,
      halfOpenSuccessThreshold: 2,
      halfOpenMaxConcurrency: 2,
    });
  });

  test("does not open on a small concurrent burst below the fast threshold", () => {
    const policy = resolveProviderCircuitPolicy(defaultConfig);

    expect(
      shouldOpenProviderCircuit({
        policy,
        consecutiveFailures: 5,
        requestCount: 5,
        failureCount: 5,
      })
    ).toBe(false);
  });

  test("opens on the consecutive-failure fast path", () => {
    const policy = resolveProviderCircuitPolicy(defaultConfig);

    expect(
      shouldOpenProviderCircuit({
        policy,
        consecutiveFailures: 8,
        requestCount: 8,
        failureCount: 8,
      })
    ).toBe(true);
  });

  test("opens when a sufficiently large rolling window reaches the failure ratio", () => {
    const policy = resolveProviderCircuitPolicy(defaultConfig);

    expect(
      shouldOpenProviderCircuit({
        policy,
        consecutiveFailures: 2,
        requestCount: 20,
        failureCount: 8,
      })
    ).toBe(true);
    expect(
      shouldOpenProviderCircuit({
        policy,
        consecutiveFailures: 2,
        requestCount: 20,
        failureCount: 7,
      })
    ).toBe(false);
  });

  test("uses bounded exponential open durations", () => {
    const policy = resolveProviderCircuitPolicy({
      ...defaultConfig,
      openDuration: 300_000,
    });

    expect(calculateProviderCircuitOpenDuration(policy, 1)).toBe(60_000);
    expect(calculateProviderCircuitOpenDuration(policy, 2)).toBe(120_000);
    expect(calculateProviderCircuitOpenDuration(policy, 3)).toBe(240_000);
    expect(calculateProviderCircuitOpenDuration(policy, 4)).toBe(300_000);
  });

  test("excludes client and request-shape failures from provider health", () => {
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 502,
        message: "Your input exceeds the context window of this model",
      })
    ).toBe(false);
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 413,
        message: "Payload too large",
      })
    ).toBe(false);
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 429,
        message: "API key quota exhausted",
        classificationLevel: "key",
      })
    ).toBe(false);
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 503,
        message: "Service temporarily unavailable",
        classificationLevel: "channel",
      })
    ).toBe(true);
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 502,
        message: "Provider returned 502: new_api_error: 服务异常，请联系站长",
        body: '{"error":{"code":"model_not_found","message":"服务异常，请联系站长","type":"new_api_error"}}',
      })
    ).toBe(false);
    expect(
      isProviderCircuitEligibleFailure({
        statusCode: 502,
        message: "Upstream service temporarily unavailable",
        body: '{"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}',
      })
    ).toBe(true);
  });

  test("failureThreshold zero still disables the breaker", () => {
    const policy = resolveProviderCircuitPolicy({ ...defaultConfig, failureThreshold: 0 });

    expect(policy.enabled).toBe(false);
    expect(
      shouldOpenProviderCircuit({
        policy,
        consecutiveFailures: 100,
        requestCount: 100,
        failureCount: 100,
      })
    ).toBe(false);
  });
});
