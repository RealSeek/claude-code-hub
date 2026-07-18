import "server-only";

import {
  getGlobalAgentPool,
  getProxyAgentForProvider,
  type ProviderProxyConfig,
} from "@/lib/proxy-agent";
import type { ProviderUpstreamBillingType } from "@/types/provider";

const UPSTREAM_BILLING_TIMEOUT_MS = 10_000;

export type ProviderUpstreamBillingSource = "new-api" | "sub2api";
export type ProviderUpstreamBillingStatus = "ok" | "partial" | "unsupported" | "error";
export type ProviderBalanceAggregation = "single_key" | "sum_of_keys" | "unavailable";
export type ProviderBalanceScope = "key" | "account";

export interface ProviderUpstreamBillingKeyResult {
  keyId: number | null;
  keyLabel: string | null;
  source: ProviderUpstreamBillingSource | null;
  status: ProviderUpstreamBillingStatus;
  balanceUsd: number | null;
  balanceRaw: number | null;
  balanceScope?: ProviderBalanceScope | null;
  quotaPerUnit: number | null;
  effectiveMultiplier: number | null;
  observedAt: string;
  errorCode: string | null;
}

export interface ProviderUpstreamBillingResult {
  providerId: number;
  keyId?: number | null;
  keyLabel?: string | null;
  source: ProviderUpstreamBillingSource | null;
  status: ProviderUpstreamBillingStatus;
  balanceUsd: number | null;
  balanceRaw: number | null;
  balanceScope?: ProviderBalanceScope | null;
  quotaPerUnit: number | null;
  effectiveMultiplier: number | null;
  observedAt: string;
  errorCode: string | null;
  balanceAggregation?: ProviderBalanceAggregation;
  successfulKeyCount?: number;
  failedKeyCount?: number;
  keys?: ProviderUpstreamBillingKeyResult[];
}

export interface ProviderUpstreamBillingConfig {
  id: number;
  name: string;
  url: string;
  key: string;
  keyId?: number | null;
  keyLabel?: string | null;
  proxyUrl: string | null;
  proxyFallbackToDirect: boolean;
  customHeaders: Record<string, string> | null;
  upstreamBillingType: ProviderUpstreamBillingType;
  upstreamBillingAccessToken: string | null;
  upstreamBillingCookie: string | null;
  upstreamBillingUserId: string | null;
  /** New-API 账户下需要解析 Token 绑定组的全部启用 Key。 */
  providerKeys?: Array<{ id: number | null; key: string; label: string | null }>;
}

interface UndiciFetchOptions extends RequestInit {
  dispatcher?: unknown;
}

type FetchImplementation = typeof fetch;

interface JsonResponse {
  response: Response;
  body: unknown;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultBase(
  providerId: number
): Pick<
  ProviderUpstreamBillingResult,
  "providerId" | "balanceUsd" | "balanceRaw" | "quotaPerUnit" | "observedAt"
> {
  return {
    providerId,
    balanceUsd: null,
    balanceRaw: null,
    quotaPerUnit: null,
    observedAt: new Date().toISOString(),
  };
}

export function resolveProviderBillingBaseUrl(providerUrl: string): string {
  const url = new URL(providerUrl);
  url.search = "";
  url.hash = "";

  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const knownApiSuffix = /\/(?:v1|api|anthropic|openai|responses)$/i;
  let basePath = trimmedPath;
  while (knownApiSuffix.test(basePath)) {
    basePath = basePath.replace(knownApiSuffix, "");
  }
  url.pathname = basePath || "/";

  return url.toString().replace(/\/$/, "");
}

function buildHeaders(
  config: ProviderUpstreamBillingConfig,
  includeProviderAuthorization: boolean
): Headers {
  const headers = new Headers(config.customHeaders ?? undefined);
  headers.set("accept", "application/json");
  if (includeProviderAuthorization) {
    headers.set("authorization", `Bearer ${config.key}`);
  } else {
    headers.delete("authorization");
  }
  return headers;
}

async function fetchJson(
  config: ProviderUpstreamBillingConfig,
  url: string,
  fetchImpl: FetchImplementation,
  headerOverrides?: HeadersInit,
  includeProviderAuthorization = true
): Promise<JsonResponse> {
  const proxyConfig: ProviderProxyConfig = {
    id: config.id,
    name: config.name,
    proxyUrl: config.proxyUrl,
    proxyFallbackToDirect: config.proxyFallbackToDirect,
  };
  const proxy = await getProxyAgentForProvider(proxyConfig, url);
  const headers = buildHeaders(config, includeProviderAuthorization);
  if (headerOverrides) {
    new Headers(headerOverrides).forEach((value, key) => headers.set(key, value));
  }
  const init: UndiciFetchOptions = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(UPSTREAM_BILLING_TIMEOUT_MS),
    cache: "no-store",
  };
  if (proxy) init.dispatcher = proxy.agent;

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (!proxy?.fallbackToDirect) throw error;
      const directInit = { ...init };
      delete directInit.dispatcher;
      response = await fetchImpl(url, directInit);
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // 非 JSON 响应由调用方根据状态码判断是否继续探测。
    }
    return { response, body };
  } finally {
    if (proxy) {
      getGlobalAgentPool().releaseAgent(proxy.cacheKey, proxy.dispatcherId);
    }
  }
}

