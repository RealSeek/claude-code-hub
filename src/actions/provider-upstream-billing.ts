"use server";

import { getSession } from "@/lib/auth";
import type { ProviderUpstreamBillingResult } from "@/lib/provider-upstream-billing";
import {
  mapWithConcurrency,
  refreshProviderUpstreamBilling,
} from "@/lib/provider-upstream-billing-service";
import { findProviderById } from "@/repository/provider";
import type { Provider } from "@/types/provider";
import type { ActionResult } from "./types";

const MAX_CONCURRENT_PROBES = 6;

async function requireAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.user.role === "admin";
}

export async function getProviderUpstreamBillingBatch(
  providerIds: number[]
): Promise<ActionResult<ProviderUpstreamBillingResult[]>> {
  if (!(await requireAdmin())) return { ok: false, error: "无权限执行此操作" };

  const uniqueIds = [...new Set(providerIds)];
  const providers = (await Promise.all(uniqueIds.map((id) => findProviderById(id)))).filter(
    (provider): provider is Provider =>
      provider !== null && provider.upstreamBillingType !== "official"
  );

  const items = await mapWithConcurrency(
    providers,
    MAX_CONCURRENT_PROBES,
    async (provider): Promise<ProviderUpstreamBillingResult> => {
      if (provider.upstreamBillingSnapshot) return provider.upstreamBillingSnapshot;

      const refreshed = await refreshProviderUpstreamBilling(provider.id, {
        source: "manual",
        force: true,
        provider,
      });
      return (
        refreshed.billing ?? {
          providerId: provider.id,
          source: null,
          status: "error",
          balanceUsd: null,
          balanceRaw: null,
          quotaPerUnit: null,
          effectiveMultiplier: null,
          observedAt: new Date().toISOString(),
          errorCode: "probe_failed",
        }
      );
    }
  );
  return { ok: true, data: items };
}

export interface SyncProviderCostMultiplierResult extends ProviderUpstreamBillingResult {
  previousMultiplier: number;
  synced: boolean;
}

export async function syncProviderCostMultiplier(
  providerId: number
): Promise<ActionResult<SyncProviderCostMultiplierResult>> {
  if (!(await requireAdmin())) return { ok: false, error: "无权限执行此操作" };

  const provider = await findProviderById(providerId);
  if (!provider) return { ok: false, error: "供应商不存在" };
  if (provider.upstreamBillingType === "official") {
    return { ok: false, error: "官方渠道不查询上游余额和倍率" };
  }

  const refreshed = await refreshProviderUpstreamBilling(providerId, {
    source: "manual",
    force: true,
    provider,
  });
  const billing = refreshed.billing;
  if (!billing) return { ok: false, error: "供应商不存在" };
  if (
    (billing.status !== "ok" && billing.status !== "partial") ||
    billing.effectiveMultiplier === null
  ) {
    return { ok: false, error: billing.errorCode ?? "上游未返回可同步的倍率" };
  }

  const previousMultiplier = refreshed.previousMultiplier ?? provider.costMultiplier;
  const synced = refreshed.multiplierSynced;

  return {
    ok: true,
    data: {
      ...billing,
      previousMultiplier,
      synced,
    },
  };
}
