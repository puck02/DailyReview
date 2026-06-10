# Cloudflare Workers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Workers deployment branch for DailyReview with TypeScript Worker APIs, D1, R2, Cron, detailed README, and stability/load testing for at least 10 concurrent users.

**Architecture:** Keep `frontend/` as the React/Vite client and add `worker/` as the Cloudflare production backend. The Worker owns `/api/*`, D1 stores structured data, R2 stores uploads and report files, Cron replaces APScheduler, and the branch `cloudflare-workers-deploy` is the Cloudflare Builds target.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, R2, Cron Triggers, Wrangler, Vitest, Miniflare, React, Vite, Node.js test runner/load script.

---

## File Structure

- Create `worker/package.json`: Worker scripts, dependencies, tests, and load commands.
- Create `worker/tsconfig.json`: strict TypeScript config for Worker runtime.
- Create `worker/wrangler.toml`: Cloudflare resource bindings and cron definitions, with placeholder resource names only.
- Create `worker/src/index.ts`: Worker entrypoint for `fetch` and `scheduled`.
- Create `worker/src/env.ts`: typed Cloudflare bindings and non-secret config.
- Create `worker/src/http.ts`: JSON, error, cookie, routing helpers.
- Create `worker/src/db/schema.sql`: D1 schema and indexes.
- Create `worker/src/db/d1.ts`: D1 helper functions for prepared statements and transactions.
- Create `worker/src/auth/security.ts`: PBKDF2 password verification/hash, JWT HMAC signing, cookie helpers.
- Create `worker/src/auth/routes.ts`: auth and invite APIs.
- Create `worker/src/settings/routes.ts`: app settings APIs.
- Create `worker/src/admin/routes.ts`: AI config APIs.
- Create `worker/src/attachments/routes.ts`: upload/download APIs backed by R2.
- Create `worker/src/chat/routes.ts`: session/message APIs and SSE chat streaming.
- Create `worker/src/ai/client.ts`: OpenAI-compatible non-streaming and streaming client.
- Create `worker/src/translation/service.ts`: translation detection, prompt, fallback, phonetic extraction.
- Create `worker/src/translation/routes.ts`: translation APIs and queued word detail state.
- Create `worker/src/reports/service.ts`: markdown report generation and R2 persistence.
- Create `worker/src/reports/routes.ts`: report list/content APIs and stable PDF downgrade response.
- Create `worker/src/cron/jobs.ts`: report generation and cleanup tasks.
- Create `worker/src/migrations/sqlite-export.mjs`: SQLite export helper for current data.
- Create `worker/src/migrations/r2-upload.mjs`: local data directory to R2 upload helper.
- Create `worker/tests/*.test.ts`: unit/integration tests.
- Create `worker/tests/load/ten-users.mjs`: 10-user load/stability test.
- Modify `frontend/src/api.ts`: support stable PDF downgrade error text.
- Modify `frontend/src/App.tsx`: show clear PDF downgrade message without broken download.
- Modify `README.md`: full Cloudflare deployment, tech stack, resources, secrets, migration, testing, pressure test, rollback.

## Commit Policy

Commit after every task that leaves tests passing. Use concise Chinese commit messages. Do not commit secrets, tokens, `.dev.vars`, `.wrangler`, local D1 files, or exported user data.

## Task 1: Worker Project Scaffold

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.toml`
- Create: `worker/src/env.ts`
- Create: `worker/src/http.ts`
- Create: `worker/src/index.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add Worker package manifest**

