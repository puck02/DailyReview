import { describe, expect, it } from "vitest";

import { generateDailyReports, generateMonthlyReports, generateWeeklyReports, runScheduledJobs } from "../src/cron/jobs";
import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

async function loginUser(email = "user@example.com"): Promise<{
  env: ReturnType<typeof createTestEnv>;
  cookie: string;
  adminCookie: string;
  userId: number;
}> {
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
    body: JSON.stringify({ email, password: "user-password", invite_code: code })
  });
  const user = (await register.json()) as { id: number };
  return { env, cookie: cookieFrom(register), adminCookie, userId: user.id };
}

async function createMessage(env: ReturnType<typeof createTestEnv>, userId: number, content: string, createdAt: string) {
  const session = await env.DB.prepare(
    "INSERT INTO chat_sessions (user_id, title, default_model, is_archived, created_at, updated_at) VALUES (?, '日报测试', 'gpt-5.4-mini', 0, ?, ?)"
  )
    .bind(userId, createdAt, createdAt)
    .run();
  const sessionId = Number((session.meta as { last_row_id: number }).last_row_id);
  await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'user', ?, ?, ?)")
    .bind(sessionId, content, "gpt-5.4-mini", createdAt)
    .run();
}

describe("reports, cron jobs, and PDF downgrade", () => {
  it("only generates daily reports at the configured local report time", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-11T10:00:00.000Z");

    await runScheduledJobs(env, new Date("2026-06-11T01:00:00.000Z"));

    const morning = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(morning.status).toBe(200);
    await expect(morning.json()).resolves.toEqual([]);

    await runScheduledJobs(env, new Date("2026-06-11T15:00:00.000Z"));

    const evening = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(evening.status).toBe(200);
    await expect(evening.json()).resolves.toMatchObject([{ period: "2026-06-11" }]);
  });

  it("generates a daily report into R2 and lists its metadata", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "今天复习了极限和 derivative 的定义", "2026-06-09T10:00:00.000Z");

    await generateDailyReports(env, "2026-06-09");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    const reports = (await list.json()) as Array<{ id: number; period: string; stats: { message_count?: number; keywords?: string[] } }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ period: "2026-06-09", stats: { message_count: 1 } });

    const content = await fetchWorker(env, `/api/reports/${reports[0].id}`, { headers: { cookie } });
    expect(content.status).toBe(200);
    await expect(content.json()).resolves.toMatchObject({
      report_type: "daily",
      period: "2026-06-09",
      markdown: expect.stringContaining("# 2026-06-09 学习日报")
    });
  });

  it("refreshes daily report metadata when regenerating the same day", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "今天复习了极限和 derivative 的定义", "2026-06-09T10:00:00.000Z");

    await generateDailyReports(env, "2026-06-09");
    const before = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [firstReport] = (await before.json()) as Array<{ id: number; created_at: string }>;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await createMessage(env, userId, "补充复习了考研英语长难句拆分", "2026-06-09T12:00:00.000Z");
    await generateDailyReports(env, "2026-06-09");

    const after = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [secondReport] = (await after.json()) as Array<{ id: number; created_at: string; stats: { message_count: number } }>;
    expect(secondReport.id).toBe(firstReport.id);
    expect(secondReport.created_at).not.toBe(firstReport.created_at);
    expect(secondReport.stats.message_count).toBe(2);
  });

  it("skips daily reports when messages are unrelated to exam study", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "给个冒泡排序模板", "2026-06-09T10:00:00.000Z");
    await createMessage(env, userId, "Cloudflare Worker 部署报错怎么处理", "2026-06-09T10:05:00.000Z");

    await generateDailyReports(env, "2026-06-09");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([]);
  });

  it("keeps only exam-study content in daily reports", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "给个冒泡排序模板", "2026-06-09T10:00:00.000Z");
    await createMessage(env, userId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-09T11:00:00.000Z");

    await generateDailyReports(env, "2026-06-09");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [report] = (await list.json()) as Array<{ id: number; stats: { message_count?: number; raw_message_count?: number } }>;
    expect(report.stats).toMatchObject({ message_count: 1, raw_message_count: 2 });
    const content = await fetchWorker(env, `/api/reports/${report.id}`, { headers: { cookie } });
    const body = (await content.json()) as { markdown: string };
    expect(body.markdown).toContain("考研英语长难句");
    expect(body.markdown).not.toContain("冒泡排序");
    expect(body.markdown).not.toContain("bubbleSort");
  });

  it("builds weekly and monthly summaries from daily reports", async () => {
    const { env, cookie, userId } = await loginUser();
    await createMessage(env, userId, "第一天学习导数", "2026-06-08T10:00:00.000Z");
    await createMessage(env, userId, "第二天学习积分", "2026-06-09T10:00:00.000Z");
    await generateDailyReports(env, "2026-06-08");
    await generateDailyReports(env, "2026-06-09");

    await generateWeeklyReports(env, "2026-06-14");
    await generateMonthlyReports(env, "2026-06-30");

    const weekly = await fetchWorker(env, "/api/reports?report_type=weekly&month=2026", { headers: { cookie } });
    expect(weekly.status).toBe(200);
    await expect(weekly.json()).resolves.toMatchObject([{ report_type: "weekly", period: "2026-W24" }]);

    const monthly = await fetchWorker(env, "/api/reports?report_type=monthly&month=2026-06", { headers: { cookie } });
    expect(monthly.status).toBe(200);
    await expect(monthly.json()).resolves.toMatchObject([{ report_type: "monthly", period: "2026-06" }]);
  });

  it("hides reports from other users and returns stable PDF downgrade JSON", async () => {
    const first = await loginUser("first@example.com");
    await createMessage(first.env, first.userId, "今天复习了考研英语阅读理解的定位题", "2026-06-09T10:00:00.000Z");
    await generateDailyReports(first.env, "2026-06-09");

    const list = await fetchWorker(first.env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie: first.cookie } });
    const [report] = (await list.json()) as Array<{ id: number }>;

    const invite = await fetchWorker(first.env, "/api/invites", {
      method: "POST",
      headers: { cookie: first.adminCookie },
      body: JSON.stringify({ expires_days: 7 })
    });
    const { code } = (await invite.json()) as { code: string };
    const otherRegister = await fetchWorker(first.env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "other@example.com", password: "user-password", invite_code: code })
    });
    const otherCookie = cookieFrom(otherRegister);

    const hidden = await fetchWorker(first.env, `/api/reports/${report.id}`, { headers: { cookie: otherCookie } });
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toEqual({ detail: "报告不存在" });

    const pdf = await fetchWorker(first.env, `/api/reports/${report.id}/pdf`, { headers: { cookie: first.cookie } });
    expect(pdf.status).toBe(501);
    await expect(pdf.json()).resolves.toEqual({
      detail: "Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。"
    });
  });
});
