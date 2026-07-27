import assert from "node:assert/strict";
import { test } from "node:test";
import { api, streamChat } from "/tmp/dailyreview-frontend-tests/frontend/src/api.js";

test("api GET requests retry one transient network failure", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("Failed to fetch");
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };

  await assert.deepEqual(await api.sessions(), []);
  assert.equal(calls, 2);
});

test("api requests translate network failures into a readable message", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(api.sessions(), /网络连接失败，请检查网络后重试/);
});

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
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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

test("streamChat reports interrupted streams without DONE", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });

  await assert.rejects(
    streamChat({ session_id: 1, content: "test", model: "gpt-5.4-mini", attachment_ids: [] }, () => undefined),
    /连接中断，AI 回复未完成/
  );
});

test("streamChat translates network failures without exposing browser errors", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    streamChat({ session_id: 1, content: "test", model: "gpt-5.4-mini", attachment_ids: [] }, () => undefined),
    /网络连接失败，请检查网络后重试/
  );
});
