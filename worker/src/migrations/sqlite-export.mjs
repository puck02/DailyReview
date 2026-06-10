#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TABLES = [
  "users",
  "invite_codes",
  "chat_sessions",
  "messages",
  "attachments",
  "reports",
  "translation_entries",
  "translation_dictionary_entries",
  "app_settings"
];

function usage() {
  console.error("Usage: node worker/src/migrations/sqlite-export.mjs ./data/app.db ./tmp/dailyreview-export");
  process.exit(1);
}

function iso(value) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const date = new Date(String(value).replace(" ", "T").replace(/\.\d+$/, "") + "Z");
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function objectKeyFromPath(filePath, folder) {
  if (!filePath) return "";
  const normalized = String(filePath).replaceAll("\\", "/");
  const marker = `/${folder}/`;
  const index = normalized.indexOf(marker);
  if (index >= 0) return `${folder}/${normalized.slice(index + marker.length)}`;
  const parts = normalized.split("/");
  const folderIndex = parts.indexOf(folder);
  if (folderIndex >= 0) return parts.slice(folderIndex).join("/");
  return `${folder}/${parts.at(-1) || "unknown"}`;
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertSql(table, rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return rows
    .map((row) => {
      const values = columns.map((column) => quote(row[column])).join(", ");
      return `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${values});`;
    })
    .join("\n");
}

function readRows(db, table) {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return [];
    throw error;
  }
}

function transform(table, row) {
  if (table === "users") {
    return {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      role: row.role,
      created_at: iso(row.created_at)
    };
  }
  if (table === "invite_codes") {
    return {
      id: row.id,
      code: row.code,
      created_by_id: row.created_by_id ?? null,
      used_by_id: row.used_by_id ?? null,
      is_used: row.is_used ? 1 : 0,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at)
    };
  }
  if (table === "chat_sessions") {
    return {
      id: row.id,
      user_id: row.user_id,
      title: row.title || "新会话",
      default_model: row.default_model || "gpt-5.4-mini",
      is_archived: row.is_archived ? 1 : 0,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at)
    };
  }
  if (table === "messages") {
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content || "",
      model: row.model ?? null,
      created_at: iso(row.created_at)
    };
  }
  if (table === "attachments") {
    return {
      id: row.id,
      message_id: row.message_id ?? null,
      user_id: row.user_id,
      object_key: objectKeyFromPath(row.object_key || row.file_path, "uploads"),
      mime_type: row.mime_type,
      size: row.size,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at)
    };
  }
  if (table === "reports") {
    return {
      id: row.id,
      user_id: row.user_id,
      report_type: row.report_type,
      period: row.period,
      markdown_key: objectKeyFromPath(row.markdown_key || row.markdown_path, "reports"),
      html_key: row.html_key ?? null,
      stats_json: row.stats_json || "{}",
      created_at: iso(row.created_at)
    };
  }
  if (table === "translation_entries") {
    return {
      id: row.id,
      user_id: row.user_id,
      source_text: row.source_text,
      source_kind: row.source_kind,
      phonetic: row.phonetic ?? null,
      result_markdown: row.result_markdown || "",
      detail_status: row.detail_status || "ready",
      is_auto_detail: row.is_auto_detail ? 1 : 0,
      created_at: iso(row.created_at)
    };
  }
  if (table === "translation_dictionary_entries") {
    return {
      id: row.id,
      source_text: row.source_text,
      phonetic: row.phonetic ?? null,
      result_markdown: row.result_markdown || "",
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at)
    };
  }
  return {
    key: row.key,
    value: row.value || "",
    updated_at: iso(row.updated_at)
  };
}

const [dbPathArg, outputDirArg] = process.argv.slice(2);
if (!dbPathArg || !outputDirArg) usage();

const dbPath = resolve(dbPathArg);
const outputDir = resolve(outputDirArg);
mkdirSync(outputDir, { recursive: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
const manifest = {};
const sqlParts = [
  "-- Generated by worker/src/migrations/sqlite-export.mjs",
  "PRAGMA foreign_keys = OFF;",
  "BEGIN TRANSACTION;"
];

for (const table of TABLES) {
  const rows = readRows(db, table).map((row) => transform(table, row));
  manifest[table] = rows.length;
  writeFileSync(resolve(outputDir, `${table}.json`), JSON.stringify(rows, null, 2) + "\n");
  const sql = insertSql(table, rows);
  if (sql) sqlParts.push(`\n-- ${table}\n${sql}`);
}

sqlParts.push("COMMIT;", "PRAGMA foreign_keys = ON;", "");
writeFileSync(resolve(outputDir, "d1-import.sql"), sqlParts.join("\n"));
writeFileSync(resolve(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Exported ${Object.values(manifest).reduce((sum, count) => sum + count, 0)} rows to ${relative(process.cwd(), outputDir).split(sep).join("/")}`);
