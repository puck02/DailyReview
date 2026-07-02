# Essay Assistant Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the essay writing module with cursor-aware, on-topic inline completion and a richer suggestion rail.

**Architecture:** Keep the existing essay session storage and `/api/essay/suggest` endpoint. Extend the request/response shape for cursor context, add frontend pure helpers for stage detection and insertion formatting, then wire `EssayView` to render a ghost completion overlay, keyboard accept/dismiss, request aborting, and undo.

**Tech Stack:** TypeScript, React, Vite, Cloudflare Workers, D1, Vitest, Node test runner.

---

### Task 1: Backend Context-Aware Suggestions

**Files:**
- Modify: `worker/src/essay/routes.ts`
- Test: `worker/tests/essay-writing.test.ts`

- [ ] **Step 1: Write the failing worker tests**

Add tests that post `prefix`, `suffix`, `cursor_index`, `word_count`, and `paragraph_stage` to `/api/essay/suggest`, then assert the AI prompt contains those fields and that returned suggestions normalize `kind`, `insert_mode`, confidence, and formatting. Add a fallback test for conclusion-stage suggestions.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm --prefix worker test -- essay-writing`

Expected: FAIL because the schema ignores the new fields and response normalization does not expose `insert_mode`.

- [ ] **Step 3: Implement backend support**

Extend the request schema with optional cursor fields. Update the system prompt to require strict on-topic completion, continuity with `prefix`, awareness of `suffix`, no unsupported facts, and clean punctuation/spacing. Normalize `kind` as `word | phrase | sentence | rewrite` and `insert_mode` as `inline | replace`. Make fallback suggestions depend on `paragraph_stage`.

- [ ] **Step 4: Run worker tests**

Run: `npm --prefix worker test -- essay-writing`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add worker/src/essay/routes.ts worker/tests/essay-writing.test.ts
git commit -m "优化作文补全后端上下文"
git push origin cloudflare-workers-deploy
```

### Task 2: Frontend Essay Helper Functions

**Files:**
- Create: `frontend/src/essayAssistant.ts`
- Create: `frontend/tests/essayAssistant.test.mjs`
- Modify: `frontend/package.json`
- Modify: `frontend/src/api.ts`
- Test: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write failing frontend helper and API tests**

Add tests for:
- `deriveEssayParagraphStage`
- `insertEssaySuggestionAtCursor`
- `undoAcceptedEssaySuggestion`
- punctuation and spacing behavior such as `", however"` not duplicating spaces, sentence completions getting one separating space, and endings keeping punctuation stable
- API payload type supporting `prefix`, `suffix`, `cursor_index`, `word_count`, and `paragraph_stage`

- [ ] **Step 2: Run tests to verify failure**

Run: `npm --prefix frontend test`

Expected: FAIL because `essayAssistant.ts` does not exist and API types do not expose the new fields.

- [ ] **Step 3: Implement helpers and API types**

Create focused pure helpers:
- `countEssayWords`
- `deriveEssayParagraphStage`
- `insertEssaySuggestionAtCursor`
- `undoAcceptedEssaySuggestion`
- `normalizeEssaySuggestionForInsert`

Update `EssaySuggestion` to include `phrase`, `rewrite`, and optional `insert_mode`. Update `essaySuggest` payload type to include cursor context.

- [ ] **Step 4: Run frontend tests**

Run: `npm --prefix frontend test`

Expected: PASS for helper/API coverage.

- [ ] **Step 5: Commit and push**

```bash
git add frontend/src/essayAssistant.ts frontend/tests/essayAssistant.test.mjs frontend/package.json frontend/src/api.ts frontend/tests/ui-static.test.mjs
git commit -m "新增作文补全格式化工具"
git push origin cloudflare-workers-deploy
```

### Task 3: Inline Ghost Completion UI

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write failing static UI tests**

Assert that `EssayView` has:
- a textarea ref
- cursor state
- a suggestion abort controller
- `acceptInlineEssaySuggestion`
- `dismissInlineEssaySuggestion`
- `essay-ghost-layer`
- `essay-ghost-suggestion`
- `onKeyDown` handling `Tab` and `Escape`
- request payload using `prefix`, `suffix`, `cursor_index`, `word_count`, and `paragraph_stage`

- [ ] **Step 2: Run static test to verify failure**

Run: `node --test frontend/tests/ui-static.test.mjs`

Expected: FAIL because the inline ghost layer and keyboard handlers do not exist.

- [ ] **Step 3: Implement EssayView interaction**

Track cursor index from selection and change events. Abort active suggestion requests before starting a new one. Send cursor-aware payload. Render the primary inline suggestion in a ghost overlay. Accept with `Tab`, dismiss with `Esc`, insert rail candidates at the cursor, and expose a compact undo button after accepting.

- [ ] **Step 4: Run frontend tests**

Run: `npm --prefix frontend test`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add frontend/src/App.tsx frontend/src/styles.css frontend/tests/ui-static.test.mjs
git commit -m "升级作文行内补全交互"
git push origin cloudflare-workers-deploy
```

### Task 4: Full Verification

**Files:**
- Modify only if verification exposes a concrete issue.

- [ ] **Step 1: Run worker tests**

Run: `npm --prefix worker test`

Expected: all tests pass.

- [ ] **Step 2: Run frontend tests**

Run: `npm --prefix frontend test`

Expected: all tests pass.

- [ ] **Step 3: Build both apps**

Run: `npm --prefix frontend run build && npm --prefix worker run build`

Expected: both builds pass.

- [ ] **Step 4: Push any verification fix**

If fixes were needed:

```bash
git add <changed-files>
git commit -m "修复作文补全验证问题"
git push origin cloudflare-workers-deploy
```

### Self-Review

- The plan covers inline ghost completion, side rail insertion, keyboard accept/dismiss, request aborting, cursor context, stage-aware backend prompts, and punctuation/spacing formatting.
- No database migration is needed.
- Existing callers remain compatible because the new backend fields are optional.
- The user requirement that completion must be on-topic, fit previous content, and handle punctuation/spacing is covered in Task 1 and Task 2.
