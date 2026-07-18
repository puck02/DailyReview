# DailyReview Interface and Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve DailyReview's mobile usability, streaming interaction smoothness, visual consistency, and Worker response path without changing its product scope or stack.

**Architecture:** Add small testable frontend helpers for scroll-follow and save coordination, a shared accessible dialog primitive, and keep view-level integration in the existing React application. Move request-time schema work into the existing D1 schema, batch core database operations, and move ancillary work behind `ExecutionContext.waitUntil` while preserving response consistency.

**Tech Stack:** React 19, TypeScript, Vite, Node test runner, Cloudflare Workers, D1, R2, Vitest.

---

### Task 1: Chat follow behavior and Markdown render isolation

**Files:**
- Create: `frontend/src/chatPerformance.ts`
- Create: `frontend/tests/chatPerformance.test.mjs`
- Modify: `frontend/package.json`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/MarkdownRenderer.tsx`
- Modify: `frontend/src/markdownPlugins.ts`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests proving that a viewport follows only within an 80px bottom threshold, that leaving the bottom disables following, and that static source no longer contains `key={normalizedMarkdown}` or `detect: true`.

- [ ] **Step 2: Run tests and verify the expected failures**

Run in `frontend`: `npm test`

Expected: the new helper import or assertions fail because the behavior has not been implemented.

- [ ] **Step 3: Implement the minimal behavior**

Export a pure helper with this contract:

```ts
export function isNearScrollBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 80): boolean;
```

Track the messages viewport with a ref and scroll listener. Auto-follow only while near the bottom and render an icon button to return to the bottom. Extract a memoized message row so unchanged historical messages keep stable props. Remove the dynamic Markdown key, share plugin loading at module scope, and configure highlight.js with `detect: false`.

- [ ] **Step 4: Run focused and full frontend verification**

Run: `npm test`

Run: `npm run build`

Expected: all frontend tests pass and the production build exits 0.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "优化聊天流式渲染与滚动跟随"
```

### Task 2: Accessible dialogs and mobile navigation

**Files:**
- Create: `frontend/src/Dialog.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write failing static behavior tests**

Assert that the dialog primitive handles Escape, focusable elements, focus restoration, and an initial focus ref. Assert that mobile navigation has four primary destinations and one account menu trigger.

- [ ] **Step 2: Run the tests and verify failure**

Run in `frontend`: `npm test`

Expected: assertions fail because `Dialog.tsx` and the account menu do not exist.

- [ ] **Step 3: Implement dialog and navigation behavior**

Create a portal-free dialog wrapper compatible with the existing layout. Use it for word detail and essay image preview. Replace mobile-only AI settings, settings, and logout buttons with an account menu while preserving all desktop buttons and role checks. Ensure mobile hit areas are at least 44x44px.

- [ ] **Step 4: Verify**

Run: `npm test`

Run: `npm run build`

Expected: tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "完善弹窗可访问性与移动导航"
```

### Task 3: Mobile essay workspace and save coordination

**Files:**
- Modify: `frontend/src/essayAssistant.ts`
- Modify: `frontend/tests/essayAssistant.test.mjs`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests for a save version guard that accepts only the latest response. Add static assertions for the `题图 / 正文 / 补全` mobile tabs and removal of React state from ghost scroll synchronization.

- [ ] **Step 2: Verify red state**

Run in `frontend`: `npm test`

Expected: the version guard and mobile tab assertions fail.

- [ ] **Step 3: Implement the essay changes**

Add a monotonically increasing save version and ignore stale responses. Suspend suggestion requests when the essay view is inactive. Sync the ghost layer through a RAF-updated transform ref. Render mobile-only tabs with the editor selected by default, while keeping the desktop three-column structure. Replace the handwriting-style font chain with a formal serif stack.

- [ ] **Step 4: Verify**

Run: `npm test`

Run: `npm run build`

Expected: tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "修复移动作文布局与保存竞态"
```

### Task 4: Remove Worker request-time schema and keepalive work

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `worker/src/essay/routes.ts`
- Modify: `worker/src/ai/usage.ts`
- Modify: `worker/src/index.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/tests/ui-static.test.mjs`
- Modify: `worker/tests/db.test.ts`
- Modify: `worker/tests/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that `/api/health` returns successfully with a DB binding that throws on access. Add source regression assertions that request handlers no longer contain `ALTER TABLE`, `CREATE TABLE`, or `CREATE INDEX`, and that the frontend no longer installs a health interval.

