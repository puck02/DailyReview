import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { generateDailyReports, generateMonthlyReports, generateWeeklyReports, runScheduledJobs } from "../src/cron/jobs";
import { cookieFrom, createTestEnv, fetchWorker, MemoryReportScheduler } from "./helpers";

const pdfCalls: { html: string; closed: boolean }[] = [];

function promptFromMessages(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
  marker: string
): string {
  const message = messages?.find((item) => item.role !== "system" && String(item.content || "").includes(marker));
  return String(message?.content || "");
}

function waitUntilContext() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        promises.push(promise);
      },
      passThroughOnException: () => {},
      props: {}
    } as ExecutionContext,
    wait: async () => {
      await Promise.all(promises);
    }
  };
}

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        setViewport: async () => {},
        setContent: async (html: string) => {
          pdfCalls.push({ html, closed: false });
        },
        evaluate: async () => {},
        pdf: async () => new TextEncoder().encode("%PDF-1.7\n% rendered by browser\n").buffer
      }),
      close: async () => {
        const call = pdfCalls[pdfCalls.length - 1];
        if (call) call.closed = true;
      }
    }))
  }
}));

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

async function registerUser(env: ReturnType<typeof createTestEnv>, adminCookie: string, email: string) {
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
  return { cookie: cookieFrom(register), userId: user.id };
}

