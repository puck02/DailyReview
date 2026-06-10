import { describe, expect, it } from "vitest";

import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

async function loginUser(): Promise<{ env: ReturnType<typeof createTestEnv>; cookie: string }> {
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
  return { env, cookie: cookieFrom(register) };
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
