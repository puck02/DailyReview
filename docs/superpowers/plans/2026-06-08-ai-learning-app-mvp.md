# AI Learning App MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the private AI-assisted learning web app on port 8082.

**Architecture:** A single FastAPI service owns API routes, SQLite persistence, scheduled report jobs, file storage, and static frontend hosting. The React frontend is built once and served by FastAPI in production so the VPS only runs one application process.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy, SQLite, APScheduler, PyJWT, httpx, Vite, React, TypeScript, systemd user service.

---

## File Structure

- Create `backend/requirements.txt`: Python dependencies.
- Create `backend/app/config.py`: environment-driven settings.
- Create `backend/app/db.py`: SQLAlchemy engine, sessions, model imports, initialization.
- Create `backend/app/models.py`: SQLite ORM models.
- Create `backend/app/security.py`: password hashing, JWT cookie helpers, auth dependencies.
- Create `backend/app/ai_client.py`: OpenAI-compatible streaming and JSON helpers.
- Create `backend/app/auth/routes.py`: login, register, logout, current user.
- Create `backend/app/invites/routes.py`: admin-only invite code generation and listing.
- Create `backend/app/chat/routes.py`: sessions, uploads, streaming chat.
- Create `backend/app/reports/service.py`: daily, weekly, monthly report generation and grep-style historical retrieval.
- Create `backend/app/reports/routes.py`: report listing and content APIs.
- Create `backend/app/scheduler/jobs.py`: scheduled report and cleanup jobs.
- Create `backend/app/storage/files.py`: upload and report path handling.
- Create `backend/app/main.py`: FastAPI app, route registration, static frontend hosting.
- Create `backend/tests/`: backend tests for auth, invites, chat retention, and report generation helpers.
- Create `frontend/`: Vite React app with login/register, chat, reports, and admin views.
- Create `deploy/dailyreview.service`: systemd user service template for port 8082.
- Create `.env.example`: documented environment variables without secrets.
- Create `.gitignore`: exclude `.env`, virtualenvs, node_modules, build output, and runtime `data/`.

## Execution Rules

- Use Python 3.11 explicitly because system `python3` is 3.6.
- Never write real API keys or passwords into committed files.
- Keep `.env` untracked and local-only.
- Commit after each verified milestone.
- Run backend tests before backend commits and frontend build before frontend commits.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `backend/requirements.txt`
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/test_health.py`

- [ ] **Step 1: Add backend dependency manifest**

Create `backend/requirements.txt` with FastAPI, SQLAlchemy, APScheduler, httpx, PyJWT, pytest, and supporting packages.

- [ ] **Step 2: Add environment template**

Create `.env.example` with only variable names and safe sample values. Include `APP_PORT=8082`.

- [ ] **Step 3: Add gitignore**

Ignore `.env`, `.venv`, `node_modules`, frontend build output, Python caches, pytest caches, and runtime `data/`.

- [ ] **Step 4: Add minimal FastAPI health app**

Create `backend/app/main.py` exposing `GET /api/health` returning `{"status":"ok"}`.

- [ ] **Step 5: Add failing health test, then implementation verification**

Run:

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/test_health.py -q
```

Expected final output: one passing test.

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example backend
git commit -m "初始化应用骨架"
```

---

### Task 2: Database, Settings, and Security

**Files:**
- Create: `backend/app/config.py`
- Create: `backend/app/models.py`
- Create: `backend/app/db.py`
- Create: `backend/app/security.py`
- Create: `backend/tests/test_security.py`
- Create: `backend/tests/test_db.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Write tests for password hashing, token roundtrip, and admin bootstrap**

Tests must prove passwords are not stored in plaintext, JWT subject can be decoded, and the first startup creates one admin from environment values.

- [ ] **Step 2: Run tests and verify they fail before implementation**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_security.py tests/test_db.py -q
```

Expected initial output: failures due missing modules/functions.

- [ ] **Step 3: Implement settings, ORM models, database initialization, and security helpers**

Use PBKDF2-HMAC-SHA256 from the Python standard library for password hashing. Use PyJWT for signed tokens. Use SQLAlchemy declarative models for `users`, `invite_codes`, `chat_sessions`, `messages`, `attachments`, and `reports`.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_security.py tests/test_db.py tests/test_health.py -q
```

Expected final output: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "添加数据库和认证基础"
```

---

### Task 3: Auth and Invite APIs

**Files:**
- Create: `backend/app/auth/__init__.py`
- Create: `backend/app/auth/routes.py`
- Create: `backend/app/invites/__init__.py`
- Create: `backend/app/invites/routes.py`
- Create: `backend/tests/test_auth_invites.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Write API tests**

Cover login success, login failure, invite generation blocked for non-admin, invite generation allowed for admin, registration requiring an unused invite, invite single-use behavior, and `/api/auth/me`.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_auth_invites.py -q
```

Expected initial output: failures due missing routes.

- [ ] **Step 3: Implement auth and invite routes**

Use HttpOnly `session` cookie for login. Admin-only routes must check `user.role == "admin"`. Registration consumes exactly one valid invite code.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_auth_invites.py tests/test_security.py tests/test_db.py tests/test_health.py -q
```

