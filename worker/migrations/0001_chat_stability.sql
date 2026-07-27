ALTER TABLE messages ADD COLUMN turn_id TEXT;
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
  CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_turn_role
  ON messages(session_id, turn_id, role)
  WHERE turn_id IS NOT NULL;

CREATE TABLE chat_generation_locks (
  session_id INTEGER PRIMARY KEY,
  turn_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_generation_locks_expires ON chat_generation_locks(expires_at);
