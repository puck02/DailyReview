type ColumnInfo = {
  name: string;
};

const readyByDatabase = new WeakMap<D1Database, Promise<void>>();

function isConcurrentColumnAdd(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("duplicate column name");
}

async function addColumn(db: D1Database, columns: Set<string>, name: string, sql: string): Promise<void> {
  if (columns.has(name)) return;
  try {
    await db.prepare(sql).run();
  } catch (error) {
    if (!isConcurrentColumnAdd(error)) throw error;
  }
}

async function applyChatStabilitySchema(db: D1Database): Promise<void> {
  const columnResult = await db.prepare("PRAGMA table_info(messages)").all<ColumnInfo>();
  const columns = new Set(columnResult.results.map((column) => column.name));

  await addColumn(db, columns, "turn_id", "ALTER TABLE messages ADD COLUMN turn_id TEXT");
  await addColumn(
    db,
    columns,
    "status",
    "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete' " +
      "CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled'))"
  );
  await db.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_turn_role " +
      "ON messages(session_id, turn_id, role) WHERE turn_id IS NOT NULL"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS chat_generation_locks (" +
      "session_id INTEGER PRIMARY KEY, " +
      "turn_id TEXT NOT NULL, " +
      "expires_at TEXT NOT NULL, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ")"
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_chat_generation_locks_expires ON chat_generation_locks(expires_at)"
  ).run();
}

export function ensureChatStabilitySchema(db: D1Database): Promise<void> {
  const ready = readyByDatabase.get(db);
  if (ready) return ready;

  const pending = applyChatStabilitySchema(db).catch((error) => {
    readyByDatabase.delete(db);
    throw error;
  });
  readyByDatabase.set(db, pending);
  return pending;
}
