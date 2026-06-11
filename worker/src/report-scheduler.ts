import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { allUsers, generateDailyReport, generateMonthlyReport, generateWeeklyReport } from "./reports/service";
import { getUserReportSettings, type ReportSettings } from "./settings/report-settings";

export type ReportJob = {
  type: "daily" | "weekly" | "monthly";
  day: string;
};

export type ReportSchedule = {
  run_at: string;
  jobs: ReportJob[];
};

type ScheduleInput = {
  userId: number;
  nowIso?: string;
};

const WEEKLY_DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function localDateTimeParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDateString(date: Date, timeZone: string): string {
  const parts = localDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = localDateTimeParts(date, timeZone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return localAsUtc - date.getTime();
}

function zonedLocalTimeToUtc(localTime: string, timeZone: string): Date {
  let result = new Date(`${localTime}Z`);
  for (let index = 0; index < 3; index += 1) {
    result = new Date(Date.parse(`${localTime}Z`) - timeZoneOffsetMs(result, timeZone));
  }
  return result;
}

function localDayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

function isMonthEnd(day: string): boolean {
  const date = new Date(`${day}T00:00:00.000Z`);
  const tomorrow = new Date(date);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.getUTCMonth() !== date.getUTCMonth();
}

function pushCandidate(
  candidates: Array<{ runAt: number; jobs: ReportJob[] }>,
  now: Date,
  day: string,
  time: string,
  timeZone: string,
  jobs: ReportJob[]
): void {
  const runAt = zonedLocalTimeToUtc(`${day}T${time}:00.000`, timeZone).getTime();
  if (runAt > now.getTime()) {
    candidates.push({ runAt, jobs });
  }
}

export function nextReportSchedule(now: Date, timeZone: string, settings: ReportSettings): ReportSchedule {
  const today = localDateString(now, timeZone);
  const candidates: Array<{ runAt: number; jobs: ReportJob[] }> = [];
  for (let offset = 0; offset < 370; offset += 1) {
    const day = addDays(today, offset);
    const dailyJobs: ReportJob[] = [{ type: "daily", day }];
    if (isMonthEnd(day)) {
      dailyJobs.push({ type: "monthly", day });
    }
    pushCandidate(candidates, now, day, settings.daily_report_time, timeZone, dailyJobs);
    if (localDayOfWeek(day) === WEEKLY_DAY_INDEX[settings.weekly_report_day]) {
      pushCandidate(candidates, now, day, settings.weekly_report_time, timeZone, [{ type: "weekly", day }]);
    }
  }
  const first = candidates.sort((left, right) => left.runAt - right.runAt)[0];
  if (!first) {
    throw new Error("Unable to compute next report schedule");
  }
  const jobs = candidates.filter((candidate) => candidate.runAt === first.runAt).flatMap((candidate) => candidate.jobs);
  return { run_at: new Date(first.runAt).toISOString(), jobs };
}

export async function runReportJobs(env: Env, userId: number, jobs: ReportJob[]): Promise<void> {
  for (const job of jobs) {
    if (job.type === "daily") {
      await generateDailyReport(env, userId, job.day);
    } else if (job.type === "weekly") {
      await generateWeeklyReport(env, userId, job.day);
    } else {
      await generateMonthlyReport(env, userId, job.day);
    }
  }
}

export async function scheduleUserReports(env: Env, userId: number, now: Date = new Date()): Promise<void> {
  try {
    const response = await env.REPORT_SCHEDULER.getByName(String(userId)).fetch("https://report-scheduler/schedule", {
      method: "POST",
      body: JSON.stringify({ userId, nowIso: now.toISOString() })
    });
    if (!response.ok) {
      throw new Error(`Report scheduler returned ${response.status}`);
    }
  } catch (error) {
    console.error("Report scheduler reschedule failed", {
      userId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function ensureReportSchedulers(env: Env, limit = 100): Promise<void> {
  for (const user of await allUsers(env, limit)) {
    await scheduleUserReports(env, user.id);
  }
}

export class ReportScheduler extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/schedule") {
      return new Response(null, { status: 404 });
    }
    const payload = (await request.json()) as Partial<ScheduleInput>;
    if (typeof payload.userId !== "number" || !Number.isInteger(payload.userId)) {
      return new Response(null, { status: 400 });
    }
    const userId = payload.userId;
    await this.schedule({
      userId,
      ...(typeof payload.nowIso === "string" ? { nowIso: payload.nowIso } : {})
    });
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<number>("userId");
    if (typeof userId !== "number" || !Number.isInteger(userId)) {
      return;
    }
    const scheduledUserId = userId;
    const jobs = (await this.ctx.storage.get<ReportJob[]>("jobs")) || [];
    const runAt = await this.ctx.storage.get<string>("runAt");
    try {
      await runReportJobs(this.env, scheduledUserId, jobs);
    } catch (error) {
      console.error("Report scheduler job failed", {
        userId: scheduledUserId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const parsedRunAt = typeof runAt === "string" ? Date.parse(runAt) : Number.NaN;
    await this.schedule({
      userId: scheduledUserId,
      nowIso: Number.isNaN(parsedRunAt) ? new Date().toISOString() : new Date(parsedRunAt).toISOString()
    });
  }

  private async schedule(input: ScheduleInput): Promise<void> {
    const now = input.nowIso ? new Date(input.nowIso) : new Date();
    const settings = await getUserReportSettings(this.env, input.userId);
    const schedule = nextReportSchedule(now, this.env.APP_TIMEZONE || "UTC", settings);
    await this.ctx.storage.put({
      userId: input.userId,
      jobs: schedule.jobs,
      runAt: schedule.run_at
    });
    await this.ctx.storage.setAlarm(Date.parse(schedule.run_at));
  }
}
