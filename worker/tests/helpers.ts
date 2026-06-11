import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker from "../src/index";
import type { Env } from "../src/env";

type BindValue = string | number | null;
type ReportScheduleInput = {
  userId: number;
  nowIso?: string;
};

export class MemoryReportScheduler {
  readonly scheduledUsers: ReportScheduleInput[] = [];

  constructor(private shouldFail = false) {}

  getByName(userId: string): { fetch: (request: Request | string, init?: RequestInit) => Promise<Response> } {
    return {
      fetch: async (request: Request | string, init?: RequestInit) => {
        if (this.shouldFail) {
          throw new Error("scheduler unavailable");
        }
        const body =
          typeof request === "string" ? init?.body : request.body ? await request.text() : init?.body;
        const input = body ? (JSON.parse(String(body)) as ReportScheduleInput) : { userId: Number(userId) };
        this.scheduledUsers.push({ ...input, userId: Number(userId) });
        return new Response(null, { status: 204 });
      }
    };
  }
}

class SqliteStatement {
  private values: BindValue[] = [];

  constructor(
    private db: DatabaseSync,
    private sql: string
  ) {}

  bind(...values: BindValue[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) || null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
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
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    const schema = readFileSync(fileURLToPath(new URL("../src/db/schema.sql", import.meta.url)), "utf8");
    this.db.exec(schema);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }
}

class MemoryR2 {
  private objects = new Map<string, { body: Uint8Array; httpMetadata?: R2HTTPMetadata }>();

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions) {
    let body: Uint8Array;
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

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return new Response(object.body, { headers: object.httpMetadata?.contentType ? { "content-type": object.httpMetadata.contentType } : {} }) as unknown as R2ObjectBody;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new SqliteD1() as unknown as D1Database,
    BUCKET: new MemoryR2() as unknown as R2Bucket,
    REPORT_SCHEDULER: new MemoryReportScheduler() as unknown as Env["REPORT_SCHEDULER"],
    ASSETS: { fetch: () => new Response("asset") },
    SECRET_KEY: "test-secret",
    AI_DEFAULT_MODEL: "gpt-5.4-mini",
    AI_COMPLEX_MODEL: "gpt-5.5",
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_INITIAL_PASSWORD: "admin-password",
    APP_TIMEZONE: "Asia/Shanghai",
    MAX_UPLOAD_BYTES: String(10 * 1024 * 1024),
    PDF_EXPORT_MODE: "downgraded",
    ...overrides
  };
}

export async function fetchWorker(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return await worker.fetch(new Request(`http://example.com${path}`, init), env);
}

export function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing set-cookie header");
  return cookie.split(";", 1)[0] || "";
}
