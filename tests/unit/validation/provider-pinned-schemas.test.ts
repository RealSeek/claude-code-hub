import { describe, expect, it } from "vitest";
import { ProviderCreateSchema, ProviderUpdateSchema } from "@/lib/api/v1/schemas/providers";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";

describe("provider pinned schemas", () => {
  it("accepts pinned state when creating a provider", () => {
    const input = {
      name: "pinned-test",
      url: "https://provider.example.com",
      key: "sk-test",
      is_pinned: true,
    };

    expect(CreateProviderSchema.parse(input).is_pinned).toBe(true);
    expect(ProviderCreateSchema.parse(input).is_pinned).toBe(true);
  });

  it("accepts explicit pinned state changes when updating a provider", () => {
    expect(UpdateProviderSchema.parse({ is_pinned: false }).is_pinned).toBe(false);
    expect(ProviderUpdateSchema.parse({ is_pinned: false }).is_pinned).toBe(false);
  });
});