function extractSub2ApiUsageBalance(
  body: Record<string, unknown>
): { balanceUsd: number; balanceScope: ProviderBalanceScope } | null {
  const mode = body.mode;
  const remaining = finiteNumber(body.remaining);
  if (remaining !== null) {
    return {
      balanceUsd: remaining,
      balanceScope: mode === "quota_limited" ? "key" : "account",
    };
  }

  const quotaRemaining = finiteNumber(objectValue(body.quota)?.remaining);
  if (quotaRemaining !== null) {
    return { balanceUsd: quotaRemaining, balanceScope: "key" };
  }

  const balance = finiteNumber(body.balance);
  return balance === null ? null : { balanceUsd: balance, balanceScope: "account" };
}

async function probeSub2Api(
  config: ProviderUpstreamBillingConfig,
  baseUrl: string,
  fetchImpl: FetchImplementation,
  strict: boolean
): Promise<ProviderUpstreamBillingResult | null> {
  const { response, body } = await fetchJson(config, `${baseUrl}/v1/sub2api/billing`, fetchImpl);

  const payload = objectValue(body);
  const isSub2Api = payload?.object === "sub2api.key_billing";
  if (!isSub2Api) {
    if (!strict) return null;
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: response.status === 404 || response.status === 405 ? "unsupported" : "error",
      effectiveMultiplier: null,
      errorCode:
        response.status === 404 || response.status === 405
          ? "unsupported_upstream"
          : response.ok
            ? "invalid_sub2api_response"
            : `upstream_http_${response.status}`,
    };
  }

  if (!response.ok) {
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: `upstream_http_${response.status}`,
    };
  }

  if (!payload || !isSub2Api) return null;
  const effectiveMultiplier = finiteNumber(payload.effective_rate_multiplier);
  if (effectiveMultiplier === null || effectiveMultiplier < 0) {
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: "invalid_multiplier",
    };
  }

  const usage = await fetchJson(config, `${baseUrl}/v1/usage`, fetchImpl);
  if (!usage.response.ok) {
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: "partial",
      effectiveMultiplier,
      observedAt:
        typeof payload.observed_at === "string" ? payload.observed_at : new Date().toISOString(),
      errorCode: `balance_upstream_http_${usage.response.status}`,
    };
  }

  const usagePayload = objectValue(usage.body);
  const balance = usagePayload ? extractSub2ApiUsageBalance(usagePayload) : null;
  if (balance && balance.balanceUsd < 0) {
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: "partial",
      effectiveMultiplier,
      observedAt:
        typeof payload.observed_at === "string" ? payload.observed_at : new Date().toISOString(),
      errorCode: "invalid_balance",
    };
  }

  return {
    ...resultBase(config.id),
    source: "sub2api",
    status: balance ? "ok" : "partial",
    balanceUsd: balance?.balanceUsd ?? null,
    balanceRaw: balance?.balanceUsd ?? null,
    balanceScope: balance?.balanceScope ?? null,
    effectiveMultiplier,
    observedAt:
      typeof payload.observed_at === "string" ? payload.observed_at : new Date().toISOString(),
    errorCode: balance ? null : "balance_unavailable",
  };
}

interface NewApiMaskedToken {
  key: string;
  group: string;
}

const NEW_API_TOKEN_PAGE_SIZE = 100;
const NEW_API_TOKEN_MAX_PAGES = 10;

