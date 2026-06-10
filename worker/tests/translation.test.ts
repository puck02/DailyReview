import { describe, expect, it } from "vitest";

import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

async function loginUser(): Promise<{ env: ReturnType<typeof createTestEnv>; cookie: string }> {
  const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
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
});
