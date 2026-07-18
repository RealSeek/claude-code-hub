/**
 * Circuit Breaker Smart Probe Scheduler
 *
 * Periodically probes providers in OPEN circuit state to enable faster recovery.
 * When a probe succeeds, the circuit transitions to HALF_OPEN state earlier.
 *
 * Configuration via environment variables:
 * - ENABLE_SMART_PROBING: Enable/disable smart probing (default: false)
 * - PROBE_INTERVAL_MS: Interval between probe cycles (default: 10000ms = 10s)
 * - PROBE_TIMEOUT_MS: Timeout for each probe request (default: 5000ms = 5s)
 * - PROBE_CONCURRENCY: Maximum number of probes per cycle (default: 4)
 * - SMART_PROBE_ALLOW_LOCAL_LOCK：Redis 不可用时允许单实例探测（默认：false）
 */

import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis/client";
import type { ProviderType } from "@/types/provider";
import { getAllHealthStatus, tripToHalfOpen } from "./circuit-breaker";
import { executeProviderTest } from "./provider-testing/test-service";
import {
  recordProviderApiKeyFailure,
  recordProviderApiKeySuccess,
  selectProviderApiKey,
} from "./provider-key-dispatch";
import { recordSmartProviderFailure, recordSmartProviderSuccess } from "./smart-dispatch";

// Configuration
const ENABLE_SMART_PROBING = process.env.ENABLE_SMART_PROBING === "true";
const PROBE_INTERVAL_MS = parseInt(process.env.PROBE_INTERVAL_MS || "10000", 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || "5000", 10);
const PROBE_MODEL = process.env.SMART_PROBE_MODEL?.trim() || undefined;
const PROBE_CONCURRENCY = Math.max(1, parseInt(process.env.PROBE_CONCURRENCY || "4", 10));
const PROBE_LEADER_LOCK_TTL_MS = Math.max(PROBE_INTERVAL_MS, PROBE_TIMEOUT_MS * 2);
const PROBE_LEADER_LOCK_KEY = "cch:smart-probe:leader";

// Probe state
let probeIntervalId: NodeJS.Timeout | null = null;
let probeSignalHandler: (() => void) | null = null;
let isProbing = false;

// In-memory cache of provider configs for probing
interface ProbeProviderConfig {
  id: number;
  name: string;
  url: string;
  providerType: ProviderType;
  model?: string;
}

let providerConfigCache: Map<number, ProbeProviderConfig> = new Map();
let lastProviderCacheUpdate = 0;
const PROVIDER_CACHE_TTL = 60000; // 1 minute

/**
 * Load provider configurations for probing
 */
