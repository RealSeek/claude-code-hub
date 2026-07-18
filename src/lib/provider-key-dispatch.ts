import "server-only";

import { getRedisClient } from "@/lib/redis/client";
import { INCREMENT_PROVIDER_KEY_ROUND_ROBIN } from "@/lib/redis/lua-scripts";
import type { Provider, ProviderApiKey } from "@/types/provider";
import { getSmartDispatchConfig } from "./smart-dispatch";

export interface PersistedProviderKeyState {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  updatedAt: number;
}

const keyStates = new Map<number, PersistedProviderKeyState>();
const localRoundRobin = new Map<number, number>();

function stateFor(keyId: number): PersistedProviderKeyState {
  let state = keyStates.get(keyId);
  if (!state) {
    state = {
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      updatedAt: 0,
    };
    keyStates.set(keyId, state);
  }
  return state;
}

export function enabledProviderApiKeys(provider: Provider): ProviderApiKey[] {
  return [...(provider.apiKeys ?? [])]
    .filter((apiKey) => apiKey.isEnabled && apiKey.key.trim() !== "")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export function hasConfiguredProviderApiKeys(provider: Provider): boolean {
  return (provider.apiKeys ?? []).length > 0;
}

export function providerApiKeyCount(provider: Provider): number {
  const count = enabledProviderApiKeys(provider).length;
  if (hasConfiguredProviderApiKeys(provider)) return count;
  return provider.key == null || provider.key.trim() === "" ? 0 : 1;
}

/**
 * 返回当前可参与调度的 Key 数量。
 *
 * 与 ccLoad 的有效 Key 权重语义一致：禁用 Key 不计入，仍在冷却中的 Key 从容量中扣除；
 * legacy 单 Key Provider 在凭据可用时按 1 个 Key 计算。
 */
export async function readyProviderApiKeyCount(
  provider: Provider,
  now = Date.now()
): Promise<number> {
  const configured = enabledProviderApiKeys(provider);
  if (configured.length === 0) return hasUsableProviderApiKey(provider) ? 1 : 0;

  await hydrateProviderApiKeyStates(configured.map((apiKey) => apiKey.id));
  return configured.filter((apiKey) => !isProviderApiKeyCooled(apiKey.id, now)).length;
}

/**
 * 判断 Provider 是否至少有一组可用于发起请求的凭据。
 *
 * 空的 api_keys 池不能再回退到已经清空的 legacy key；这类 Provider 必须从调度候选中
 * 排除，否则会以空 Authorization 继续请求上游。
 */
export function hasUsableProviderApiKey(provider: Provider): boolean {
  if (hasConfiguredProviderApiKeys(provider)) {
    return enabledProviderApiKeys(provider).length > 0;
  }
  // 部分内部测试/旧 Provider 快照没有 legacy key 字段；保持历史兼容，将 undefined
  // 视为“由上游适配器自行提供凭据”，只有显式空字符串代表已清空的空池。
  return provider.key == null || provider.key.trim() !== "";
}

export async function hydrateProviderApiKeyStates(keyIds: number[]): Promise<void> {
  if (!process.env.REDIS_URL || keyIds.length === 0) return;
  const { loadProviderKeyStates } = await import("@/lib/redis/provider-key-dispatch-store");
  const remote = await loadProviderKeyStates(keyIds);
  for (const [id, state] of remote) {
    const local = keyStates.get(id);
    if (!local || state.updatedAt > local.updatedAt) keyStates.set(id, state);
  }
}

export function isProviderApiKeyCooled(keyId: number, now = Date.now()): boolean {
  return stateFor(keyId).cooldownUntil > now;
}

export function providerApiKeyReadyAt(keyId: number): number {
  return stateFor(keyId).cooldownUntil;
}

async function nextRoundRobinIndex(providerId: number, size: number): Promise<number> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status === "ready") {
    try {
      const counter = Number(
        await redis.eval(
          INCREMENT_PROVIDER_KEY_ROUND_ROBIN,
          1,
          `cch:provider-key:rr:${providerId}`,
          String(24 * 60 * 60)
        )
      );
      return (counter - 1) % size;
    } catch {
      // Redis 不可用时降级到进程内轮询。
    }
  }
  const counter = localRoundRobin.get(providerId) ?? 0;
  localRoundRobin.set(providerId, counter + 1);
  return counter % size;
}

