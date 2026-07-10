/**
 * Error Category Status Precedence Tests
 *
 * Validates that HTTP 5xx status codes are prioritized over message-based
 * error rule matching in categorizeErrorAsync().
 *
 * Context: PR #1325 fix
 * Problem: Upstream 5xx responses with semantic error messages (e.g., "model_not_found")
 *          were being misclassified as NON_RETRYABLE_CLIENT_ERROR instead of PROVIDER_ERROR,
 *          preventing retry and provider failover logic from running.
 *
 * Solution: Check HTTP status codes before running message-based heuristics.
 */
import { describe, expect, it } from "vitest";
import { categorizeErrorAsync, ErrorCategory, ProxyError } from "@/app/v1/_lib/proxy/errors";

describe("categorizeErrorAsync - HTTP status precedence over message content", () => {
  it("503 with model-error body → PROVIDER_ERROR (not CLIENT_ERROR)", async () => {
    const error = new ProxyError(
      "model_not_found: No available channel for model gpt-4",
      503,
      {
        body: '{"error": {"message": "model_not_found: No available channel for model gpt-4"}}',
        parsed: { error: { message: "model_not_found: No available channel for model gpt-4" } },
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("502 with transport-like message → PROVIDER_ERROR (not SYSTEM_ERROR)", async () => {
    const error = new ProxyError(
      "Connection failed: upstream unreachable",
      502,
      {
        body: "Connection failed: upstream unreachable",
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("503 with abort-like message → PROVIDER_ERROR (not CLIENT_ABORT)", async () => {
    const error = new ProxyError(
      "Request aborted by upstream",
      503,
      {
        body: "Request aborted by upstream",
        providerId: 1,
        providerName: "test-provider",
      }
    );

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("500 Internal Server Error → PROVIDER_ERROR", async () => {
    const error = new ProxyError("Internal Server Error", 500, {
      body: '{"error": "internal server error"}',
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("504 Gateway Timeout → PROVIDER_ERROR", async () => {
    const error = new ProxyError("Gateway Timeout", 504, {
      body: "Gateway Timeout",
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("599 with any message → PROVIDER_ERROR", async () => {
    const error = new ProxyError("Custom 5xx error with confusing message", 599, {
      body: "This looks like a client error but it's actually 599",
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("Native transport error → SYSTEM_ERROR (preserved)", async () => {
    const error = new Error("fetch failed");
    (error as Error & { code: string }).code = "ECONNREFUSED";

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.SYSTEM_ERROR);
  });

  it("404 with model-error body → RESOURCE_NOT_FOUND (preserved)", async () => {
    const error = new ProxyError("model_not_found", 404, {
      body: '{"error": "model not found"}',
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    expect(category).toBe(ErrorCategory.RESOURCE_NOT_FOUND);
  });

  it("4xx non-404 errors still go through normal classification", async () => {
    const error = new ProxyError("Bad Request", 400, {
      body: '{"error": "bad request"}',
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    // 400 should go through normal ProxyError classification
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });

  it("FAKE_200_ prefixed errors should NOT be caught by 5xx check", async () => {
    // FAKE_200_ errors are internal markers for "HTTP 200 but actually an error"
    // They should go through normal classification flow
    const error = new ProxyError("FAKE_200_INVALID_JSON", 502, {
      body: "Not valid JSON",
      providerId: 1,
      providerName: "test-provider",
    });

    const category = await categorizeErrorAsync(error);
    // Should still be PROVIDER_ERROR but via the later check
    expect(category).toBe(ErrorCategory.PROVIDER_ERROR);
  });
});
