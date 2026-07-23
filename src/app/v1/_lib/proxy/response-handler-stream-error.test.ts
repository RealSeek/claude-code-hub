import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nodeStreamToWebStreamSafe } from "./node-stream-to-web";
import { recoverClientSseStreamErrors } from "./response-handler";

const encoder = new TextEncoder();

function createFailingStream(): ReadableStream<Uint8Array> {
  let pullCount = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(encoder.encode("event: response.output_text.delta\ndata: {}\n\n"));
        return;
      }
      controller.error(new Error("upstream socket reset"));
    },
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("recoverClientSseStreamErrors", () => {
  it("converts a Responses API stream failure into a terminal SSE error", async () => {
    const text = await readText(recoverClientSseStreamErrors(createFailingStream(), "response"));

    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.error");
    expect(text).toContain('"code":"upstream_stream_error"');
    expect(text).not.toContain("upstream socket reset");
  });

  it("uses the Anthropic error event shape for Claude clients", async () => {
    const text = await readText(recoverClientSseStreamErrors(createFailingStream(), "claude"));

    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"type":"upstream_stream_error"');
  });

  it("uses a JSON data error for Gemini CLI clients", async () => {
    const text = await readText(recoverClientSseStreamErrors(createFailingStream(), "gemini-cli"));

    expect(text).toContain('"error":{"code":"upstream_stream_error"');
  });

  it("turns a premature Node upstream close into a clean terminal SSE error", async () => {
    const node = new Readable({
      read() {
        // pushed manually below
      },
    });
    const recovered = recoverClientSseStreamErrors(
      nodeStreamToWebStreamSafe(node, 1, "test"),
      "response"
    );
    const textPromise = readText(recovered);

    node.push(encoder.encode("event: response.output_text.delta\ndata: {}\n\n"));
    await new Promise((resolve) => setImmediate(resolve));
    node.emit("close");

    const text = await textPromise;
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.error");
    expect(text).toContain('"code":"upstream_stream_error"');
  });
});
