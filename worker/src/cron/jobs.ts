import { all, type Row } from "../db/d1";
import type { Env } from "../env";
import {
  allUsers,
  generateDailyReport,
  generateMonthlyReport,
  generateWeeklyReport
} from "../reports/service";
import { ensureReportSchedulers } from "../report-scheduler";

type AttachmentCleanupRow = Row & {
  id: number;
  object_key: string;
};

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
  await ensureReportSchedulers(env, 100);
  await processQueuedWordDetails(env, 10);
  await cleanupExpiredData(env, now);
}
