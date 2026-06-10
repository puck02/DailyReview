import { z } from "zod";

import { first, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { requireAdmin, requireUser } from "../auth/routes";

const DAILY_REPORT_TIME_KEY = "report_daily_time";
const WEEKLY_REPORT_TIME_KEY = "report_weekly_time";
const WEEKLY_REPORT_DAY_KEY = "report_weekly_day";
const WORD_CLOUD_ENABLED_KEY = "word_cloud_enabled";
const DEFAULT_REPORT_TIME = "23:00";
const DEFAULT_WEEKLY_REPORT_DAY = "sun";
const WEEKLY_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type AppSettings = {
  daily_report_time: string;
  weekly_report_time: string;
  weekly_report_day: string;
  word_cloud_enabled: boolean;
};

const settingsSchema = z.object({
  daily_report_time: z.string(),
  weekly_report_time: z.string(),
  weekly_report_day: z.string(),
  word_cloud_enabled: z.boolean()
});

function validateReportTime(value: string): string {
  const normalized = value.trim();
  if (!TIME_PATTERN.test(normalized)) {
    throw new HttpError(400, "时间格式必须为 HH:MM");
  }
  return normalized;
}

function validateWeeklyReportDay(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!WEEKLY_DAYS.has(normalized)) {
    throw new HttpError(400, "周报生成日无效");
  }
  return normalized;
}

function settingBool(value: string, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

async function getSetting(env: Env, key: string): Promise<string> {
  const row = await first<Row & { value: string }>(env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key));
  return row?.value || "";
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, value, nowIso())
    .run();
}

export async function getAppSettings(env: Env): Promise<AppSettings> {
  return {
    daily_report_time: validateReportTime((await getSetting(env, DAILY_REPORT_TIME_KEY)) || DEFAULT_REPORT_TIME),
    weekly_report_time: validateReportTime((await getSetting(env, WEEKLY_REPORT_TIME_KEY)) || DEFAULT_REPORT_TIME),
    weekly_report_day: validateWeeklyReportDay((await getSetting(env, WEEKLY_REPORT_DAY_KEY)) || DEFAULT_WEEKLY_REPORT_DAY),
    word_cloud_enabled: settingBool(await getSetting(env, WORD_CLOUD_ENABLED_KEY), true)
  };
}

async function readSettings(request: Request, env: Env): Promise<Response> {
  await requireUser(request, env);
  return json(await getAppSettings(env));
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = settingsSchema.parse(await parseJson<unknown>(request));
  const dailyReportTime = validateReportTime(payload.daily_report_time);
  const weeklyReportTime = validateReportTime(payload.weekly_report_time);
  const weeklyReportDay = validateWeeklyReportDay(payload.weekly_report_day);
  await setSetting(env, DAILY_REPORT_TIME_KEY, dailyReportTime);
  await setSetting(env, WEEKLY_REPORT_TIME_KEY, weeklyReportTime);
  await setSetting(env, WEEKLY_REPORT_DAY_KEY, weeklyReportDay);
  await setSetting(env, WORD_CLOUD_ENABLED_KEY, payload.word_cloud_enabled ? "true" : "false");
  return json(await getAppSettings(env));
}

export function settingsRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/settings", (request) => readSettings(request, env)),
    route("PUT", "/api/settings", (request) => updateSettings(request, env))
  ];
}
