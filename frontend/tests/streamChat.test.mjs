import assert from "node:assert/strict";
import { test } from "node:test";
import { streamChat } from "/tmp/dailyreview-frontend-tests/api.js";

test("streamChat parses JSON encoded multiline SSE tokens", async () => {
  const token = "第一行\n[ e^x = 1+x+\\frac{x^2}{2}+o(x^2) ]";
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(token)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });
  const tokens = [];

  await streamChat({ session_id: 1, content: "test", model: "gpt-5.4-mini", attachment_ids: [] }, (item) => {
    tokens.push(item);
  });

  assert.deepEqual(tokens, [token]);
});
