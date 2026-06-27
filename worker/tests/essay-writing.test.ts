import { describe, expect, it, vi } from "vitest";

import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

async function loginUser(
  envOverrides: Parameters<typeof createTestEnv>[0] = {}
): Promise<{ env: ReturnType<typeof createTestEnv>; cookie: string; adminCookie: string }> {
  const env = createTestEnv({
    AI_BASE_URL: "https://gpt.example.test/v1",
    AI_API_KEY: "gpt-key",
    ...envOverrides
  });
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
    body: JSON.stringify({ email: "essay-user@example.com", password: "user-password", invite_code: code })
  });
  return { env, cookie: cookieFrom(register), adminCookie };
}

function pngFile(name = "topic.png"): File {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
  ]);
  return new File([bytes], name, { type: "image/png" });
}

describe("essay writing assistant", () => {
  it("creates essay sessions and stores a topic image context", async () => {
    const { env, cookie } = await loginUser();
    const sessionResponse = await fetchWorker(env, "/api/essay/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "图画作文练习", model: "gpt-5.4-mini" })
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { id: number; title: string; has_topic_image: boolean };
    expect(session.title).toBe("图画作文练习");
    expect(session.has_topic_image).toBe(false);

    const attachmentResponse = await fetchWorker(
      env,
      "/api/attachments",
      {
        method: "POST",
        headers: { cookie },
        body: (() => {
          const form = new FormData();
          form.append("file", pngFile());
          return form;
        })()
      }
    );
    expect(attachmentResponse.status).toBe(200);
    const attachment = (await attachmentResponse.json()) as { id: number };

    let requestBody: { messages?: Array<{ role: string; content: unknown }>; model?: string } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ocr_text: "Write about the picture.",
                  objective_description: "A person is standing next to a bicycle."
                })
              }
            }
          ],
          usage: { total_tokens: 12 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    const contextResponse = await fetchWorker(env, `/api/essay/sessions/${session.id}/image-context`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ attachment_id: attachment.id })
    });

    expect(contextResponse.status).toBe(200);
    const context = (await contextResponse.json()) as {
      has_topic_image: boolean;
      ocr_text: string;
      objective_description: string;
      topic_attachment: { id: number } | null;
    };
    expect(context.has_topic_image).toBe(true);
    expect(context.ocr_text).toBe("Write about the picture.");
    expect(context.objective_description).toBe("A person is standing next to a bicycle.");
    expect(context.topic_attachment?.id).toBe(attachment.id);
    expect(requestBody?.messages?.at(0)).toMatchObject({ role: "system" });
    expect(requestBody?.messages?.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("解析这道考研英语一作文题目图片")
        }),
        expect.objectContaining({ type: "image_url" })
      ])
    );
  });

  it("returns delayed essay suggestions from the current draft and image context", async () => {
    const { env, cookie } = await loginUser();
    const create = await fetchWorker(env, "/api/essay/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "练习 1", model: "gpt-5.4-mini" })
    });
    const session = (await create.json()) as { id: number };

    await env.DB.prepare(
      "UPDATE essay_sessions SET ocr_text = ?, objective_description = ? WHERE id = ?"
    )
      .bind("The picture shows a student.", "A student is writing at a desk.", session.id)
      .run();

    let requestBody: { messages?: Array<{ role: string; content: string }>; model?: string } | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  suggestions: [
                    {
                      kind: "sentence",
                      text: "This picture clearly shows a student writing at a desk. ",
                      reason: "适合作为图画作文的首句",
                      confidence: 0.84
                    },
                    {
                      kind: "word",
                      text: "Moreover, ",
                      reason: "适合继续展开",
                      confidence: 0.62
                    }
                  ]
                })
              }
            }
          ],
          usage: { total_tokens: 9 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    const suggestionResponse = await fetchWorker(env, "/api/essay/suggest", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: session.id, content: "In recent years, ", model: "gpt-5.4-mini" })
    });

    expect(suggestionResponse.status).toBe(200);
    const body = (await suggestionResponse.json()) as { suggestions: Array<{ kind: string; text: string; reason: string }> };
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0]).toMatchObject({ kind: "sentence" });
    expect(body.suggestions[1]).toMatchObject({ kind: "word" });
    expect(requestBody?.messages?.at(0)).toMatchObject({ role: "system" });
    expect(String(requestBody?.messages?.at(-1)?.content)).toContain("题目 OCR");
    expect(String(requestBody?.messages?.at(-1)?.content)).toContain("当前草稿");
  });
});