Expected final output: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "实现登录注册和邀请码"
```

---

### Task 4: Chat, Uploads, and AI Streaming

**Files:**
- Create: `backend/app/chat/__init__.py`
- Create: `backend/app/chat/routes.py`
- Create: `backend/app/storage/__init__.py`
- Create: `backend/app/storage/files.py`
- Create: `backend/app/ai_client.py`
- Create: `backend/tests/test_chat.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Write chat tests**

Cover creating sessions, listing only the current user's sessions from the last 7 days, storing user messages, creating assistant messages, and saving uploaded image metadata with a 7-day expiry.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_chat.py -q
```

Expected initial output: failures due missing chat routes.

- [ ] **Step 3: Implement chat routes**

Implement session CRUD, image upload validation, and a streaming endpoint that forwards OpenAI-compatible chat completion chunks. Persist assistant output after the stream completes.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_chat.py tests/test_auth_invites.py tests/test_security.py tests/test_db.py tests/test_health.py -q
```

Expected final output: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "实现会话聊天和图片上传"
```

---

### Task 5: Reports and Cleanup Jobs

**Files:**
- Create: `backend/app/reports/__init__.py`
- Create: `backend/app/reports/service.py`
- Create: `backend/app/reports/routes.py`
- Create: `backend/app/scheduler/__init__.py`
- Create: `backend/app/scheduler/jobs.py`
- Create: `backend/tests/test_reports.py`
- Create: `backend/tests/test_cleanup.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Write report and cleanup tests**

Cover daily report skipping empty days, report Markdown path creation, historical text search from prior reports, monthly report listing scoped to current user, and deleting 7-day-old chat/upload data without deleting reports.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd backend
.venv/bin/python -m pytest tests/test_reports.py tests/test_cleanup.py -q
```

Expected initial output: failures due missing report service/routes/jobs.

- [ ] **Step 3: Implement report service and routes**

Generate NovaForge-style Markdown reports with seven sections. Use model output when API configuration is present; otherwise keep tests deterministic by allowing injected content generation.

- [ ] **Step 4: Implement scheduler jobs**

Schedule daily user report generation at 23:00, weekly summaries on Sunday after daily reports, monthly summaries on the last day of month, and cleanup after reporting.

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
cd backend
.venv/bin/python -m pytest -q
```

Expected final output: all backend tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app backend/tests
git commit -m "实现学习报告和清理任务"
```

---

### Task 6: React Frontend

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/api.ts`
- Create: `frontend/src/styles.css`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Create Vite React app files**

Build a compact app with login/register, chat, reports, and admin invite views. Use a utilitarian study workspace style with dense but readable layout.

- [ ] **Step 2: Install frontend dependencies**

Run:

```bash
cd frontend
npm install
```

Expected output: dependencies installed and `package-lock.json` created.

- [ ] **Step 3: Build frontend**

Run:

```bash
cd frontend
npm run build
```

Expected output: Vite build succeeds and creates `frontend/dist`.

- [ ] **Step 4: Verify backend serves SPA fallback**

Run backend tests:

```bash
cd backend
.venv/bin/python -m pytest -q
```

Expected output: all backend tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app frontend package-lock.json
git commit -m "添加前端界面"
```

If `package-lock.json` is under `frontend/`, add `frontend/package-lock.json` instead.

---

### Task 7: Runtime Configuration and Deployment

**Files:**
- Create: `deploy/dailyreview.service`
- Create: `README.md`
- Create local-only: `.env`

- [ ] **Step 1: Add systemd service template**

Service runs:

```bash
/home/admin/workspace/DailyReview/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8082
```

with working directory:

```bash
/home/admin/workspace/DailyReview/backend
```

- [ ] **Step 2: Add README deployment notes**

Document setup, `.env` variables, tests, build, and systemd commands. Do not include secrets.

- [ ] **Step 3: Create local `.env`**

Create `.env` from the user's provided deployment values. Do not commit it.

- [ ] **Step 4: Run full verification**

Run:

```bash
cd backend
.venv/bin/python -m pytest -q
cd ../frontend
npm run build
```

Expected output: backend tests pass and frontend build succeeds.

- [ ] **Step 5: Commit deploy docs**

```bash
git add deploy README.md
git commit -m "添加部署配置说明"
```

- [ ] **Step 6: Install and start service**

Run:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/dailyreview.service ~/.config/systemd/user/dailyreview.service
systemctl --user daemon-reload
systemctl --user enable --now dailyreview.service
systemctl --user status --no-pager dailyreview.service
curl -sSf http://127.0.0.1:8082/api/health
```

Expected output: service active and health endpoint returns `{"status":"ok"}`.

---

## Self-Review

- Spec coverage: this plan covers authentication, invite-only registration, SQLite data model, chat sessions, image upload metadata, 7-day retention, reports, frontend pages, and systemd deployment on port 8082.
- Scope split: all MVP subsystems are included because the user explicitly requested continuing until deployment.
- Placeholder scan: the plan contains no unfinished placeholder markers.
- Type consistency: backend module names and route groups match the design spec.
