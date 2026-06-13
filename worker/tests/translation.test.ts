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
    const body = (await response.json()) as { result_markdown: string; phonetic: string | null };
    expect(aiFetch).toHaveBeenCalledOnce();
    expect(body.phonetic).toBe("/dɪˈrɪvətɪv/");
    expect(body.result_markdown).toContain("衍生物");
    expect(body.result_markdown).not.toContain("bad-cache");
    const cached = await env.DB.prepare(
      "SELECT result_markdown FROM translation_dictionary_entries WHERE source_text = ?"
    )
      .bind("derivative")
      .first<{ result_markdown: string }>();
    expect(cached?.result_markdown).toContain("衍生物");
    expect(cached?.result_markdown).not.toContain("bad-cache");
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
      result_markdown: expect.not.stringContaining("词条：")
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
