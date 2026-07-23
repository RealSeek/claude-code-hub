import type { Provider, ProviderEndpoint } from "@/types/provider";
import { DEFAULT_SMART_DISPATCH_SETTINGS, type SmartDispatchSettings } from "@/types/system-config";

export type SmartDispatchConfig = SmartDispatchSettings;
const DEFAULT_CONFIG = DEFAULT_SMART_DISPATCH_SETTINGS;
let cachedDbConfig: SmartDispatchConfig | null = null;
let configRefreshedAt = 0;
const CONFIG_REFRESH_INTERVAL_MS = 30_000;

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberEnv(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function getSmartDispatchConfig(): SmartDispatchConfig {
  const base = cachedDbConfig ?? DEFAULT_CONFIG;
  return {
    enabled: boolEnv("SMART_DISPATCH_ENABLED", base.enabled),
    healthScoreEnabled: boolEnv("SMART_DISPATCH_HEALTH_SCORE_ENABLED", base.healthScoreEnabled),
    windowMinutes: numberEnv("SMART_DISPATCH_WINDOW_MINUTES", base.windowMinutes, 1),
    minConfidentSample: numberEnv("SMART_DISPATCH_MIN_CONFIDENT_SAMPLE", base.minConfidentSample),
    successRatePenaltyWeight: numberEnv(
      "SMART_DISPATCH_SUCCESS_RATE_PENALTY_WEIGHT",
      base.successRatePenaltyWeight
    ),
    enableTTFBScore: boolEnv("SMART_DISPATCH_ENABLE_TTFB_SCORE", base.enableTTFBScore),
    ttfbPenaltyWeight: numberEnv("SMART_DISPATCH_TTFB_PENALTY_WEIGHT", base.ttfbPenaltyWeight),
    ttfbMaxSlowRatio: numberEnv("SMART_DISPATCH_TTFB_MAX_SLOW_RATIO", base.ttfbMaxSlowRatio),
    ttfbMinConfidentSample: numberEnv(
      "SMART_DISPATCH_TTFB_MIN_CONFIDENT_SAMPLE",
      base.ttfbMinConfidentSample
    ),
    cooldownBaseMs: numberEnv("SMART_DISPATCH_COOLDOWN_BASE_MS", base.cooldownBaseMs, 1),
    cooldownMaxMs: numberEnv("SMART_DISPATCH_COOLDOWN_MAX_MS", base.cooldownMaxMs, 1),
    ewmaAlpha: Math.min(1, numberEnv("SMART_DISPATCH_EWMA_ALPHA", base.ewmaAlpha, 0.01)),
  };
}

export async function refreshSmartDispatchConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && configRefreshedAt > 0 && now - configRefreshedAt < CONFIG_REFRESH_INTERVAL_MS)
    return;
  try {
    const { getCachedSystemSettings } = await import("@/lib/config/system-settings-cache");
    const settings = await getCachedSystemSettings();
    cachedDbConfig = { ...DEFAULT_CONFIG, ...settings.smartDispatchConfig };
  } catch {
    // 数据库不可用时继续使用环境变量配置。
  } finally {
    configRefreshedAt = now;
  }
}

export function invalidateSmartDispatchConfig(): void {
  cachedDbConfig = null;
  configRefreshedAt = 0;
}

export interface PersistedSmartOutcome {
  id?: string;
  at: number;
  ok: boolean;
  ttfbMs?: number;
}

export interface PersistedSmartProviderState {
  outcomes: PersistedSmartOutcome[];
  cooldownUntil: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  updatedAt: number;
}

export interface PersistedSmartEndpointState {
  ewmaMs: number;
  sampleCount: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  updatedAt: number;
}

type ProviderState = PersistedSmartProviderState;
type EndpointState = PersistedSmartEndpointState;

