import "server-only";

import { logger } from "@/lib/logger";
import type {
  PersistedSmartEndpointState,
  PersistedSmartProviderState,
} from "@/lib/smart-dispatch";
import { getRedisClient } from "./client";
import { RedisKVStore } from "./redis-kv-store";

const STATE_TTL_SECONDS = 24 * 60 * 60;
const PROVIDER_PREFIX = "cch:smart-dispatch:provider:";
const ENDPOINT_PREFIX = "cch:smart-dispatch:endpoint:";

const MERGE_PROVIDER_SCRIPT = `
local incoming = cjson.decode(ARGV[3])
local operation = incoming.operation or 'failure'
local requestStartedAt = tonumber(incoming.requestStartedAt or 0)
local currentRaw = redis.call('GET', KEYS[1])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok then
    local merged = {}
    local seen = {}
    local function append(items)
      for _, item in ipairs(items or {}) do
        local signature = tostring(item.id or (tostring(item.at) .. ':' .. tostring(item.ok) .. ':' .. tostring(item.ttfbMs or '')))
        if tonumber(item.at or 0) >= tonumber(ARGV[4]) and not seen[signature] then
          seen[signature] = true
          table.insert(merged, item)
        end
      end
    end
    append(current.outcomes)
    append(incoming.outcomes)
    table.sort(merged, function(a, b)
      if tonumber(a.at or 0) ~= tonumber(b.at or 0) then
        return tonumber(a.at or 0) < tonumber(b.at or 0)
      end
      return tostring(a.id or '') < tostring(b.id or '')
    end)
    incoming.outcomes = merged
    if operation == 'failure' then
      -- 失败只能延长状态，不能被另一个实例的旧快照缩短。
      incoming.cooldownUntil = math.max(tonumber(current.cooldownUntil or 0), tonumber(incoming.cooldownUntil or 0))
      incoming.consecutiveFailures = math.max(tonumber(current.consecutiveFailures or 0), tonumber(incoming.consecutiveFailures or 0))
      incoming.lastFailureAt = math.max(tonumber(current.lastFailureAt or 0), tonumber(incoming.lastFailureAt or 0))
    elseif tonumber(current.lastFailureAt or 0) > requestStartedAt then
      -- 成功请求开始于最新失败之前时，不能恢复该失败状态。
      incoming.cooldownUntil = tonumber(current.cooldownUntil or 0)
      incoming.consecutiveFailures = tonumber(current.consecutiveFailures or 0)
      incoming.lastFailureAt = tonumber(current.lastFailureAt or 0)
    end
    incoming.updatedAt = math.max(
      tonumber(current.updatedAt or 0),
      tonumber(incoming.updatedAt or 0)
    )
  end
end
incoming.operation = nil
incoming.requestStartedAt = nil
redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), cjson.encode(incoming))
return 1`;

const MERGE_ENDPOINT_SCRIPT = `
local incoming = cjson.decode(ARGV[3])
local operation = incoming.operation or 'failure'
local requestStartedAt = tonumber(incoming.requestStartedAt or 0)
local currentRaw = redis.call('GET', KEYS[1])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok then
    if operation == 'failure' then
      incoming.cooldownUntil = math.max(tonumber(current.cooldownUntil or 0), tonumber(incoming.cooldownUntil or 0))
      incoming.consecutiveFailures = math.max(tonumber(current.consecutiveFailures or 0), tonumber(incoming.consecutiveFailures or 0))
      incoming.lastFailureAt = math.max(tonumber(current.lastFailureAt or 0), tonumber(incoming.lastFailureAt or 0))
    elseif tonumber(current.lastFailureAt or 0) > requestStartedAt then
      incoming.cooldownUntil = tonumber(current.cooldownUntil or 0)
      incoming.consecutiveFailures = tonumber(current.consecutiveFailures or 0)
      incoming.lastFailureAt = tonumber(current.lastFailureAt or 0)
    end
    incoming.updatedAt = math.max(tonumber(current.updatedAt or 0), tonumber(incoming.updatedAt or 0))
    if tonumber(current.updatedAt or 0) > tonumber(ARGV[1]) then
      incoming.ewmaMs = tonumber(current.ewmaMs or 0)
      incoming.sampleCount = tonumber(current.sampleCount or 0)
    end
  end
end
incoming.operation = nil
incoming.requestStartedAt = nil
redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), cjson.encode(incoming))
return 1`;

const providerStore = new RedisKVStore<PersistedSmartProviderState>({
  prefix: PROVIDER_PREFIX,
  defaultTtlSeconds: STATE_TTL_SECONDS,
});

const endpointStore = new RedisKVStore<PersistedSmartEndpointState>({
  prefix: ENDPOINT_PREFIX,
  defaultTtlSeconds: STATE_TTL_SECONDS,
});

export async function saveSmartProviderState(
  providerId: number,
  state: PersistedSmartProviderState,
  requestStartedAt = Date.now(),
  operation: "failure" | "success" = "failure",
  outcomeCutoffAt = state.updatedAt - 2 * 60 * 60 * 1000
): Promise<boolean> {
  return saveState(
    `${PROVIDER_PREFIX}${providerId}`,
    state,
    MERGE_PROVIDER_SCRIPT,
    requestStartedAt,
    operation,
    outcomeCutoffAt
  );
}

export async function saveSmartEndpointState(
  endpointId: number,
  state: PersistedSmartEndpointState,
  requestStartedAt = Date.now(),
  operation: "failure" | "success" = "failure"
): Promise<boolean> {
  return saveState(
    `${ENDPOINT_PREFIX}${endpointId}`,
    state,
    MERGE_ENDPOINT_SCRIPT,
    requestStartedAt,
    operation
  );
}

export async function deleteSmartProviderState(providerId: number): Promise<boolean> {
  return deleteState(`${PROVIDER_PREFIX}${providerId}`);
}

export async function deleteSmartEndpointState(endpointId: number): Promise<boolean> {
  return deleteState(`${ENDPOINT_PREFIX}${endpointId}`);
}

async function deleteState(key: string): Promise<boolean> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return false;
  try {
    return (await redis.del(key)) > 0;
  } catch (error) {
    logger.warn("[SmartDispatchStore] Failed to delete state", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function saveState(
  key: string,
  state: PersistedSmartProviderState | PersistedSmartEndpointState,
  script: string,
  requestStartedAt: number,
  operation: "failure" | "success",
  outcomeCutoffAt = state.updatedAt - 2 * 60 * 60 * 1000
): Promise<boolean> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return false;
  try {
    const result = await redis.eval(
      script,
      1,
      key,
      String(state.updatedAt),
      String(STATE_TTL_SECONDS),
      JSON.stringify({ ...state, requestStartedAt, operation }),
      String(outcomeCutoffAt)
    );
    return Number(result) === 1;
  } catch (error) {
    logger.warn("[SmartDispatchStore] Failed to persist state", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function loadSmartProviderStates(
  providerIds: number[]
): Promise<Map<number, PersistedSmartProviderState>> {
  const entries = await Promise.all(
    [...new Set(providerIds)].map(async (id) => [id, await providerStore.get(String(id))] as const)
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [number, PersistedSmartProviderState] => entry[1] !== null
    )
  );
}

export async function loadSmartEndpointStates(
  endpointIds: number[]
): Promise<Map<number, PersistedSmartEndpointState>> {
  const entries = await Promise.all(
    [...new Set(endpointIds)].map(async (id) => [id, await endpointStore.get(String(id))] as const)
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [number, PersistedSmartEndpointState] => entry[1] !== null
    )
  );
}
