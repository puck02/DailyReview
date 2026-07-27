import { afterEach, describe, expect, it, vi } from "vitest";

import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loginUser(): Promise<{ env: ReturnType<typeof createTestEnv>; cookie: string; adminCookie: string }> {
  const env = createTestEnv();
  await fetchWorker(env, "/api/health");
  const adminLogin = await fetchWorker(env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
  });
  const adminCookie = cookieFrom(adminLogin);
  const invite = await fetchWorker(env, "/api/invites", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ expires_days: 7 })
  });
  const { code } = (await invite.json()) as { code: string };
  const register = await fetchWorker(env, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "user@example.com", password: "user-password", invite_code: code })
  });
  return { env, cookie: cookieFrom(register), adminCookie };
}

async function readSse(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.replace(/^data:\s*/, ""));
}

describe("chat sessions and attachments", () => {
  it("creates a session, streams fallback chat, and lists stored messages", async () => {
    const { env, cookie } = await loginUser();
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "新会话", model: "gpt-5.4-mini" })
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "今天学了极限", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([
      JSON.stringify("这是一个本地测试回答。生产环境会使用配置的 AI API。"),
      "[DONE]"
    ]);

    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    expect(messages.status).toBe(200);
    await expect(messages.json()).resolves.toMatchObject([
      { role: "user", content: "今天学了极限" },
      { role: "assistant", content: "这是一个本地测试回答。生产环境会使用配置的 AI API。" }
    ]);
  });

  it("rejects invalid attachments before storing the user message", async () => {
    const { env, cookie } = await loginUser();
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "附件校验", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const response = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "这条消息不应保存",
        model: "gpt-5.4-mini",
        attachment_ids: [999999]
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "附件不存在" });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .bind(session.id)
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("sends only the latest 60 chat messages upstream in chronological order", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response('data: {"choices":[{"delta":{"content":"窗口正常"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "历史窗口", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    for (let index = 0; index < 65; index += 1) {
      await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'user', ?, ?, ?)")
        .bind(
          session.id,
          `history-${String(index).padStart(2, "0")}`,
          "gpt-5.4-mini",
          new Date(Date.UTC(2026, 6, 17, 0, 0, index)).toISOString()
        )
        .run();
    }

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "latest-question",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    await readSse(stream);

    const nonSystemMessages = requestBody?.messages?.filter((message) => message.role !== "system") || [];
    expect(nonSystemMessages).toHaveLength(60);
    expect(nonSystemMessages[0]).toMatchObject({ role: "user", content: "history-06" });
    expect(nonSystemMessages.at(-1)).toMatchObject({ role: "user", content: "latest-question" });
  });

  it("does not switch providers when the user explicitly selects a chat model", async () => {
    const { env, cookie, adminCookie } = await loginUser();
    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        default_text_model: "gpt-5.5",
        providers: {
          gpt: {
            base_url: "https://gpt.example.test/v1",
            api_key: "gpt-key",
            text_model: "gpt-5.5",
            translation_model: "gpt-5.5",
            report_model: "gpt-5.5",
            enabled_text_models: ["gpt-5.5"]
          },
          deepseek: {
            base_url: "https://api.deepseek.com",
            api_key: "deepseek-key",
            text_model: "deepseek-chat",
            translation_model: "deepseek-chat",
            report_model: "deepseek-chat",
            enabled_text_models: ["deepseek-chat"]
          }
        }
      })
    });
    expect(saved.status).toBe(200);
    const calls: Array<{ url: string; model?: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
      calls.push({ url: String(input), model: body.model });
      if (String(input).startsWith("https://gpt.example.test")) {
        return new Response(JSON.stringify({ error: "upstream down" }), { status: 503 });
      }
      return new Response('data: {"choices":[{"delta":{"content":"已切到备用模型"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "备用模型", model: "gpt-5.5" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "测试备用模型", model: "gpt-5.5", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("AI 服务连接失败，请稍后重试。"), "[DONE]"]);
    expect(calls.map((call) => call.model)).toEqual(["gpt-5.5"]);

    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const stored = (await messages.json()) as Array<{ role: string; content: string; model: string | null }>;
    expect(stored.at(-1)).toMatchObject({
      role: "assistant",
      content: "AI 服务连接失败，请稍后重试。",
      model: "gpt-5.5"
    });
  });

  it("routes an explicitly selected DeepSeek chat model to DeepSeek", async () => {
    const { env, cookie, adminCookie } = await loginUser();
    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        default_text_model: "deepseek-chat",
        providers: {
          gpt: {
            base_url: "https://gpt.example.test/v1",
            api_key: "gpt-key",
            text_model: "gpt-5.5",
            translation_model: "gpt-5.5",
            report_model: "gpt-5.5",
            enabled_text_models: ["gpt-5.5"]
          },
          deepseek: {
            base_url: "https://api.deepseek.com",
            api_key: "deepseek-key",
            text_model: "deepseek-chat",
            translation_model: "deepseek-chat",
            report_model: "deepseek-chat",
            enabled_text_models: ["deepseek-chat"]
          }
        }
      })
    });
    expect(saved.status).toBe(200);
    const calls: Array<{ url: string; model?: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
      calls.push({ url: String(input), model: body.model });
      return new Response('data: {"choices":[{"delta":{"content":"DeepSeek回答"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "DeepSeek", model: "deepseek-chat" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "测试 DeepSeek", model: "deepseek-chat", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("DeepSeek回答"), "[DONE]"]);
    expect(calls).toEqual([{ url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" }]);
  });

  it("adds a stable math markdown protocol to chat completions", async () => {
    const { env, cookie, adminCookie } = await loginUser();
    await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        default_text_model: "gpt-5.4-mini",
        providers: {
          gpt: {
            base_url: "https://gpt.example.test/v1",
            api_key: "gpt-key",
            text_model: "gpt-5.4-mini",
            translation_model: "gpt-5.4-mini",
            report_model: "gpt-5.4-mini",
            enabled_text_models: ["gpt-5.4-mini"]
          }
        }
      })
    });
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "公式", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "讲一下导数定义", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await readSse(stream);
    expect(requestBody?.messages?.at(-1)).toMatchObject({ role: "user", content: "讲一下导数定义" });
    const protocol = requestBody?.messages?.at(-2);
    expect(protocol?.role).toBe("system");
    expect(String(protocol?.content)).toContain("行内公式只使用 $...$");
    expect(String(protocol?.content)).toContain("不要使用 \\(...\\)、\\[...\\]、\\$");
    expect(String(protocol?.content)).toContain("不要输出裸露的 \\frac");
  });

  it("uses the configured default chat model when creating a new session", async () => {
    const { env, cookie, adminCookie } = await loginUser();
    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        default_text_model: "deepseek-chat",
        providers: {
          deepseek: {
            base_url: "https://api.deepseek.com",
            api_key: "deepseek-key",
            text_model: "deepseek-chat",
            translation_model: "deepseek-chat",
            report_model: "deepseek-chat",
            enabled_text_models: ["deepseek-chat", "deepseek-reasoner"]
          }
        }
      })
    });
    expect(saved.status).toBe(200);

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "默认模型", model: "gpt-5.4-mini" })
    });

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      default_model: "deepseek-chat"
    });
  });

  it("regenerates the latest assistant reply without duplicating the user message", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    const replies = ["第一次回答", "重新回答"];
    vi.stubGlobal("fetch", async () => {
      const content = replies.shift() || "兜底回答";
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "重生成会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const first = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "解释洛必达", model: "gpt-5.4-mini", attachment_ids: [] })
    });
    expect(first.status).toBe(200);
    await expect(readSse(first)).resolves.toEqual([JSON.stringify("第一次回答"), "[DONE]"]);
    const initialMessages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const [, assistant] = (await initialMessages.json()) as Array<{ id: number; role: string; content: string }>;

    const regenerated = await fetchWorker(env, "/api/chat/regenerate", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, assistant_message_id: assistant?.id, model: "gpt-5.4-mini" })
    });

    expect(regenerated.status).toBe(200);
    await expect(readSse(regenerated)).resolves.toEqual([JSON.stringify("重新回答"), "[DONE]"]);
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    await expect(messages.json()).resolves.toMatchObject([
      { role: "user", content: "解释洛必达" },
      { role: "assistant", content: "重新回答" }
    ]);
  });

  it("does not overwrite another reply when the regeneration target is stale", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "不应写入" } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "过期回复", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'user', ?, ?, ?)")
      .bind(session.id, "解释导数定义", "gpt-5.4-mini", "2026-06-18T10:00:00.000Z")
      .run();
    await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'assistant', ?, ?, ?)")
      .bind(session.id, "旧回答", "gpt-5.4-mini", "2026-06-18T10:00:01.000Z")
      .run();

    const regenerated = await fetchWorker(env, "/api/chat/regenerate", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        assistant_message_id: 999999,
        turn_id: "missing-turn",
        model: "gpt-5.4-mini",
        content: "解释导数定义"
      })
    });

    expect(regenerated.status).toBe(404);
    await expect(regenerated.json()).resolves.toEqual({ detail: "回复不存在" });
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    await expect(messages.json()).resolves.toMatchObject([
      { role: "user", content: "解释导数定义" },
      { role: "assistant", content: "旧回答" }
    ]);
  });

  it("deduplicates repeated chat delivery by turn id", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCalls += 1;
      return new Response('data: {"choices":[{"delta":{"content":"唯一回答"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "幂等会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const payload = {
      session_id: session.id,
      turn_id: "turn-deduplicate-1",
      content: "只保存一次",
      model: "gpt-5.4-mini",
      attachment_ids: []
    };

    const first = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(payload)
    });
    await expect(readSse(first)).resolves.toEqual([JSON.stringify("唯一回答"), "[DONE]"]);
    const second = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(payload)
    });
    await expect(readSse(second)).resolves.toEqual([JSON.stringify("唯一回答"), "[DONE]"]);

    expect(upstreamCalls).toBe(1);
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    await expect(messages.json()).resolves.toMatchObject([
      { role: "user", content: "只保存一次", turn_id: "turn-deduplicate-1", status: "complete" },
      { role: "assistant", content: "唯一回答", turn_id: "turn-deduplicate-1", status: "complete" }
    ]);
  });

  it("rejects a different turn while the same session is generating", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    const upstreamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamControllers.push(controller);
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "并发会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const firstResponse = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        turn_id: "concurrent-turn-1",
        content: "第一个问题",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    await vi.waitFor(() => expect(upstreamControllers).toHaveLength(1));
    const secondResponse = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        turn_id: "concurrent-turn-2",
        content: "第二个问题",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    if (secondResponse.status === 200) {
      await vi.waitFor(() => expect(upstreamControllers).toHaveLength(2));
    }
    const encoder = new TextEncoder();
    for (const controller of upstreamControllers) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    }
    await readSse(firstResponse);
    if (secondResponse.status === 200) await readSse(secondResponse);

    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toEqual({ detail: "当前会话正在生成回复" });
  });

  it("takes over an expired generation lease", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "过期租约", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    await env.DB.prepare(
      "INSERT INTO chat_generation_locks (session_id, turn_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(session.id, "expired-turn", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").run();

    const response = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        turn_id: "replacement-turn",
        content: "接管生成",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    await vi.waitFor(() => expect(upstreamController).not.toBeNull());
    const activeLease = await env.DB.prepare(
      "SELECT turn_id, expires_at FROM chat_generation_locks WHERE session_id = ?"
    ).bind(session.id).first<{ turn_id: string; expires_at: string }>();
    const controller = upstreamController as ReadableStreamDefaultController<Uint8Array>;
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已接管"}}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    await readSse(response);
    const releasedLease = await env.DB.prepare(
      "SELECT turn_id FROM chat_generation_locks WHERE session_id = ?"
    ).bind(session.id).first<{ turn_id: string }>();

    expect(response.status).toBe(200);
    expect(activeLease?.turn_id).toBe("replacement-turn");
    expect(Date.parse(activeLease?.expires_at || "")).toBeGreaterThan(Date.now());
    expect(releasedLease).toBeNull();
  });

  it("blocks session deletion while a reply is generating", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "删除保护", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const streamResponse = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        turn_id: "delete-protected-turn",
        content: "生成期间不要删除",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    await vi.waitFor(() => expect(upstreamController).not.toBeNull());
    const deleteResponse = await fetchWorker(env, `/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { cookie }
    });
    const deletePayload = await deleteResponse.json();
    const controller = upstreamController as ReadableStreamDefaultController<Uint8Array>;
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    await readSse(streamResponse);

    expect(deleteResponse.status).toBe(409);
    expect(deletePayload).toEqual({ detail: "当前会话正在生成回复" });
  });

  it("records total token usage returned by streaming chat completions", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "回答" } }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 37 } })}`,
        "data: [DONE]",
        ""
      ].join("\n\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "token 统计", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const backgroundTasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        backgroundTasks.push(promise);
      },
      passThroughOnException() {}
    } as unknown as ExecutionContext;

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "解释极限", model: "gpt-5.4-mini", attachment_ids: [] })
    }, `https://example.com/api/chat/stream`, ctx);

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("回答"), "[DONE]"]);
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    const usage = await env.DB.prepare("SELECT user_id, total_tokens FROM ai_token_usage").first<{
      user_id: number;
      total_tokens: number;
    }>();
    expect(usage).toEqual({ user_id: 2, total_tokens: 37 });
  });

  it("stores partial assistant content when an upstream stream fails after tokens", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const encoder = new TextEncoder();
          if (!this.sent) {
            this.sent = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "先给出部分回答" } }] })}\n\n`));
            return;
          }
          controller.error(new Error("upstream stream reset"));
        }
      } as UnderlyingDefaultSource<Uint8Array> & { sent?: boolean });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "中断保存", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "解释可导", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([
      JSON.stringify("先给出部分回答"),
      JSON.stringify("AI 服务连接失败，请稍后重试。"),
      "[DONE]"
    ]);
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const stored = (await messages.json()) as Array<{ role: string; content: string }>;
    expect(stored.at(-1)).toMatchObject({
      role: "assistant",
      content: "先给出部分回答\n\nAI 服务连接失败，请稍后重试。"
    });
  });

  it("marks a clean upstream EOF without DONE as an interrupted reply", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      return new Response('data: {"choices":[{"delta":{"content":"未完成回答"}}]}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "无完成标记", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "继续说明", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    await expect(readSse(stream)).resolves.toEqual([
      JSON.stringify("未完成回答"),
      JSON.stringify("AI 服务连接失败，请稍后重试。"),
      "[DONE]"
    ]);
  });

  it("keeps a silent downstream stream alive with SSE comments", async () => {
    const login = await loginUser();
    const env = Object.assign(login.env, { CHAT_HEARTBEAT_MS: "10" });
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    const requestAbort = new AbortController();
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie: login.cookie },
      body: JSON.stringify({ title: "心跳", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie: login.cookie },
      signal: requestAbort.signal,
      body: JSON.stringify({ session_id: session.id, content: "长思考", model: "gpt-5.4-mini", attachment_ids: [] })
    });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const first = await Promise.race([
        reader!.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 60))
      ]);
      expect(first).not.toBe("timeout");
      if (first !== "timeout") {
        expect(new TextDecoder().decode(first.value)).toBe(": ping\n\n");
      }
    } finally {
      requestAbort.abort();
      await reader?.cancel().catch(() => undefined);
    }
  });

  it("times out stalled upstream streams and stores the failure message", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    env.AI_STREAM_TIMEOUT_MS = "25";
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "超时保存", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "解释连续", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("AI 服务连接失败，请稍后重试。"), "[DONE]"]);
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const stored = (await messages.json()) as Array<{ role: string; content: string }>;
    expect(stored.at(-1)).toMatchObject({
      role: "assistant",
      content: "AI 服务连接失败，请稍后重试。"
    });
  });

  it("stores a visible failure message when upstream finishes without assistant content", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "空回复", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "解释泰勒公式", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("AI 没有返回内容，请重试或切换模型。"), "[DONE]"]);
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const stored = (await messages.json()) as Array<{ role: string; content: string }>;
    expect(stored.at(-1)).toMatchObject({
      role: "assistant",
      content: "AI 没有返回内容，请重试或切换模型。"
    });
  });

  it("aborts the upstream AI request when the chat request is aborted", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    const requestAbort = new AbortController();
    let upstreamAborted = false;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return await new Promise<Response>(() => undefined);
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "中断上游", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      signal: requestAbort.signal,
      body: JSON.stringify({ session_id: session.id, content: "解释中断", model: "gpt-5.4-mini", attachment_ids: [] })
    });

    expect(stream.status).toBe(200);
    requestAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamAborted).toBe(true);
  });

  it("uploads and downloads a PNG attachment for its owner", async () => {
    const { env, cookie } = await loginUser();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: "image/png" }), "a.png");

    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: form });

    expect(upload.status).toBe(200);
    const attachment = (await upload.json()) as { id: number; mime_type: string; url: string };
    expect(attachment.mime_type).toBe("image/png");
    const download = await fetchWorker(env, attachment.url, { headers: { cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await download.arrayBuffer()).slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it("sends uploaded images to the AI chat completion request", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      const body = [
        'data: {"choices":[{"delta":{"content":"看到了图片"}}]}',
        "data: [DONE]",
        ""
      ].join("\n\n");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: "image/png" }), "chart.png");
    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: form });
    const attachment = (await upload.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "请描述这张图",
        model: "gpt-5.4-mini",
        attachment_ids: [attachment.id]
      })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("看到了图片"), "[DONE]"]);
    expect(requestBody?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "请描述这张图" },
        { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }
      ]
    });
  });

  it("uses client-prepared image data urls without reading R2 during send", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response('data: {"choices":[{"delta":{"content":"直传图片"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" }), "chart.png");
    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: form });
    const attachment = (await upload.json()) as { id: number };
    const originalBucket = env.BUCKET;
    env.BUCKET = new Proxy(originalBucket, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async () => {
            throw new Error("R2 should not be read when image_data_urls are supplied");
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    }) as R2Bucket;

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "请描述这张图",
        model: "gpt-5.4-mini",
        attachment_ids: [attachment.id],
        image_data_urls: ["data:image/png;base64,client-prepared"]
      })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("直传图片"), "[DONE]"]);
    expect(requestBody?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "请描述这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,client-prepared" } }
      ]
    });
  });

  it("accepts image-only messages and prompts the AI to analyze the image", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response('data: {"choices":[{"delta":{"content":"图片分析完成"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片消息", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" }), "chart.png");
    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: form });
    const attachment = (await upload.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "",
        model: "gpt-5.4-mini",
        attachment_ids: [attachment.id],
        image_data_urls: ["data:image/png;base64,client-prepared"]
      })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("图片分析完成"), "[DONE]"]);
    expect(requestBody?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "请分析这张图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,client-prepared" } }
      ]
    });
    const messages = await fetchWorker(env, `/api/sessions/${session.id}/messages`, { headers: { cookie } });
    const storedMessages = (await messages.json()) as Array<{ role: string; content: string }>;
    expect(storedMessages[0]).toMatchObject({ role: "user", content: "" });
  });

  it("falls back to R2 only for attachments without client-prepared data urls", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response('data: {"choices":[{"delta":{"content":"两张图片"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片会话", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const firstForm = new FormData();
    firstForm.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" }), "first.png");
    const secondForm = new FormData();
    secondForm.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2])], { type: "image/png" }), "second.png");
    const firstUpload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: firstForm });
    const secondUpload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: secondForm });
    const firstAttachment = (await firstUpload.json()) as { id: number };
    const secondAttachment = (await secondUpload.json()) as { id: number };

    const stream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "请比较这两张图",
        model: "gpt-5.4-mini",
        attachment_ids: [firstAttachment.id, secondAttachment.id],
        image_data_urls: ["data:image/png;base64,client-prepared-first"]
      })
    });

    expect(stream.status).toBe(200);
    await expect(readSse(stream)).resolves.toEqual([JSON.stringify("两张图片"), "[DONE]"]);
    expect(requestBody?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "请比较这两张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,client-prepared-first" } },
        { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }
      ]
    });
  });

  it("reuses stored image context for text-only follow-up messages", async () => {
    const { env, cookie } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    const requestBodies: Array<{ model?: string; messages?: Array<{ role: string; content: unknown }> }> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body || "{}")) as (typeof requestBodies)[number]);
      const reply = requestBodies.length === 1 ? "先看图" : "继续分析";
      return new Response(`data: {"choices":[{"delta":{"content":"${reply}"}}]}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片上下文", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])], { type: "image/png" }), "first.png");
    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: form });
    const attachment = (await upload.json()) as { id: number };

    const firstStream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "记住这张图",
        model: "gpt-5.4-mini",
        attachment_ids: [attachment.id],
        image_data_urls: ["data:image/png;base64,client-prepared-first"]
      })
    });
    expect(firstStream.status).toBe(200);
    await expect(readSse(firstStream)).resolves.toEqual([JSON.stringify("先看图"), "[DONE]"]);

    const secondStream = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "继续根据刚才那张图回答",
        model: "gpt-5.4-mini",
        attachment_ids: []
      })
    });
    expect(secondStream.status).toBe(200);
    await expect(readSse(secondStream)).resolves.toEqual([JSON.stringify("继续分析"), "[DONE]"]);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1].model).toBe("gpt-5.4-mini");
    expect(requestBodies[1].messages?.find((message) => message.role === "system" && String(message.content).includes("图片记忆"))).toMatchObject({
      role: "system",
      content: expect.stringContaining("记住这张图")
    });
    expect(requestBodies[1].messages?.find((message) => message.role === "user" && message.content === "继续根据刚才那张图回答")).toBeTruthy();
  });

  it("rejects chat requests with too many images or oversized client image data", async () => {
    const { env, cookie } = await loginUser();
    const sessionResponse = await fetchWorker(env, "/api/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图片限制", model: "gpt-5.4-mini" })
    });
    const session = (await sessionResponse.json()) as { id: number };

    const tooMany = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "请分析",
        model: "gpt-5.4-mini",
        attachment_ids: [1, 2, 3, 4, 5],
        image_data_urls: []
      })
    });

    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toEqual({ detail: "一次最多发送 4 张图片" });

    const oversized = await fetchWorker(env, "/api/chat/stream", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "请分析",
        model: "gpt-5.4-mini",
        attachment_ids: [1],
        image_data_urls: [`data:image/png;base64,${"a".repeat(11 * 1024 * 1024)}`]
      })
    });

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ detail: "图片总大小不能超过 10MB" });
  });

  it("rejects invalid uploads and hides attachments from other users", async () => {
    const { env, cookie } = await loginUser();
    const invalid = new FormData();
    invalid.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }), "x.bin");
    const rejected = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: invalid });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ detail: "只支持 PNG、JPEG、WebP 或 GIF 图片" });

    const valid = new FormData();
    valid.append("file", new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1])], { type: "image/gif" }), "a.gif");
    const upload = await fetchWorker(env, "/api/attachments", { method: "POST", headers: { cookie }, body: valid });
    const attachment = (await upload.json()) as { url: string };

    const otherInvite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: cookieFrom(await fetchWorker(env, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }) })) },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await otherInvite.json()) as { code: string };
    const otherRegister = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "other@example.com", password: "user-password", invite_code: code })
    });
    const otherCookie = cookieFrom(otherRegister);

    const hidden = await fetchWorker(env, attachment.url, { headers: { cookie: otherCookie } });
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toEqual({ detail: "附件不存在" });
  });
});
