import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";
import {
  areAllProviderApiKeysCooled,
  clearProviderApiKeyDispatchStates,
  hasReadyProviderApiKey,
  hasUsableProviderApiKey,
  readyProviderApiKeyCount,
  recordProviderApiKeyFailure,
  recordProviderApiKeySuccess,
  resetProviderKeyDispatchState,
  selectProviderApiKey,
} from "@/lib/provider-key-dispatch";

function provider(): Provider {
  return {
    id: 7,
    name: "multi-key",
    url: "https://example.com",
    key: "legacy-key",
    keyStrategy: "round_robin",
    apiKeys: [
      {
        id: 101,
        providerId: 7,
        key: "key-a",
        label: "A",
        isEnabled: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 102,
        providerId: 7,
        key: "key-b",
        label: "B",
        isEnabled: true,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  } as unknown as Provider;
}

describe("provider key dispatch", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProviderKeyDispatchState();
  });

  it("round-robin selects each enabled key and skips a cooled key", async () => {
    const source = provider();
    const first = await selectProviderApiKey(source);
    const second = await selectProviderApiKey(source);

    expect([first.key, second.key]).toEqual(["key-a", "key-b"]);

    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    const next = await selectProviderApiKey(source);
    expect(next.key).toBe("key-b");
    expect(next.selectedApiKeyId).toBe(102);
  });

  it("按未冷却的已启用 Key 数计算 Provider 调度容量", async () => {
    const source = provider();
    await expect(readyProviderApiKeyCount(source)).resolves.toBe(2);

    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    await expect(readyProviderApiKeyCount(source)).resolves.toBe(1);

    recordProviderApiKeyFailure(102, Date.now() + 60_000);
    await expect(readyProviderApiKeyCount(source)).resolves.toBe(0);
  });

  it("legacy Provider 按单 Key 容量计算，禁用的 Key 池容量为零", async () => {
    const legacy = provider();
    legacy.apiKeys = [];
    await expect(readyProviderApiKeyCount(legacy)).resolves.toBe(1);

    const disabledPool = provider();
    disabledPool.apiKeys = disabledPool.apiKeys.map((apiKey) => ({
      ...apiKey,
      isEnabled: false,
    }));
    await expect(readyProviderApiKeyCount(disabledPool)).resolves.toBe(0);
  });

  it("keeps the Provider open only after every enabled key is cooled", () => {
    const source = provider();
    expect(areAllProviderApiKeysCooled(source)).toBe(false);
    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    expect(areAllProviderApiKeysCooled(source)).toBe(false);
    recordProviderApiKeyFailure(102, Date.now() + 60_000);
    expect(areAllProviderApiKeysCooled(source)).toBe(true);
  });

  it("does not fall back to the legacy key when the configured pool is fully disabled", async () => {
    const source = provider();
    source.apiKeys = source.apiKeys.map((apiKey) => ({ ...apiKey, isEnabled: false }));
    const selected = await selectProviderApiKey(source);
    expect(selected.key).toBe("");
    expect(selected.selectedApiKeyId).toBeNull();
  });

  it("does not select a cooled key unless cooldown fallback is explicit", async () => {
    const source = provider();
    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    recordProviderApiKeyFailure(102, Date.now() + 120_000);

    const strict = await selectProviderApiKey(source);
    expect(strict.selectedApiKeyId).toBeNull();
    expect(strict.key).toBe("");
    await expect(hasReadyProviderApiKey(source)).resolves.toBe(false);

    const fallback = await selectProviderApiKey(source, new Set(), Date.now(), {
      allowCooldownFallback: true,
    });
    expect(fallback.selectedApiKeyId).toBe(101);
  });

  it("treats an empty legacy provider as unusable", () => {
    const source = provider();
    source.apiKeys = [];
    source.key = "";
    expect(hasUsableProviderApiKey(source)).toBe(false);
  });

  it("handles a null legacy key without throwing when the pool is disabled", async () => {
    const source = provider();
    source.apiKeys = source.apiKeys.map((apiKey) => ({ ...apiKey, isEnabled: false }));
    source.key = null;
    await expect(hasReadyProviderApiKey(source)).resolves.toBe(false);
  });

  it("does not let an older request success clear a newer key failure", async () => {
    vi.useFakeTimers();
    const requestStartedAt = Date.now();
    vi.advanceTimersByTime(10);
    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    recordProviderApiKeySuccess(101, requestStartedAt);
    expect(areAllProviderApiKeysCooled(provider())).toBe(false);
    await expect(
      selectProviderApiKey(provider()).then((selected) => selected.selectedApiKeyId)
    ).resolves.toBe(102);
  });

  it("clears a removed key's local cooldown state", async () => {
    const source = provider();
    recordProviderApiKeyFailure(101, Date.now() + 60_000);
    expect((await selectProviderApiKey(source)).selectedApiKeyId).toBe(102);
    await clearProviderApiKeyDispatchStates([101]);
    expect((await selectProviderApiKey(source)).selectedApiKeyId).toBe(101);
  });
});
