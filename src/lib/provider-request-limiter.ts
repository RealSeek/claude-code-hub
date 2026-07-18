import { getRedisClient } from "@/lib/redis";
import {
  ACQUIRE_PROVIDER_REQUEST,
  RELEASE_PROVIDER_REQUEST,
} from "@/lib/redis/lua-scripts";

const RPM_WINDOW_MS = 60_000;
const ACTIVE_REQUEST_TTL_MS = 10 * 60_000;

type LocalProviderState = {
  active: Map<string, number>;
  rpm: Map<string, number>;
};

type ProviderRequestLimitOptions = {
  providerId: number;
  rpmLimit?: number | null;
  concurrencyLimit?: number | null;
  requestId?: string;
  now?: number;
};

export type ProviderRequestLease = {
  requestId: string;
  release: () => Promise<void>;
};

export type ProviderRequestAcquireResult =
  | { allowed: true; lease: ProviderRequestLease; current: number; rpmCurrent: number }
  | {
      allowed: false;
      reason: "rpm" | "concurrency";
      current: number;
      rpmCurrent: number;
      retryAfterMs: number;
    };

const localStates = new Map<number, LocalProviderState>();

function getLocalState(providerId: number): LocalProviderState {
  let state = localStates.get(providerId);
  if (!state) {
    state = { active: new Map(), rpm: new Map() };
    localStates.set(providerId, state);
  }
  return state;
}

function normalizeLimit(value: number | null | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : 0;
}

function makeRequestId(providerId: number): string {
  return `${providerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function acquireLocal(
  options: Required<Pick<ProviderRequestLimitOptions, "providerId" | "now" | "requestId">> & {
    rpmLimit: number;
    concurrencyLimit: number;
  }
): ProviderRequestAcquireResult {
  const state = getLocalState(options.providerId);
  const activeCutoff = options.now - ACTIVE_REQUEST_TTL_MS;
  for (const [id, startedAt] of state.active) {
    if (startedAt <= activeCutoff) state.active.delete(id);
  }
  const rpmCutoff = options.now - RPM_WINDOW_MS;
  for (const [id, startedAt] of state.rpm) {
    if (startedAt <= rpmCutoff) state.rpm.delete(id);
  }

  const current = state.active.size;
  const alreadyActive = state.active.has(options.requestId);
  const alreadyRpm = state.rpm.has(options.requestId);
  if (options.concurrencyLimit > 0 && !alreadyActive && current >= options.concurrencyLimit) {
    const oldest = Math.min(...state.active.values());
    return {
      allowed: false,
      reason: "concurrency",
      current,
      rpmCurrent: state.rpm.size,
      retryAfterMs: Math.max(1, oldest + ACTIVE_REQUEST_TTL_MS - options.now),
    };
  }
  const rpmCurrent = state.rpm.size;
  if (options.rpmLimit > 0 && !alreadyRpm && rpmCurrent >= options.rpmLimit) {
    const oldest = Math.min(...state.rpm.values());
    return {
      allowed: false,
      reason: "rpm",
      current,
      rpmCurrent,
      retryAfterMs: Math.max(1, oldest + RPM_WINDOW_MS - options.now),
    };
  }

  if (!alreadyActive) state.active.set(options.requestId, options.now);
  if (!alreadyRpm) state.rpm.set(options.requestId, options.now);
  let released = false;
  return {
    allowed: true,
    current: state.active.size,
    rpmCurrent: state.rpm.size,
    lease: {
      requestId: options.requestId,
      release: async () => {
        if (released) return;
        released = true;
        state.active.delete(options.requestId);
      },
    },
  };
}

export class ProviderRequestLimitError extends Error {
  constructor(
    public readonly providerId: number,
    public readonly reason: "rpm" | "concurrency",
    public readonly retryAfterMs: number,
    public readonly current: number,
    public readonly rpmCurrent: number
  ) {
    super(
      reason === "rpm"
        ? `供应商每分钟请求数已达到上限（${rpmCurrent}）`
        : `供应商并发请求数已达到上限（${current}）`
    );
    this.name = "ProviderRequestLimitError";
  }
}

export async function acquireProviderRequest(
  input: ProviderRequestLimitOptions
): Promise<ProviderRequestAcquireResult> {
  const providerId = input.providerId;
  const requestId = input.requestId ?? makeRequestId(providerId);
  const now = input.now ?? Date.now();
  const rpmLimit = normalizeLimit(input.rpmLimit);
  const concurrencyLimit = normalizeLimit(input.concurrencyLimit);

  if (rpmLimit === 0 && concurrencyLimit === 0) {
    return {
      allowed: true,
      current: 0,
      rpmCurrent: 0,
      lease: { requestId, release: async () => undefined },
    };
  }

  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") {
    return acquireLocal({ providerId, requestId, now, rpmLimit, concurrencyLimit });
  }

  try {
    const result = (await redis.eval(
      ACQUIRE_PROVIDER_REQUEST,
      2,
      `provider:{${providerId}}:active_requests`,
      `provider:{${providerId}}:rpm_window`,
      requestId,
      String(rpmLimit),
      String(concurrencyLimit),
      String(now),
      String(ACTIVE_REQUEST_TTL_MS),
      String(RPM_WINDOW_MS)
    )) as [number | string, number | string, number | string, number | string, number | string];
    const allowed = Number(result[0]) === 1;
    const reason = Number(result[1]);
    if (!allowed) {
      return {
        allowed: false,
        reason: reason === 2 ? "rpm" : "concurrency",
        current: Number(result[2]) || 0,
        rpmCurrent: Number(result[3]) || 0,
        retryAfterMs: Math.max(1, Number(result[4]) || 1),
      };
    }

    let released = false;
    return {
      allowed: true,
      current: Number(result[2]) || 0,
      rpmCurrent: Number(result[3]) || 0,
      lease: {
        requestId,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await redis.eval(
              RELEASE_PROVIDER_REQUEST,
              1,
              `provider:{${providerId}}:active_requests`,
              requestId
            );
          } catch {
            // TTL 会最终回收槽位；释放失败不能影响客户端响应。
          }
        },
      },
    };
  } catch {
    // Redis 故障时保留单实例限流能力，避免整条请求链被 Redis 故障阻断。
    return acquireLocal({ providerId, requestId, now, rpmLimit, concurrencyLimit });
  }
}

export function wrapProviderResponseBody(response: Response, lease: ProviderRequestLease): Response {
  if (!response.body) {
    void lease.release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await lease.release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        await release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function clearLocalProviderRequestLimiter(): void {
  localStates.clear();
}
