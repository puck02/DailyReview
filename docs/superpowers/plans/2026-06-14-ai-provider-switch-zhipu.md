# AI Provider Switch and ZHIPU Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global AI provider switch with two preserved configurations, so the admin can choose GPT or ZHIPU at runtime and independently set text and vision models for each provider.

**Architecture:** Keep the existing request routes and UI structure, but move model selection behind a provider-aware adapter. Persist both provider configs in `app_settings`, resolve the active provider centrally in the backend, and let chat/translation/reports ask the adapter for either the text model or the vision model. The frontend settings page should edit both provider configs and expose one active-provider selector.

**Tech Stack:** TypeScript, React, Vite, Cloudflare Workers, D1, R2, Wrangler, Vitest, Node test runner.

---

### Task 1: Extend AI config types and storage

**Files:**
- Modify: `worker/src/env.ts`
- Modify: `worker/src/admin/routes.ts`
- Modify: `worker/src/ai/client.ts`
- Modify: `frontend/src/api.ts`
- Modify: `worker/tests/settings-admin.test.ts`
- Modify: `frontend/tests/ui-static.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add backend tests that expect `/api/admin/ai-config` to return `active_provider`, `providers.gpt`, and `providers.zhipu`, and expect saving one provider not to erase the other. Add a frontend static test that expects the settings UI to render a provider switch instead of a single `report_model` select.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm --prefix worker run test -- settings-admin.test.ts
npm --prefix frontend run test -- ui-static.test.mjs
```

Expected: failures complaining that the new provider fields and provider switch are missing.

- [ ] **Step 3: Write the minimal implementation**

Add provider config types, expand the admin config response, and make the save path read/write `ai_active_provider` plus `ai_provider_*` keys. Keep legacy GPT values readable during migration.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm --prefix worker run test -- settings-admin.test.ts
npm --prefix frontend run test -- ui-static.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/env.ts worker/src/admin/routes.ts worker/src/ai/client.ts frontend/src/api.ts worker/tests/settings-admin.test.ts frontend/tests/ui-static.test.mjs
git commit -m "扩展AI提供商配置"
```

### Task 2: Add provider-aware model resolution and ZHIPU adapter

**Files:**
- Create: `worker/src/ai/providers.ts`
- Modify: `worker/src/ai/client.ts`
- Modify: `worker/src/admin/routes.ts`
- Modify: `worker/tests/settings-admin.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests for provider resolution and model selection:

- GPT text calls keep using the GPT text model.
- ZHIPU text calls use `glm-5`.
- ZHIPU vision calls use `glm-4.6v-flash` or `glm-4.6v`.
- `testAiConnection` uses the active provider config.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm --prefix worker run test -- settings-admin.test.ts
```

Expected: failures showing provider/model routing is still hard-coded.

- [ ] **Step 3: Write the minimal implementation**

Introduce a provider adapter that:

- normalizes `gpt` and `zhipu`
- returns the correct base URL, API key, text model, and vision model
- builds OpenAI-compatible `chat/completions` requests for both providers
- keeps the existing fallback behavior when configuration is incomplete

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm --prefix worker run test -- settings-admin.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ai/providers.ts worker/src/ai/client.ts worker/src/admin/routes.ts worker/tests/settings-admin.test.ts
git commit -m "增加AI提供商适配层"
```

### Task 3: Route chat, translation, and reports through the active provider

**Files:**
- Modify: `worker/src/chat/routes.ts`
- Modify: `worker/src/translation/routes.ts`
- Modify: `worker/src/reports/service.ts`
- Modify: `worker/src/cron/jobs.ts`
- Modify: `worker/tests/chat-attachments.test.ts`
- Modify: `worker/tests/reports-cron.test.ts`
- Modify: `worker/tests/translation.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove:

- a normal chat request uses the active provider text model
- a chat request with attachments uses the active provider vision model
- translation uses the active provider text model
- daily report generation uses the active provider text model

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm --prefix worker run test -- chat-attachments.test.ts reports-cron.test.ts translation.test.ts
```

Expected: failures showing the old hard-coded model names are still in use.

- [ ] **Step 3: Write the minimal implementation**

Replace direct model references with provider resolution:

- chat uses text or vision model depending on whether images are attached
- translation uses text model
- reports use text model
- cron paths keep using the same provider-aware helper, not copied logic

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm --prefix worker run test -- chat-attachments.test.ts reports-cron.test.ts translation.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/chat/routes.ts worker/src/translation/routes.ts worker/src/reports/service.ts worker/src/cron/jobs.ts worker/tests/chat-attachments.test.ts worker/tests/reports-cron.test.ts worker/tests/translation.test.ts
git commit -m "改造业务调用为提供商路由"
```

### Task 4: Update the settings UI for provider switching

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/tests/ui-static.test.mjs`
- Modify: `frontend/tests/ui-smoke.mjs`

- [ ] **Step 1: Write the failing tests**

Add static UI tests that expect:

- a provider selector in the admin AI panel
- separate GPT and ZHIPU configuration inputs
- ZHIPU text model limited to `glm-5`
- ZHIPU vision model limited to `glm-4.6v-flash` and `glm-4.6v`

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm --prefix frontend run test -- ui-static.test.mjs
```

Expected: failures about the old single-model selector.

- [ ] **Step 3: Write the minimal implementation**

Refactor the admin AI section so it edits one active provider at a time while preserving both provider configs. Keep the rest of the app unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm --prefix frontend run test -- ui-static.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/api.ts frontend/tests/ui-static.mjs frontend/tests/ui-smoke.mjs
git commit -m "更新AI设置界面"
```

### Task 5: Validate, document, and deploy

**Files:**
- Modify: `README.md`
- Modify: `worker/src/migrations/README.md` if needed
- Possibly modify: `worker/wrangler.toml` only if new vars are needed

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm --prefix worker run test
npm --prefix frontend run test
```

Expected: all tests pass.

- [ ] **Step 2: Run builds**

Run:

```bash
npm --prefix worker run build
npm --prefix frontend run build
```

Expected: both builds pass.

- [ ] **Step 3: Update docs**

Document:

- active provider switch
- GPT and ZHIPU config fields
- text vs vision model selection
- how to fall back from GPT to ZHIPU manually

- [ ] **Step 4: Commit final docs**

```bash
git add README.md worker/src/migrations/README.md worker/wrangler.toml
git commit -m "补充AI提供商文档"
```

- [ ] **Step 5: Deploy**

Run from `worker/`:

```bash
npx wrangler deploy
```

Expected: deployment succeeds and `nektos.cn` keeps serving the new version.
