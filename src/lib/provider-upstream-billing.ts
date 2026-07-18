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
  upstreamBillingRefreshToken: string | null;
  upstreamBillingCookie: string | null;
  upstreamBillingUserId: string | null;
  /** New-API 账户下需要解析 Token 绑定组的启用 Key。 */
  providerKeys?: Array<{ id: number | null; key: string; label: string | null }>;
  /** sub2api 刷新令牌轮换后立即持久化；凭据不会进入探测结果。 */
  persistSub2ApiTokens?: (accessToken: string, refreshToken: string) => Promise<void>;
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
  includeProviderAuthorization = true,
  requestInit?: Pick<RequestInit, "method" | "body">
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
    method: requestInit?.method ?? "GET",
    headers,
    ...(requestInit?.body !== undefined ? { body: requestInit.body } : {}),
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

interface Sub2ApiAccountResponse {
  result: JsonResponse | null;
  errorCode: string | null;
}

function sub2ApiResponseData(body: unknown): unknown {
  const root = objectValue(body);
  return finiteNumber(root?.code) === 0 ? root?.data : null;
}

function createSub2ApiAccountFetcher(
  config: ProviderUpstreamBillingConfig,
  baseUrl: string,
  fetchImpl: FetchImplementation
): (path: string) => Promise<Sub2ApiAccountResponse> {
  let accessToken = config.upstreamBillingAccessToken?.trim() ?? "";
  let refreshToken = config.upstreamBillingRefreshToken?.trim() ?? "";
  let refreshAttempted = false;

  const refreshAccessToken = async (): Promise<string | null> => {
    if (!refreshToken || refreshAttempted) return "sub2api_auth_token_invalid";
    refreshAttempted = true;
    const refreshed = await fetchJson(
      config,
      `${baseUrl}/api/v1/auth/refresh`,
      fetchImpl,
      { "content-type": "application/json" },
      false,
      { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) }
    );
    if (!refreshed.response.ok) {
      return refreshed.response.status === 401 || refreshed.response.status === 403
        ? "sub2api_refresh_token_invalid"
        : `sub2api_refresh_http_${refreshed.response.status}`;
    }

    const data = objectValue(sub2ApiResponseData(refreshed.body));
    const nextAccessToken = typeof data?.access_token === "string" ? data.access_token.trim() : "";
    const nextRefreshToken =
      typeof data?.refresh_token === "string" ? data.refresh_token.trim() : "";
    if (!nextAccessToken || !nextRefreshToken) return "invalid_sub2api_refresh_response";

    try {
      await config.persistSub2ApiTokens?.(nextAccessToken, nextRefreshToken);
    } catch {
      return "sub2api_token_persist_failed";
    }
    accessToken = nextAccessToken;
    refreshToken = nextRefreshToken;
    return null;
  };

  return async (path: string): Promise<Sub2ApiAccountResponse> => {
    if (!accessToken) {
      const refreshError = await refreshAccessToken();
      if (refreshError) return { result: null, errorCode: refreshError };
    }

    const request = () =>
      fetchJson(
        config,
        `${baseUrl}${path}`,
        fetchImpl,
        { authorization: `Bearer ${accessToken}` },
        false
      );
    let result = await request();
    if (result.response.status === 401) {
      const refreshError = await refreshAccessToken();
      if (refreshError) return { result: null, errorCode: refreshError };
      result = await request();
    }
    if (result.response.status === 401 || result.response.status === 403) {
      return { result, errorCode: "sub2api_auth_token_invalid" };
    }
    return { result, errorCode: null };
  };
}

function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}

