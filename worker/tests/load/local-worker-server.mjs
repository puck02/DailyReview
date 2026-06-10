#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const bundlePath = join(tmpdir(), `dailyreview-worker-${process.pid}.mjs`);

class SqliteStatement {
  values = [];

  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        last_row_id: Number(result.lastInsertRowid || 0),
        changes: result.changes
      }
    };
  }
}

class SqliteD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8"));
  }

  prepare(sql) {
    return new SqliteStatement(this.db, sql);
  }
}

class MemoryR2 {
  objects = new Map();

  async put(key, value, options) {
    let body;
    if (typeof value === "string") {
      body = new TextEncoder().encode(value);
    } else if (value instanceof Blob) {
      body = new Uint8Array(await value.arrayBuffer());
    } else if (value instanceof ArrayBuffer) {
      body = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      body = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    } else {
      body = new Uint8Array();
    }
    this.objects.set(key, { body, httpMetadata: options?.httpMetadata });
    return null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return new Response(object.body, {
      headers: object.httpMetadata?.contentType ? { "content-type": object.httpMetadata.contentType } : {}
    });
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function headersFromNode(request) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

async function writeWebResponse(nodeResponse, response) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    nodeResponse.write(Buffer.from(value));
  }
  nodeResponse.end();
}

await build({
  entryPoints: [new URL("../../src/index.ts", import.meta.url).pathname],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: bundlePath,
  logLevel: "silent"
});

const worker = (await import(pathToFileURL(bundlePath).href)).default;
const env = {
  DB: new SqliteD1(),
  BUCKET: new MemoryR2(),
  ASSETS: { fetch: () => new Response("asset") },
  SECRET_KEY: "local-load-secret",
  AI_BASE_URL: "",
  AI_API_KEY: "",
  AI_DEFAULT_MODEL: "gpt-5.4-mini",
  AI_COMPLEX_MODEL: "gpt-5.5",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@example.com",
  ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_PASSWORD || "admin-password",
  APP_TIMEZONE: "Asia/Shanghai",
  MAX_UPLOAD_BYTES: String(10 * 1024 * 1024),
  PDF_EXPORT_MODE: "downgraded"
};

const server = createServer(async (nodeRequest, nodeResponse) => {
  try {
    const body = await readBody(nodeRequest);
    const request = new Request(`http://127.0.0.1:${PORT}${nodeRequest.url}`, {
      method: nodeRequest.method,
      headers: headersFromNode(nodeRequest),
      body: body.length && nodeRequest.method !== "GET" && nodeRequest.method !== "HEAD" ? body : undefined
    });
    await writeWebResponse(nodeResponse, await worker.fetch(request, env));
  } catch (error) {
    nodeResponse.statusCode = 500;
    nodeResponse.setHeader("content-type", "application/json; charset=utf-8");
    nodeResponse.end(JSON.stringify({ detail: error instanceof Error ? error.message : "local worker error" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`DailyReview local load server listening on http://127.0.0.1:${PORT}`);
});

function shutdown() {
  server.close(() => {
    rmSync(bundlePath, { force: true });
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
