# Essay Writing Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated English exam essay writing workspace that accepts topic images, derives backend image context, and offers delayed completion suggestions while the user types.

**Architecture:** Reuse the existing Cloudflare Worker AI stack, image upload flow, and provider configuration. Add a new backend route that turns an uploaded topic image into a compact objective description plus OCR text, store the result with the essay session, and stream completion suggestions from the configured vision/text models. On the frontend, add a separate writing view with a paper-like editor, floating suggestion UI, and accept/reject controls instead of a plain textarea.

**Tech Stack:** TypeScript, React, Vite, Cloudflare Workers, D1, R2, Vitest, Node test runner, lucide-react.

---

### Task 1: Add essay session persistence and backend routes

**Files:**
- Modify: `worker/src/db/schema.sql`
- Modify: `worker/src/chat/routes.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/tests/essay-writing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("creates an essay session and stores image context from a topic image", async () => {
  // create session
  // upload image attachment
  // call new essay image-context route
  // expect saved objective image context to be persisted
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix worker test -- essay-writing`
Expected: route missing or response body mismatch.

- [ ] **Step 3: Write minimal implementation**

```ts
// add essay_sessions table fields for user-scoped writing state
// add POST /api/essay/sessions
// add POST /api/essay/sessions/:id/image-context
// reuse vision model + completion prompt to return objective OCR/context only
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix worker test -- essay-writing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/schema.sql worker/src/chat/routes.ts worker/src/index.ts worker/tests/essay-writing.test.ts
git commit -m "feat: add essay writing backend"
```

### Task 2: Add essay writing API surface to the frontend client

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("essay api methods serialize session creation, image context, and completion suggestion requests", async () => {
  // assert request paths and payloads
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix frontend test -- essay`
Expected: missing methods or wrong request payloads.

- [ ] **Step 3: Write minimal implementation**

```ts
export type EssaySession = { id: number; ... };
export type EssaySuggestion = { kind: "word" | "sentence"; text: string; confidence: number; reason: string };

export const api = {
  // ...
  essaySessions: () => request<EssaySession[]>("/api/essay/sessions"),
  createEssaySession: (title: string) => request<EssaySession>("/api/essay/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  essayImageContext: (sessionId: number, attachmentId: number) =>
    request<{ objective_description: string; ocr_text: string }>("/api/essay/sessions/${sessionId}/image-context", {
      method: "POST",
      body: JSON.stringify({ attachment_id: attachmentId })
    }),
  essaySuggest: (payload: { session_id: number; content: string; model: string; objective_description: string; ocr_text: string }) =>
    request<{ suggestions: EssaySuggestion[] }>("/api/essay/suggest", { method: "POST", body: JSON.stringify(payload) })
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix frontend test -- essay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat: add essay writing api"
```

### Task 3: Build the writing workspace UI

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("essay writing view renders a dedicated workspace and suggestion rail", () => {
  assert.ok(app.includes('aria-label="作文"'));
  assert.ok(app.includes("essay-editor"));
  assert.ok(app.includes("essay-suggestion-rail"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix frontend test -- ui-static`
Expected: missing nav entry and layout classes.

- [ ] **Step 3: Write minimal implementation**

```tsx
// add a new View: "essay"
// add nav button for 作文
// add an essay workspace with:
// - topic image upload
// - paper-like editor area
// - delayed suggestion overlay
// - accept/reject controls
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix frontend test -- ui-static`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/styles.css frontend/tests/ui-static.test.mjs
git commit -m "feat: add essay writing workspace"
```

### Task 4: Add completion suggestion generation and debounce behavior

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Test: `worker/tests/essay-writing.test.ts`
- Test: `frontend/tests/streamChat.test.mjs`

- [ ] **Step 1: Write the failing test**

```ts
it("returns short delayed essay suggestions that respect the current context", async () => {
  // verify endpoint returns multiple candidate suggestions
  // verify prompt contains objective image context and current draft
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix worker test -- essay-writing`
Expected: no suggestion endpoint.

- [ ] **Step 3: Write minimal implementation**

```ts
// add /api/essay/suggest
// generate 1-3 suggestions from the text model using:
// - objective image context
// - OCR text
// - current draft
// - a strict "do not invent unsupported facts" prompt
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix worker test -- essay-writing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/chat/routes.ts worker/tests/essay-writing.test.ts frontend/src/App.tsx frontend/src/api.ts frontend/tests/streamChat.test.mjs
git commit -m "feat: add essay completion suggestions"
```

### Task 5: Verify the full app and keep the change scoped

**Files:**
- Modify: none unless verification exposes a concrete bug

- [ ] **Step 1: Run backend tests**

Run: `npm --prefix worker test`
Expected: all tests pass.

- [ ] **Step 2: Run frontend tests**

Run: `npm --prefix frontend test`
Expected: all tests pass.

- [ ] **Step 3: Build both apps**

Run: `npm --prefix frontend run build && npm --prefix worker run build`
Expected: successful builds.

- [ ] **Step 4: Commit verification fixes only if needed**

```bash
git add .
git commit -m "feat: finish essay writing assistant"
```

### Self-review

- Scope matches one product surface: a dedicated essay writing workspace.
- Backend persistence, completion generation, and frontend interaction each have a task.
- No placeholder steps remain.
- All function names and payload shapes are defined before they are used.

