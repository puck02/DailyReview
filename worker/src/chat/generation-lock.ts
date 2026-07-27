import type { Env } from "../env";

const GENERATION_LEASE_MS = 5 * 60 * 1000;

type GenerationLockRow = {
  session_id: number;
  turn_id: string;
  expires_at: string;
};

export async function acquireGenerationLock(env: Env, sessionId: number, turnId: string): Promise<boolean> {
  const now = new Date();
  const nowValue = now.toISOString();
  const expiresAt = new Date(now.getTime() + GENERATION_LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO chat_generation_locks (session_id, turn_id, expires_at, created_at)
     SELECT ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = ?)
     ON CONFLICT(session_id) DO UPDATE SET
       turn_id = excluded.turn_id,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at
     WHERE chat_generation_locks.expires_at < ?`
  ).bind(sessionId, turnId, expiresAt, nowValue, sessionId, nowValue).run();
  return (result.meta.changes || 0) > 0;
}

export async function activeGenerationLock(env: Env, sessionId: number): Promise<GenerationLockRow | null> {
  return await env.DB.prepare(
    "SELECT session_id, turn_id, expires_at FROM chat_generation_locks WHERE session_id = ? AND expires_at >= ?"
  ).bind(sessionId, new Date().toISOString()).first<GenerationLockRow>();
}

export async function releaseGenerationLock(env: Env, sessionId: number, turnId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM chat_generation_locks WHERE session_id = ? AND turn_id = ?")
    .bind(sessionId, turnId)
    .run();
}
