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

async function createConversation(
  env: ReturnType<typeof createTestEnv>,
  userId: number,
  messages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>
) {
  const firstCreatedAt = messages[0]?.createdAt || "2026-06-09T10:00:00.000Z";
  const session = await env.DB.prepare(
    "INSERT INTO chat_sessions (user_id, title, default_model, is_archived, created_at, updated_at) VALUES (?, '日报测试', 'gpt-5.4-mini', 0, ?, ?)"
  )
    .bind(userId, firstCreatedAt, messages[messages.length - 1]?.createdAt || firstCreatedAt)
    .run();
  const sessionId = Number((session.meta as { last_row_id: number }).last_row_id);
  for (const message of messages) {
    await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sessionId, message.role, message.content, "gpt-5.4-mini", message.createdAt)
      .run();
  }
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

  it("extracts high-value learning events before writing the daily report", async () => {
    const { env, cookie, userId } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    await createConversation(env, userId, [
      {
        role: "user",
        content: "这道极限题为什么看到三次根号要换元？",
        createdAt: "2026-06-09T10:00:00.000Z"
      },
      {
        role: "assistant",
        content: "令 u=∛x 后，∛(x^2)-2∛x+1 会变成 u^2-2u+1，也就是 (u-1)^2。",
        createdAt: "2026-06-09T10:00:01.000Z"
      },
      {
        role: "user",
        content: "Cloudflare 部署日志怎么看？",
        createdAt: "2026-06-09T11:00:00.000Z"
      },
      {
        role: "assistant",
        content: "可以使用 wrangler tail 查看日志。",
        createdAt: "2026-06-09T11:00:01.000Z"
      }
    ]);

    const requestPrompts: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[0]?.content || "";
      requestPrompts.push(prompt);
      if (prompt.includes("抽取高价值学习事件")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      subject: "数学",
                      topic: "三次根号极限换元",
                      question: "为什么三次根号极限适合换元",
                      insight: "理解了三次根号结构可令 u=∛x，把复杂根式化成二次因式。",
                      misconception: "之前容易只从 x-1 入手，忽略根式本身的二次结构。",
                      memory: "看到 ∛x 的二次组合，优先令 u=∛x。",
                      value_score: 5,
                      evidence: "∛(x^2)-2∛x+1 = (∛x-1)^2"
                    }
                  ])
                }
              }
            ]
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (prompt.includes("审查这份学习日报")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "PASS" } }] }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "# 2026-06-09 学习日报\n\n## 今天最大的收获\n- 理解了三次根号极限可以通过 u=∛x 暴露二次因式结构。\n\n## 今天修正的误解\n### 误解\n之前以为：\n> 这类题优先令 u=x-1。\n\n现在理解：\n> 变量替换应优先服务于表达式的核心结构。\n\n## 核心知识\n- 三次根号换元：令 u=∛x 后，根式组合可转化为普通多项式。\n\n## 一句话记忆\n- 看到 ∛x 的二次组合，先令 u=∛x。\n\n## 明日建议\n- 继续整理根式极限的换元触发条件。"
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

    expect(requestPrompts[0]).toContain("抽取高价值学习事件");
    expect(requestPrompts[0]).toContain("用户问题");
    expect(requestPrompts[0]).toContain("AI回答");
    expect(requestPrompts[0]).toContain("Cloudflare 部署日志怎么看？");
    expect(requestPrompts[1]).toContain("高价值学习事件");
    expect(requestPrompts[1]).toContain("三次根号极限换元");
    expect(requestPrompts[1]).not.toContain("wrangler tail");
    expect(requestPrompts[2]).toContain("审查这份学习日报");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [report] = (await list.json()) as Array<{ id: number; stats: { event_count?: number; quality_review?: string } }>;
    expect(report.stats).toMatchObject({ event_count: 1, quality_review: "pass" });
    const content = await fetchWorker(env, `/api/reports/${report.id}`, { headers: { cookie } });
    const body = (await content.json()) as { markdown: string };
    expect(body.markdown).toContain("三次根号极限");
    expect(body.markdown).not.toContain("Cloudflare");
  });

  it("rewrites the daily report once when the quality review fails", async () => {
    const { env, cookie, userId } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    await createConversation(env, userId, [
      {
        role: "user",
        content: "为什么可积一定有界，但有界不一定可积？",
        createdAt: "2026-06-09T10:00:00.000Z"
      },
      {
        role: "assistant",
        content: "可积要求间断点集合受限，所以有界只是必要条件，不是充分条件。",
        createdAt: "2026-06-09T10:00:01.000Z"
      }
    ]);

    const requestPrompts: string[] = [];
    let reportDraftCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[0]?.content || "";
      requestPrompts.push(prompt);
      if (prompt.includes("抽取高价值学习事件")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      subject: "数学",
                      topic: "可积与有界",
                      question: "可积和有界的关系",
                      insight: "理解了有界是可积的必要条件，但不是充分条件。",
                      misconception: "之前容易把必要条件误当充分条件。",
                      memory: "可积必有界，有界未必可积。",
                      value_score: 5,
                      evidence: "可积 ⇒ 有界"
                    }
                  ])
                }
              }
            ]
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (prompt.includes("审查这份学习日报")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "FAIL：包含过程描述，缺少一句话记忆。" } }] }), {
          headers: { "content-type": "application/json" }
        });
      }
      reportDraftCount += 1;
      const content =
        reportDraftCount === 1
          ? "# 2026-06-09 学习日报\n\n## 今天最大的收获\n- 用户问了可积和有界的关系。"
          : "# 2026-06-09 学习日报\n\n## 今天最大的收获\n- 理解了有界只是可积的必要条件，而不是充分条件。\n\n## 今天修正的误解\n### 误解\n之前以为：\n> 有界可以推出可积。\n\n现在理解：\n> 可积能推出有界，但有界本身不能保证可积。\n\n## 核心知识\n- 可积与有界：可积 ⇒ 有界；有界 ⇏ 可积。\n\n## 一句话记忆\n- 可积必有界，有界未必可积。\n\n## 明日建议\n- 用反例巩固必要条件和充分条件。";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { "content-type": "application/json" }
      });
    });

    try {
      await generateDailyReports(env, "2026-06-09");
    } finally {
      fetchMock.mockRestore();
    }

    expect(requestPrompts.filter((prompt) => prompt.includes("审查这份学习日报"))).toHaveLength(1);
    expect(requestPrompts.some((prompt) => prompt.includes("根据以下审查意见重写日报"))).toBe(true);
    expect(reportDraftCount).toBe(2);

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [report] = (await list.json()) as Array<{ id: number; stats: { quality_review?: string; rewrite_count?: number } }>;
    expect(report.stats).toMatchObject({ quality_review: "rewrite", rewrite_count: 1 });
    const content = await fetchWorker(env, `/api/reports/${report.id}`, { headers: { cookie } });
    const body = (await content.json()) as { markdown: string };
    expect(body.markdown).toContain("可积必有界，有界未必可积");
    expect(body.markdown).not.toContain("用户问了");
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
