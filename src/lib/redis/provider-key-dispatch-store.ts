import "server-only";

import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";
import type { PersistedProviderKeyState } from "../provider-key-dispatch";

const PREFIX = "cch:provider-key:state:";
const TTL_SECONDS = 24 * 60 * 60;

const MERGE_SCRIPT = `
local incoming = cjson.decode(ARGV[3])
local currentRaw = redis.call('GET', KEYS[1])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok then
    -- 失败事件只能单调延长冷却；成功事件只有在请求开始时已经覆盖最新失败时才能清除。
    if incoming.operation == 'failure' then
      incoming.cooldownUntil = math.max(tonumber(current.cooldownUntil or 0), tonumber(incoming.cooldownUntil or 0))
      incoming.consecutiveFailures = math.max(tonumber(current.consecutiveFailures or 0), tonumber(incoming.consecutiveFailures or 0))
      incoming.lastFailureAt = math.max(tonumber(current.lastFailureAt or 0), tonumber(incoming.lastFailureAt or 0))
    elseif tonumber(current.lastFailureAt or 0) > tonumber(incoming.requestStartedAt or 0) then
      incoming.cooldownUntil = tonumber(current.cooldownUntil or 0)
      incoming.consecutiveFailures = tonumber(current.consecutiveFailures or 0)
      incoming.lastFailureAt = tonumber(current.lastFailureAt or 0)
    end
    incoming.updatedAt = math.max(tonumber(current.updatedAt or 0), tonumber(incoming.updatedAt or 0))
  end
end
redis.call('SETEX', KEYS[1], tonumber(ARGV[2]), cjson.encode(incoming))
return 1`;

export async function saveProviderKeyState(
  keyId: number,
  state: PersistedProviderKeyState,
  requestStartedAt = Date.now(),
  operation: "failure" | "success" = "failure"
): Promise<boolean> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return false;
  try {
    const result = await redis.eval(
      MERGE_SCRIPT,
      1,
      `${PREFIX}${keyId}`,
      String(state.updatedAt),
      String(TTL_SECONDS),
      JSON.stringify({ ...state, requestStartedAt, operation })
    );
    return Number(result) === 1;
  } catch (error) {
    logger.warn("[ProviderKeyDispatchStore] Failed to persist key state", {
      keyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteProviderKeyState(keyId: number): Promise<boolean> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return false;
  try {
    return (await redis.del(`${PREFIX}${keyId}`)) > 0;
  } catch (error) {
    logger.warn("[ProviderKeyDispatchStore] Failed to delete key state", {
      keyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function loadProviderKeyStates(
  keyIds: number[]
): Promise<Map<number, PersistedProviderKeyState>> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready" || keyIds.length === 0) return new Map();
  const entries = await Promise.all(
    [...new Set(keyIds)].map(async (keyId) => {
      try {
        const raw = await redis.get(`${PREFIX}${keyId}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedProviderKeyState;
        if (
          !Number.isFinite(parsed.cooldownUntil) ||
          !Number.isFinite(parsed.consecutiveFailures) ||
          !Number.isFinite(parsed.lastFailureAt) ||
          !Number.isFinite(parsed.updatedAt)
        ) {
          return null;
        }
        return [keyId, parsed] as const;
      } catch {
        return null;
      }
    })
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [number, PersistedProviderKeyState] => entry !== null
    )
  );
}
