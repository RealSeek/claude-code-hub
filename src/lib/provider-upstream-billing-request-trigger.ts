import "server-only";

import { logger } from "@/lib/logger";

/**
 * 请求成功路径只投递任务，不等待数据库或上游网络。
 * 动态导入也避免把计费探针及仓储依赖加入代理热路径的同步初始化阶段。
 */
export function triggerProviderUpstreamBillingRefresh(providerId: number | null): void {
  if (providerId == null) return;

  void import("@/lib/provider-upstream-billing-service")
    .then(({ refreshProviderUpstreamBilling, REQUEST_TRIGGER_REFRESH_INTERVAL_MS }) =>
      refreshProviderUpstreamBilling(providerId, {
        source: "request",
        minimumIntervalMs: REQUEST_TRIGGER_REFRESH_INTERVAL_MS,
      })
    )
    .catch((error: unknown) => {
      logger.warn("Provider upstream billing request-triggered refresh failed", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
