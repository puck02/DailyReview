import { describe, expect, it } from "vitest";

import schema from "../src/db/schema.sql?raw";

describe("D1 schema", () => {
  it("declares core tables and performance indexes", () => {
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS chat_sessions");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS reports");
    expect(schema).toContain("idx_chat_sessions_user_archived_updated");
    expect(schema).toContain("idx_messages_session_created");
    expect(schema).toContain("idx_reports_user_type_period");
  });
});