export async function selectProviderApiKey(
  provider: Provider,
  excludedKeyIds: ReadonlySet<number> = new Set(),
  now = Date.now(),
  options: { allowCooldownFallback?: boolean } = {}
): Promise<Provider> {
  const configured = enabledProviderApiKeys(provider);
  if (configured.length === 0) {
    return hasConfiguredProviderApiKeys(provider)
      ? { ...provider, key: "", selectedApiKeyId: null }
      : { ...provider, selectedApiKeyId: null };
  }

  await hydrateProviderApiKeyStates(configured.map((apiKey) => apiKey.id));
  const eligible = configured.filter((apiKey) => !excludedKeyIds.has(apiKey.id));
  if (eligible.length === 0) return { ...provider, selectedApiKeyId: null };

  const ready = eligible.filter((apiKey) => !isProviderApiKeyCooled(apiKey.id, now));
  const candidates =
    ready.length > 0
      ? ready
      : options.allowCooldownFallback
        ? [...eligible]
            .sort(
              (a, b) =>
                providerApiKeyReadyAt(a.id) - providerApiKeyReadyAt(b.id) ||
                a.sortOrder - b.sortOrder ||
                a.id - b.id
            )
            .slice(0, 1)
        : [];

  if (candidates.length === 0) {
    return { ...provider, key: "", selectedApiKeyId: null };
  }

  const selected =
    provider.keyStrategy === "sequential" || candidates.length === 1
      ? candidates[0]
      : candidates[await nextRoundRobinIndex(provider.id, candidates.length)];

  return {
    ...provider,
    key: selected.key,
    selectedApiKeyId: selected.id,
  };
}

/**
 * 在 Provider 级别严格检查是否存在未冷却的 Key。
 * 这是普通调度的过滤条件；全冷却兜底必须由调用方显式决定。
 */
export async function hasReadyProviderApiKey(
  provider: Provider,
  now = Date.now()
): Promise<boolean> {
  return (await readyProviderApiKeyCount(provider, now)) > 0;
}

/** 返回 Provider Key 池中最早可恢复的时间，用于全冷却兜底排序。 */
export async function providerReadyAt(provider: Provider, now = Date.now()): Promise<number> {
  const configured = enabledProviderApiKeys(provider);
  if (configured.length === 0)
    return hasUsableProviderApiKey(provider) ? now : Number.POSITIVE_INFINITY;

  await hydrateProviderApiKeyStates(configured.map((apiKey) => apiKey.id));
  return Math.min(...configured.map((apiKey) => providerApiKeyReadyAt(apiKey.id)));
}

export function recordProviderApiKeyFailure(keyId: number, requestedCooldownUntil?: number): void {
  const now = Date.now();
  const state = stateFor(keyId);
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  const config = getSmartDispatchConfig();
  const duration = Math.min(
    config.cooldownMaxMs,
    config.cooldownBaseMs * 2 ** Math.max(0, state.consecutiveFailures - 1)
  );
  state.cooldownUntil = Math.max(
    state.cooldownUntil,
    requestedCooldownUntil && requestedCooldownUntil > now ? requestedCooldownUntil : now + duration
  );
  state.updatedAt = now;
  if (process.env.REDIS_URL) {
    void import("@/lib/redis/provider-key-dispatch-store").then(({ saveProviderKeyState }) =>
      saveProviderKeyState(keyId, { ...state }, now, "failure")
    );
  }
}

export function recordProviderApiKeySuccess(keyId: number, requestStartedAt = Date.now()): void {
  const state = stateFor(keyId);
  if (requestStartedAt < state.lastFailureAt) return;
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.updatedAt = Date.now();
  if (process.env.REDIS_URL) {
    void import("@/lib/redis/provider-key-dispatch-store").then(({ saveProviderKeyState }) =>
      saveProviderKeyState(keyId, { ...state }, requestStartedAt, "success")
    );
  }
}

export function areAllProviderApiKeysCooled(provider: Provider, now = Date.now()): boolean {
  const keys = enabledProviderApiKeys(provider);
  return keys.length > 0 && keys.every((apiKey) => isProviderApiKeyCooled(apiKey.id, now));
}

export function resetProviderKeyDispatchState(): void {
  keyStates.clear();
  localRoundRobin.clear();
}

export async function clearProviderApiKeyDispatchStates(keyIds: number[]): Promise<void> {
  const uniqueIds = [...new Set(keyIds)];
  for (const keyId of uniqueIds) keyStates.delete(keyId);
  if (!process.env.REDIS_URL || uniqueIds.length === 0) return;
  const { deleteProviderKeyState } = await import("@/lib/redis/provider-key-dispatch-store");
  await Promise.all(uniqueIds.map((keyId) => deleteProviderKeyState(keyId)));
}