- [ ] **Step 2: Verify red state**

Run in `frontend`: `npm test`

Run in `worker`: `npm test`

Expected: health DB access and request-time DDL assertions fail.

- [ ] **Step 3: Remove hot-path DDL and keepalive**

Use the existing `worker/src/db/schema.sql` as the only schema source. Remove schema guards from chat, essay and token usage. Make health a pure runtime response. Delete the frontend keepalive API and interval.

- [ ] **Step 4: Verify both projects**

Run in `worker`: `npm test && npm run build`

Run in `frontend`: `npm test && npm run build`

Expected: all tests and builds pass.

- [ ] **Step 5: Commit**

```bash
git add frontend worker
git commit -m "移除请求热路径中的初始化开销"
```

### Task 5: Batch Worker work and propagate cancellation

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `worker/src/essay/routes.ts`
- Modify: `worker/src/translation/routes.ts`
- Modify: `worker/src/ai/client.ts`
- Modify: `worker/tests/helpers.ts`
- Modify: `worker/tests/chat-attachments.test.ts`
- Modify: `worker/tests/essay-writing.test.ts`
- Modify: `worker/tests/translation.test.ts`

- [ ] **Step 1: Write failing Worker tests**

Add tests proving that invalid attachment ownership is rejected before a user message is inserted, chat history sent upstream is bounded, essay session listing returns attachments without per-row fetch behavior, translation auto-word work is registered through `waitUntil`, and a request abort reaches non-streaming AI fetch.

- [ ] **Step 2: Verify red state**

Run in `worker`: `npm test`

Expected: each new behavioral assertion fails against the current serial implementation.

- [ ] **Step 3: Implement the Worker changes**

Validate attachments in one `IN` query and link them through `DB.batch`. Bound AI history to the most recent 60 messages while retaining image context. Fetch essay attachments with one joined query. Move translation auto-word extraction and Token usage recording into `waitUntil`. Pass `request.signal` into non-streaming AI requests and enforce one total request deadline.

- [ ] **Step 4: Verify**

Run: `npm test`

Run: `npm run build`

Expected: 0 failed Worker tests and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "批处理服务端热路径并传递请求中止"
```

### Task 6: Visual system and motion cleanup

**Files:**
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/tests/ui-static.test.mjs`
- Modify: `frontend/index.html`

- [ ] **Step 1: Write failing visual contract tests**

Assert the new 6/8/12px radius tokens, defined muted token, reduced-motion word cloud rule, static mobile word cloud, formal essay font, metadata, and removal of card blur from settings and essay panels.

- [ ] **Step 2: Verify red state**

Run in `frontend`: `npm test`

Expected: assertions fail against the current styles and HTML.

- [ ] **Step 3: Apply targeted visual upgrades**

Introduce restrained neutral and semantic color tokens in light and dark modes. Reduce large radii, shadow and blur usage; use separators and surface bands for settings and essay. Reduce word-cloud repeated items and disable its animation on mobile and reduced motion. Prevent the mobile clear-entry button label from wrapping. Add description and theme-color metadata.

- [ ] **Step 4: Verify frontend**

Run: `npm test`

Run: `npm run build`

Expected: tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "统一学习工作台视觉与动效规范"
```

### Task 7: Browser regression and final verification

**Files:**
- Modify only files required by verified browser regressions.

- [ ] **Step 1: Start a production-like frontend with mock API data**

Build the frontend, serve it on an unused local port, and run the existing mock audit at 1440x900, 360x800, 390x844 and 430x932.

- [ ] **Step 2: Verify layout and interaction criteria**

Check that the essay tabs expose every panel, no page has horizontal overflow, bottom navigation is coherent, visible controls are at least 44x44px, dialogs trap and restore focus, and chat follow pauses after scrolling up.

- [ ] **Step 3: Fix each observed regression with a failing assertion first**

For every regression, add or tighten a static/browser assertion, run it to observe failure, apply the smallest correction, and rerun it.

- [ ] **Step 4: Run complete fresh verification**

Run in `frontend`: `npm test && npm run build`

Run in `worker`: `npm test && npm run build`

Run: `git diff --check`

Expected: all commands exit 0, screenshots show no clipping or incoherent overlap, and only intended files are modified.

- [ ] **Step 5: Commit any final regression corrections**

```bash
git add frontend worker
git commit -m "完成界面与性能优化回归"
```