function maskNewApiTokenKey(value: string): string {
  const key = value.startsWith("sk-") ? value.slice(3) : value;
  if (key.length <= 4) return "*".repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}**********${key.slice(-4)}`;
}

async function fetchNewApiTokens(
  config: ProviderUpstreamBillingConfig,
  baseUrl: string,
  fetchImpl: FetchImplementation,
  accountHeaders: HeadersInit
): Promise<{ tokens: NewApiMaskedToken[]; errorCode: string | null }> {
  const tokens: NewApiMaskedToken[] = [];

  for (let page = 1; page <= NEW_API_TOKEN_MAX_PAGES; page++) {
    const result = await fetchJson(
      config,
      `${baseUrl}/api/token/?p=${page}&page_size=${NEW_API_TOKEN_PAGE_SIZE}`,
      fetchImpl,
      accountHeaders,
      false
    );
    if (!result.response.ok) {
      return {
        tokens: [],
        errorCode: `token_list_upstream_http_${result.response.status}`,
      };
    }

    const root = objectValue(result.body);
    const data = objectValue(root?.data);
    const items = Array.isArray(data?.items) ? data.items : null;
    const total = finiteNumber(data?.total);
    if (root?.success !== true || !items || total === null || total < 0) {
      return { tokens: [], errorCode: "invalid_token_list_response" };
    }
    if (total > NEW_API_TOKEN_PAGE_SIZE * NEW_API_TOKEN_MAX_PAGES) {
      return { tokens: [], errorCode: "too_many_new_api_tokens" };
    }

    for (const item of items) {
      const token = objectValue(item);
      if (typeof token?.key !== "string") continue;
      tokens.push({
        key: token.key,
        group: typeof token.group === "string" ? token.group : "",
      });
    }

    if (tokens.length >= total || items.length < NEW_API_TOKEN_PAGE_SIZE) {
      return { tokens, errorCode: null };
    }
  }

  return { tokens: [], errorCode: "incomplete_token_list" };
}

function resolveNewApiTokenGroupMultiplier(input: {
  accountGroup: string;
  groupData: Record<string, unknown>;
  tokens: NewApiMaskedToken[];
  providerKeys: Array<{ id: number | null; key: string; label: string | null }>;
}): { effectiveMultiplier: number | null; errorCode: string | null } {
  if (input.providerKeys.length === 0) {
    return { effectiveMultiplier: null, errorCode: "no_enabled_keys" };
  }

  const tokensByMaskedKey = new Map<string, NewApiMaskedToken[]>();
  for (const token of input.tokens) {
    const matches = tokensByMaskedKey.get(token.key) ?? [];
    matches.push(token);
    tokensByMaskedKey.set(token.key, matches);
  }

  const multipliers: number[] = [];
  for (const providerKey of input.providerKeys) {
    const matches = tokensByMaskedKey.get(maskNewApiTokenKey(providerKey.key)) ?? [];
    if (matches.length === 0) {
      return { effectiveMultiplier: null, errorCode: "new_api_token_not_found" };
    }
    if (matches.length > 1) {
      return { effectiveMultiplier: null, errorCode: "new_api_token_match_ambiguous" };
    }

    const targetGroup = matches[0]?.group.trim() || input.accountGroup.trim();
    if (!targetGroup) {
      return { effectiveMultiplier: null, errorCode: "new_api_token_group_missing" };
    }
    if (targetGroup === "auto") {
      return { effectiveMultiplier: null, errorCode: "new_api_token_group_dynamic" };
    }

    const ratio = finiteNumber(objectValue(input.groupData[targetGroup])?.ratio);
    if (ratio === null || ratio < 0) {
      return { effectiveMultiplier: null, errorCode: "new_api_group_ratio_unavailable" };
    }
    multipliers.push(ratio);
  }

  const uniqueMultipliers = [...new Set(multipliers)];
  return uniqueMultipliers.length === 1
    ? { effectiveMultiplier: uniqueMultipliers[0] ?? null, errorCode: null }
    : { effectiveMultiplier: null, errorCode: "inconsistent_multipliers" };
}

async function probeNewApi(
  config: ProviderUpstreamBillingConfig,
  baseUrl: string,
  fetchImpl: FetchImplementation
): Promise<ProviderUpstreamBillingResult> {
  const cookie = config.upstreamBillingCookie?.trim();
  const accessToken = config.upstreamBillingAccessToken?.trim();
  const userId = config.upstreamBillingUserId?.trim();
  if ((!cookie && !accessToken) || !userId) {
    return {
      ...resultBase(config.id),
      source: "new-api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: "missing_new_api_account_credentials",
    };
  }

  const accountHeaders = {
    ...(cookie ? { cookie } : { authorization: `Bearer ${accessToken}` }),
    "new-api-user": userId,
    "user-agent": "cc-switch/1.0",
  };
  const account = await fetchJson(
    config,
    `${baseUrl}/api/user/self`,
    fetchImpl,
    accountHeaders,
    false
  );
  if (account.response.status === 404 || account.response.status === 405) {
    return {
      ...resultBase(config.id),
      source: null,
      status: "unsupported",
      effectiveMultiplier: null,
      errorCode: "unsupported_upstream",
    };
  }
  if (!account.response.ok) {
    return {
      ...resultBase(config.id),
      source: "new-api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: `upstream_http_${account.response.status}`,
    };
  }

  const accountRoot = objectValue(account.body);
  const accountData = objectValue(accountRoot?.data);
  const quota = finiteNumber(accountData?.quota);
  if (accountRoot?.success !== true || quota === null || quota < 0) {
    return {
      ...resultBase(config.id),
      source: "new-api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: "invalid_balance",
    };
  }

  const quotaPerUnit = 500_000;
  const balanceResult = {
    ...resultBase(config.id),
    source: "new-api" as const,
    balanceRaw: quota,
    balanceScope: "account" as const,
    quotaPerUnit,
    balanceUsd: quota / quotaPerUnit,
  };

  const groupsResponse = await fetchJson(
    config,
    `${baseUrl}/api/user/self/groups`,
    fetchImpl,
    accountHeaders,
    false
  );
  if (!groupsResponse.response.ok) {
    return {
      ...balanceResult,
      status: "partial",
      effectiveMultiplier: null,
      errorCode: `group_ratio_upstream_http_${groupsResponse.response.status}`,
    };
  }

  const groupRoot = objectValue(groupsResponse.body);
  const groupData = objectValue(groupRoot?.data);
  if (groupRoot?.success !== true || !groupData) {
    return {
      ...balanceResult,
      status: "partial",
      effectiveMultiplier: null,
      errorCode: "invalid_group_ratio_response",
    };
  }

  const tokenResult = await fetchNewApiTokens(config, baseUrl, fetchImpl, accountHeaders);
  if (tokenResult.errorCode) {
    return {
      ...balanceResult,
      status: "partial",
      effectiveMultiplier: null,
      errorCode: tokenResult.errorCode,
    };
  }

  const multiplier = resolveNewApiTokenGroupMultiplier({
    accountGroup: typeof accountData?.group === "string" ? accountData.group : "",
    groupData,
    tokens: tokenResult.tokens,
    providerKeys: config.providerKeys ?? [
      { id: config.keyId ?? null, key: config.key, label: null },
    ],
  });

  return {
    ...balanceResult,
    status: multiplier.effectiveMultiplier === null ? "partial" : "ok",
    effectiveMultiplier: multiplier.effectiveMultiplier,
    errorCode: multiplier.errorCode,
  };
}

export async function probeProviderUpstreamBilling(
  config: ProviderUpstreamBillingConfig,
  fetchImpl: FetchImplementation = fetch
): Promise<ProviderUpstreamBillingResult> {
  const withKeyMetadata = (
    result: ProviderUpstreamBillingResult
  ): ProviderUpstreamBillingResult => ({
    ...result,
    keyId: config.keyId ?? null,
    keyLabel: config.keyLabel ?? null,
  });
  let baseUrl: string;
  try {
    baseUrl = resolveProviderBillingBaseUrl(config.url);
  } catch {
    return withKeyMetadata({
      ...resultBase(config.id),
      source: null,
      status: "error",
      effectiveMultiplier: null,
      errorCode: "invalid_provider_url",
    });
  }

  try {
    if (config.upstreamBillingType === "sub2api") {
      const result = await probeSub2Api(config, baseUrl, fetchImpl, true);
      return withKeyMetadata(
        result ?? {
          ...resultBase(config.id),
          source: "sub2api",
          status: "error",
          effectiveMultiplier: null,
          errorCode: "invalid_sub2api_response",
        }
      );
    }
    if (config.upstreamBillingType === "new-api") {
      return withKeyMetadata(await probeNewApi(config, baseUrl, fetchImpl));
    }

    const sub2api = await probeSub2Api(config, baseUrl, fetchImpl, false);
    if (sub2api) return withKeyMetadata(sub2api);
    return withKeyMetadata(await probeNewApi(config, baseUrl, fetchImpl));
  } catch (error) {
    return withKeyMetadata({
      ...resultBase(config.id),
      source: null,
      status: "error",
      effectiveMultiplier: null,
      errorCode:
        error instanceof DOMException && error.name === "TimeoutError"
          ? "timeout"
          : "request_failed",
    });
  }
}
