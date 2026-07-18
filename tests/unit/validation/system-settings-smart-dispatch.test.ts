import { describe, expect, it } from "vitest";
import { UpdateSystemSettingsSchema } from "@/lib/validation/schemas";
import { SystemSettingsSchema } from "@/lib/api/v1/schemas/system-config";
import { toSystemSettings } from "@/repository/_shared/transformers";
import { DEFAULT_SMART_DISPATCH_SETTINGS } from "@/types/system-config";

describe("smart dispatch system settings", () => {
  it("uses ccLoad-compatible defaults for legacy rows", () => {
    expect(toSystemSettings({}).smartDispatchConfig).toEqual(DEFAULT_SMART_DISPATCH_SETTINGS);
  });

  it("accepts partial smart dispatch updates", () => {
    const parsed = UpdateSystemSettingsSchema.parse({
      smartDispatchConfig: {
        healthScoreEnabled: true,
        windowMinutes: 60,
        ewmaAlpha: 0.5,
      },
    });
    expect(parsed.smartDispatchConfig).toEqual({
      healthScoreEnabled: true,
      windowMinutes: 60,
      ewmaAlpha: 0.5,
    });
  });

  it("rejects invalid EWMA and cooldown values", () => {
    expect(() =>
      UpdateSystemSettingsSchema.parse({ smartDispatchConfig: { ewmaAlpha: 2 } })
    ).toThrow();
    expect(() =>
      UpdateSystemSettingsSchema.parse({ smartDispatchConfig: { cooldownBaseMs: 100 } })
    ).toThrow();
  });

  it("is exposed by the v1 system settings response schema", () => {
    expect(Object.keys(SystemSettingsSchema.shape)).toContain("smartDispatchConfig");
  });
});