const providerStates = new Map<number, ProviderState>();
const endpointStates = new Map<number, EndpointState>();
const rrCurrentWeights = new Map<string, Map<number, number>>();
const rrLastAccess = new Map<string, number>();
let lastStateCleanupAt = 0;
const STATE_CLEANUP_INTERVAL_MS = 60_000;
const STATE_RETENTION_MS = 2 * 60 * 60 * 1000;

function cleanupSmartState(now: number): void {
  if (now - lastStateCleanupAt < STATE_CLEANUP_INTERVAL_MS) return;
  lastStateCleanupAt = now;
  const config = getSmartDispatchConfig();
  const windowMs = config.windowMinutes * 60 * 1000;
  const cutoff = now - STATE_RETENTION_MS;

  for (const [id, state] of providerStates) {
    prune(state, now, windowMs);
    if (state.outcomes.length === 0 && state.cooldownUntil <= now) providerStates.delete(id);
  }
  for (const [id, state] of endpointStates) {
    if (state.cooldownUntil <= now && state.updatedAt < cutoff) endpointStates.delete(id);
  }
  for (const [key, accessedAt] of rrLastAccess) {
    if (accessedAt < cutoff) {
      rrLastAccess.delete(key);
      rrCurrentWeights.delete(key);
    }
  }
}

function providerState(id: number): ProviderState {
  let state = providerStates.get(id);
  if (!state) {
    state = {
      outcomes: [],
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      updatedAt: 0,
    };
    providerStates.set(id, state);
  }
  return state;
}

function endpointState(id: number): EndpointState {
  let state = endpointStates.get(id);
  if (!state) {
    state = {
      ewmaMs: 0,
      sampleCount: 0,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      updatedAt: 0,
    };
    endpointStates.set(id, state);
  }
  return state;
}

function prune(state: ProviderState, now: number, windowMs: number): void {
  for (let index = 1; index < state.outcomes.length; index += 1) {
    if (state.outcomes[index - 1].at > state.outcomes[index].at) {
      state.outcomes.sort(
        (a, b) => a.at - b.at || String(a.id ?? "").localeCompare(String(b.id ?? ""))
      );
      break;
    }
  }
  const cutoff = now - windowMs;
  while (state.outcomes.length > 0 && state.outcomes[0].at < cutoff) state.outcomes.shift();
}

function persistProviderState(
  providerId: number,
  state: ProviderState,
  requestStartedAt: number,
  operation: "failure" | "success"
): void {
  if (!process.env.REDIS_URL) return;
  const snapshot: ProviderState = {
    ...state,
    outcomes: state.outcomes.map((outcome) => ({ ...outcome })),
  };
  void import("@/lib/redis/smart-dispatch-store").then(({ saveSmartProviderState }) =>
    saveSmartProviderState(
      providerId,
      snapshot,
      requestStartedAt,
      operation,
      Date.now() - getSmartDispatchConfig().windowMinutes * 60 * 1000
    )
  );
}

function persistEndpointState(
  endpointId: number,
  state: EndpointState,
  requestStartedAt: number,
  operation: "failure" | "success"
): void {
  if (!process.env.REDIS_URL) return;
  const snapshot: EndpointState = { ...state };
  void import("@/lib/redis/smart-dispatch-store").then(({ saveSmartEndpointState }) =>
    saveSmartEndpointState(endpointId, snapshot, requestStartedAt, operation)
  );
}

function isValidProviderState(state: PersistedSmartProviderState): boolean {
  return (
    Array.isArray(state.outcomes) &&
    Number.isFinite(state.cooldownUntil) &&
    Number.isFinite(state.consecutiveFailures) &&
    Number.isFinite(state.updatedAt)
  );
}

function isValidEndpointState(state: PersistedSmartEndpointState): boolean {
  return (
    Number.isFinite(state.ewmaMs) &&
    Number.isFinite(state.sampleCount) &&
    Number.isFinite(state.cooldownUntil) &&
    Number.isFinite(state.consecutiveFailures) &&
    Number.isFinite(state.updatedAt)
  );
}

