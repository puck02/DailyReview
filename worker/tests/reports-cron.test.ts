import { describe, expect, it, vi } from "vitest";

import { generateDailyReports, generateMonthlyReports, generateWeeklyReports, runScheduledJobs } from "../src/cron/jobs";
import { cookieFrom, createTestEnv, fetchWorker, MemoryReportScheduler } from "./helpers";

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
  it("cron maintenance reschedules report alarms without generating reports directly", async () => {
    const { env, cookie, userId } = await loginUser();
    const scheduler = env.REPORT_SCHEDULER as unknown as MemoryReportScheduler;
    scheduler.scheduledUsers.length = 0;
    await createMessage(env, userId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-11T10:00:00.000Z");

    await runScheduledJobs(env, new Date("2026-06-11T01:00:00.000Z"));

    expect(scheduler.scheduledUsers.map((entry) => entry.userId).sort((left, right) => left - right)).toEqual([1, userId]);
    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([]);
  });

  it("backfills a daily report when the user alarm was missed", async () => {
    const { env, cookie, userId } = await loginUser();
    await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "22:22",
        weekly_report_time: "22:22",
        weekly_report_day: "sun",
        word_cloud_enabled: true
      })
    });
    await createMessage(env, userId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-12T10:00:00.000Z");

    await runScheduledJobs(env, new Date("2026-06-12T15:00:00.000Z"));

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject([{ period: "2026-06-12" }]);
  });

  it("backfills yesterday's daily report after midnight", async () => {
    const { env, cookie, userId } = await loginUser();
    await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_time: "22:22",
        weekly_report_time: "22:22",
        weekly_report_day: "sun",
        word_cloud_enabled: true
      })
    });
    await createMessage(env, userId, "昨天复习了考研英语阅读理解和定位题", "2026-06-12T10:00:00.000Z");

    await runScheduledJobs(env, new Date("2026-06-12T16:05:00.000Z"));

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject([{ period: "2026-06-12" }]);
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

  it("uses the configured high-quality model and cognition-review prompt for daily reports", async () => {
    const { env, cookie, adminCookie, userId } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ base_url: "https://ai.example.test/v1", api_key: "", report_model: "gpt-5.4-mini" })
    });
    await createMessage(env, userId, "今天理解了极限存在必须左右极限相等，并修正了只看代入值的误解", "2026-06-09T10:00:00.000Z");

    let requestBody: { model?: string; messages?: Array<{ content?: string }> } | null = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "# 2026-06-09 学习日报\n\n## 今天最大的收获\n- 理解了极限存在要求左右极限相等。\n\n## 今天修正的误解\n### 误解\n之前以为：\n> 只要能代入就能判断极限。\n\n现在理解：\n> 极限关注趋近过程。\n\n## 核心知识\n- 极限存在：左右极限相等。\n\n## 一句话记忆\n- 极限看趋近，不只看代入。\n\n## 明日建议\n- 做 3 道左右极限题。"
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    try {
      await generateDailyReports(env, "2026-06-09");
    } finally {
      fetchMock.mockRestore();
    }

    expect(requestBody?.model).toBe("gpt-5.4-mini");
    const prompt = requestBody?.messages?.[0]?.content || "";
    expect(prompt).toContain("你的任务不是总结聊天内容，而是帮助我进行一次高质量的学习复盘");
    expect(prompt).toContain("今天最大的收获");
    expect(prompt).toContain("今天修正的误解");
    expect(prompt).toContain("一句话记忆");
    expect(prompt).not.toContain("今日学习概览");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [report] = (await list.json()) as Array<{ id: number }>;
    const content = await fetchWorker(env, `/api/reports/${report.id}`, { headers: { cookie } });
    const body = (await content.json()) as { markdown: string };
    expect(body.markdown).toContain("## 今天最大的收获");
    expect(body.markdown).toContain("## 一句话记忆");
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