describe("reports, cron jobs, and PDF export", () => {
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

  it("ten-minute cron generates queued PDFs for reports that only have markdown", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("queued-pdf@example.com");
    first.env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    const markdownKey = "reports/user-queued-pdf/daily/2026/06/2026-06-15.md";
    await first.env.BUCKET.put(markdownKey, "# 2026-06-15 学习日报\n\n## 核心知识\n\n核心公式：$$\\frac{1}{2}$$", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }
    });
    await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-15', ?, NULL, '{}', '2026-06-15T23:00:00.000Z')`
    )
      .bind(first.userId, markdownKey)
      .run();

    await runScheduledJobs(first.env, new Date("2026-06-16T00:10:00.000Z"), "*/10 * * * *");

    const report = await first.env.DB.prepare(
      "SELECT html_key FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = '2026-06-15'"
    )
      .bind(first.userId)
      .first<{ html_key: string | null }>();
    expect(report?.html_key).toContain(".pdf");
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]?.html).toContain("mfrac");
  });

  it("does not queue missing report PDFs when the report list is opened", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("list-queues-pdf@example.com");
    first.env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    const markdownKey = "reports/user-list-queues/daily/2026/06/2026-06-15.md";
    await first.env.BUCKET.put(markdownKey, "# 2026-06-15 学习日报\n\n## 核心知识\n\n- 极限看趋近过程。", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }
    });
    await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-15', ?, NULL, '{}', '2026-06-15T23:00:00.000Z')`
    )
      .bind(first.userId, markdownKey)
      .run();
    const list = await fetchWorker(first.env, "/api/reports?report_type=daily&month=2026-06", {
      headers: { cookie: first.cookie }
    });
    expect(list.status).toBe(200);

    const report = await first.env.DB.prepare(
      "SELECT html_key FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = '2026-06-15'"
    )
      .bind(first.userId)
      .first<{ html_key: string | null }>();
    expect(report?.html_key).toBeNull();
    expect(pdfCalls).toHaveLength(0);
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

  it("does not backfill daily reports when the user disabled daily reports", async () => {
    const { env, cookie, userId } = await loginUser();
    await fetchWorker(env, "/api/settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        daily_report_enabled: false,
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
    await expect(list.json()).resolves.toEqual([]);
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

  it("auto-creates the report generation lock table when it is missing", async () => {
    const { env, cookie, userId } = await loginUser();
    await env.DB.prepare("DROP TABLE report_generation_locks").run();
    await createMessage(env, userId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-09T10:00:00.000Z");

    await generateDailyReports(env, "2026-06-09");

    const lockTable = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'report_generation_locks'"
    ).first<{ name: string }>();
    expect(lockTable?.name).toBe("report_generation_locks");
    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject([{ period: "2026-06-09" }]);
  });

  it("exposes failed daily report generation status to the current user", async () => {
    const { env, cookie, userId } = await loginUser("report-status@example.com");
    await createMessage(env, userId, "今天理解了极限存在必须左右极限相等", "2026-06-09T10:00:00.000Z");
    const originalBucket = env.BUCKET;
    env.BUCKET = {
      ...originalBucket,
      put: async () => {
        throw new Error("simulated report write failure");
      }
    } as R2Bucket;

    await expect(generateDailyReports(env, "2026-06-09")).rejects.toThrow("simulated report write failure");

    const response = await fetchWorker(env, "/api/reports/generation-status?report_type=daily&month=2026-06", {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const statuses = (await response.json()) as Array<{ period: string; status: string; message: string; updated_at: string }>;
    expect(statuses).toMatchObject([
      {
        period: "2026-06-09",
        status: "failed",
        message: "日报生成失败：报告文件写入失败，系统会在下次定时任务重试。"
      }
    ]);
    expect(statuses[0]?.updated_at).toEqual(expect.any(String));
  });

  it("continues hourly daily report backfill when one user fails", async () => {
    const { env, cookie: failingCookie, adminCookie, userId: failingUserId } = await loginUser("failing@example.com");
    const healthyUser = await registerUser(env, adminCookie, "healthy@example.com");
    await createMessage(env, failingUserId, "今天复习了考研英语长难句和 derivative 的用法", "2026-06-12T10:00:00.000Z");
    await createMessage(env, healthyUser.userId, "今天理解了极限存在要求左右极限相等", "2026-06-12T11:00:00.000Z");

    const originalBucket = env.BUCKET;
    const originalPut = originalBucket.put.bind(originalBucket);
    env.BUCKET = {
      ...originalBucket,
      put: async (key, value, options) => {
        if (key.includes(`user-${failingUserId}/`)) {
          throw new Error("simulated report write failure");
        }
        return await originalPut(key, value, options);
      }
    } as R2Bucket;

    await expect(runScheduledJobs(env, new Date("2026-06-12T15:00:00.000Z"))).resolves.toBeUndefined();

    const failingList = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", {
      headers: { cookie: failingCookie }
    });
    await expect(failingList.json()).resolves.toEqual([]);

    const healthyList = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", {
      headers: { cookie: healthyUser.cookie }
    });
    await expect(healthyList.json()).resolves.toMatchObject([{ period: "2026-06-12" }]);
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
      body: JSON.stringify({
        active_provider: "gpt",
        providers: {
          gpt: {
            base_url: "https://ai.example.test/v1",
            api_key: "",
            text_model: "gpt-5.5",
            vision_model: "gpt-5.5",
            translation_model: "gpt-5.5",
            report_model: "gpt-5.4-mini"
          }
        }
      })
    });
    await createMessage(env, userId, "今天理解了极限存在必须左右极限相等，并修正了只看代入值的误解", "2026-06-09T10:00:00.000Z");

    let requestBody: { model?: string; messages?: Array<{ role?: string; content?: unknown }> } | null = null;
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
    const protocol = requestBody?.messages?.[0];
    expect(protocol?.role).toBe("system");
    expect(String(protocol?.content)).toContain("行内公式只使用 $...$");
    expect(String(protocol?.content)).toContain("不要输出裸露的 \\frac");
    const prompt = promptFromMessages(requestBody?.messages, "学习复盘");
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

  it("preserves the administrator-selected provider during ten-minute maintenance", async () => {
    const { env, adminCookie } = await loginUser();
    await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie: adminCookie },
      body: JSON.stringify({
        active_provider: "gpt",
        providers: {
          gpt: {
            base_url: "https://broken.example.test/v1",
            api_key: "broken-key",
            text_model: "gpt-5.5",
            vision_model: "gpt-5.5",
            translation_model: "gpt-5.5",
            report_model: "gpt-5.5"
          },
          zhipu: {
            base_url: "https://healthy.example.test/v1",
            api_key: "healthy-key",
            text_model: "glm-5",
            vision_model: "glm-4.6v",
            translation_model: "glm-5",
            report_model: "glm-5"
          }
        }
      })
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
      if (String(input).includes("broken.example.test")) {
        return new Response("fail", { status: 500 });
      }
      if (String(input).includes("healthy.example.test")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: body.model || "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    try {
      await runScheduledJobs(env, new Date("2026-06-11T00:10:00.000Z"), "*/10 * * * *");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }

    const config = await fetchWorker(env, "/api/admin/ai-config", {
      headers: { cookie: adminCookie }
    });
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toMatchObject({ active_provider: "gpt", default_text_model: "gpt-5.5" });
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
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };
      const prompt =
        promptFromMessages(body.messages, "抽取高价值学习事件") ||
        promptFromMessages(body.messages, "审查这份学习日报") ||
        promptFromMessages(body.messages, "学习复盘");
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
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> };
      const prompt =
        promptFromMessages(body.messages, "抽取高价值学习事件") ||
        promptFromMessages(body.messages, "审查这份学习日报") ||
        promptFromMessages(body.messages, "学习复盘");
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

  it("deduplicates concurrent daily report generation for the same user and day", async () => {
    const { env, userId } = await loginUser();
    env.AI_BASE_URL = "https://ai.example.test/v1";
    env.AI_API_KEY = "test-key";
    await createMessage(env, userId, "今天理解了极限存在必须左右极限相等", "2026-06-09T10:00:00.000Z");
    let aiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      aiCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const body = JSON.parse(String(init?.body || "{}")) as { messages?: Array<{ role?: string; content?: unknown }> };
      const prompt =
        promptFromMessages(body.messages, "学习复盘信息抽取器") ||
        promptFromMessages(body.messages, "请审查这份学习日报是否合格") ||
        promptFromMessages(body.messages, "学习复盘");
      if (prompt.includes("学习复盘信息抽取器")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      subject: "数学",
                      topic: "极限存在",
                      question: "极限存在条件",
                      insight: "理解了极限存在要求左右极限相等。",
                      misconception: "",
                      memory: "极限存在看左右极限。",
                      value_score: 5,
                      evidence: "今天理解了极限存在必须左右极限相等"
                    }
                  ])
                }
              }
            ]
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (prompt.includes("请审查这份学习日报是否合格")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "PASS" } }] }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "# 2026-06-09 学习日报\n\n## 今天最大的收获\n- 理解了极限存在要求左右极限相等。\n\n## 今天修正的误解\n- 今日没有足够明确的误解修正记录。\n\n## 核心知识\n- 极限存在：左右极限相等。\n\n## 一句话记忆\n- 极限看趋近。\n\n## 明日建议\n- 做左右极限题。"
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    try {
      await Promise.all([generateDailyReports(env, "2026-06-09"), generateDailyReports(env, "2026-06-09")]);
    } finally {
      fetchMock.mockRestore();
    }

    const reports = await env.DB.prepare("SELECT COUNT(*) AS count FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = ?")
      .bind(userId, "2026-06-09")
      .first<{ count: number }>();
    expect(reports?.count).toBe(1);
    expect(aiCalls).toBe(3);
  });

  it("pre-renders the daily report PDF during report generation and reuses it on export", async () => {
    pdfCalls.length = 0;
    const { env, cookie, userId } = await loginUser("generated-pdf@example.com");
    env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    await createMessage(env, userId, "今天理解了极限存在必须左右极限相等", "2026-06-09T10:00:00.000Z");

    await generateDailyReports(env, "2026-06-09");

    expect(pdfCalls).toHaveLength(1);
    const stored = await env.DB.prepare(
      "SELECT * FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = '2026-06-09'"
    )
      .bind(userId)
      .first();
    expect((stored as { html_key?: string | null } | null)?.html_key).toContain(".pdf");

    const list = await fetchWorker(env, "/api/reports?report_type=daily&month=2026-06", { headers: { cookie } });
    const [report] = (await list.json()) as Array<{ id: number }>;
    pdfCalls.length = 0;
    const pdf = await fetchWorker(env, `/api/reports/${report.id}/pdf`, { headers: { cookie } });

    expect(pdf.status).toBe(200);
    expect(new TextDecoder("latin1").decode(await pdf.arrayBuffer())).toContain("rendered by browser");
    expect(pdfCalls).toHaveLength(0);
  });

  it("keeps the existing cached PDF when report regeneration cannot pre-render a new PDF", async () => {
    const { env, userId } = await loginUser("preserve-pdf@example.com");
    env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    await createMessage(env, userId, "今天理解了函数连续和极限之间的关系", "2026-06-09T10:00:00.000Z");
    await generateDailyReports(env, "2026-06-09");
    const before = await env.DB.prepare(
      "SELECT html_key FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = '2026-06-09'"
    )
      .bind(userId)
      .first<{ html_key: string | null }>();

    env.BROWSER = undefined;
    await createMessage(env, userId, "补充理解了连续函数保极限的结论", "2026-06-09T12:00:00.000Z");
    await generateDailyReports(env, "2026-06-09");

    const after = await env.DB.prepare(
      "SELECT html_key FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = '2026-06-09'"
    )
      .bind(userId)
      .first<{ html_key: string | null }>();
    expect(after?.html_key).toBe(before?.html_key);
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

  it("hides reports from other users and rejects low-quality PDF export without browser rendering", async () => {
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
    expect(pdf.status).toBe(503);
    await expect(pdf.json()).resolves.toEqual({ detail: "PDF 正在生成，请稍后重试" });
  });

  it("queues browser PDF rendering when the cache is cold", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("formula@example.com");
    first.env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    await first.env.BUCKET.put(
      "reports/user-formula/daily/2026/06/2026-06-10.md",
      "# 学习日报\n\n## 核心知识\n\n不能把 \nΔy/Δx 直接等同于 \ndy/dx；更准确地说，\ndy/dx = lim_{Δx→0} Δy/Δx。",
      { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }
    );
    const insert = await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-10', ?, NULL, '{}', '2026-06-10T23:00:00.000Z')`
    )
      .bind(first.userId, "reports/user-formula/daily/2026/06/2026-06-10.md")
      .run();
    const reportId = Number((insert.meta as { last_row_id: number }).last_row_id);
    const envWithBrowser = { ...first.env, BROWSER: { fetch: async () => new Response(null) } as Fetcher };
    const { ctx, wait } = waitUntilContext();

    const pdf = await fetchWorker(envWithBrowser, `/api/reports/${reportId}/pdf`, { headers: { cookie: first.cookie } }, undefined, ctx);
    expect(pdf.status).toBe(503);
    await expect(pdf.json()).resolves.toEqual({ detail: "PDF 正在生成，请稍后重试" });
    await wait();
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]?.html).toContain("katex-display");
    expect(pdfCalls[0]?.html).toContain("mfrac");
    expect(pdfCalls[0]?.html).toContain("lim");
    expect(pdfCalls[0]?.closed).toBe(true);

    const report = await first.env.DB.prepare("SELECT * FROM reports WHERE user_id = ? AND report_type = 'daily' AND period = ?")
      .bind(first.userId, "2026-06-10")
      .first();
    expect(report).not.toBeNull();
    expect((report as { html_key?: string | null } | null)?.html_key).toContain(".pdf");
  });

  it("does not wait for remote font loading when rendering PDF", () => {
    const source = fs.readFileSync(new URL("../src/reports/browser-pdf.ts", import.meta.url), "utf8");
    expect(source).not.toContain("document.fonts");
    expect(source).toContain('waitUntil: "load"');
    expect(source).not.toContain('waitUntil: "networkidle0"');
  });

  it("exports a warmed cached PDF without invoking browser rendering again", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("cached@example.com");
    first.env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    await first.env.BUCKET.put(
      "reports/user-cached/daily/2026/06/2026-06-10.md",
      "# 学习日报\n\n## 核心知识\n\n核心公式：$$\\lim_{x \\to 0}\\frac{\\sin x}{x}=1$$",
      { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }
    );
    const insert = await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-10', ?, NULL, '{}', '2026-06-10T23:00:00.000Z')`
    )
      .bind(first.userId, "reports/user-cached/daily/2026/06/2026-06-10.md")
      .run();
    const reportId = Number((insert.meta as { last_row_id: number }).last_row_id);
    const envWithBrowser = { ...first.env, BROWSER: { fetch: async () => new Response(null) } as Fetcher };
    const { ctx, wait } = waitUntilContext();
    const firstPdf = await fetchWorker(envWithBrowser, `/api/reports/${reportId}/pdf`, { headers: { cookie: first.cookie } }, undefined, ctx);
    expect(firstPdf.status).toBe(503);
    await wait();
    expect(pdfCalls).toHaveLength(1);
    pdfCalls.length = 0;

    const pdf = await fetchWorker(first.env, `/api/reports/${reportId}/pdf`, { headers: { cookie: first.cookie } });

    expect(pdf.status).toBe(200);
    expect(new TextDecoder("latin1").decode(await pdf.arrayBuffer())).toContain("rendered by browser");
    expect(pdfCalls).toHaveLength(0);
  });

  it("returns a clear error instead of a low-quality PDF when browser rendering is unavailable", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("browser-unavailable@example.com");
    const markdownKey = "reports/user-cache-failure/daily/2026/06/2026-06-15.md";
    await first.env.BUCKET.put(markdownKey, "# 2026-06-15 学习日报\n\n## 核心知识\n\n- 可积必有界。", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }
    });
    const insert = await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-15', ?, NULL, '{}', '2026-06-15T23:00:00.000Z')`
    )
      .bind(first.userId, markdownKey)
      .run();
    const reportId = Number((insert.meta as { last_row_id: number }).last_row_id);
    first.env.BROWSER = undefined;

    const { ctx, wait } = waitUntilContext();
    const pdf = await fetchWorker(first.env, `/api/reports/${reportId}/pdf`, { headers: { cookie: first.cookie } }, undefined, ctx);

    expect(pdf.status).toBe(503);
    await expect(pdf.json()).resolves.toEqual({ detail: "PDF 正在生成，请稍后重试" });
    await wait();
    expect(pdfCalls).toHaveLength(0);
  });

  it("rebuilds an existing legacy PDF cache when the cached version is outdated", async () => {
    pdfCalls.length = 0;
    const first = await loginUser("legacy-pdf@example.com");
    first.env.BROWSER = { fetch: async () => new Response(null) } as Fetcher;
    const markdownKey = "reports/user-legacy-pdf/daily/2026/06/2026-06-16.md";
    const pdfKey = "reports/user-legacy-pdf/daily/2026/06/2026-06-16.pdf";
    await first.env.BUCKET.put(markdownKey, "# 学习日报\n\n## 核心知识\n\n- 极限看趋近过程。", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }
    });
    await first.env.BUCKET.put(pdfKey, "%PDF-1.7\n% legacy pdf\n", {
      httpMetadata: { contentType: "application/pdf" }
    });
    const insert = await first.env.DB.prepare(
      `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
       VALUES (?, 'daily', '2026-06-16', ?, ?, '{}', '2026-06-16T23:00:00.000Z')`
    )
      .bind(first.userId, markdownKey, pdfKey)
      .run();
    const reportId = Number((insert.meta as { last_row_id: number }).last_row_id);
    const before = await first.env.DB.prepare("SELECT html_key FROM reports WHERE id = ?").bind(reportId).first<{ html_key: string | null }>();
    expect(before?.html_key).toBe(pdfKey);

    const { ctx, wait } = waitUntilContext();
    const pdf = await fetchWorker(first.env, `/api/reports/${reportId}/pdf`, { headers: { cookie: first.cookie } }, undefined, ctx);

    expect(pdf.status).toBe(503);
    await expect(pdf.json()).resolves.toEqual({ detail: "PDF 正在生成，请稍后重试" });
    await wait();
    expect(pdfCalls).toHaveLength(1);

    const after = await first.env.DB.prepare("SELECT html_key FROM reports WHERE id = ?").bind(reportId).first<{ html_key: string | null }>();
    expect(after?.html_key).toBe(`reports/user-${first.userId}/daily/2026/06/2026-06-16.pdf`);
    const rebuilt = after?.html_key ? await first.env.BUCKET.get(after.html_key) : null;
    expect(await new Response(rebuilt?.body).text()).toContain("rendered by browser");
  });
});
