import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";
import { ProxyProviderResolver } from "@/app/v1/_lib/proxy/provider-selector";
import {
  recordProviderApiKeyFailure,
  resetProviderKeyDispatchState,
} from "@/lib/provider-key-dispatch";
import { recordSmartProviderFailure, resetSmartDispatchState } from "@/lib/smart-dispatch";

const findAllProvidersMock = vi.hoisted(() => vi.fn<[], Promise<Provider[]>>());

vi.mock("@/repository/provider", () => {
  return {
    findAllProviders: findAllProvidersMock,
    findProviderById: vi.fn(),
  };
});

describe("ProxyProviderResolver.selectProviderByType - /v1/models 分组隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetProviderKeyDispatchState();
    resetSmartDispatchState();
    vi.spyOn(ProxyProviderResolver, "filterByLimits").mockImplementation(async (providers) => {
      return providers;
    });
    vi.spyOn(ProxyProviderResolver, "selectTopPriority").mockImplementation((providers) => {
      return providers;
    });
    vi.spyOn(ProxyProviderResolver, "selectOptimal").mockImplementation((providers) => {
      return (providers[0] ?? null) as unknown as Provider;
    });
  });

  test("当配置分组但匹配 0 个供应商时，应 fail closed（不回退到全量）", async () => {
    findAllProvidersMock.mockResolvedValue([
      {
        id: 1,
        name: "p1",
        isEnabled: true,
        providerType: "openai-compatible",
        groupTag: "other",
        weight: 1,
        priority: 0,
        costMultiplier: 1,
      } as unknown as Provider,
    ]);

    const { provider, context } = await ProxyProviderResolver.selectProviderByType(
      {
        user: { id: 1, providerGroup: "groupA" },
        key: { providerGroup: null },
      },
      "openai-compatible"
    );

    expect(provider).toBeNull();
    expect(context.groupFilterApplied).toBe(true);
    expect(context.userGroup).toBe("groupA");
    expect(context.totalProviders).toBe(0);
  });

  test("当分组匹配到供应商时，应只在分组内选择", async () => {
    const inGroup = {
      id: 1,
      name: "in-group",
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: "groupA",
      weight: 1,
      priority: 0,
      costMultiplier: 1,
    } as unknown as Provider;

    const outGroup = {
      id: 2,
      name: "out-group",
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: "groupB",
      weight: 100,
      priority: 0,
      costMultiplier: 1,
    } as unknown as Provider;

    findAllProvidersMock.mockResolvedValue([outGroup, inGroup]);

    const { provider } = await ProxyProviderResolver.selectProviderByType(
      {
        user: { id: 1, providerGroup: "groupA" },
        key: { providerGroup: null },
      },
      "openai-compatible"
    );

    expect(provider?.id).toBe(inGroup.id);
  });

  test("最早恢复的供应商被限额过滤时，应继续尝试下一个冷却供应商", async () => {
    vi.useFakeTimers();
    const first = {
      id: 11,
      name: "earliest-but-limited",
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: null,
      weight: 1,
      priority: 0,
      costMultiplier: 1,
    } as unknown as Provider;
    const second = {
      id: 12,
      name: "later-but-healthy",
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: null,
      weight: 1,
      priority: 0,
      costMultiplier: 1,
    } as unknown as Provider;

    findAllProvidersMock.mockResolvedValue([first, second]);
    recordSmartProviderFailure(first.id);
    vi.advanceTimersByTime(10);
    recordSmartProviderFailure(second.id);

    const filterByLimits = vi.mocked(ProxyProviderResolver.filterByLimits);
    filterByLimits.mockImplementation(async (providers) =>
      providers.some((provider) => provider.id === first.id) ? [] : providers
    );

    const result = await ProxyProviderResolver.selectProviderByType(null, "openai-compatible");

    expect(result.provider?.id).toBe(second.id);
    expect(filterByLimits).toHaveBeenCalledTimes(2);
  });

  test("显式清空 legacy key 的 Provider 不应继续进入调度", async () => {
    const empty = {
      id: 21,
      name: "empty",
      key: "",
      apiKeys: [],
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: null,
      weight: 100,
      priority: 0,
      costMultiplier: 1,
    } as unknown as Provider;
    const valid = {
      ...empty,
      id: 22,
      name: "valid",
      key: "sk-valid",
      weight: 1,
    } as unknown as Provider;
    findAllProvidersMock.mockResolvedValue([empty, valid]);

    const result = await ProxyProviderResolver.selectProviderByType(null, "openai-compatible");

    expect(result.provider?.id).toBe(valid.id);
  });

  test("同优先级多 Provider 应按配置权重乘以可用 Key 数平滑分流", async () => {
    vi.restoreAllMocks();
    vi.stubEnv("REDIS_URL", "");

    const key = (id: number, providerId: number) => ({
      id,
      providerId,
      key: `key-${id}`,
      label: null,
      isEnabled: true,
      sortOrder: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const providerWithThreeKeys = {
      id: 31,
      name: "three-keys",
      key: "key-311",
      keyStrategy: "sequential",
      apiKeys: [key(311, 31), key(312, 31), key(313, 31)],
      providerVendorId: null,
      isEnabled: true,
      providerType: "openai-compatible",
      groupTag: null,
      groupPriorities: null,
      weight: 1,
      priority: 0,
      costMultiplier: 1,
      activeTimeStart: null,
      activeTimeEnd: null,
    } as unknown as Provider;
    const providerWithOneKey = {
      ...providerWithThreeKeys,
      id: 32,
      name: "one-key",
      key: "key-321",
      apiKeys: [key(321, 32)],
    } as unknown as Provider;

    findAllProvidersMock.mockResolvedValue([providerWithThreeKeys, providerWithOneKey]);
    vi.spyOn(ProxyProviderResolver, "filterByLimits").mockImplementation(
      async (providers) => providers
    );

    const selections = [];
    let lastContext:
      | Awaited<ReturnType<typeof ProxyProviderResolver.selectProviderByType>>["context"]
      | null = null;
    for (let index = 0; index < 4; index += 1) {
      const result = await ProxyProviderResolver.selectProviderByType(null, "openai-compatible");
      selections.push(result.provider?.id);
      lastContext = result.context;
    }

    expect(selections).toEqual([31, 31, 32, 31]);
    expect(lastContext?.candidatesAtPriority).toEqual([
      expect.objectContaining({
        id: 31,
        weight: 1,
        readyKeyCount: 3,
        effectiveWeight: 3,
        probability: 0.75,
      }),
      expect.objectContaining({
        id: 32,
        weight: 1,
        readyKeyCount: 1,
        effectiveWeight: 1,
        probability: 0.25,
      }),
    ]);

    recordProviderApiKeyFailure(313, Date.now() + 60_000);
    resetSmartDispatchState();
    const selectionsAfterCooldown = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await ProxyProviderResolver.selectProviderByType(null, "openai-compatible");
      selectionsAfterCooldown.push(result.provider?.id);
      lastContext = result.context;
    }

    expect(selectionsAfterCooldown).toEqual([31, 32, 31]);
    expect(lastContext?.candidatesAtPriority).toEqual([
      expect.objectContaining({
        id: 31,
        readyKeyCount: 2,
        effectiveWeight: 2,
        probability: 2 / 3,
      }),
      expect.objectContaining({
        id: 32,
        readyKeyCount: 1,
        effectiveWeight: 1,
        probability: 1 / 3,
      }),
    ]);

    const cooldownNow = Date.now();
    recordProviderApiKeyFailure(311, cooldownNow + 120_000);
    recordProviderApiKeyFailure(312, cooldownNow + 120_000);
    recordProviderApiKeyFailure(321, cooldownNow + 30_000);
    resetSmartDispatchState();

    const earliestKeyRecovery = await ProxyProviderResolver.selectProviderByType(
      null,
      "openai-compatible"
    );
    expect(earliestKeyRecovery.provider?.id).toBe(32);
    expect(earliestKeyRecovery.provider?.selectedApiKeyId).toBe(321);

    recordSmartProviderFailure(32, cooldownNow + 180_000);
    const earliestCombinedRecovery = await ProxyProviderResolver.selectProviderByType(
      null,
      "openai-compatible"
    );
    expect(earliestCombinedRecovery.provider?.id).toBe(31);
    expect(earliestCombinedRecovery.provider?.selectedApiKeyId).toBe(313);
  });
});
