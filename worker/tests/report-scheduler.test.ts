import { describe, expect, it } from "vitest";

import { nextReportSchedule, ReportScheduler, type ReportJob } from "../src/report-scheduler";
import type { Env } from "../src/env";
import { createTestEnv } from "./helpers";

class MemoryDurableStorage {
  alarmAt: number | null = null;
  private readonly values = new Map<string, unknown>();

  constructor(values: Record<string, unknown>) {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, value));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(values: Record<string, unknown>): Promise<void> {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, value));
  }

  async setAlarm(alarmAt: number): Promise<void> {
    this.alarmAt = alarmAt;
  }
}

class FailingR2Bucket {
  async put(): Promise<null> {
    throw new Error("r2 unavailable");
  }
}

async function seedDailyMessage(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, 'hash', 'user', ?)")
    .bind(userId, "scheduler-user@example.com", "2026-06-11T00:00:00.000Z")
    .run();
  await env.DB.prepare(
    "INSERT INTO chat_sessions (id, user_id, title, default_model, is_archived, created_at, updated_at) VALUES (1, ?, '日报测试', 'gpt-5.4-mini', 0, ?, ?)"
  )
    .bind(userId, "2026-06-11T10:00:00.000Z", "2026-06-11T10:00:00.000Z")
    .run();
  await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (1, 'user', ?, 'gpt-5.4-mini', ?)")
    .bind("今天复习了考研英语长难句和 derivative 的用法", "2026-06-11T10:00:00.000Z")
    .run();
}

describe("report scheduler", () => {
  it("schedules the next daily report in the user's local timezone", () => {
    const schedule = nextReportSchedule(new Date("2026-06-11T14:55:00.000Z"), "Asia/Shanghai", {
      daily_report_time: "23:00",
      weekly_report_time: "23:00",
      weekly_report_day: "sun"
    });

    expect(schedule.run_at).toBe("2026-06-11T15:00:00.000Z");
    expect(schedule.jobs).toEqual([{ type: "daily", day: "2026-06-11" }]);
  });

  it("coalesces daily and monthly reports at month end", () => {
    const schedule = nextReportSchedule(new Date("2026-06-30T14:55:00.000Z"), "Asia/Shanghai", {
      daily_report_time: "23:00",
      weekly_report_time: "22:00",
      weekly_report_day: "sun"
    });

    expect(schedule.run_at).toBe("2026-06-30T15:00:00.000Z");
    expect(schedule.jobs).toEqual([
      { type: "daily", day: "2026-06-30" },
      { type: "monthly", day: "2026-06-30" }
    ]);
  });

  it("coalesces daily and weekly reports when they share a local timestamp", () => {
    const schedule = nextReportSchedule(new Date("2026-06-14T14:55:00.000Z"), "Asia/Shanghai", {
      daily_report_time: "23:00",
      weekly_report_time: "23:00",
      weekly_report_day: "sun"
    });

    expect(schedule.run_at).toBe("2026-06-14T15:00:00.000Z");
    expect(schedule.jobs).toEqual([
      { type: "daily", day: "2026-06-14" },
      { type: "weekly", day: "2026-06-14" }
    ]);
  });

  it("reschedules the next alarm even when a report job fails", async () => {
    const env = createTestEnv({
      AI_BASE_URL: "",
      AI_API_KEY: "",
      BUCKET: new FailingR2Bucket() as unknown as R2Bucket
    });
    const userId = 42;
    await seedDailyMessage(env, userId);
    const storage = new MemoryDurableStorage({
      userId,
      jobs: [{ type: "daily", day: "2026-06-11" } satisfies ReportJob],
      runAt: "2026-06-11T15:00:00.000Z"
    });
    const scheduler = new ReportScheduler({ storage } as unknown as DurableObjectState, env);

    await expect(scheduler.alarm()).resolves.toBeUndefined();

    expect(storage.alarmAt).toBe(Date.parse("2026-06-12T15:00:00.000Z"));
  });
});