async function loadProviderConfigs(): Promise<void> {
  const now = Date.now();
  if (now - lastProviderCacheUpdate < PROVIDER_CACHE_TTL && providerConfigCache.size > 0) {
    return; // Cache still valid
  }

  try {
    // Dynamic import to avoid circular dependencies
    const { db } = await import("@/drizzle/db");
    const { providers } = await import("@/drizzle/schema");
    const { eq, isNull, and } = await import("drizzle-orm");

    const providerList = await db
      .select({
        id: providers.id,
        name: providers.name,
        url: providers.url,
        providerType: providers.providerType,
      })
      .from(providers)
      .where(and(eq(providers.isEnabled, true), isNull(providers.deletedAt)));

    providerConfigCache = new Map(
      providerList.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.name,
          url: p.url,
          providerType: (p.providerType || "claude") as ProviderType,
        },
      ])
    );
    lastProviderCacheUpdate = now;

    logger.debug("[SmartProbe] Updated provider cache", {
      count: providerConfigCache.size,
    });
  } catch (error) {
    logger.error("[SmartProbe] Failed to load provider configs", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Probe a single provider
 */
async function probeProvider(providerId: number): Promise<boolean> {
  const config = providerConfigCache.get(providerId);
  if (!config) {
    logger.warn("[SmartProbe] Provider config not found", { providerId });
    return false;
  }

  try {
    const { findProviderById } = await import("@/repository/provider");
    const provider = await findProviderById(providerId);
    if (!provider) {
      logger.warn("[SmartProbe] Provider no longer exists", { providerId });
      return false;
    }

    const selected = await selectProviderApiKey(provider, new Set(), Date.now(), {
      allowCooldownFallback: true,
    });
    if (!selected.key) {
      logger.warn("[SmartProbe] Provider has no usable API key", { providerId });
      recordSmartProviderFailure(providerId);
      return false;
    }

    logger.info("[SmartProbe] Probing provider", {
      providerId,
      providerName: config.name,
      apiKeyId: selected.selectedApiKeyId,
    });

    const startedAt = Date.now();
    const result = await executeProviderTest({
      providerUrl: config.url,
      apiKey: selected.key,
      providerType: config.providerType,
      model: config.model ?? PROBE_MODEL,
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    if (result.success) {
      logger.info("[SmartProbe] Probe succeeded, transitioning to half-open", {
        providerId,
        providerName: config.name,
        latencyMs: result.latencyMs,
        status: result.status,
      });

      // Transition circuit to half-open state for safe recovery verification
      // This allows real requests to gradually test the provider before fully closing
      tripToHalfOpen(providerId);
      if (selected.selectedApiKeyId != null) {
        recordProviderApiKeySuccess(selected.selectedApiKeyId, startedAt);
      }
      recordSmartProviderSuccess(providerId, result.latencyMs, startedAt);
      return true;
    }

    logger.info("[SmartProbe] Probe failed, keeping circuit open", {
      providerId,
      providerName: config.name,
      status: result.status,
      subStatus: result.subStatus,
      errorMessage: result.errorMessage,
    });
    const statusCode = result.httpStatusCode;
    if (
      selected.selectedApiKeyId != null &&
      (statusCode === 401 || statusCode === 403 || statusCode === 429)
    ) {
      recordProviderApiKeyFailure(selected.selectedApiKeyId);
    } else {
      recordSmartProviderFailure(providerId);
    }
    return false;
  } catch (error) {
    logger.error("[SmartProbe] Probe execution error", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    recordSmartProviderFailure(providerId);
    return false;
  }
}

async function acquireProbeLeaderLock(): Promise<(() => Promise<void>) | null> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  const allowLocalLock = process.env.SMART_PROBE_ALLOW_LOCAL_LOCK === "true";
  if (redis?.status !== "ready") {
    if (allowLocalLock) return async () => undefined;
    logger.warn("[SmartProbe] Redis 不可用，跳过本轮探测以保持单 Leader 语义");
    return null;
  }

  const token = crypto.randomUUID();
  try {
    const acquired = await redis.set(
      PROBE_LEADER_LOCK_KEY,
      token,
      "PX",
      PROBE_LEADER_LOCK_TTL_MS,
      "NX"
    );
    if (acquired !== "OK") return null;
    const renewTimer = setInterval(() => {
      void redis
        .eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
          1,
          PROBE_LEADER_LOCK_KEY,
          token,
          String(PROBE_LEADER_LOCK_TTL_MS)
        )
        .catch(() => undefined);
    }, Math.max(1000, Math.floor(PROBE_LEADER_LOCK_TTL_MS / 3)));
    return async () => {
      clearInterval(renewTimer);
      try {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          PROBE_LEADER_LOCK_KEY,
          token
        );
      } catch {
        // 锁会通过 TTL 自动释放。
      }
    };
  } catch {
    if (allowLocalLock) return async () => undefined;
    logger.warn("[SmartProbe] Redis Leader 锁失败，跳过本轮探测");
    return null;
  }
}

async function probeWithConcurrency(providerIds: number[]): Promise<PromiseSettledResult<boolean>[]> {
  const results: PromiseSettledResult<boolean>[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= providerIds.length) return;
      try {
        results[index] = { status: "fulfilled", value: await probeProvider(providerIds[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, providerIds.length) }, () => worker())
  );
  return results;
}

/**
 * Run a single probe cycle
 */
async function runProbeCycle(): Promise<void> {
  if (isProbing) {
    logger.debug("[SmartProbe] Skipping cycle, previous cycle still running");
    return;
  }

  isProbing = true;
  let releaseLeaderLock: (() => Promise<void>) | null = null;

  try {
    releaseLeaderLock = await acquireProbeLeaderLock();
    if (!releaseLeaderLock) {
      logger.debug("[SmartProbe] Another instance owns the probe leader lock");
      return;
    }
    // Load fresh provider configs
    await loadProviderConfigs();

    // Get all providers with open circuits
    const healthStatus = getAllHealthStatus();
    const openCircuits: number[] = [];

    for (const [providerId, health] of Object.entries(healthStatus)) {
      if (health.circuitState === "open") {
        openCircuits.push(parseInt(providerId, 10));
      }
    }

    if (openCircuits.length === 0) {
      logger.debug("[SmartProbe] No open circuits to probe");
      return;
    }

    logger.info("[SmartProbe] Starting probe cycle", {
      openCircuitCount: openCircuits.length,
      providerIds: openCircuits,
    });

    // Probe each provider with open circuit
    const results = await probeWithConcurrency(openCircuits);

    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    const failed = results.length - succeeded;

    logger.info("[SmartProbe] Probe cycle completed", {
      total: results.length,
      succeeded,
      failed,
    });
  } catch (error) {
    logger.error("[SmartProbe] Probe cycle error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await releaseLeaderLock?.();
    isProbing = false;
  }
}

/**
 * Start the probe scheduler
 */
export function startProbeScheduler(): void {
  if (!ENABLE_SMART_PROBING) {
    logger.info("[SmartProbe] Smart probing is disabled");
    return;
  }

  if (probeIntervalId) {
    logger.warn("[SmartProbe] Scheduler already running");
    return;
  }

  logger.info("[SmartProbe] Starting probe scheduler", {
    intervalMs: PROBE_INTERVAL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    concurrency: PROBE_CONCURRENCY,
  });

  // Run immediately on startup
  runProbeCycle().catch((error) => {
    logger.error("[SmartProbe] Initial probe cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Schedule periodic probes
  probeIntervalId = setInterval(() => {
    runProbeCycle().catch((error) => {
      logger.error("[SmartProbe] Scheduled probe cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, PROBE_INTERVAL_MS);

  // Ensure cleanup on process exit
  probeSignalHandler = stopProbeScheduler;
  process.on("SIGTERM", probeSignalHandler);
  process.on("SIGINT", probeSignalHandler);
}

/**
 * Stop the probe scheduler
 */
export function stopProbeScheduler(): void {
  if (probeIntervalId) {
    clearInterval(probeIntervalId);
    probeIntervalId = null;
    logger.info("[SmartProbe] Probe scheduler stopped");
  }
  if (probeSignalHandler) {
    process.off("SIGTERM", probeSignalHandler);
    process.off("SIGINT", probeSignalHandler);
    probeSignalHandler = null;
  }
}

/**
 * Check if smart probing is enabled
 */
export function isSmartProbingEnabled(): boolean {
  return ENABLE_SMART_PROBING;
}

/**
 * Get probe scheduler status
 */
export function getProbeSchedulerStatus(): {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  timeoutMs: number;
  concurrency: number;
} {
  return {
    enabled: ENABLE_SMART_PROBING,
    running: probeIntervalId !== null,
    intervalMs: PROBE_INTERVAL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    concurrency: PROBE_CONCURRENCY,
  };
}

/**
 * Manually trigger a probe for a specific provider
 */
export async function triggerManualProbe(providerId: number): Promise<boolean> {
  await loadProviderConfigs();
  return probeProvider(providerId);
}
