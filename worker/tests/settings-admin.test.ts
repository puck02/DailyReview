import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { getAiConfig } from "../src/admin/routes";
import { testAiConnection } from "../src/ai/client";
import { cookieFrom, createTestEnv, fetchWorker, MemoryReportScheduler } from "./helpers";

async function adminCookie(env = createTestEnv()): Promise<string> {
  await fetchWorker(env, "/api/health");
  const login = await fetchWorker(env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
  });
  return cookieFrom(login);
}

function aiConfigPayload(overrides: Partial<{
  active_provider: "gpt" | "zhipu";
  providers: {
    gpt: {
      base_url: string;
      api_key: string;
      text_model: string;
      vision_model: string;
      translation_model: string;
      report_model: string;
    };
    zhipu: {
      base_url: string;
      api_key: string;
      text_model: string;
      vision_model: string;
      translation_model: string;
      report_model: string;
    };
  };
}> = {}) {
  return {
    active_provider: "gpt",
    providers: {
      gpt: {
        base_url: "https://example.com/v1",
        api_key: "abcdef1234567890",
        text_model: "gpt-5.5",
        vision_model: "gpt-5.4-mini",
        translation_model: "gpt-5.4-mini",
        report_model: "gpt-5.5"
      },
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api_key: "zhipu1234567890",
        text_model: "glm-5",
        vision_model: "glm-4.6v-flash",
        translation_model: "glm-5",
        report_model: "glm-5"
      }
    },
    ...overrides,
    providers: {
      gpt: {
        base_url: "https://example.com/v1",
        api_key: "abcdef1234567890",
        text_model: "gpt-5.5",
        vision_model: "gpt-5.4-mini",
        translation_model: "gpt-5.4-mini",
        report_model: "gpt-5.5",
        ...(overrides.providers?.gpt || {})
      },
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api_key: "zhipu1234567890",
        text_model: "glm-5",
        vision_model: "glm-4.6v-flash",
        translation_model: "glm-5",
        report_model: "glm-5",
        ...(overrides.providers?.zhipu || {})
      }
    }
  };
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

  it("loads app settings with one settings table query", async () => {
    const env = createTestEnv();
    const cookie = await adminCookie(env);
    const originalDb = env.DB;
    let appSettingsQueries = 0;
    env.DB = new Proxy(originalDb, {
      get(target, prop, receiver) {
        if (prop !== "prepare") {
          return Reflect.get(target, prop, receiver);
        }
        return (sql: string) => {
          if (/FROM app_settings/i.test(sql)) {
            appSettingsQueries += 1;
          }
          return target.prepare(sql);
        };
      }
    }) as D1Database;

    const response = await fetchWorker(env, "/api/settings", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(appSettingsQueries).toBeLessThanOrEqual(1);
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

  it("saves both provider configs and exposes the active provider", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);

    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(aiConfigPayload())
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      active_provider: "gpt",
      providers: {
        gpt: {
          base_url: "https://example.com/v1",
          has_api_key: true,
          api_key_preview: "abcdef****7890",
          text_model: "gpt-5.5",
          vision_model: "gpt-5.4-mini",
          translation_model: "gpt-5.4-mini",
          report_model: "gpt-5.5"
        },
        zhipu: {
          base_url: "https://open.bigmodel.cn/api/paas/v4",
          has_api_key: true,
          api_key_preview: "zhipu1****7890",
          text_model: "glm-5",
          vision_model: "glm-4.6v-flash",
          translation_model: "glm-5",
          report_model: "glm-5"
        }
      },
      base_url: "https://example.com/v1",
      has_api_key: true,
      api_key_preview: "abcdef****7890",
      translation_model: "gpt-5.4-mini",
      report_model: "gpt-5.5"
    });

    const switched = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(
        aiConfigPayload({
          active_provider: "zhipu",
          providers: {
            zhipu: {
              vision_model: "glm-4.6v"
            }
          }
        })
      )
    });
    expect(switched.status).toBe(200);
    await expect(switched.json()).resolves.toMatchObject({
      active_provider: "zhipu",
      providers: {
        gpt: {
          base_url: "https://example.com/v1",
          text_model: "gpt-5.5"
        },
        zhipu: {
          vision_model: "glm-4.6v"
        }
      }
    });

    const config = await getAiConfig(env);
    expect(config.active_provider).toBe("zhipu");
    expect(config.providers.gpt.text_model).toBe("gpt-5.5");
  });

  it("switches the active provider back from zhipu to gpt", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);

    const zhipu = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(aiConfigPayload({ active_provider: "zhipu" }))
    });
    expect(zhipu.status).toBe(200);
    await expect(zhipu.json()).resolves.toMatchObject({ active_provider: "zhipu" });

    const gpt = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(aiConfigPayload({ active_provider: "gpt" }))
    });
    expect(gpt.status).toBe(200);
    await expect(gpt.json()).resolves.toMatchObject({
      active_provider: "gpt",
      base_url: "https://example.com/v1",
      text_model: "gpt-5.5"
    });

    const config = await getAiConfig(env);
    expect(config.active_provider).toBe("gpt");
  });

  it("tests the active provider text model", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);
    const saved = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(aiConfigPayload({ active_provider: "zhipu" }))
    });
    expect(saved.status).toBe(200);

    let requestBody: { model?: string; messages?: Array<{ role: string; content: unknown }> } | null = null;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(JSON.stringify({ choices: [{ message: { content: "AI 连接正常" } }] }), {
        headers: { "content-type": "application/json" }
      });
    });

    try {
      const config = await getAiConfig(env);
      const result = await testAiConnection(config, config.providers.zhipu.text_model);
      expect(result).toBe("AI 连接正常");
    } finally {
      fetchMock.mockRestore();
    }

    expect(requestBody?.model).toBe("glm-5");
    expect(requestBody?.messages?.[0]?.content).toBe("请只回复 OK");
  });

  it("rejects unsupported daily report models in admin AI config", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);

    const response = await fetchWorker(env, "/api/admin/ai-config", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify(
        aiConfigPayload({
          providers: {
            gpt: {
              report_model: "unknown-model"
            }
          }
        })
      )
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "AI 模型无效" });
  });

  it("returns provider configuration for collapsing each provider row independently", async () => {
    const env = createTestEnv({ AI_BASE_URL: "", AI_API_KEY: "" });
    const cookie = await adminCookie(env);
    const response = await fetchWorker(env, "/api/admin/ai-config", { headers: { cookie } });

    expect(response.status).toBe(200);
    const config = (await response.json()) as {
      active_provider: "gpt" | "zhipu";
      providers: {
        gpt: { api_key_preview: string | null; text_model: string; vision_model: string; translation_model: string; report_model: string };
        zhipu: { api_key_preview: string | null; text_model: string; vision_model: string; translation_model: string; report_model: string };
      };
    };
    expect(config.active_provider).toBe("gpt");
    expect(config.providers.gpt.text_model).toBe("gpt-5.5");
    expect(config.providers.zhipu.text_model).toBe("glm-5");
  });

  it("returns per-user total token usage for today and the last seven days", async () => {
    const env = createTestEnv();
    const cookie = await adminCookie(env);
    const now = "2026-06-17T08:00:00.000Z";
    await env.DB.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, 'user', ?)")
      .bind("learner@example.com", "hash", "2026-06-10T00:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO ai_token_usage (user_id, provider, model, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(1, "gpt", "gpt-5.5", 100, "2026-06-17T01:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO ai_token_usage (user_id, provider, model, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(1, "gpt", "gpt-5.5", 40, "2026-06-16T12:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO ai_token_usage (user_id, provider, model, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(2, "zhipu", "glm-5", 25, "2026-06-17T02:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO ai_token_usage (user_id, provider, model, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(2, "zhipu", "glm-5", 999, "2026-06-09T02:00:00.000Z")
      .run();

    const response = await fetchWorker(env, `/api/admin/token-usage?now=${encodeURIComponent(now)}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        user_id: 1,
        email: "admin@example.com",
        role: "admin",
        today_total_tokens: 100,
        last_7d_total_tokens: 140
      },
      {
        user_id: 2,
        email: "learner@example.com",
        role: "user",
        today_total_tokens: 25,
        last_7d_total_tokens: 25
      }
    ]);
  });
});
