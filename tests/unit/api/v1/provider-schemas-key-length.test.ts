import { describe, expect, test } from "vitest";

import {
  ProviderCreateSchema,
  ProviderSummarySchema,
  ProviderUpdateSchema,
} from "@/lib/api/v1/schemas/providers";
import { PROVIDER_KEY_MAX_LENGTH } from "@/lib/constants/provider.constants";

describe("v1 Provider schemas - API 密钥长度限制", () => {
  const createBase = {
    name: "test-provider",
    url: "https://api.example.com",
  };

  test("ProviderCreateSchema 接受远超旧 1024 限制的密钥", () => {
    const longKey = "k".repeat(8192);
    expect(ProviderCreateSchema.safeParse({ ...createBase, key: longKey }).success).toBe(true);
  });

  test("ProviderCreateSchema 接受长度正好为上限的密钥", () => {
    const maxKey = "k".repeat(PROVIDER_KEY_MAX_LENGTH);
    expect(ProviderCreateSchema.safeParse({ ...createBase, key: maxKey }).success).toBe(true);
  });

  test("ProviderCreateSchema 支持只提交 api_keys 而不提交 legacy key", () => {
    expect(
      ProviderCreateSchema.safeParse({
        ...createBase,
        api_keys: [{ key: "sk-pool-only", label: "主 Key" }],
      }).success
    ).toBe(true);
  });

  test("ProviderCreateSchema 拒绝超出上限的密钥", () => {
    const tooLongKey = "k".repeat(PROVIDER_KEY_MAX_LENGTH + 1);
    expect(ProviderCreateSchema.safeParse({ ...createBase, key: tooLongKey }).success).toBe(false);
  });

  test("ProviderCreateSchema 仍拒绝空密钥", () => {
    expect(ProviderCreateSchema.safeParse({ ...createBase, key: "" }).success).toBe(false);
  });

  test("ProviderUpdateSchema 接受远超旧 1024 限制的密钥", () => {
    const longKey = "k".repeat(65536);
    expect(ProviderUpdateSchema.safeParse({ key: longKey }).success).toBe(true);
  });

  test("ProviderUpdateSchema 接受长度正好为上限的密钥", () => {
    const maxKey = "k".repeat(PROVIDER_KEY_MAX_LENGTH);
    expect(ProviderUpdateSchema.safeParse({ key: maxKey }).success).toBe(true);
  });

  test("ProviderUpdateSchema 拒绝超出上限的密钥", () => {
    const tooLongKey = "k".repeat(PROVIDER_KEY_MAX_LENGTH + 1);
    expect(ProviderUpdateSchema.safeParse({ key: tooLongKey }).success).toBe(false);
  });

  test("ProviderUpdateSchema 仍拒绝空密钥", () => {
    expect(ProviderUpdateSchema.safeParse({ key: "" }).success).toBe(false);
  });

  test("Provider Schema 接受显式上游计费系统且更新时不会注入默认值", () => {
    const created = ProviderCreateSchema.parse({
      ...createBase,
      key: "sk-test",
      upstream_billing_type: "sub2api",
    });
    const updated = ProviderUpdateSchema.parse({});

    expect(created.upstream_billing_type).toBe("sub2api");
    expect(updated.upstream_billing_type).toBeUndefined();
    expect(
      ProviderCreateSchema.safeParse({
        ...createBase,
        key: "sk-test",
        upstream_billing_type: "unknown",
      }).success
    ).toBe(false);
  });

  test("New-API 账户凭据只作为写入字段且响应仅暴露配置状态", () => {
    const created = ProviderCreateSchema.parse({
      ...createBase,
      key: "sk-test",
      upstream_billing_type: "new-api",
      upstream_billing_access_token: "account-token",
      upstream_billing_cookie: "session=test-cookie",
      upstream_billing_user_id: "42",
    });
    const updated = ProviderUpdateSchema.parse({
      upstream_billing_access_token: "replacement-token",
      upstream_billing_cookie: "session=replacement-cookie",
      upstream_billing_user_id: "43",
    });

    expect(created.upstream_billing_access_token).toBe("account-token");
    expect(created.upstream_billing_cookie).toBe("session=test-cookie");
    expect(created.upstream_billing_user_id).toBe("42");
    expect(updated.upstream_billing_access_token).toBe("replacement-token");
    expect(ProviderUpdateSchema.safeParse({ upstream_billing_access_token: "" }).success).toBe(
      false
    );
    expect("hasUpstreamBillingAccessToken" in ProviderSummarySchema.shape).toBe(true);
    expect("hasUpstreamBillingCookie" in ProviderSummarySchema.shape).toBe(true);
    expect("upstreamBillingAccessToken" in ProviderSummarySchema.shape).toBe(false);
    expect("upstreamBillingCookie" in ProviderSummarySchema.shape).toBe(false);
  });

  test("ProviderCreateSchema 接受表单为空时提交的上游计费用户 ID", () => {
    const created = ProviderCreateSchema.parse({
      ...createBase,
      key: "sk-test",
      upstream_billing_user_id: null,
    });

    expect(created.upstream_billing_user_id).toBeNull();
  });

  test("主动更新间隔默认 30 分钟，支持 0 关闭并拒绝越界值", () => {
    const created = ProviderCreateSchema.parse({ ...createBase, key: "sk-test" });
    expect(created.upstream_billing_refresh_interval_minutes).toBe(30);
    expect(
      ProviderUpdateSchema.parse({ upstream_billing_refresh_interval_minutes: 0 })
        .upstream_billing_refresh_interval_minutes
    ).toBe(0);
    expect(
      ProviderUpdateSchema.safeParse({ upstream_billing_refresh_interval_minutes: -1 }).success
    ).toBe(false);
    expect(
      ProviderUpdateSchema.safeParse({ upstream_billing_refresh_interval_minutes: 10081 }).success
    ).toBe(false);
  });
});
