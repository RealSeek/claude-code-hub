import type { CircuitBreakerConfig } from "@/lib/redis/circuit-breaker-config";

export const PROVIDER_CIRCUIT_WINDOW_MS = 60_000;
export const PROVIDER_CIRCUIT_MIN_SAMPLES = 20;
export const PROVIDER_CIRCUIT_FAILURE_RATE = 0.4;
export const PROVIDER_CIRCUIT_MIN_CONSECUTIVE_FAILURES = 8;
export const PROVIDER_CIRCUIT_BASE_OPEN_MS = 60_000;
export const PROVIDER_CIRCUIT_HALF_OPEN_MAX_CONCURRENCY = 2;
export const PROVIDER_CIRCUIT_HALF_OPEN_LEASE_MS = 120_000;

export interface ProviderCircuitPolicy {
  enabled: boolean;
  windowMs: number;
  minimumSamples: number;
  failureRateThreshold: number;
  consecutiveFailureThreshold: number;
  baseOpenDurationMs: number;
  maxOpenDurationMs: number;
  halfOpenSuccessThreshold: number;
  halfOpenMaxConcurrency: number;
  halfOpenLeaseMs: number;
}

export function resolveProviderCircuitPolicy(config: CircuitBreakerConfig): ProviderCircuitPolicy {
  const enabled = Number.isFinite(config.failureThreshold) && config.failureThreshold > 0;
  const consecutiveFailureThreshold = Math.max(
    1,
    Math.trunc(config.consecutiveFailureThreshold ?? Math.max(PROVIDER_CIRCUIT_MIN_CONSECUTIVE_FAILURES, config.failureThreshold))
  );
  const maxOpenDurationMs = Math.max(1_000, Math.trunc(config.openDuration));
  const baseOpenDurationMs = Math.max(1_000, Math.trunc(config.baseOpenDuration ?? PROVIDER_CIRCUIT_BASE_OPEN_MS));

  return {
    enabled,
    windowMs: Math.max(1_000, Math.trunc(config.rollingWindowDuration ?? PROVIDER_CIRCUIT_WINDOW_MS)),
    minimumSamples: Math.max(1, Math.trunc(config.minimumSamples ?? PROVIDER_CIRCUIT_MIN_SAMPLES)),
    failureRateThreshold: Math.min(1, Math.max(0, config.failureRateThreshold ?? PROVIDER_CIRCUIT_FAILURE_RATE)),
    consecutiveFailureThreshold,
    baseOpenDurationMs: Math.min(baseOpenDurationMs, maxOpenDurationMs),
    maxOpenDurationMs,
    halfOpenSuccessThreshold: Math.max(1, Math.trunc(config.halfOpenSuccessThreshold)),
    halfOpenMaxConcurrency: Math.max(1, Math.trunc(config.halfOpenMaxConcurrency ?? PROVIDER_CIRCUIT_HALF_OPEN_MAX_CONCURRENCY)),
    halfOpenLeaseMs: Math.max(1_000, Math.trunc(config.halfOpenLeaseDuration ?? PROVIDER_CIRCUIT_HALF_OPEN_LEASE_MS)),
  };
}

export function calculateProviderCircuitOpenDuration(
  policy: ProviderCircuitPolicy,
  openCount: number
): number {
  const exponent = Math.max(0, Math.min(20, Math.trunc(openCount) - 1));
  return Math.min(policy.maxOpenDurationMs, policy.baseOpenDurationMs * 2 ** exponent);
}

export function shouldOpenProviderCircuit(input: {
  policy: ProviderCircuitPolicy;
  consecutiveFailures: number;
  requestCount: number;
  failureCount: number;
}): boolean {
  if (!input.policy.enabled) return false;
  if (input.consecutiveFailures >= input.policy.consecutiveFailureThreshold) return true;
  if (input.requestCount < input.policy.minimumSamples) return false;
  return input.failureCount / input.requestCount >= input.policy.failureRateThreshold;
}

const CLIENT_FAILURE_PATTERNS = [
  /context window/i,
  /context length/i,
  /maximum context/i,
  /input (?:is )?too (?:large|long)/i,
  /too many tokens/i,
  /token limit/i,
];

export function isProviderCircuitEligibleFailure(input: {
  statusCode?: number;
  message: string;
  body?: string | null;
  classificationLevel?: string;
}): boolean {
  if (input.classificationLevel === "client" || input.classificationLevel === "key") return false;
  if ([404, 408, 413, 414, 415].includes(input.statusCode ?? 0)) return false;
  const text = `${input.message}\n${input.body ?? ""}`;
  return !CLIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}
