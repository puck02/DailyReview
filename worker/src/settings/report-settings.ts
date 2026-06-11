import { first, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError } from "../http";

const DAILY_REPORT_TIME_KEY = "report_daily_time";
const WEEKLY_REPORT_TIME_KEY = "report_weekly_time";
const WEEKLY_REPORT_DAY_KEY = "report_weekly_day";
const WORD_CLOUD_ENABLED_KEY = "word_cloud_enabled";
const DEFAULT_REPORT_TIME = "23:00";
const DEFAULT_WEEKLY_REPORT_DAY = "sun";
const WEEKLY_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type ReportSettings = {
  daily_report_time: string;
  weekly_report_time: string;
  weekly_report_day: string;
};

export type AppSettings = ReportSettings & {
  word_cloud_enabled: boolean;
};

export function validateReportTime(value: string): string {
  const normalized = value.trim();
  if (!TIME_PATTERN.test(normalized)) {
    throw new HttpError(400, "时间格式必须为 HH:MM");
  }
  return normalized;
}

export function validateWeeklyReportDay(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!WEEKLY_DAYS.has(normalized)) {
    throw new HttpError(400, "周报生成日无效");
  }
  return normalized;
}

function userSettingKey(userId: number, key: string): string {
  return `user:${userId}:${key}`;
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

async function globalReportDefaults(env: Env): Promise<ReportSettings> {
  return {
    daily_report_time: validateReportTime((await getSetting(env, DAILY_REPORT_TIME_KEY)) || DEFAULT_REPORT_TIME),
    weekly_report_time: validateReportTime((await getSetting(env, WEEKLY_REPORT_TIME_KEY)) || DEFAULT_REPORT_TIME),
    weekly_report_day: validateWeeklyReportDay((await getSetting(env, WEEKLY_REPORT_DAY_KEY)) || DEFAULT_WEEKLY_REPORT_DAY)
  };
}

export async function getUserReportSettings(env: Env, userId: number): Promise<ReportSettings> {
  const defaults = await globalReportDefaults(env);
  return {
    daily_report_time: validateReportTime(
      (await getSetting(env, userSettingKey(userId, DAILY_REPORT_TIME_KEY))) || defaults.daily_report_time
    ),
    weekly_report_time: validateReportTime(
      (await getSetting(env, userSettingKey(userId, WEEKLY_REPORT_TIME_KEY))) || defaults.weekly_report_time
    ),
    weekly_report_day: validateWeeklyReportDay(
      (await getSetting(env, userSettingKey(userId, WEEKLY_REPORT_DAY_KEY))) || defaults.weekly_report_day
    )
  };
}

export async function setUserReportSettings(env: Env, userId: number, settings: ReportSettings): Promise<void> {
  await setSetting(env, userSettingKey(userId, DAILY_REPORT_TIME_KEY), validateReportTime(settings.daily_report_time));
  await setSetting(env, userSettingKey(userId, WEEKLY_REPORT_TIME_KEY), validateReportTime(settings.weekly_report_time));
  await setSetting(env, userSettingKey(userId, WEEKLY_REPORT_DAY_KEY), validateWeeklyReportDay(settings.weekly_report_day));
}

export async function setGlobalWordCloudEnabled(env: Env, enabled: boolean): Promise<void> {
  await setSetting(env, WORD_CLOUD_ENABLED_KEY, enabled ? "true" : "false");
}

export async function getAppSettings(env: Env, userId: number): Promise<AppSettings> {
  return {
    ...(await getUserReportSettings(env, userId)),
    word_cloud_enabled: settingBool(await getSetting(env, WORD_CLOUD_ENABLED_KEY), true)
  };
}