export async function hydrateSmartProviderStates(providerIds: number[]): Promise<void> {
  if (!getSmartDispatchConfig().enabled || !process.env.REDIS_URL || providerIds.length === 0)
    return;
  const { loadSmartProviderStates } = await import("@/lib/redis/smart-dispatch-store");
  const remote = await loadSmartProviderStates(providerIds);
  for (const [id, state] of remote) {
    if (!isValidProviderState(state)) continue;
    state.lastFailureAt = Number.isFinite(state.lastFailureAt) ? state.lastFailureAt : 0;
    const local = providerStates.get(id);
    if (!local || state.updatedAt > local.updatedAt) {
      providerStates.set(id, {
        ...state,
        outcomes: state.outcomes.map((outcome) => ({ ...outcome })),
      });
    }
  }
}

export async function hydrateSmartEndpointStates(endpointIds: number[]): Promise<void> {
  if (!getSmartDispatchConfig().enabled || !process.env.REDIS_URL || endpointIds.length === 0)
    return;
  const { loadSmartEndpointStates } = await import("@/lib/redis/smart-dispatch-store");
  const remote = await loadSmartEndpointStates(endpointIds);
  for (const [id, state] of remote) {
    if (!isValidEndpointState(state)) continue;
    state.lastFailureAt = Number.isFinite(state.lastFailureAt) ? state.lastFailureAt : 0;
    const local = endpointStates.get(id);
    if (!local || state.updatedAt > local.updatedAt) endpointStates.set(id, { ...state });
  }
}

export function recordSmartProviderSuccess(
  providerId: number,
  ttfbMs?: number | null,
  requestStartedAt = Date.now()
): void {
  if (!getSmartDispatchConfig().enabled) return;
  const now = Date.now();
  cleanupSmartState(now);
  const state = providerState(providerId);
  state.outcomes.push({
    id: `${now}:${Math.random()}`,
    at: now,
    ok: true,
    ...(ttfbMs != null ? { ttfbMs } : {}),
  });
  if (requestStartedAt >= state.lastFailureAt) {
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }
  state.updatedAt = now;
  persistProviderState(providerId, state, requestStartedAt, "success");
}

export function recordSmartProviderFailure(
  providerId: number,
  requestedCooldownUntil?: number
): void {
  if (!getSmartDispatchConfig().enabled) return;
  const now = Date.now();
  cleanupSmartState(now);
  const state = providerState(providerId);
  state.outcomes.push({ id: `${now}:${Math.random()}`, at: now, ok: false });
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  const config = getSmartDispatchConfig();
  const duration = Math.min(
    config.cooldownMaxMs,
    config.cooldownBaseMs * 2 ** Math.max(0, state.consecutiveFailures - 1)
  );
  const defaultCooldownUntil = now + duration;
  const explicitCooldownUntil =
    requestedCooldownUntil != null && Number.isFinite(requestedCooldownUntil)
      ? requestedCooldownUntil
      : 0;
  // 上游明确给出的 reset_at 优先于本地退避；已有更晚的冷却不能被新失败缩短。
  state.cooldownUntil = Math.max(
    state.cooldownUntil,
    explicitCooldownUntil > now ? explicitCooldownUntil : defaultCooldownUntil
  );
  state.updatedAt = now;
  persistProviderState(providerId, state, now, "failure");
}

export function recordSmartProviderTTFB(providerId: number, ttfbMs: number): void {
  if (!getSmartDispatchConfig().enabled) return;
  if (!Number.isFinite(ttfbMs) || ttfbMs <= 0) return;
  const now = Date.now();
  cleanupSmartState(now);
  const state = providerState(providerId);
  for (let index = state.outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = state.outcomes[index];
    if (outcome.ok && outcome.ttfbMs == null) {
      outcome.ttfbMs = ttfbMs;
      if (now >= state.lastFailureAt) {
        state.consecutiveFailures = 0;
        state.cooldownUntil = 0;
      }
      state.updatedAt = now;
      persistProviderState(providerId, state, now, "success");
      return;
    }
  }
  recordSmartProviderSuccess(providerId, ttfbMs);
}

