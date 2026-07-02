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

  it("sends cursor context and normalizes insertion-aware essay suggestions", async () => {
    const { env, cookie } = await loginUser();
    const create = await fetchWorker(env, "/api/essay/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "练习 2", model: "gpt-5.4-mini" })
    });
    const session = (await create.json()) as { id: number };

    await env.DB.prepare(
      "UPDATE essay_sessions SET ocr_text = ?, objective_description = ? WHERE id = ?"
    )
      .bind(
        "Directions: write an essay based on the picture.",
        "A young man is looking at a phone while books are open on the desk.",
        session.id
      )
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
                      kind: "phrase",
                      text: "a lack of self-discipline",
                      reason: "贴合前文对手机干扰学习的论述",
                      confidence: 0.91,
                      insert_mode: "inline"
                    },
                    {
                      kind: "rewrite",
                      text: "This scene suggests that digital distraction may weaken students' self-discipline.",
                      reason: "更准确承接图片和前文",
                      confidence: 0.72,
                      insert_mode: "replace"
                    },
                    {
                      kind: "bad-kind",
                      text: "   , therefore, students should stay focused.  ",
                      reason: "测试格式修剪",
                      confidence: 2,
                      insert_mode: "bad-mode"
                    }
                  ]
                })
              }
            }
          ],
          usage: { total_tokens: 17 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    const suggestionResponse = await fetchWorker(env, "/api/essay/suggest", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "In the picture, the student is distracted by his phone. This reflects ",
        prefix: "In the picture, the student is distracted by his phone. This reflects ",
        suffix: " in modern learning.",
        cursor_index: 69,
        word_count: 12,
        paragraph_stage: "development",
        model: "gpt-5.4-mini"
      })
    });

    expect(suggestionResponse.status).toBe(200);
    const body = (await suggestionResponse.json()) as {
      suggestions: Array<{ kind: string; text: string; reason: string; confidence: number; insert_mode?: string }>;
    };
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions[0]).toMatchObject({
      kind: "phrase",
      text: "a lack of self-discipline",
      insert_mode: "inline"
    });
    expect(body.suggestions[1]).toMatchObject({
      kind: "rewrite",
      insert_mode: "replace"
    });
    expect(body.suggestions[2]).toMatchObject({
      kind: "sentence",
      text: ", therefore, students should stay focused.",
      confidence: 1,
      insert_mode: "inline"
    });
    const systemPrompt = String(requestBody?.messages?.at(0)?.content || "");
    const userPrompt = String(requestBody?.messages?.at(-1)?.content || "");
    expect(systemPrompt).toContain("必须切合题目");
    expect(systemPrompt).toContain("贴合光标前文");
    expect(systemPrompt).toContain("标点和空格");
    expect(userPrompt).toContain("光标前文");
    expect(userPrompt).toContain("光标后文");
    expect(userPrompt).toContain("段落阶段：development");
    expect(userPrompt).toContain("词数：12");
    expect(userPrompt).toContain("A young man is looking at a phone");
  });

  it("returns conclusion-stage fallback suggestions when AI is unavailable", async () => {
    const { env, cookie } = await loginUser({ AI_API_KEY: "" });
    const create = await fetchWorker(env, "/api/essay/sessions", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "练习 3", model: "gpt-5.4-mini" })
    });
    const session = (await create.json()) as { id: number };

    const suggestionResponse = await fetchWorker(env, "/api/essay/suggest", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "In conclusion, we should pay more attention to this issue",
        prefix: "In conclusion, we should pay more attention to this issue",
        suffix: "",
        cursor_index: 57,
        word_count: 10,
        paragraph_stage: "conclusion",
        model: "gpt-5.4-mini"
      })
    });

    expect(suggestionResponse.status).toBe(200);
    const body = (await suggestionResponse.json()) as {
      suggestions: Array<{ kind: string; text: string; reason: string; insert_mode?: string }>;
    };
    expect(body.suggestions[0]).toMatchObject({
      kind: "sentence",
      insert_mode: "inline"
    });
    expect(body.suggestions[0].text).toContain("practical steps");
    expect(body.suggestions[0].reason).toContain("结尾");
  });
});