Create `worker/package.json` with scripts:

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "dev": "wrangler dev --local",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "load": "node tests/load/ten-users.mjs"
  },
  "dependencies": {
    "itty-router": "^5.0.22",
    "jose": "^6.2.3",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.14",
    "@cloudflare/workers-types": "^4.20260610.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8",
    "wrangler": "^4.99.0"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "WebWorker"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Add Wrangler config**

Create `worker/wrangler.toml`:

```toml
name = "dailyreview"
main = "src/index.ts"
compatibility_date = "2026-06-10"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "../frontend/dist"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "dailyreview-prod"
database_id = "replace-with-cloudflare-d1-id"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "dailyreview-prod-assets"

[triggers]
crons = ["0 * * * *"]

[vars]
APP_TIMEZONE = "Asia/Shanghai"
AI_DEFAULT_MODEL = "gpt-5.4-mini"
AI_COMPLEX_MODEL = "5.5"
MAX_UPLOAD_BYTES = "10485760"
PDF_EXPORT_MODE = "downgraded"
```

- [ ] **Step 4: Add environment typings**

Create `worker/src/env.ts`:

```ts
export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SECRET_KEY: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_DEFAULT_MODEL: string;
  AI_COMPLEX_MODEL: string;
  ADMIN_EMAIL?: string;
  ADMIN_INITIAL_PASSWORD?: string;
  APP_TIMEZONE: string;
  MAX_UPLOAD_BYTES: string;
  PDF_EXPORT_MODE: "downgraded";
};
```

- [ ] **Step 5: Add HTTP helpers**

Create `worker/src/http.ts`:

```ts
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ detail: error.message }, { status: error.status });
  }
  return json({ detail: "服务器内部错误" }, { status: 500 });
}

export async function parseJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "请求格式无效");
  }
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function sessionCookie(value: string, maxAge: number): string {
  return `session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
```

- [ ] **Step 6: Add Worker entrypoint**

Create `worker/src/index.ts`:

```ts
import type { Env } from "./env";
import { errorResponse, json } from "./http";

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return json({ status: "ok", runtime: "cloudflare-workers" });
  }
  return json({ detail: "接口未实现" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
  async scheduled(_event: ScheduledEvent, _env: Env): Promise<void> {
    return;
  }
};
```

- [ ] **Step 7: Ignore local Cloudflare files**

Append to `.gitignore`:

```text
.wrangler/
worker/.dev.vars
worker/.mf/
worker/.d1/
worker/dist/
```

- [ ] **Step 8: Install dependencies**

Run:

```bash
npm --prefix worker install
```

Expected: `worker/package-lock.json` is created and install exits successfully.

- [ ] **Step 9: Verify scaffold**

Run:

```bash
npm --prefix worker run build
```

Expected: TypeScript exits with code 0.

- [ ] **Step 10: Commit**

Run:

```bash
git add .gitignore worker/package.json worker/package-lock.json worker/tsconfig.json worker/wrangler.toml worker/src
git commit -m "搭建 Cloudflare Worker 工程"
```

## Task 2: D1 Schema and Query Helpers

**Files:**
- Create: `worker/src/db/schema.sql`
- Create: `worker/src/db/d1.ts`
- Create: `worker/tests/db.test.ts`

- [ ] **Step 1: Write D1 schema**

Create `worker/src/db/schema.sql` with tables and indexes matching the existing model:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_by_id INTEGER,
  used_by_id INTEGER,
  is_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  default_model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_archived_updated ON chat_sessions(user_id, is_archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  user_id INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_user_expires ON attachments(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  period TEXT NOT NULL,
  markdown_key TEXT NOT NULL,
  html_key TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, report_type, period)
);
CREATE INDEX IF NOT EXISTS idx_reports_user_type_period ON reports(user_id, report_type, period DESC);

CREATE TABLE IF NOT EXISTS translation_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  phonetic TEXT,
  result_markdown TEXT NOT NULL DEFAULT '',
  detail_status TEXT NOT NULL DEFAULT 'ready',
  is_auto_detail INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_translation_entries_user_created ON translation_entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_entries_user_kind_created ON translation_entries(user_id, source_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_entries_status ON translation_entries(detail_status, created_at ASC);

CREATE TABLE IF NOT EXISTS translation_dictionary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT NOT NULL UNIQUE,
  phonetic TEXT,
  result_markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_translation_dictionary_source ON translation_dictionary_entries(source_text);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Add D1 helpers**

Create `worker/src/db/d1.ts`:

```ts
export type Row = Record<string, unknown>;

export async function first<T extends Row>(stmt: D1PreparedStatement): Promise<T | null> {
  return await stmt.first<T>();
}

export async function all<T extends Row>(stmt: D1PreparedStatement): Promise<T[]> {
  const result = await stmt.all<T>();
  return result.results || [];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function boolFromDb(value: unknown): boolean {
  return value === 1 || value === true;
}

export function boolToDb(value: boolean): number {
  return value ? 1 : 0;
}
```

- [ ] **Step 3: Add schema smoke test**

Create `worker/tests/db.test.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix worker run test
```

Expected: test passes.

- [ ] **Step 5: Commit**

Run:

```bash
git add worker/src/db worker/tests/db.test.ts
git commit -m "添加 D1 数据结构"
```

## Task 3: Auth, Sessions, and Invites

**Files:**
- Create: `worker/src/auth/security.ts`
- Create: `worker/src/auth/routes.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/tests/auth.test.ts`

- [ ] **Step 1: Implement old PBKDF2-compatible security helpers**

`worker/src/auth/security.ts` must verify existing hashes like:

```text
pbkdf2_sha256$240000$0123456789abcdef0123456789abcdef$d6f16137374d885080f468d07c645eba1b226a49f701c7ee1290ee85c7dc9d6a
```

The password for that vector is:

```text
CorrectHorseBatteryStaple1!
```

Implement:

- `verifyPassword(password, hash)`
- `hashPassword(password)`
- `signSession(userId, secret)`
- `verifySession(token, secret)`
- `requireUser(request, env)`
- `requireAdmin(request, env)`

- [ ] **Step 2: Implement auth routes**

`worker/src/auth/routes.ts` handles:

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/invites`
- `GET /api/invites`

Match existing Chinese errors:

- `未登录`
- `登录已失效`
- `用户不存在`
- `邮箱或密码错误`
- `邮箱已注册`
- `邀请码无效`
- `需要管理员权限`

- [ ] **Step 3: Wire routes in entrypoint**

Modify `worker/src/index.ts` so `handleApi()` delegates auth and invite paths before returning 404.

- [ ] **Step 4: Add auth tests**

Create tests covering:

- PBKDF2 vector verifies true.
- Wrong password verifies false.
- Login returns `Set-Cookie`.
- `/api/auth/me` returns user when cookie exists.
- Admin can create invite.
- Normal user cannot create invite.

- [ ] **Step 5: Run auth tests**

Run:

```bash
npm --prefix worker run test -- auth
```

Expected: all auth tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add worker/src/auth worker/src/index.ts worker/tests/auth.test.ts
git commit -m "实现 Worker 认证与邀请码"
```

## Task 4: Settings and Admin AI Config

**Files:**
- Create: `worker/src/settings/routes.ts`
- Create: `worker/src/admin/routes.ts`
- Create: `worker/src/ai/client.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/tests/settings-admin.test.ts`

- [ ] **Step 1: Implement settings validation**

`worker/src/settings/routes.ts` must preserve:

- default `daily_report_time = "23:00"`
- default `weekly_report_time = "23:00"`
- default `weekly_report_day = "sun"`
- default `word_cloud_enabled = true`
- HH:MM validation with error `时间格式必须为 HH:MM`
- weekly day validation with error `周报生成日无效`
- `PUT /api/settings` requires admin.

- [ ] **Step 2: Implement AI config routes**

`worker/src/admin/routes.ts` must preserve:

- `GET /api/admin/ai-config`
- `PUT /api/admin/ai-config`
- `POST /api/admin/ai-config/test`
- API key mask behavior: `abcdef****1234` for longer keys.
- Test response shape `{ ok, message }`.

- [ ] **Step 3: Implement AI client**

`worker/src/ai/client.ts` exposes:

- `completeChat(messages, model, fallback, env, config?)`
- `streamChatCompletion(messages, model, env, config?)`
- `testAiConnection(config, model)`
- safe error messages equivalent to current Python behavior.

- [ ] **Step 4: Add tests**

Tests cover:

- Defaults are returned when no settings exist.
- Invalid time is rejected.
- Admin can update settings.
- Non-admin cannot update settings.
- API key preview masks secrets.
- AI test with missing key returns `AI 配置不完整`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm --prefix worker run test -- settings-admin
```

- [ ] **Step 6: Commit**

Run:

```bash
git add worker/src/settings worker/src/admin worker/src/ai worker/src/index.ts worker/tests/settings-admin.test.ts
git commit -m "实现设置和 AI 配置接口"
```

## Task 5: Chat Sessions, Messages, Attachments, and SSE

**Files:**
- Create: `worker/src/attachments/routes.ts`
- Create: `worker/src/chat/routes.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/tests/chat-attachments.test.ts`

- [ ] **Step 1: Implement attachment validation**

Support PNG, JPEG, GIF, WebP signatures. Preserve errors:

- empty file: `图片为空，请重新粘贴或选择图片`
- unsupported file: `只支持 PNG、JPEG、WebP 或 GIF 图片`
- too large: `图片不能超过 10MB`

Store object key in D1 and bytes in R2.

- [ ] **Step 2: Implement attachment download**

`GET /api/attachments/:id/content` must:

- require login.
- check `attachments.user_id`.
- return 404 `附件不存在` if missing or unauthorized.
- stream R2 object with stored content type.

- [ ] **Step 3: Implement session and message APIs**

Preserve:

- create session with `title || "新会话"`.
- list only sessions updated within 7 days unless archived.
- hide non-archived sessions without messages.
- archive/unarchive behavior.
- delete session removes messages but keeps detached attachments.
- list messages includes attachment URLs.

- [ ] **Step 4: Implement SSE chat**

`POST /api/chat/stream` must:

- validate session ownership.
- insert user message first.
- attach selected attachments.
- update session title from first user message if title is `新会话`.
- stream tokens as `data: "<token>"\n\n`.
- end with `data: [DONE]\n\n`.
- write complete assistant message after stream.
- return fallback local answer when AI config is incomplete.

- [ ] **Step 5: Add tests**

Tests cover:

- create/list/archive/delete session.
- upload/download PNG fixture.
- reject invalid upload.
- unauthorized attachment access returns 404.
- SSE returns local fallback and `[DONE]` with no AI config.

- [ ] **Step 6: Run tests**

Run:

```bash
npm --prefix worker run test -- chat-attachments
```

- [ ] **Step 7: Commit**

Run:

```bash
git add worker/src/attachments worker/src/chat worker/src/index.ts worker/tests/chat-attachments.test.ts
git commit -m "实现聊天和附件接口"
```

## Task 6: Translation Module

**Files:**
- Create: `worker/src/translation/service.ts`
- Create: `worker/src/translation/routes.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/tests/translation.test.ts`

- [ ] **Step 1: Implement translation service**

Preserve:

- source kind detection: Chinese text -> `chinese`; single English word -> `word`; other English -> `english`.
- input limit 2000 characters.
- limit error: `输入超过 2000 字，已超限，不予翻译。`
- default prompt content.
- fallback Markdown for Chinese, word, English.
- phonetic extraction from `音标：/.../`.
- thin dictionary detection.

- [ ] **Step 2: Implement translation routes**

Routes:

- `GET /api/translation/prompt`
- `PUT /api/translation/prompt`
- `GET /api/translation/entries`
- `POST /api/translation/dictionary-entry`
- `POST /api/translation`

Preserve:

- entries list limited to 30.
- dictionary entry can return queued status.
- AI failure falls back to local Markdown.

- [ ] **Step 3: Add tests**

Tests cover:

- Chinese detection.
- word detection.
- English sentence detection.
- prompt update and read.
- 2000-character limit.
- translate without AI config returns fallback and ready status.
- dictionary entry returns queued when no cached detail exists.

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix worker run test -- translation
```

- [ ] **Step 5: Commit**

Run:

```bash
git add worker/src/translation worker/src/index.ts worker/tests/translation.test.ts
git commit -m "迁移翻译模块到 Worker"
```

## Task 7: Reports, Cron, Cleanup, and Stable PDF Downgrade

**Files:**
- Create: `worker/src/reports/service.ts`
- Create: `worker/src/reports/routes.ts`
- Create: `worker/src/cron/jobs.ts`
- Modify: `worker/src/index.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`
- Create: `worker/tests/reports-cron.test.ts`
- Modify or create: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Implement report service**

Preserve:

- daily report from messages on a day.
- weekly summary from daily reports.
- monthly summary from daily reports.
- keyword extraction from Chinese and English text.
- Markdown saved to R2.
- report metadata saved to D1.

- [ ] **Step 2: Implement report routes**

Routes:

- `GET /api/reports?report_type=daily|weekly|monthly&month=YYYY-MM`
- `GET /api/reports/:id`
- `GET /api/reports/:id/pdf`

PDF downgrade behavior must be stable:

```json
HTTP 501
{ "detail": "Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。" }
```

- [ ] **Step 3: Implement Cron jobs**

`worker/src/cron/jobs.ts` exposes:

- `runScheduledJobs(env, now)`
- `generateDailyReports(env, day)`
- `generateWeeklyReports(env, day)`
- `generateMonthlyReports(env, day)`
- `cleanupExpiredData(env, now)`
- `processQueuedWordDetails(env, limit)`

Each job processes limited rows and can safely run again.

- [ ] **Step 4: Wire scheduled entrypoint**

Modify `worker/src/index.ts` `scheduled()` to call `runScheduledJobs(env, new Date())`.

- [ ] **Step 5: Frontend PDF downgrade**

Modify `frontend/src/api.ts` and `frontend/src/App.tsx` so failed PDF export displays the returned detail and does not create a broken download.

Expected visible text:

```text
Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。
```

- [ ] **Step 6: Add report and PDF stability tests**

Tests cover:

- daily report writes R2 Markdown and D1 metadata.
- report list filters by type and month.
- report content reads Markdown from R2.
- unauthorized report returns 404.
- `/api/reports/:id/pdf` returns 501 JSON with exact downgrade text.
- frontend static test verifies PDF failure path displays error.

- [ ] **Step 7: Run tests**

Run:

```bash
npm --prefix worker run test -- reports-cron
npm --prefix frontend run test
```

- [ ] **Step 8: Commit**

Run:

```bash
git add worker/src/reports worker/src/cron worker/src/index.ts worker/tests/reports-cron.test.ts frontend/src/api.ts frontend/src/App.tsx frontend/tests
git commit -m "实现报告和 PDF 稳定降级"
```

## Task 8: Data Migration Scripts

**Files:**
- Create: `worker/src/migrations/sqlite-export.mjs`
- Create: `worker/src/migrations/r2-upload.mjs`
- Create: `worker/src/migrations/README.md`

- [ ] **Step 1: Add SQLite export script**

`sqlite-export.mjs` reads `data/app.db` and exports JSON files for D1 import:

```bash
node worker/src/migrations/sqlite-export.mjs ./data/app.db ./tmp/dailyreview-export
```

The script must export:

- `users.json`
- `invite_codes.json`
- `chat_sessions.json`
- `messages.json`
- `attachments.json`
- `reports.json`
- `translation_entries.json`
- `translation_dictionary_entries.json`
- `app_settings.json`

- [ ] **Step 2: Add R2 upload script**

`r2-upload.mjs` uploads local files through Wrangler:

```bash
node worker/src/migrations/r2-upload.mjs ./data/uploads uploads
node worker/src/migrations/r2-upload.mjs ./data/reports reports
```

The script must print commands before executing and never print secrets.

- [ ] **Step 3: Add migration README**

Document:

- backup first.
- export local SQLite.
- create D1 schema.
- import rows.
- upload files to R2.
- verify counts.
- rollback by routing back to old service.

- [ ] **Step 4: Commit**

Run:

```bash
git add worker/src/migrations
git commit -m "添加 Cloudflare 数据迁移脚本"
```

## Task 9: Load and Stability Testing

**Files:**
- Create: `worker/tests/load/ten-users.mjs`
- Create: `worker/tests/load/README.md`
- Modify: `worker/package.json`

- [ ] **Step 1: Add 10-user load script**

`ten-users.mjs` accepts:

```bash
DAILYREVIEW_BASE_URL=http://127.0.0.1:8787 node worker/tests/load/ten-users.mjs
```

The script must:

- create or reuse 10 test users.
- login all users.
- create one session per user.
- call sessions/messages repeatedly for 3 minutes.
- call `/api/chat/stream` with AI mock/fallback mode.
- upload a tiny PNG.
- list reports.
- record p50/p95/max latency.
- fail if any 5xx occurs.
- fail if non-AI p95 exceeds 500ms on local/mock mode.
- fail if SSE first token p95 exceeds 1000ms on local/mock mode.

- [ ] **Step 2: Add load README**

Document:

- local mode.
- preview deployment mode.
- required admin/test setup.
- expected thresholds.
- how to interpret failures.

- [ ] **Step 3: Run local smoke load**

Run:

```bash
npm --prefix worker run load
```

Expected: script exits 0 against local Worker after test users and fallback AI are configured.

- [ ] **Step 4: Commit**

Run:

```bash
git add worker/tests/load worker/package.json
git commit -m "添加 10 人并发压测脚本"
```

## Task 10: README and Deployment Documentation

**Files:**
- Modify: `README.md`
- Create: `.env.example.cloudflare`

- [ ] **Step 1: Rewrite README technical stack**

README must include:

- current branch purpose.
- frontend stack.
- Worker stack.
- D1/R2/Cron purpose.
- local Python backend note for main branch.

- [ ] **Step 2: Document Cloudflare resources**

Include commands:

```bash
npx wrangler d1 create dailyreview-prod
npx wrangler r2 bucket create dailyreview-prod-assets
npx wrangler d1 execute dailyreview-prod --file worker/src/db/schema.sql
```

State that IDs must be copied into `worker/wrangler.toml`.

- [ ] **Step 3: Document secrets**

Use safe examples only:

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put AI_BASE_URL
npx wrangler secret put AI_API_KEY
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_INITIAL_PASSWORD
```

Explicitly warn not to commit Cloudflare tokens.

- [ ] **Step 4: Document GitHub branch deployment**

Cloudflare Workers Builds:

- repo: `puck02/DailyReview`
- branch: `cloudflare-workers-deploy`
- build command:

```bash
npm --prefix frontend ci && npm --prefix frontend run build && npm --prefix worker ci && npm --prefix worker run build
```

- deploy command: Cloudflare default Worker deploy or configured build output.

- [ ] **Step 5: Document PDF downgrade stability**

README must state:

- PDF export is intentionally disabled in first Workers migration.
- API returns 501 with stable JSON.
- users can still view Markdown report.
- later upgrade option: Cloudflare Browser Rendering or external PDF service.

- [ ] **Step 6: Document testing and load testing**

Include:

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix worker run test
npm --prefix worker run build
npm --prefix worker run load
```

- [ ] **Step 7: Commit**

Run:

```bash
git add README.md .env.example.cloudflare
git commit -m "完善 Cloudflare 部署文档"
```

## Task 11: End-to-End Verification and Push

**Files:**
- No new files expected unless verification reveals a needed fix.

- [ ] **Step 1: Run full frontend verification**

Run:

```bash
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: both pass.

- [ ] **Step 2: Run full Worker verification**

Run:

```bash
npm --prefix worker run test
npm --prefix worker run build
```

Expected: both pass.

- [ ] **Step 3: Run local Worker smoke**

Run:

```bash
npm --prefix worker run dev
```

In another shell:

```bash
curl -sSf http://127.0.0.1:8787/api/health
```

Expected JSON contains:

```json
{ "status": "ok", "runtime": "cloudflare-workers" }
```

- [ ] **Step 4: Run load test**

Run:

```bash
DAILYREVIEW_BASE_URL=http://127.0.0.1:8787 npm --prefix worker run load
```

Expected:

- no 5xx.
- non-AI p95 under 500ms in local/mock mode.
- SSE first token p95 under 1000ms in local/mock mode.

- [ ] **Step 5: Check for secrets**

Run:

```bash
rg -n "cfut_[A-Za-z0-9_-]+|AI_API_KEY=.*[A-Za-z0-9_-]{20,}|SECRET_KEY=.*[A-Za-z0-9_-]{20,}|CLOUDFLARE_API_TOKEN=.*[A-Za-z0-9_-]{20,}" . --glob '!docs/superpowers/plans/2026-06-10-cloudflare-workers-migration.md'
```

Expected: no real secret values.

- [ ] **Step 6: Check git status**

Run:

```bash
git status --short --branch
```

Expected: clean worktree on `cloudflare-workers-deploy`.

- [ ] **Step 7: Push branch**

Run:

```bash
git push -u origin cloudflare-workers-deploy
```

Expected: branch is pushed to GitHub.

## Final Summary Requirements

Final response must include:

- branch name and latest commit hash.
- list of major optimizations.
- test commands run and results.
- load test p95 results.
- PDF downgrade behavior and stability test result.
- deployment instructions summary.
- reminder that the exposed Cloudflare token should be revoked/rotated.