export function isSmartProviderCooled(providerId: number, now = Date.now()): boolean {
  return providerState(providerId).cooldownUntil > now;
}

export function smartProviderReadyAt(providerId: number): number {
  return providerState(providerId).cooldownUntil;
}

function median(values: number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function smartProviderEffectivePriority(
  provider: Provider,
  candidates: Provider[],
  enabled = getSmartDispatchConfig().enabled,
  userGroup: string | null = null
): number {
  const config = getSmartDispatchConfig();
  const groups =
    userGroup
      ?.split(",")
      .map((group) => group.trim())
      .filter(Boolean) ?? [];
  const override = groups
    .map((group) => provider.groupPriorities?.[group])
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)[0];
  const base = -(override ?? provider.priority);
  if (!enabled || !config.healthScoreEnabled) return base;
  const now = Date.now();
  const windowMs = config.windowMinutes * 60 * 1000;
  const states = candidates.map((item) => {
    const state = providerState(item.id);
    prune(state, now, windowMs);
    return state;
  });
  const ttfbs = states.flatMap((state) =>
    state.outcomes
      .filter((outcome) => outcome.ok && outcome.ttfbMs != null)
      .map((outcome) => outcome.ttfbMs!)
  );
  const medianTtfb = median(ttfbs);
  const state = providerState(provider.id);
  const sampleCount = state.outcomes.length;
  const successes = state.outcomes.filter((outcome) => outcome.ok).length;
  const failureRate = sampleCount > 0 ? 1 - successes / sampleCount : 0;
  const confidence =
    config.minConfidentSample > 0 ? Math.min(1, sampleCount / config.minConfidentSample) : 1;
  let penalty = failureRate * config.successRatePenaltyWeight * confidence;
  const providerTtfbs = state.outcomes
    .filter((outcome) => outcome.ok && outcome.ttfbMs != null)
    .map((outcome) => outcome.ttfbMs!);
  if (config.enableTTFBScore && medianTtfb > 0 && providerTtfbs.length > 0) {
    const average = providerTtfbs.reduce((sum, value) => sum + value, 0) / providerTtfbs.length;
    const slow = Math.min(config.ttfbMaxSlowRatio, Math.max(0, average / medianTtfb - 1));
    const ttfbConfidence =
      config.ttfbMinConfidentSample > 0
        ? Math.min(1, providerTtfbs.length / config.ttfbMinConfidentSample)
        : 1;
    penalty += slow * config.ttfbPenaltyWeight * ttfbConfidence;
  }
  return base - penalty;
}

export function filterSmartCooldown<T extends { id: number }>(
  items: T[],
  now = Date.now(),
  tieBreaker?: (a: T, b: T) => number
): T[] {
  if (!getSmartDispatchConfig().enabled) return items;
  const available = items.filter((item) => !isSmartProviderCooled(item.id, now));
  if (available.length > 0) return available;
  const earliest = [...items].sort((a, b) => {
    const readyDiff = smartProviderReadyAt(a.id) - smartProviderReadyAt(b.id);
    if (readyDiff !== 0) return readyDiff;
    return tieBreaker?.(a, b) ?? a.id - b.id;
  });
  return earliest.slice(0, 1);
}

export function smoothWeightedOrder<T extends { id: number; weight: number }>(
  items: T[],
  key = items
    .map((item) => item.id)
    .sort((a, b) => a - b)
    .join(",")
): T[] {
  if (items.length <= 1 || !getSmartDispatchConfig().enabled) return items;
  const state = rrCurrentWeights.get(key) ?? new Map<number, number>();
  rrCurrentWeights.set(key, state);
  rrLastAccess.set(key, Date.now());
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0) return items;
  let selected = items[0];
  let selectedWeight = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const current = (state.get(item.id) ?? 0) + Math.max(0, item.weight);
    state.set(item.id, current);
    if (current > selectedWeight || (current === selectedWeight && item.id < selected.id)) {
      selected = item;
      selectedWeight = current;
    }
  }
  state.set(selected.id, selectedWeight - total);
  return [selected, ...items.filter((item) => item.id !== selected.id)];
}

