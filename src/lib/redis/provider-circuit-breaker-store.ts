import "server-only";

import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import type { ProviderCircuitPolicy } from "@/lib/provider-circuit-policy";
import { getRedisClient } from "./client";

const STATE_PREFIX = "circuit_breaker:state:";
const SUCCESS_EVENT_PREFIX = "circuit_breaker:success_events:";
const FAILURE_EVENT_PREFIX = "circuit_breaker:failure_events:";
const LEASE_PREFIX = "circuit_breaker:half_open_leases:";
const STATE_TTL_SECONDS = 86_400;

export interface AtomicProviderCircuitState {
  failureCount: number;
  lastFailureTime: number | null;
  circuitState: "closed" | "open" | "half-open";
  circuitOpenUntil: number | null;
  halfOpenSuccessCount: number;
  windowRequestCount: number;
  windowFailureCount: number;
  windowFailureRate: number;
  openCount: number;
  halfOpenInFlight: number;
  opened: boolean;
}

export interface ProviderCircuitAdmission {
  allowed: boolean;
  permitToken: string | null;
  state: AtomicProviderCircuitState | null;
}

const RECORD_OUTCOME_SCRIPT = `
local stateKey = KEYS[1]
local successEventKey = KEYS[2]
local failureEventKey = KEYS[3]
local leaseKey = KEYS[4]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local outcome = ARGV[2]
local member = ARGV[3]
local permitToken = ARGV[4]
local windowMs = tonumber(ARGV[6])
local minSamples = tonumber(ARGV[7])
local failureRateThreshold = tonumber(ARGV[8])
local consecutiveThreshold = tonumber(ARGV[9])
local baseOpenMs = tonumber(ARGV[10])
local maxOpenMs = tonumber(ARGV[11])
local halfOpenSuccessThreshold = tonumber(ARGV[12])
local ttlSeconds = tonumber(ARGV[13])

local circuitState = redis.call('HGET', stateKey, 'circuitState') or 'closed'
local failureCount = tonumber(redis.call('HGET', stateKey, 'failureCount') or '0')
local lastFailureTime = tonumber(redis.call('HGET', stateKey, 'lastFailureTime') or '0')
local circuitOpenUntil = tonumber(redis.call('HGET', stateKey, 'circuitOpenUntil') or '0')
local halfOpenSuccessCount = tonumber(redis.call('HGET', stateKey, 'halfOpenSuccessCount') or '0')
local openCount = tonumber(redis.call('HGET', stateKey, 'openCount') or '0')
local opened = 0
local recovered = 0
local ownsPermit = 0

if permitToken ~= '' and redis.call('ZREM', leaseKey, permitToken) == 1 then ownsPermit = 1 end
redis.call('ZREMRANGEBYSCORE', leaseKey, '-inf', now)
redis.call('ZREMRANGEBYSCORE', successEventKey, '-inf', now - windowMs)
redis.call('ZREMRANGEBYSCORE', failureEventKey, '-inf', now - windowMs)

if outcome ~= 'ignored' and circuitState == 'closed' then
  if outcome == 'failure' then
    redis.call('ZADD', failureEventKey, now, member)
  else
    redis.call('ZADD', successEventKey, now, member)
  end
end

if outcome == 'failure' then
  if circuitState == 'half-open' and ownsPermit == 1 then
    failureCount = failureCount + 1
    lastFailureTime = now
    openCount = openCount + 1
    local duration = math.min(maxOpenMs, baseOpenMs * (2 ^ math.min(20, math.max(0, openCount - 1))))
    circuitState = 'open'
    circuitOpenUntil = now + duration
    halfOpenSuccessCount = 0
    opened = 1
  elseif circuitState == 'closed' then
    failureCount = failureCount + 1
    lastFailureTime = now
  end
elseif outcome == 'success' then
  if circuitState == 'half-open' and ownsPermit == 1 then
    halfOpenSuccessCount = halfOpenSuccessCount + 1
    if halfOpenSuccessCount >= halfOpenSuccessThreshold then
      circuitState = 'closed'
      failureCount = 0
      lastFailureTime = 0
      circuitOpenUntil = 0
      halfOpenSuccessCount = 0
      recovered = 1
      redis.call('DEL', successEventKey)
      redis.call('DEL', failureEventKey)
      redis.call('DEL', leaseKey)
    end
  elseif circuitState == 'closed' then
    failureCount = 0
    lastFailureTime = 0
  end
end

local windowSuccessCount = redis.call('ZCARD', successEventKey)
local windowFailureCount = redis.call('ZCARD', failureEventKey)
local requestCount = windowSuccessCount + windowFailureCount
local failureRate = requestCount > 0 and windowFailureCount / requestCount or 0

if circuitState == 'closed' and outcome == 'success' and recovered == 0 and windowFailureCount == 0 then
  openCount = 0
end

if circuitState == 'closed' and outcome == 'failure' and
   (failureCount >= consecutiveThreshold or
    (requestCount >= minSamples and failureRate >= failureRateThreshold)) then
  openCount = openCount + 1
  local duration = math.min(maxOpenMs, baseOpenMs * (2 ^ math.min(20, math.max(0, openCount - 1))))
  circuitState = 'open'
  circuitOpenUntil = now + duration
  halfOpenSuccessCount = 0
  opened = 1
end

local halfOpenInFlight = redis.call('ZCARD', leaseKey)
redis.call('HSET', stateKey,
  'failureCount', failureCount,
  'lastFailureTime', lastFailureTime > 0 and lastFailureTime or '',
  'circuitState', circuitState,
  'circuitOpenUntil', circuitOpenUntil > 0 and circuitOpenUntil or '',
  'halfOpenSuccessCount', halfOpenSuccessCount,
  'openCount', openCount,
  'windowRequestCount', requestCount,
  'windowFailureCount', windowFailureCount,
  'windowFailureRate', failureRate,
  'halfOpenInFlight', halfOpenInFlight)
redis.call('EXPIRE', stateKey, ttlSeconds)
redis.call('EXPIRE', successEventKey, ttlSeconds)
redis.call('EXPIRE', failureEventKey, ttlSeconds)
redis.call('EXPIRE', leaseKey, ttlSeconds)

return cjson.encode({
  failureCount = failureCount,
  lastFailureTime = lastFailureTime,
  circuitState = circuitState,
  circuitOpenUntil = circuitOpenUntil,
  halfOpenSuccessCount = halfOpenSuccessCount,
  windowRequestCount = requestCount,
  windowFailureCount = windowFailureCount,
  windowFailureRate = failureRate,
  openCount = openCount,
  halfOpenInFlight = halfOpenInFlight,
  opened = opened
})`;

