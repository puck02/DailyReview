import { all, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import type { AiConfig } from "./providers";

export type TokenUsageSummary = {
  user_id: number;
  email: string;
  role: string;
  today_total_tokens: number;
  last_7d_total_tokens: number;
};

async function ensureTokenUsageTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_ai_token_usage_user_created ON ai_token_usage(user_id, created_at DESC)"
  ).run();
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
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
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
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

function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function dayBounds(now: Date, timeZone: string): { todayStart: string; tomorrowStart: string; sevenDaysStart: string } {
  const today = formatDay(now, timeZone);
  const todayStart = zonedLocalTimeToUtc(`${today}T00:00:00.000`, timeZone);
  const tomorrow = new Date(todayStart);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const sevenDays = new Date(todayStart);
  sevenDays.setUTCDate(sevenDays.getUTCDate() - 6);
  return {
    todayStart: todayStart.toISOString(),
    tomorrowStart: tomorrow.toISOString(),
    sevenDaysStart: sevenDays.toISOString()
  };
}

export async function recordTokenUsage(
  env: Env,
  userId: number,
  config: AiConfig,
  model: string,
  totalTokens: number | null | undefined
): Promise<void> {
  if (!Number.isFinite(totalTokens) || !totalTokens || totalTokens <= 0) {
    return;
  }
  await ensureTokenUsageTable(env);
  await env.DB.prepare(
    "INSERT INTO ai_token_usage (user_id, provider, model, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(userId, config.active_provider, model, Math.round(totalTokens), nowIso())
    .run();
}

export async function summarizeTokenUsage(
  env: Env,
  now = new Date(),
  timeZone = env.APP_TIMEZONE || "UTC"
): Promise<TokenUsageSummary[]> {
  await ensureTokenUsageTable(env);
  const bounds = dayBounds(now, timeZone);
  return await all<TokenUsageSummary & Row>(
    env.DB.prepare(
      `SELECT
         u.id AS user_id,
         u.email AS email,
         u.role AS role,
         COALESCE(SUM(CASE WHEN usage.created_at >= ? AND usage.created_at < ? THEN usage.total_tokens ELSE 0 END), 0)
           AS today_total_tokens,
         COALESCE(SUM(CASE WHEN usage.created_at >= ? AND usage.created_at < ? THEN usage.total_tokens ELSE 0 END), 0)
           AS last_7d_total_tokens
       FROM users u
       LEFT JOIN ai_token_usage usage
         ON usage.user_id = u.id
        AND usage.created_at >= ?
        AND usage.created_at < ?
       GROUP BY u.id, u.email, u.role
       ORDER BY last_7d_total_tokens DESC, today_total_tokens DESC, u.id ASC`
    ).bind(
      bounds.todayStart,
      bounds.tomorrowStart,
      bounds.sevenDaysStart,
      bounds.tomorrowStart,
      bounds.sevenDaysStart,
      bounds.tomorrowStart
    )
  );
}