/**
 * 将 CCH 的人工配置权重视为单个有效 Key 的基础权重，再按实时可用 Key 数放大容量。
 * 全 Key 冷却的兜底候选最少按 1 计算，保持 ccLoad 的恢复探测语义。
 */
export function smartProviderEffectiveWeight(
  provider: Provider,
  readyKeyCount: number,
  enabled = getSmartDispatchConfig().enabled
): number {
  const configuredWeight = Number.isFinite(provider.weight) ? Math.max(0, provider.weight) : 0;
  if (!enabled) return configuredWeight;
  const effectiveKeyCount = Number.isFinite(readyKeyCount)
    ? Math.max(1, Math.floor(readyKeyCount))
    : 1;
  return configuredWeight * effectiveKeyCount;
}

export function selectSmartProvider(
  providers: Provider[],
  userGroup: string | null,
  schedulingWeights?: ReadonlyMap<number, number>
): Provider {
  if (providers.length === 0) throw new Error("No providers available for selection");
  if (providers.length === 1) return providers[0];
  const pinnedProviders = providers.filter((provider) => provider.isPinned);
  if (pinnedProviders.length > 0 && pinnedProviders.length < providers.length) {
    return selectSmartProvider(pinnedProviders, userGroup, schedulingWeights);
  }
  if (!getSmartDispatchConfig().enabled) {
    const sorted = [...providers].sort((a, b) => a.costMultiplier - b.costMultiplier);
    const totalWeight = sorted.reduce((sum, provider) => sum + provider.weight, 0);
    if (totalWeight <= 0) return sorted[Math.floor(Math.random() * sorted.length)];
    let cursor = Math.random() * totalWeight;
    for (const provider of sorted) {
      cursor -= provider.weight;
      if (cursor < 0) return provider;
    }
    return sorted[sorted.length - 1];
  }
  const scored = [...providers].sort((a, b) => {
    const scoreA = smartProviderEffectivePriority(a, providers, undefined, userGroup);
    const scoreB = smartProviderEffectivePriority(b, providers, undefined, userGroup);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.id - b.id;
  });
  const bestScore = smartProviderEffectivePriority(scored[0], providers, undefined, userGroup);
  const samePriority = scored.filter(
    (provider) =>
      Math.abs(
        smartProviderEffectivePriority(provider, providers, undefined, userGroup) - bestScore
      ) < 0.1
  );
  const weighted = samePriority.map((provider) => ({
    provider,
    id: provider.id,
    weight: schedulingWeights?.get(provider.id) ?? provider.weight,
  }));
  return smoothWeightedOrder(
    weighted,
    `provider:${userGroup ?? ""}:${samePriority
      .map((p) => p.id)
      .sort()
      .join(",")}`
  )[0].provider;
}

export function recordSmartEndpointSuccess(
  endpointId: number,
  latencyMs?: number,
  requestStartedAt = Date.now()
): void {
  if (!getSmartDispatchConfig().enabled) return;
  cleanupSmartState(Date.now());
  const state = endpointState(endpointId);
  if (latencyMs != null && Number.isFinite(latencyMs) && latencyMs > 0) {
    const alpha = getSmartDispatchConfig().ewmaAlpha;
    state.ewmaMs = state.ewmaMs > 0 ? alpha * latencyMs + (1 - alpha) * state.ewmaMs : latencyMs;
    state.sampleCount += 1;
  }
  if (requestStartedAt >= state.lastFailureAt) {
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }
  state.updatedAt = Date.now();
  persistEndpointState(endpointId, state, requestStartedAt, "success");
}