const ACQUIRE_SCRIPT = `
local stateKey = KEYS[1]
local leaseKey = KEYS[2]
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local token = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local maxConcurrency = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])
local circuitState = redis.call('HGET', stateKey, 'circuitState') or 'closed'
local circuitOpenUntil = tonumber(redis.call('HGET', stateKey, 'circuitOpenUntil') or '0')

if circuitState == 'open' and circuitOpenUntil > 0 and now >= circuitOpenUntil then
  circuitState = 'half-open'
  redis.call('HSET', stateKey, 'circuitState', circuitState, 'halfOpenSuccessCount', 0)
end
if circuitState == 'open' then return cjson.encode({ allowed = 0, state = circuitState }) end
if circuitState == 'closed' then return cjson.encode({ allowed = 1, state = circuitState }) end

redis.call('ZREMRANGEBYSCORE', leaseKey, '-inf', now)
local inFlight = redis.call('ZCARD', leaseKey)
if inFlight >= maxConcurrency then
  redis.call('HSET', stateKey, 'halfOpenInFlight', inFlight)
  return cjson.encode({ allowed = 0, state = circuitState, halfOpenInFlight = inFlight })
end
redis.call('ZADD', leaseKey, now + leaseMs, token)
redis.call('HSET', stateKey, 'halfOpenInFlight', inFlight + 1)
redis.call('EXPIRE', leaseKey, ttlSeconds)
redis.call('EXPIRE', stateKey, ttlSeconds)
return cjson.encode({ allowed = 1, state = circuitState, permitToken = token, halfOpenInFlight = inFlight + 1 })`;

const RELEASE_SCRIPT = `
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 1 then
  redis.call('HSET', KEYS[1], 'halfOpenInFlight', redis.call('ZCARD', KEYS[2]))
end
return removed`;

const RESET_SCRIPT = `
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
redis.call('HSET', KEYS[1],
  'failureCount', 0,
  'lastFailureTime', '',
  'circuitState', 'closed',
  'circuitOpenUntil', '',
  'halfOpenSuccessCount', 0,
  'windowRequestCount', 0,
  'windowFailureCount', 0,
  'windowFailureRate', 0,
  'openCount', 0,
  'halfOpenInFlight', 0)
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1`;

function stateKey(providerId: number): string {
  return `${STATE_PREFIX}${providerId}`;
}