function currentMinutesInTimeZone(timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

async function resolveLegacySub2ApiMultiplier(
  config: ProviderUpstreamBillingConfig,
  baseUrl: string,
  fetchImpl: FetchImplementation
): Promise<{ effectiveMultiplier: number | null; errorCode: string | null }> {
  if (!config.upstreamBillingAccessToken?.trim() && !config.upstreamBillingRefreshToken?.trim()) {
    return { effectiveMultiplier: null, errorCode: "sub2api_account_credentials_missing" };
  }

  const accountFetch = createSub2ApiAccountFetcher(config, baseUrl, fetchImpl);
  let matchedKey: Record<string, unknown> | null = null;
  for (let page = 1; page <= 10 && !matchedKey; page++) {
    const keys = await accountFetch(`/api/v1/keys?page=${page}&page_size=100`);
    if (keys.errorCode) return { effectiveMultiplier: null, errorCode: keys.errorCode };
    if (!keys.result?.response.ok) {
      return {
        effectiveMultiplier: null,
        errorCode: `sub2api_keys_http_${keys.result?.response.status ?? 0}`,
      };
    }
    const pageData = objectValue(sub2ApiResponseData(keys.result.body));
    const items = Array.isArray(pageData?.items) ? pageData.items : null;
    if (!items) return { effectiveMultiplier: null, errorCode: "invalid_sub2api_keys_response" };
    matchedKey =
      items
        .map(objectValue)
        .find((item): item is Record<string, unknown> => item?.key === config.key) ?? null;
    const total = finiteNumber(pageData?.total) ?? 0;
    if (page * 100 >= total) break;
  }
  if (!matchedKey) return { effectiveMultiplier: null, errorCode: "sub2api_key_not_found" };

  const apiKeyId = finiteNumber(matchedKey.id);
  const groupId = finiteNumber(matchedKey.group_id);
  if (apiKeyId === null || groupId === null) {
    return { effectiveMultiplier: null, errorCode: "sub2api_key_group_missing" };
  }

  // 顺序读取可避免过期 JWT 触发并发刷新，导致一次性 Refresh Token 被重复消费。
  const groups = await accountFetch("/api/v1/groups/available");
  const rates = await accountFetch("/api/v1/groups/rates");
  const latestUsage = await accountFetch(
    `/api/v1/usage?api_key_id=${apiKeyId}&page=1&page_size=1&sort_by=created_at&sort_order=desc`
  );
  for (const response of [groups, rates, latestUsage]) {
    if (response.errorCode) {
      return { effectiveMultiplier: null, errorCode: response.errorCode };
    }
  }

  if (!groups.result?.response.ok) {
    return {
      effectiveMultiplier: null,
      errorCode: `sub2api_groups_http_${groups.result?.response.status ?? 0}`,
    };
  }
  const groupItems = sub2ApiResponseData(groups.result.body);
  const group = Array.isArray(groupItems)
    ? groupItems
        .map(objectValue)
        .find((item): item is Record<string, unknown> => finiteNumber(item?.id) === groupId)
    : null;
  if (!group) return { effectiveMultiplier: null, errorCode: "sub2api_group_not_found" };

  const groupMultiplier = finiteNumber(group.rate_multiplier);
  if (groupMultiplier === null || groupMultiplier < 0) {
    return { effectiveMultiplier: null, errorCode: "invalid_multiplier" };
  }
  let effectiveMultiplier = groupMultiplier;

  if (rates.result?.response.ok) {
    const rateMap = objectValue(sub2ApiResponseData(rates.result.body));
    const userMultiplier = finiteNumber(rateMap?.[String(groupId)]);
    if (userMultiplier !== null && userMultiplier >= 0) effectiveMultiplier = userMultiplier;
  }

  const usageData = objectValue(sub2ApiResponseData(latestUsage.result?.body));
  const usageItems = Array.isArray(usageData?.items) ? usageData.items : [];
  const latestMultiplier = finiteNumber(objectValue(usageItems[0])?.rate_multiplier);
  if (latestMultiplier !== null && latestMultiplier >= 0) effectiveMultiplier = latestMultiplier;

  if (group.peak_rate_enabled === true && latestMultiplier === null) {
    const settings = await fetchJson(
      config,
      `${baseUrl}/api/v1/settings/public`,
      fetchImpl,
      undefined,
      false
    );
    const settingsData = objectValue(sub2ApiResponseData(settings.body));
    const timeZone =
      typeof settingsData?.server_timezone === "string" ? settingsData.server_timezone : "";
    const nowMinutes = currentMinutesInTimeZone(timeZone);
    const startMinutes = parseClockMinutes(group.peak_start);
    const endMinutes = parseClockMinutes(group.peak_end);
    const peakMultiplier = finiteNumber(group.peak_rate_multiplier);
    if (
      nowMinutes === null ||
      startMinutes === null ||
      endMinutes === null ||
      startMinutes >= endMinutes ||
      peakMultiplier === null ||
      peakMultiplier < 0
    ) {
      return { effectiveMultiplier: null, errorCode: "sub2api_peak_multiplier_dynamic" };
    }
    if (nowMinutes >= startMinutes && nowMinutes < endMinutes) {
      effectiveMultiplier *= peakMultiplier;
    }
  }

  return { effectiveMultiplier, errorCode: null };
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
  const directMultiplier =
    response.ok && isSub2Api ? finiteNumber(payload.effective_rate_multiplier) : null;

  const usage = await fetchJson(config, `${baseUrl}/v1/usage`, fetchImpl);
  const usagePayload = objectValue(usage.body);
  const balance =
    usage.response.ok && usagePayload ? extractSub2ApiUsageBalance(usagePayload) : null;
  if (balance && balance.balanceUsd < 0) {
    return {
      ...resultBase(config.id),
      source: "sub2api",
      status: "partial",
      effectiveMultiplier: directMultiplier,
      observedAt:
        typeof payload?.observed_at === "string" ? payload.observed_at : new Date().toISOString(),
      errorCode: "invalid_balance",
    };
  }

  const fallbackMultiplier =
    directMultiplier === null
      ? await resolveLegacySub2ApiMultiplier(config, baseUrl, fetchImpl)
      : { effectiveMultiplier: directMultiplier, errorCode: null };
  const effectiveMultiplier = fallbackMultiplier.effectiveMultiplier;
  const recognized = isSub2Api || balance !== null || effectiveMultiplier !== null;
  if (!recognized && !strict) return null;

  const status =
    balance !== null && effectiveMultiplier !== null
      ? "ok"
      : recognized
        ? "partial"
        : response.status === 404 || response.status === 405
          ? "unsupported"
          : "error";
  const errorCode =
    status === "ok"
      ? null
      : (fallbackMultiplier.errorCode ??
        (balance === null
          ? usage.response.ok
            ? "balance_unavailable"
            : `balance_upstream_http_${usage.response.status}`
          : response.status === 404 || response.status === 405
            ? "unsupported_upstream_multiplier"
            : response.ok
              ? "invalid_sub2api_response"
              : `upstream_http_${response.status}`));

  return {
    ...resultBase(config.id),
    source: "sub2api",
    status,
    balanceUsd: balance?.balanceUsd ?? null,
    balanceRaw: balance?.balanceUsd ?? null,
    balanceScope: balance?.balanceScope ?? null,
    effectiveMultiplier,
    observedAt:
      typeof payload?.observed_at === "string" ? payload.observed_at : new Date().toISOString(),
    errorCode,
  };
}

interface NewApiMaskedToken {
  key: string;
  group: string;
}

const NEW_API_TOKEN_PAGE_SIZE = 100;
const NEW_API_TOKEN_MAX_PAGES = 10;

function getNewApiCredentialErrorCode(response: Response, usesCookie: boolean): string | null {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const authenticationRejected =
    response.status === 401 ||
    response.status === 403 ||
    response.redirected ||
    contentType.includes("text/html");

  if (!authenticationRejected) return null;
  return usesCookie ? "new_api_cookie_invalid" : "new_api_access_token_invalid";
}

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
  accountHeaders: HeadersInit,
  usesCookie: boolean
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
    const credentialErrorCode = getNewApiCredentialErrorCode(result.response, usesCookie);
    if (credentialErrorCode) {
      return { tokens: [], errorCode: credentialErrorCode };
    }
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
  const credentialErrorCode = getNewApiCredentialErrorCode(account.response, Boolean(cookie));
  if (credentialErrorCode) {
    return {
      ...resultBase(config.id),
      source: "new-api",
      status: "error",
      effectiveMultiplier: null,
      errorCode: credentialErrorCode,
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
  const groupsCredentialErrorCode = getNewApiCredentialErrorCode(
    groupsResponse.response,
    Boolean(cookie)
  );
  if (groupsCredentialErrorCode) {
    return {
      ...balanceResult,
      status: "error",
      effectiveMultiplier: null,
      errorCode: groupsCredentialErrorCode,
    };
  }
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

  const tokenResult = await fetchNewApiTokens(
    config,
    baseUrl,
    fetchImpl,
    accountHeaders,
    Boolean(cookie)
  );
  if (tokenResult.errorCode) {
    return {
      ...balanceResult,
      status:
        tokenResult.errorCode === "new_api_cookie_invalid" ||
        tokenResult.errorCode === "new_api_access_token_invalid"
          ? "error"
          : "partial",
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
  if (config.upstreamBillingType === "official") {
    return withKeyMetadata({
      ...resultBase(config.id),
      source: null,
      status: "unsupported",
      effectiveMultiplier: null,
      errorCode: "official_billing_disabled",
    });
  }
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
