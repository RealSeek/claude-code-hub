import "server-only";

import { publishProviderCacheInvalidation } from "@/lib/cache/provider-cache";
import { clearConfigCache } from "@/lib/circuit-breaker";
import { logger } from "@/lib/logger";
import { enabledProviderApiKeys } from "@/lib/provider-key-dispatch";
import {
  type ProviderUpstreamBillingConfig,
  type ProviderUpstreamBillingKeyResult,
  type ProviderUpstreamBillingResult,
  probeProviderUpstreamBilling,
} from "@/lib/provider-upstream-billing";
import {
  claimProviderUpstreamBillingRefresh,
  findProviderById,
  updateProviderUpstreamBillingSnapshot,
} from "@/repository/provider";
import type { Provider } from "@/types/provider";

const MAX_CONCURRENT_PROBES = 6;
export const REQUEST_TRIGGER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export type ProviderUpstreamBillingRefreshSource = "request" | "scheduled" | "manual";

export interface ProviderUpstreamBillingRefreshResult {
  refreshed: boolean;
  billing: ProviderUpstreamBillingResult | null;
  multiplierSynced: boolean;
  previousMultiplier: number | null;
}

function toProbeConfig(
  provider: Provider,
  key: { id: number | null; key: string; label: string | null }
): ProviderUpstreamBillingConfig {
  return {
    id: provider.id,
    name: provider.name,
    url: provider.url,
    key: key.key,
    keyId: key.id,
    keyLabel: key.label,
    proxyUrl: provider.proxyUrl,
    proxyFallbackToDirect: provider.proxyFallbackToDirect,
    customHeaders: provider.customHeaders,
    upstreamBillingType: provider.upstreamBillingType,
    upstreamBillingAccessToken: provider.upstreamBillingAccessToken,
    upstreamBillingCookie: provider.upstreamBillingCookie,
    upstreamBillingUserId: provider.upstreamBillingUserId,
  };
}

function toProviderProbeConfigs(provider: Provider): ProviderUpstreamBillingConfig[] {
  const keys = enabledProviderApiKeys(provider);
  if (provider.upstreamBillingType === "new-api") {
    if (keys.length > 0) {
      const primary = keys[0];
      return [
        {
          ...toProbeConfig(provider, { id: null, key: primary.key, label: null }),
          providerKeys: keys.map((key) => ({ id: key.id, key: key.key, label: key.label })),
        },
      ];
    }
    if ((provider.apiKeys ?? []).length > 0) return [];
    return [
      {
        ...toProbeConfig(provider, { id: null, key: provider.key, label: null }),
        providerKeys: [{ id: null, key: provider.key, label: "legacy" }],
      },
    ];
  }
  if (keys.length > 0) {
    return keys.map((key) =>
      toProbeConfig(provider, { id: key.id, key: key.key, label: key.label })
    );
  }
  if ((provider.apiKeys ?? []).length > 0) return [];
  return [toProbeConfig(provider, { id: null, key: provider.key, label: "legacy" })];
}