export function recordSmartEndpointFailure(
  endpointId: number,
  requestedCooldownUntil?: number
): void {
  if (!getSmartDispatchConfig().enabled) return;
  const now = Date.now();
  cleanupSmartState(now);
  const state = endpointState(endpointId);
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  const config = getSmartDispatchConfig();
  const fallbackCooldownUntil =
    now +
    Math.min(config.cooldownMaxMs, config.cooldownBaseMs * 2 ** (state.consecutiveFailures - 1));
  state.cooldownUntil = Math.max(
    state.cooldownUntil,
    requestedCooldownUntil != null && requestedCooldownUntil > now
      ? requestedCooldownUntil
      : fallbackCooldownUntil
  );
  state.updatedAt = now;
  persistEndpointState(endpointId, state, now, "failure");
}

export function isSmartEndpointCooled(endpointId: number, now = Date.now()): boolean {
  return endpointState(endpointId).cooldownUntil > now;
}

export function smartEndpointReadyAt(endpointId: number): number {
  return endpointStates.get(endpointId)?.cooldownUntil ?? 0;
}

export function smartEndpointLatency(endpoint: ProviderEndpoint): number {
  const state = endpointStates.get(endpoint.id);
  return state?.ewmaMs || endpoint.lastProbeLatencyMs || Number.POSITIVE_INFINITY;
}

export function rankSmartEndpoints(endpoints: ProviderEndpoint[]): ProviderEndpoint[] {
  if (!getSmartDispatchConfig().enabled || endpoints.length <= 1) return endpoints;
  // 没有运行时样本时保留 Hub 原有探测排序，避免首次启动改变既有端点顺序。
  if (!endpoints.some((endpoint) => endpointStates.has(endpoint.id))) return endpoints;
  const now = Date.now();
  const available = endpoints.filter((endpoint) => !isSmartEndpointCooled(endpoint.id, now));
  const candidates =
    available.length > 0
      ? available
      : [...endpoints]
          .sort((a, b) => smartEndpointReadyAt(a.id) - smartEndpointReadyAt(b.id))
          .slice(0, 1);
  const unknown = candidates.filter(
    (endpoint) => !endpointStates.has(endpoint.id) && endpoint.lastProbeLatencyMs == null
  );
  const known = candidates
    .filter((endpoint) => !unknown.includes(endpoint))
    .sort((a, b) => smartEndpointLatency(a) - smartEndpointLatency(b));
  if (unknown.length > 0) {
    const selected = unknown[Math.floor(Math.random() * unknown.length)];
    return [selected, ...unknown.filter((endpoint) => endpoint.id !== selected.id), ...known];
  }

  const weighted = known.map((endpoint) => ({
    endpoint,
    id: endpoint.id,
    weight: 1 / Math.max(0.1, smartEndpointLatency(endpoint)),
  }));
  return smoothWeightedOrder(
    weighted,
    `endpoint:${known
      .map((endpoint) => endpoint.id)
      .sort((a, b) => a - b)
      .join(",")}`
  ).map((item) => item.endpoint);
}

export function resetSmartDispatchState(): void {
  providerStates.clear();
  endpointStates.clear();
  rrCurrentWeights.clear();
  rrLastAccess.clear();
  lastStateCleanupAt = 0;
  invalidateSmartDispatchConfig();
}

export async function clearSmartProviderState(providerId: number): Promise<void> {
  providerStates.delete(providerId);
  if (!process.env.REDIS_URL) return;
  const { deleteSmartProviderState } = await import("@/lib/redis/smart-dispatch-store");
  await deleteSmartProviderState(providerId);
}

export async function clearSmartEndpointState(endpointId: number): Promise<void> {
  endpointStates.delete(endpointId);
  if (!process.env.REDIS_URL) return;
  const { deleteSmartEndpointState } = await import("@/lib/redis/smart-dispatch-store");
  await deleteSmartEndpointState(endpointId);
}
