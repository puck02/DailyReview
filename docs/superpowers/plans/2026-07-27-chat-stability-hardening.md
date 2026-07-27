# Chat Stability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat requests idempotent, cancellable, serialized per session, correctly classified on stream termination, bounded for long histories, paginated, and observable.

**Architecture:** A client-generated `turn_id` identifies one user/assistant pair. D1 stores the pair and a per-session lease before the upstream call, while the SSE bridge owns heartbeat, completion validation, cancellation, final status, and telemetry. Cursor pagination and a pure context-budget function bound data sent in each direction.

**Tech Stack:** React 19, TypeScript, Cloudflare Workers, D1, Web Streams/SSE, Vitest, Node test runner, GitHub Actions.

---

### Task 1: D1 schema and deployment migration

**Files:**
- Create: `worker/src/db/chat-schema.ts`
- Modify: `worker/src/db/schema.sql`
- Modify: `worker/src/index.ts`
- Modify: `.github/workflows/deploy-cloudflare-worker.yml`
- Test: `worker/tests/auth.test.ts`, `worker/tests/db.test.ts`

- [ ] Add failing schema assertions for `turn_id`, `status`, the unique turn index, and `chat_generation_locks`.
- [ ] Run `npm test -- db.test.ts` and confirm the assertions fail.
- [ ] Add the fresh-schema definitions and an idempotent D1 binding migration for existing databases.
- [ ] Require schema readiness before API dispatch and return `schema: ready` from health checks.
- [ ] Deploy the Worker, verify the online health response, and commit with `新增聊天稳定性数据库迁移`.

### Task 2: Cancellation, heartbeat, and upstream completion

**Files:**
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/ai/client.ts`
- Modify: `worker/src/chat/routes.ts`
- Test: `worker/tests/deployment-config.test.ts`
- Test: `worker/tests/chat-attachments.test.ts`

- [ ] Add failing tests that require `enable_request_signal`, an SSE heartbeat during a stalled upstream request, and a visible failed result when upstream EOF arrives without `[DONE]`.
- [ ] Run the targeted tests and confirm all three fail for the expected reasons.
- [ ] Track upstream `[DONE]`; throw `AI stream interrupted before DONE` on premature EOF.
- [ ] Send `: ping\n\n` every configured heartbeat interval and clear the timer in every exit path.
- [ ] Enable the incoming request signal compatibility flag and pass cancellation through to the upstream fetch.
- [ ] Run targeted and full Worker tests, then commit with `完善聊天流取消与断流处理`.

### Task 3: Turn identity and reliable regeneration

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`
- Test: `worker/tests/chat-attachments.test.ts`
- Test: `frontend/tests/ui-static.test.mjs`

- [ ] Add failing tests showing a stale assistant ID cannot overwrite the previous reply and duplicate `turn_id` cannot create duplicate user messages.
- [ ] Generate `turn_id` with `crypto.randomUUID()` before optimistic rendering and include it in the stream request.
- [ ] Atomically insert user plus assistant placeholder using the same turn; return or reuse the stored turn on duplicate delivery.
- [ ] Update the exact placeholder at stream completion. Regeneration must select by exact assistant ID or turn and return 404 when neither exists.
- [ ] Expose `turn_id` and `status` in message responses and reconcile authoritative messages after every stream exit.
- [ ] Run frontend and Worker tests, then commit with `修复聊天幂等与重新生成定位`.

### Task 4: Per-session generation lease

**Files:**
- Create: `worker/src/chat/generation-lock.ts`
- Modify: `worker/src/chat/routes.ts`
- Test: `worker/tests/chat-attachments.test.ts`

- [ ] Add failing tests for two simultaneous turns in one session, expired lease takeover, and deletion during generation.
- [ ] Implement atomic lease acquisition with `INSERT ... ON CONFLICT ... WHERE expires_at < ?`, guarded release, and active-lock lookup.
- [ ] Acquire before message insertion or regeneration and release from the stream finalizer.
- [ ] Return HTTP 409 for a different active turn and block deletion while the lease is active.
- [ ] Run Worker tests and commit with `增加会话生成并发保护`.

### Task 5: Context budget and input bounds

**Files:**
- Create: `worker/src/chat/context.ts`
- Modify: `worker/src/chat/routes.ts`
- Test: `worker/tests/chat-context.test.ts`

- [ ] Add failing pure tests for an 80,000-character budget, leading assistant removal, failed/pending exclusion, and preservation of the newest user message.
- [ ] Implement a reverse accumulator over at most 120 candidate messages and normalize the selected start to a user boundary.
- [ ] Add `.max(20_000)` to chat text input and return a 400 response above the limit.
- [ ] Use the bounded context in send and regenerate paths.
- [ ] Run Worker tests and commit with `限制聊天输入与上下文规模`.

### Task 6: Cursor message pagination

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `worker/tests/chat-attachments.test.ts`
- Test: `frontend/tests/ui-static.test.mjs`

- [ ] Add failing backend tests for 100-row pages and `before_id`, plus frontend assertions for the older-message control and scroll preservation.
- [ ] Return `{items, next_before_id}` and query attachments only for messages in the selected page.
- [ ] Load the newest page by default and prepend older pages with ID deduplication.
- [ ] Preserve `scrollHeight - scrollTop` while prepending.
- [ ] Run frontend and Worker tests, then commit with `增加聊天记录游标分页`.

### Task 7: Structured telemetry and stronger load smoke

**Files:**
- Create: `worker/src/chat/telemetry.ts`
- Modify: `worker/src/chat/routes.ts`
- Modify: `worker/src/ai/client.ts`
- Modify: `worker/tests/load/ten-users.mjs`
- Test: `worker/tests/chat-attachments.test.ts`

- [ ] Add failing tests that capture a failed stream log and ensure it contains identifiers/outcome but not prompt text or credentials.
- [ ] Emit structured start/final/error events with request, turn, session, user, model, phase, duration, character count, and safe error fields.
- [ ] Extend load smoke to require downstream `[DONE]` and issue two concurrent requests to one session, accepting exactly one and requiring one 409.
- [ ] Run Worker tests and a short local load smoke, then commit with `补充聊天观测与并发压测`.

### Task 8: Full verification and deployment

**Files:**
- Verify only.

- [ ] Run `npm test` and `npm run build` in `frontend/`.
- [ ] Run `npm test` and `npm run build` in `worker/`.
- [ ] Run `git diff --check` and verify `example.txt` remains untracked.
- [ ] Push `cloudflare-workers-deploy` and wait for GitHub Actions success.
- [ ] Verify the production asset, `/api/health`, and the deployed commit SHA.
