import { all, type Row } from "../db/d1";
import type { Env } from "../env";
import {
  allUsers,
  generateDailyReport,
  generateMonthlyReport,
  generateWeeklyReport
} from "../reports/service";
import { getAppSettings } from "../settings/routes";

type AttachmentCleanupRow = Row & {
  id: number;
  object_key: string;
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

function localDateTimeParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDateString(date: Date, timeZone: string): string {
  const parts = localDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localTimeString(date: Date, timeZone: string): string {
  const parts = localDateTimeParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
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

export async function generateDailyReports(env: Env, day: string): Promise<void> {
  for (const user of await allUsers(env)) {
    await generateDailyReport(env, user.id, day);
  }
}

export async function generateWeeklyReports(env: Env, day: string): Promise<void> {
  for (const user of await allUsers(env)) {
    await generateWeeklyReport(env, user.id, day);
  }
}

export async function generateMonthlyReports(env: Env, day: string): Promise<void> {
  for (const user of await allUsers(env)) {
    await generateMonthlyReport(env, user.id, day);
  }
}

export async function cleanupExpiredData(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const expiredAttachments = await all<AttachmentCleanupRow>(
    env.DB.prepare(
      `SELECT id, object_key FROM attachments
       WHERE expires_at < ?
       ORDER BY expires_at ASC
       LIMIT 100`
    ).bind(now.toISOString())
  );
  for (const attachment of expiredAttachments) {
    await env.BUCKET.delete(attachment.object_key);
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachment.id).run();
  }
  const oldSessions = await all<Row & { id: number }>(
    env.DB.prepare("SELECT id FROM chat_sessions WHERE updated_at < ? AND is_archived = 0 LIMIT 100").bind(cutoff.toISOString())
  );
  for (const session of oldSessions) {
    await env.DB.prepare("UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)")
      .bind(session.id)
      .run();
    await env.DB.prepare("DELETE FROM messages WHERE session_id = ?").bind(session.id).run();
    await env.DB.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(session.id).run();
  }
}

export async function processQueuedWordDetails(env: Env, limit = 10): Promise<void> {
  await env.DB.prepare(
    `UPDATE translation_entries
     SET detail_status = 'failed'
     WHERE id IN (
       SELECT id FROM translation_entries
       WHERE detail_status = 'processing'
       ORDER BY created_at ASC
       LIMIT ?
     )`
  )
    .bind(limit)
    .run();
}

export async function runScheduledJobs(env: Env, now: Date): Promise<void> {
  const settings = await getAppSettings(env);
  const timeZone = env.APP_TIMEZONE || "UTC";
  const day = localDateString(now, timeZone);
  const time = localTimeString(now, timeZone);
  if (time === settings.daily_report_time) {
    await generateDailyReports(env, day);
    if (isMonthEnd(day)) {
      await generateMonthlyReports(env, day);
    }
  }
  if (time === settings.weekly_report_time && localDayOfWeek(day) === WEEKLY_DAY_INDEX[settings.weekly_report_day]) {
    await generateWeeklyReports(env, day);
  }
  await processQueuedWordDetails(env, 10);
  await cleanupExpiredData(env, now);
}
