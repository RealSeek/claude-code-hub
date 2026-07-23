import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

interface ServerModule {
  configureHttpServerTimeouts: (
    server: ReturnType<typeof createServer>,
    env?: Record<string, string | undefined>
  ) => void;
}

const { configureHttpServerTimeouts } = require("../../server.js") as ServerModule;

describe("configureHttpServerTimeouts", () => {
  it("keeps server sockets alive beyond common client pool idle timeouts", () => {
    const server = createServer();

    configureHttpServerTimeouts(server, {});

    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it("honors overrides and keeps headers timeout above the socket timeout", () => {
    const server = createServer();

    configureHttpServerTimeouts(server, {
      HTTP_KEEP_ALIVE_TIMEOUT_MS: "180000",
      HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS: "10000",
      HTTP_HEADERS_TIMEOUT_MS: "1000",
    });

    expect(server.keepAliveTimeout).toBe(180_000);
    expect(server.headersTimeout).toBe(191_000);
  });
});
