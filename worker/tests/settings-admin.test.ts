import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { cookieFrom, createTestEnv, fetchWorker, MemoryReportScheduler } from "./helpers";

async function adminCookie(env = createTestEnv()): Promise<string> {
  await fetchWorker(env, "/api/health");
  const login = await fetchWorker(env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
  });
  return cookieFrom(login);
}

describe("settings and admin routes", () => {
  it("returns default app settings for logged-in users", async () => {
    const env = createTestEnv();
    const cookie = await adminCookie(env);

    const response = await fetchWorker(env, "/api/settings", { headers: { cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daily_report_time: "23:00",
      weekly_report_time: "23:00",
      weekly_report_day: "sun",
      word_cloud_enabled: true
    });
  });

  it("rejects invalid report times", async () => {
    const env = createTestEnv();
    const cookie = await adminCookie(env);

    const response = await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "25:00",
        weekly_report_time: "23:00",
        weekly_report_day: "sun",
        word_cloud_enabled: true
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "时间格式必须为 HH:MM" });
  });

  it("lets admins update settings", async () => {
    const env = createTestEnv();
    const cookie = await adminCookie(env);

    const response = await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "22:30",
        weekly_report_time: "21:15",
        weekly_report_day: "fri",
        word_cloud_enabled: false
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      daily_report_time: "22:30",
      weekly_report_time: "21:15",
      weekly_report_day: "fri",
      word_cloud_enabled: false
    });
  });

  it("lets normal users update their own report schedule but not global word cloud settings", async () => {
    const env = createTestEnv();
    const admin = await adminCookie(env);
    const invite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: admin },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await invite.json()) as { code: string };
    const register = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "user@example.com", password: "user-password", invite_code: code })
    });
    const user = cookieFrom(register);

    const response = await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie: user },
      body: JSON.stringify({
        daily_report_time: "22:30",
        weekly_report_time: "21:15",
        weekly_report_day: "fri",
        word_cloud_enabled: false
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daily_report_time: "22:30",
      weekly_report_time: "21:15",
      weekly_report_day: "fri",
      word_cloud_enabled: true
    });
  });

  it("reschedules the current user when report settings change", async () => {
    const scheduler = new MemoryReportScheduler();
    const env = createTestEnv({ REPORT_SCHEDULER: scheduler as unknown as Env["REPORT_SCHEDULER"] });
    const cookie = await adminCookie(env);
    scheduler.scheduledUsers.length = 0;

    const response = await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "22:30",
        weekly_report_time: "21:15",
        weekly_report_day: "fri",
        word_cloud_enabled: true
      })
    });

    expect(response.status).toBe(200);
    expect(scheduler.scheduledUsers).toHaveLength(1);
    expect(scheduler.scheduledUsers[0]?.userId).toBe(1);
  });

  it("saves report settings even when alarm rescheduling is temporarily unavailable", async () => {
    const env = createTestEnv({ REPORT_SCHEDULER: new MemoryReportScheduler(true) as unknown as Env["REPORT_SCHEDULER"] });
    const cookie = await adminCookie(env);

    const response = await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "20:10",
        weekly_report_time: "20:20",
        weekly_report_day: "sat",
        word_cloud_enabled: true
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      daily_report_time: "20:10",
      weekly_report_time: "20:20",
      weekly_report_day: "sat"
    });
  });

  it("masks AI API keys and reports incomplete AI config", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);

    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({ base_url: "https://example.com/v1", api_key: "abcdef1234567890" })
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({
      base_url: "https://example.com/v1",
      has_api_key: true,
      api_key_preview: "abcdef****7890"
    });

    const test = await fetchWorker(env, "/api/admin/ai-config/test", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ base_url: "", api_key: "" })
    });
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: false, message: "AI 配置不完整" });
  });
});
