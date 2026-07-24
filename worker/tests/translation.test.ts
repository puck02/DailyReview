import { afterEach, describe, expect, it, vi } from "vitest";

import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

async function loginUser(
  envOverrides: Parameters<typeof createTestEnv>[0] = {}
): Promise<{ env: ReturnType<typeof createTestEnv>; cookie: string }> {
  const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "", ...envOverrides });
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
  return { env, cookie: cookieFrom(register) };
}

describe("translation routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates Chinese, words, and English sentences with local fallback", async () => {
    const { env, cookie } = await loginUser();

    const chinese = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "极限存在" })
    });
    const word = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "Derivative" })
    });
    const english = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "The derivative requires careful limits." })
    });

    expect(chinese.status).toBe(200);
    await expect(chinese.json()).resolves.toMatchObject({
      source_text: "极限存在",
      source_kind: "chinese",
      detail_status: "ready",
      is_auto_detail: false
    });
    expect(word.status).toBe(200);
    await expect(word.json()).resolves.toMatchObject({
      source_text: "derivative",
      source_kind: "word",
      detail_status: "ready",
      is_auto_detail: false
    });
    expect(english.status).toBe(200);
    await expect(english.json()).resolves.toMatchObject({
      source_kind: "english",
      detail_status: "ready"
    });
  });

  it("registers automatic English word extraction through waitUntil", async () => {
    const { env, cookie } = await loginUser();
    const backgroundTasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        backgroundTasks.push(promise);
      },
      passThroughOnException() {}
    } as unknown as ExecutionContext;

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "The derivative requires careful limits." })
    }, `https://example.com/api/translation`, ctx);

    expect(response.status).toBe(200);
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    const entries = await env.DB.prepare(
      "SELECT source_text FROM translation_entries WHERE source_kind = 'word' AND is_auto_detail = 1 ORDER BY id ASC"
    ).all<{ source_text: string }>();
    expect(entries.results.map((entry) => entry.source_text)).toEqual(["derivative", "requires", "careful", "limits"]);
  });

  it("updates and reads the per-user translation prompt", async () => {
    const { env, cookie } = await loginUser();

    const before = await fetchWorker(env, "/api/translation/prompt", { headers: { cookie } });
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      system_prompt: expect.stringContaining("考研英语一")
    });

    const saved = await fetchWorker(env, "/api/translation/prompt", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({ system_prompt: "请用两行说明译文和重点。" })
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ system_prompt: "请用两行说明译文和重点。" });

    const after = await fetchWorker(env, "/api/translation/prompt", { headers: { cookie } });
    await expect(after.json()).resolves.toEqual({ system_prompt: "请用两行说明译文和重点。" });
  });

  it("uses the active provider translation model", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const adminLogin = await fetchWorker(env, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });
    const adminCookie = cookieFrom(adminLogin);
    await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        active_provider: "zhipu",
        providers: {
          zhipu: {
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            api_key: "test-key",
            text_model: "glm-5",
            vision_model: "glm-4.6v",
            translation_model: "glm-5",
            report_model: "glm-5"
          }
        }
      })
    });
    const invite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await invite.json()) as { code: string };
    const register = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "zhipu-user@example.com", password: "user-password", invite_code: code })
    });
    const cookie = cookieFrom(register);
    let requestBody: { messages?: Array<{ role: string; content: unknown }>; model?: string } | null = null;
    const aiFetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "### 译文\n极限存在\n\n### 重点\n- limit 表示极限。" } }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", aiFetch);

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "limit exists" })
    });

    expect(response.status).toBe(200);
    expect(aiFetch).toHaveBeenCalledOnce();
    expect(requestBody?.model).toBe("glm-5");
    const protocol = requestBody?.messages?.[0];
    expect(protocol?.role).toBe("system");
    expect(String(protocol?.content)).toContain("行内公式只使用 $...$");
    expect(String(protocol?.content)).toContain("不要输出裸露的 \\frac");
    expect(requestBody?.messages?.at(-1)).toMatchObject({ role: "user" });
  });

  it("rejects text over the 2000 character limit before storing entries", async () => {
    const { env, cookie } = await loginUser();

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "a".repeat(2001) })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "输入超过 2000 字，已超限，不予翻译。" });

    const entries = await fetchWorker(env, "/api/translation/entries", { headers: { cookie } });
    await expect(entries.json()).resolves.toEqual([]);
  });

  it("returns queued dictionary entries and limits the history to 30 entries", async () => {
    const { env, cookie } = await loginUser();

    const dictionary = await fetchWorker(env, "/api/translation/dictionary-entry", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "responsibilities" })
    });
    expect(dictionary.status).toBe(200);
    await expect(dictionary.json()).resolves.toMatchObject({
      source_text: "responsibilities",
      source_kind: "word",
      result_markdown: "",
      detail_status: "queued",
      is_auto_detail: true
    });

    for (let index = 0; index < 31; index += 1) {
      const response = await fetchWorker(env, "/api/translation", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ text: `hello ${index}` })
      });
      expect(response.status).toBe(200);
    }

    const entries = await fetchWorker(env, "/api/translation/entries", { headers: { cookie } });
    expect(entries.status).toBe(200);
    const body = (await entries.json()) as unknown[];
    expect(body).toHaveLength(30);
  });

  it("builds the word cloud from all history without counting automatic details twice", async () => {
    const { env, cookie } = await loginUser();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("user@example.com").first<{ id: number }>();
    expect(user).not.toBeNull();

    const recentAt = new Date().toISOString();
    const oldAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    for (let index = 0; index < 45; index += 1) {
      await env.DB.prepare(
        `INSERT INTO translation_entries
           (user_id, source_text, source_kind, result_markdown, detail_status, is_auto_detail, created_at)
         VALUES (?, ?, 'word', '', 'ready', 0, ?)`
      )
        .bind(user?.id || 0, `recentword${index}`, recentAt)
        .run();
    }
    for (let index = 0; index < 2; index += 1) {
      await env.DB.prepare(
        `INSERT INTO translation_entries
           (user_id, source_text, source_kind, result_markdown, detail_status, is_auto_detail, created_at)
         VALUES (?, 'legacy', 'word', 'legacy detail', 'ready', 0, ?)`
      )
        .bind(user?.id || 0, oldAt)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO translation_entries
         (user_id, source_text, source_kind, result_markdown, detail_status, is_auto_detail, created_at)
       VALUES (?, 'legacy', 'word', 'automatic detail', 'ready', 1, ?)`
    )
      .bind(user?.id || 0, oldAt)
      .run();

    const response = await fetchWorker(env, "/api/translation/word-cloud", { headers: { cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{
      key: string;
      label: string;
      count: number;
      reason: string;
      last_seen_at: string;
      last_reviewed_at: string | null;
    }>;
    expect(body.length).toBeLessThanOrEqual(40);
    expect(body.find((item) => item.label === "legacy")).toMatchObject({
      key: "word:legacy",
      count: 2,
      reason: "overdue",
      last_seen_at: oldAt,
      last_reviewed_at: null
    });

    const legacyEntry = await env.DB.prepare(
      "SELECT id FROM translation_entries WHERE user_id = ? AND source_text = 'legacy' AND is_auto_detail = 0 ORDER BY id DESC LIMIT 1"
    )
      .bind(user?.id || 0)
      .first<{ id: number }>();
    const reviewed = await fetchWorker(env, "/api/translation/word-cloud/review", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ key: "word:legacy", entry_id: legacyEntry?.id })
    });
    expect(reviewed.status).toBe(200);

    const refreshed = await fetchWorker(env, "/api/translation/word-cloud", { headers: { cookie } });
    const refreshedBody = (await refreshed.json()) as Array<{ label: string }>;
    expect(refreshedBody.some((item) => item.label === "legacy")).toBe(false);
  });

  it("records word cloud review time without increasing the learning count", async () => {
    const { env, cookie } = await loginUser();
    const translated = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "retention" })
    });
    const entry = (await translated.json()) as { id: number };

    const reviewed = await fetchWorker(env, "/api/translation/word-cloud/review", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ key: "word:retention", entry_id: entry.id })
    });
    expect(reviewed.status).toBe(200);

    const cloud = await fetchWorker(env, "/api/translation/word-cloud", { headers: { cookie } });
    const body = (await cloud.json()) as Array<{ label: string; count: number; last_reviewed_at: string | null }>;
    const retention = body.find((item) => item.label === "retention");
    expect(retention?.count).toBe(1);
    expect(retention?.last_reviewed_at).not.toBeNull();
  });

  it("clears only the current user's translation entries without deleting shared dictionary cache", async () => {
    const env = createTestEnv();
    const first = await loginUser({ DB: env.DB, BUCKET: env.BUCKET, REPORT_SCHEDULER: env.REPORT_SCHEDULER });
    const adminLogin = await fetchWorker(env, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });
    const invite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: cookieFrom(adminLogin) },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await invite.json()) as { code: string };
    const secondRegister = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "other@example.com", password: "user-password", invite_code: code })
    });
    const secondCookie = cookieFrom(secondRegister);
    await fetchWorker(env, "/api/translation/dictionary-entry", {
      method: "POST",
      headers: { cookie: first.cookie },
      body: JSON.stringify({ text: "derivative" })
    });
    await fetchWorker(env, "/api/translation/dictionary-entry", {
      method: "POST",
      headers: { cookie: secondCookie },
      body: JSON.stringify({ text: "matrix" })
    });
    await env.DB.prepare(
      `INSERT INTO translation_dictionary_entries (source_text, phonetic, result_markdown, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind("derivative", "/dɪˈrɪvətɪv/", "### 释义\n导数", new Date().toISOString(), new Date().toISOString())
      .run();

    const cleared = await fetchWorker(env, "/api/translation/entries", {
      method: "DELETE",
      headers: { cookie: first.cookie }
    });

    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({ status: "ok" });
    const firstEntries = await fetchWorker(env, "/api/translation/entries", { headers: { cookie: first.cookie } });
    await expect(firstEntries.json()).resolves.toEqual([]);
    const secondEntries = await fetchWorker(env, "/api/translation/entries", { headers: { cookie: secondCookie } });
    await expect(secondEntries.json()).resolves.toMatchObject([{ source_text: "matrix" }]);
    const sharedCache = await env.DB.prepare(
      "SELECT source_text FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("derivative")
      .first<{ source_text: string }>();
    expect(sharedCache?.source_text).toBe("derivative");
  });

  it("does not cache AI fallback word translations in the global dictionary", async () => {
    const { env, cookie } = await loginUser();

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "Derivative" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source_text: "derivative",
      result_markdown: expect.stringContaining("AI 配置不可用")
    });
    const dictionary = await env.DB.prepare(
      "SELECT source_text FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("derivative")
      .all();
    expect(dictionary.results).toEqual([]);
  });

  it("ignores polluted fallback dictionary cache when AI is available", async () => {
    const { env, cookie } = await loginUser({
      AI_BASE_URL: "https://ai.example/v1",
      AI_API_KEY: "test-key"
    });
    await env.DB.prepare(
      `INSERT INTO translation_dictionary_entries (source_text, phonetic, result_markdown, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        "derivative",
        null,
        "### 释义\nbad-cache\n\n### 重点\n- AI 配置不可用时暂时返回原词；配置完成后会补充词根词缀、易混词、用法和例句。",
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
    const aiFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "音标：/dɪˈrɪvətɪv/\n### 释义\n衍生物；派生词\n\n### 重点\n- derive 的名词形式。"
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", aiFetch);

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "Derivative" })
    });

    expect(response.status).toBe(200);
    expect(aiFetch).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toMatchObject({
      source_text: "derivative",
      source_kind: "word",
      phonetic: "/dɪˈrɪvətɪv/",
      result_markdown: expect.stringContaining("衍生物"),
      detail_status: "ready"
    });
    expect(body.result_markdown).not.toContain("bad-cache");
    const cached = await env.DB.prepare(
      "SELECT result_markdown FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("derivative")
      .first<{ result_markdown: string }>();
    expect(cached?.result_markdown).toContain("衍生物");
    expect(cached?.result_markdown).not.toContain("bad-cache");
  });

  it("uses the shared dictionary cache before calling AI for repeated word lookups", async () => {
    const env = createTestEnv({
      AI_BASE_URL: "https://ai.example/v1",
      AI_API_KEY: "test-key"
    });
    const first = await loginUser({ DB: env.DB, BUCKET: env.BUCKET, REPORT_SCHEDULER: env.REPORT_SCHEDULER, AI_BASE_URL: env.AI_BASE_URL, AI_API_KEY: env.AI_API_KEY });
    const adminLogin = await fetchWorker(env, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });
    const invite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: cookieFrom(adminLogin) },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await invite.json()) as { code: string };
    const secondRegister = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "cache-user@example.com", password: "user-password", invite_code: code })
    });
    const secondCookie = cookieFrom(secondRegister);
    const aiFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "词条：access\n音标：/ˈakses/\n### 释义\n进入；使用权\n\n### 重点\n- 常见搭配：have access to。"
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", aiFetch);

    const firstLookup = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie: first.cookie },
      body: JSON.stringify({ text: "access" })
    });
    const secondLookup = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie: secondCookie },
      body: JSON.stringify({ text: "access" })
    });

    expect(firstLookup.status).toBe(200);
    expect(secondLookup.status).toBe(200);
    await expect(firstLookup.json()).resolves.toMatchObject({
      source_text: "access",
      source_kind: "word",
      phonetic: "/ˈakses/",
      result_markdown: expect.stringContaining("have access to"),
      detail_status: "ready"
    });
    expect(aiFetch).toHaveBeenCalledTimes(1);
    await expect(secondLookup.json()).resolves.toMatchObject({
      source_text: "access",
      source_kind: "word",
      phonetic: "/ˈakses/",
      result_markdown: expect.stringContaining("have access to")
    });
  });

  it("stores the corrected canonical word when AI fixes a misspelled lookup", async () => {
    const { env, cookie } = await loginUser({
      AI_BASE_URL: "https://ai.example/v1",
      AI_API_KEY: "test-key"
    });
    await env.DB.prepare(
      `INSERT INTO translation_dictionary_entries (source_text, phonetic, result_markdown, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind("enviroment", null, "### 释义\n旧缓存，错误 key。", new Date().toISOString(), new Date().toISOString())
      .run();
    const aiFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "词条：environment\n音标：/ɪnˈvaɪrənmənt/\n### 释义\n环境\n\n### 拼写提醒\n- `enviroment` 是常见误拼，正确拼写是 `environment`。"
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", aiFetch);

    const response = await fetchWorker(env, "/api/translation", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ text: "enviroment" })
    });

    expect(response.status).toBe(200);
    expect(aiFetch).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      source_text: "environment",
      source_kind: "word",
      phonetic: "/ɪnˈvaɪrənmənt/",
      result_markdown: expect.not.stringContaining("词条："),
      detail_status: "ready"
    });
    const correct = await env.DB.prepare(
      "SELECT source_text, result_markdown FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("environment")
      .first<{ source_text: string; result_markdown: string }>();
    expect(correct?.result_markdown).toContain("正确拼写是 `environment`");
    const misspelled = await env.DB.prepare(
      "SELECT source_text FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("enviroment")
      .first<{ source_text: string }>();
    expect(misspelled).toBeNull();
  });
});
