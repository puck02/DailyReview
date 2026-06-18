import assert from "node:assert/strict";
import { test } from "node:test";
import { streamChat } from "/tmp/dailyreview-frontend-tests/frontend/src/api.js";

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

test("streamChat forwards abort signals to fetch", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
  const controller = new AbortController();
  let receivedSignal;
  globalThis.fetch = async (_path, init) => {
    receivedSignal = init.signal;
    return new Response(body, { status: 200 });
  };

  await streamChat(
    { session_id: 1, content: "test", model: "gpt-5.4-mini", attachment_ids: [] },
    () => undefined,
    { signal: controller.signal }
  );

  assert.equal(receivedSignal, controller.signal);
});