function parseState(raw: string): AtomicProviderCircuitState {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const number = (key: string) => Number(value[key] ?? 0);
  return {
    failureCount: number("failureCount"),
    lastFailureTime: number("lastFailureTime") || null,
    circuitState: value.circuitState as AtomicProviderCircuitState["circuitState"],
    circuitOpenUntil: number("circuitOpenUntil") || null,
    halfOpenSuccessCount: number("halfOpenSuccessCount"),
    windowRequestCount: number("windowRequestCount"),
    windowFailureCount: number("windowFailureCount"),
    windowFailureRate: number("windowFailureRate"),
    openCount: number("openCount"),
    halfOpenInFlight: number("halfOpenInFlight"),
    opened: number("opened") === 1,
  };
}

export async function recordProviderCircuitOutcome(input: {
  providerId: number;
  outcome: "success" | "failure" | "ignored";
  policy: ProviderCircuitPolicy;
  requestStartedAt: number;
  permitToken?: string | null;
}): Promise<AtomicProviderCircuitState | null> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return null;
  const now = Date.now();
  try {
    const raw = await redis.eval(
      RECORD_OUTCOME_SCRIPT,
      4,
      stateKey(input.providerId),
      `${SUCCESS_EVENT_PREFIX}${input.providerId}`,
      `${FAILURE_EVENT_PREFIX}${input.providerId}`,
      `${LEASE_PREFIX}${input.providerId}`,
      String(now),
      input.outcome,
      randomUUID(),
      input.permitToken ?? "",
      String(input.requestStartedAt),
      String(input.policy.windowMs),
      String(input.policy.minimumSamples),
      String(input.policy.failureRateThreshold),
      String(input.policy.consecutiveFailureThreshold),
      String(input.policy.baseOpenDurationMs),
      String(input.policy.maxOpenDurationMs),
      String(input.policy.halfOpenSuccessThreshold),
      String(STATE_TTL_SECONDS)
    );
    return parseState(String(raw));
  } catch (error) {
    logger.warn("[ProviderCircuitStore] Failed to record atomic outcome", {
      providerId: input.providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function acquireProviderCircuitPermit(
  providerId: number,
  policy: ProviderCircuitPolicy
): Promise<ProviderCircuitAdmission | null> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return null;
  const token = randomUUID();
  try {
    const raw = await redis.eval(
      ACQUIRE_SCRIPT,
      2,
      stateKey(providerId),
      `${LEASE_PREFIX}${providerId}`,
      String(Date.now()),
      token,
      String(policy.halfOpenLeaseMs),
      String(policy.halfOpenMaxConcurrency),
      String(STATE_TTL_SECONDS)
    );
    const parsed = JSON.parse(String(raw)) as {
      allowed?: number;
      state?: AtomicProviderCircuitState["circuitState"];
      permitToken?: string;
      halfOpenInFlight?: number;
    };
    return {
      allowed: parsed.allowed === 1,
      permitToken: parsed.permitToken ?? null,
      state: parsed.state
        ? {
            failureCount: 0,
            lastFailureTime: null,
            circuitState: parsed.state,
            circuitOpenUntil: null,
            halfOpenSuccessCount: 0,
            windowRequestCount: 0,
            windowFailureCount: 0,
            windowFailureRate: 0,
            openCount: 0,
            halfOpenInFlight: parsed.halfOpenInFlight ?? 0,
            opened: false,
          }
        : null,
    };
  } catch (error) {
    logger.warn("[ProviderCircuitStore] Failed to acquire half-open permit", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function clearProviderCircuitRuntime(providerId: number): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return;
  try {
    await redis.del(
      stateKey(providerId),
      `${SUCCESS_EVENT_PREFIX}${providerId}`,
      `${FAILURE_EVENT_PREFIX}${providerId}`,
      `${LEASE_PREFIX}${providerId}`
    );
  } catch (error) {
    logger.warn("[ProviderCircuitStore] Failed to clear circuit runtime", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resetProviderCircuitRuntime(providerId: number): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return;
  try {
    await redis.eval(
      RESET_SCRIPT,
      4,
      stateKey(providerId),
      `${SUCCESS_EVENT_PREFIX}${providerId}`,
      `${FAILURE_EVENT_PREFIX}${providerId}`,
      `${LEASE_PREFIX}${providerId}`,
      String(STATE_TTL_SECONDS)
    );
  } catch (error) {
    logger.warn("[ProviderCircuitStore] Failed to reset circuit runtime", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseProviderCircuitPermit(
  providerId: number,
  permitToken: string
): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return;
  try {
    await redis.eval(
      RELEASE_SCRIPT,
      2,
      stateKey(providerId),
      `${LEASE_PREFIX}${providerId}`,
      permitToken
    );
  } catch (error) {
    logger.warn("[ProviderCircuitStore] Failed to release circuit permit", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
