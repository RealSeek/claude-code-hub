import "server-only";

import { logger } from "@/lib/logger";
import {
  acquireLeaderLock,
  releaseLeaderLock,
  startLeaderLockKeepAlive,
} from "@/lib/provider-endpoints/leader-lock";
import {
  mapWithConcurrency,
  refreshProviderUpstreamBilling,
} from "@/lib/provider-upstream-billing-service";
import { findAllProvidersFresh } from "@/repository/provider";

const TICK_INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 120_000;
const CONCURRENCY = 4;
const LOCK_KEY = "cch:provider-upstream-billing:scheduler:leader";

const schedulerState = globalThis as typeof globalThis & {
  __CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_STARTED__?: boolean;
  __CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_RUNNING__?: boolean;
  __CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_INTERVAL_ID__?: ReturnType<typeof setInterval>;
};

function isDue(
  lastAttemptedAt: Date | null,
  refreshIntervalMinutes: number,
  nowMs: number
): boolean {
  if (refreshIntervalMinutes <= 0) return false;
  if (!lastAttemptedAt) return true;
  return nowMs - lastAttemptedAt.getTime() >= refreshIntervalMinutes * 60_000;
}

export async function runProviderUpstreamBillingRefreshCycle(): Promise<void> {
  if (schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_RUNNING__) return;
  schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_RUNNING__ = true;

  const lock = await acquireLeaderLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock) {
    schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_RUNNING__ = false;
    return;
  }

  let leadershipLost = false;
  const keepAlive = startLeaderLockKeepAlive({
    getLock: () => (leadershipLost ? undefined : lock),
    clearLock: () => {
      leadershipLost = true;
    },
    ttlMs: LOCK_TTL_MS,
    logTag: "ProviderUpstreamBillingScheduler",
    onLost: () => {
      leadershipLost = true;
    },
  });

  try {
    const nowMs = Date.now();
    const providers = (await findAllProvidersFresh()).filter(
      (provider) =>
        provider.isEnabled &&
        provider.upstreamBillingType !== "official" &&
        isDue(
          provider.upstreamBillingLastAttemptedAt,
          provider.upstreamBillingRefreshIntervalMinutes,
          nowMs
        )
    );

    await mapWithConcurrency(providers, CONCURRENCY, async (provider) => {
      if (leadershipLost) return;
      try {
        await refreshProviderUpstreamBilling(provider.id, {
          source: "scheduled",
          minimumIntervalMs: provider.upstreamBillingRefreshIntervalMinutes * 60_000,
          provider,
        });
      } catch (error) {
        logger.warn("Scheduled provider upstream billing refresh failed", {
          providerId: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } catch (error) {
    logger.warn("Provider upstream billing refresh cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    keepAlive.stop();
    await releaseLeaderLock(lock);
    schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_RUNNING__ = false;
  }
}

export function startProviderUpstreamBillingScheduler(): void {
  if (schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_STARTED__) return;
  schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_STARTED__ = true;

  void runProviderUpstreamBillingRefreshCycle();
  const intervalId = setInterval(() => {
    void runProviderUpstreamBillingRefreshCycle();
  }, TICK_INTERVAL_MS);
  intervalId.unref?.();
  schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_INTERVAL_ID__ = intervalId;

  logger.info("Provider upstream billing scheduler started", {
    tickIntervalMs: TICK_INTERVAL_MS,
    concurrency: CONCURRENCY,
  });
}

export function stopProviderUpstreamBillingScheduler(): void {
  const intervalId = schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_INTERVAL_ID__;
  if (intervalId) clearInterval(intervalId);
  schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_INTERVAL_ID__ = undefined;
  schedulerState.__CCH_PROVIDER_UPSTREAM_BILLING_SCHEDULER_STARTED__ = false;
}