function toKeyResult(result: ProviderUpstreamBillingResult): ProviderUpstreamBillingKeyResult {
  return {
    keyId: result.keyId ?? null,
    keyLabel: result.keyLabel ?? null,
    source: result.source,
    status: result.status,
    balanceUsd: result.balanceUsd,
    balanceRaw: result.balanceRaw,
    balanceScope: result.balanceScope ?? null,
    quotaPerUnit: result.quotaPerUnit,
    effectiveMultiplier: result.effectiveMultiplier,
    observedAt: result.observedAt,
    errorCode: result.errorCode,
  };
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function probeProviderBilling(
  provider: Provider
): Promise<ProviderUpstreamBillingResult> {
  const configs = toProviderProbeConfigs(provider);
  if (configs.length === 0) {
    return {
      providerId: provider.id,
      source: null,
      status: "error",
      balanceUsd: null,
      balanceRaw: null,
      quotaPerUnit: null,
      effectiveMultiplier: null,
      observedAt: new Date().toISOString(),
      errorCode: "no_enabled_keys",
      keys: [],
    };
  }

  const keyResults = await mapWithConcurrency(configs, MAX_CONCURRENT_PROBES, async (config) =>
    toKeyResult(await probeProviderUpstreamBilling(config))
  );
  if (configs.length === 1 && configs[0]?.keyId == null && keyResults[0]) {
    const legacy = keyResults[0];
    return {
      providerId: provider.id,
      source: legacy.source,
      status: legacy.status,
      balanceUsd: legacy.balanceUsd,
      balanceRaw: legacy.balanceRaw,
      balanceScope: legacy.balanceScope ?? null,
      quotaPerUnit: legacy.quotaPerUnit,
      effectiveMultiplier: legacy.effectiveMultiplier,
      observedAt: legacy.observedAt,
      errorCode: legacy.errorCode,
    };
  }

  const successful = keyResults.filter((result) => result.status === "ok");
  const recognized = keyResults.filter(
    (result) => result.status === "ok" || result.status === "partial"
  );
  const source = recognized.find((result) => result.source)?.source ?? null;
  const balancesUsd = successful
    .map((result) => result.balanceUsd)
    .filter((value): value is number => value !== null);
  const balancesRaw = successful
    .map((result) => result.balanceRaw)
    .filter((value): value is number => value !== null);
  const multiplierValues = keyResults
    .map((result) => result.effectiveMultiplier)
    .filter((value): value is number => value !== null);
  const multipliers = [...new Set(multiplierValues)];
  const multiplierInconsistent = multipliers.length > 1;
  const hasCompleteMultiplier = multiplierValues.length === keyResults.length;
  const failedKeyCount = keyResults.length - successful.length;
  const complete = failedKeyCount === 0;
  const hasAccountScopedMultiKeyBalance =
    keyResults.length > 1 && successful.some((result) => result.balanceScope === "account");
  const hasCompleteBalance =
    complete &&
    !hasAccountScopedMultiKeyBalance &&
    balancesUsd.length === successful.length &&
    balancesRaw.length === successful.length;
  const status = complete
    ? "ok"
    : recognized.length > 0
      ? "partial"
      : keyResults.every((result) => result.status === "unsupported")
        ? "unsupported"
        : "error";

  return {
    providerId: provider.id,
    source,
    status,
    balanceUsd:
      hasCompleteBalance && balancesUsd.length > 0
        ? balancesUsd.reduce((sum, value) => sum + value, 0)
        : null,
    balanceRaw:
      hasCompleteBalance && balancesRaw.length > 0
        ? balancesRaw.reduce((sum, value) => sum + value, 0)
        : null,
    balanceScope:
      successful.length === 1
        ? (successful[0]?.balanceScope ?? null)
        : hasAccountScopedMultiKeyBalance
          ? "account"
          : hasCompleteBalance
            ? "key"
            : null,
    quotaPerUnit: successful.find((result) => result.quotaPerUnit !== null)?.quotaPerUnit ?? null,
    effectiveMultiplier:
      !multiplierInconsistent && hasCompleteMultiplier ? (multipliers[0] ?? null) : null,
    observedAt: new Date().toISOString(),
    errorCode: multiplierInconsistent
      ? "inconsistent_multipliers"
      : !complete && recognized.length > 0
        ? "partial_key_probe"
        : successful.length > 0
          ? null
          : (keyResults.find((result) => result.errorCode)?.errorCode ?? "probe_failed"),
    balanceAggregation:
      hasCompleteBalance && successful.length > 0
        ? successful.length > 1
          ? "sum_of_keys"
          : "single_key"
        : "unavailable",
    successfulKeyCount: successful.length,
    failedKeyCount,
    keys: keyResults,
  };
}

function canSyncMultiplier(billing: ProviderUpstreamBillingResult): boolean {
  return (
    (billing.status === "ok" || billing.status === "partial") &&
    billing.effectiveMultiplier !== null
  );
}

export async function refreshProviderUpstreamBilling(
  providerId: number,
  options: {
    source: ProviderUpstreamBillingRefreshSource;
    minimumIntervalMs?: number;
    force?: boolean;
    provider?: Provider;
  }
): Promise<ProviderUpstreamBillingRefreshResult> {
  const provider = options.provider ?? (await findProviderById(providerId));
  if (!provider) {
    return {
      refreshed: false,
      billing: null,
      multiplierSynced: false,
      previousMultiplier: null,
    };
  }

  const claimed = await claimProviderUpstreamBillingRefresh(
    providerId,
    options.minimumIntervalMs ?? REQUEST_TRIGGER_REFRESH_INTERVAL_MS,
    options.force === true
  );
  if (!claimed) {
    return {
      refreshed: false,
      billing: provider.upstreamBillingSnapshot,
      multiplierSynced: false,
      previousMultiplier: provider.costMultiplier,
    };
  }

  const billing = await probeProviderBilling(provider);
  const nextMultiplier = canSyncMultiplier(billing) ? billing.effectiveMultiplier : null;
  const multiplierSynced = nextMultiplier !== null && provider.costMultiplier !== nextMultiplier;
  const saved = await updateProviderUpstreamBillingSnapshot(
    providerId,
    billing,
    multiplierSynced ? nextMultiplier : undefined
  );
  if (!saved) {
    return {
      refreshed: false,
      billing,
      multiplierSynced: false,
      previousMultiplier: provider.costMultiplier,
    };
  }

  if (multiplierSynced) {
    clearConfigCache(providerId);
    await publishProviderCacheInvalidation();
  }

  logger.info("Provider upstream billing refreshed", {
    providerId,
    refreshSource: options.source,
    billingSource: billing.source,
    status: billing.status,
    multiplierSynced,
  });

  return {
    refreshed: true,
    billing,
    multiplierSynced,
    previousMultiplier: provider.costMultiplier,
  };
}
