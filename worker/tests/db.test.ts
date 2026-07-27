import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import tokenUsageSource from "../src/ai/usage.ts?raw";
import chatRoutesSource from "../src/chat/routes.ts?raw";
import schema from "../src/db/schema.sql?raw";
import essayRoutesSource from "../src/essay/routes.ts?raw";

const chatMigrationUrl = new URL("../migrations/0001_chat_stability.sql", import.meta.url);
const chatMigration = existsSync(chatMigrationUrl) ? readFileSync(chatMigrationUrl, "utf8") : "";
const deployWorkflow = readFileSync(new URL("../../.github/workflows/deploy-cloudflare-worker.yml", import.meta.url), "utf8");

describe("D1 schema", () => {
  it("declares core tables and performance indexes", () => {
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS chat_sessions");
    expect(schema).toContain("image_context TEXT NOT NULL DEFAULT ''");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS reports");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS ai_token_usage");
    expect(schema).toContain("idx_chat_sessions_user_archived_updated");
    expect(schema).toContain("idx_messages_session_created");
    expect(schema).toContain("turn_id TEXT");
    expect(schema).toContain("status TEXT NOT NULL DEFAULT 'complete'");
    expect(schema).toContain("idx_messages_session_turn_role");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS chat_generation_locks");
    expect(schema).toContain("idx_reports_user_type_period");
    expect(schema).toContain("idx_ai_token_usage_user_created");
  });

  it("ships the chat schema change as a deployment migration", () => {
    expect(chatMigration).toContain("ALTER TABLE messages ADD COLUMN turn_id TEXT");
    expect(chatMigration).toContain("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'");
    expect(chatMigration).toContain("CREATE TABLE chat_generation_locks");
    expect(deployWorkflow).toContain("wrangler d1 migrations apply dailyreview-prod --remote");
    expect(deployWorkflow.indexOf("wrangler d1 migrations apply")).toBeLessThan(deployWorkflow.indexOf("npx wrangler deploy"));
  });

  it("keeps request handlers free of runtime schema DDL", () => {
    expect(chatRoutesSource).not.toContain("ALTER TABLE");
    expect(essayRoutesSource).not.toContain("CREATE TABLE");
    expect(essayRoutesSource).not.toContain("CREATE INDEX");
    expect(tokenUsageSource).not.toContain("CREATE TABLE");
    expect(tokenUsageSource).not.toContain("CREATE INDEX");
  });
});
