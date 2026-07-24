# Translation Enter Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Enter` submit translation while `Shift+Enter` inserts a newline and IME composition remains uninterrupted.

**Architecture:** Keep the behavior inside the existing `TranslationView` component and reuse `submitTranslation()` for all validation and request state. Bind one keyboard handler to the existing translation textarea; do not change the API, layout, or button behavior.

**Tech Stack:** React 19, TypeScript, Node test runner, Vite

---

### Task 1: Define the keyboard interaction with a failing regression test

**Files:**
- Modify: `frontend/tests/ui-static.test.mjs`

- [x] **Step 1: Add a focused static interaction test**

```js
test("translation submits with Enter while Shift+Enter inserts a newline", () => {
  assert.match(app, /function handleTranslationKeyDown\(event: KeyboardEvent<HTMLTextAreaElement>\)/);
  assert.match(app, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.nativeEvent\.isComposing/);
  assert.match(app, /event\.preventDefault\(\);[\s\S]*void submitTranslation\(\);/);
  assert.match(app, /className="translation-input"[\s\S]*onKeyDown=\{handleTranslationKeyDown\}/);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="translation submits with Enter" tests/ui-static.test.mjs`

Expected: FAIL because `handleTranslationKeyDown` and the textarea binding do not exist.

### Task 2: Implement Enter submission and verify the frontend

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/tests/ui-static.test.mjs`

- [x] **Step 1: Add the minimal handler next to `submitTranslation`**

```tsx
function handleTranslationKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  void submitTranslation();
}
```

- [x] **Step 2: Bind the handler to the translation textarea**

```tsx
<textarea
  className="translation-input"
  value={input}
  onChange={(event) => {
    setInput(event.target.value);
    if (event.target.value.length <= translationInputLimit && error === "输入超过 2000 字，已超限，不予翻译。") {
      setError("");
    }
  }}
  onKeyDown={handleTranslationKeyDown}
  placeholder="输入中文、英文单词、短语或句子..."
/>
```

- [x] **Step 3: Run the focused test and verify GREEN**

Run: `node --test --test-name-pattern="translation submits with Enter" tests/ui-static.test.mjs`

Expected: PASS.

- [x] **Step 4: Run complete frontend verification**

Run: `npm test && npm run build`

Expected: All frontend tests pass and Vite production build exits with code 0.

- [x] **Step 5: Review and commit the implementation**

```bash
git diff --check
git add frontend/src/App.tsx frontend/tests/ui-static.test.mjs docs/superpowers/plans/2026-07-24-translation-enter-submit.md
git commit -m "优化翻译回车提交交互"
```
