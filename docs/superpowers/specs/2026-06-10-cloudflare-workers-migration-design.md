# DailyReview Cloudflare Workers 迁移设计

## 背景

DailyReview 当前是 FastAPI + SQLAlchemy + SQLite + 本地文件目录的单机应用，生产环境由 systemd 启动 Uvicorn，并由 FastAPI 托管前端构建产物。用户希望建立一个专门用于 Cloudflare Workers 部署的 Git 分支，从 GitHub 仓库自动部署，目标是至少支持 10 人流畅使用，并完善 README、技术栈说明、稳定性优化和压测。

本设计适用于分支 `cloudflare-workers-deploy`。主分支现有 Python 后端可以继续保留，不作为 Cloudflare 生产运行时依赖。

## 目标

- 将生产运行时迁移到 Cloudflare Workers。
- 使用 TypeScript Worker 重写后端 API，保留前端 API 契约，尽量减少 React 侧改动。
- 使用 D1 替代 SQLite 文件数据库。
- 使用 R2 替代本地上传目录和报告目录。
- 使用 Cron Triggers 替代 APScheduler。
- 支持 GitHub 仓库分支触发 Cloudflare Workers Builds。
- 通过自动化测试和压测验证 10 人并发使用的关键路径。
- README 写清部署、资源、Secrets、迁移、压测、回滚和技术栈。

## 非目标

- 不在本次迁移中继续维护 FastAPI 作为 Cloudflare 生产后端。
- 不把 Cloudflare token 写入仓库、README、脚本或日志。
- 不把测试环境连接到生产 D1/R2。
- 不承诺 Workers 版本与旧 Python 后端内部实现逐行等价，只保证对前端和用户可见行为一致。
- 不在 Workers 内运行系统 Chrome；报告 PDF 生成需要降级为 HTML/Markdown 下载，或后续接入外部 PDF 服务。

## 目标架构

### 运行时

- `frontend/`：继续使用 React + Vite。
- `worker/`：新增 TypeScript Cloudflare Worker，处理所有 `/api/*` 请求和静态资源兜底。
- `D1`：存储结构化数据。
- `R2`：存储上传图片、报告 Markdown、可选报告 HTML/PDF。
- `Cron Triggers`：定时生成报告、清理过期会话与附件、补全翻译词条详情。
- `GitHub + Cloudflare Workers Builds`：从 `cloudflare-workers-deploy` 分支构建并部署。

### 推荐目录结构

```text
worker/
  package.json
  tsconfig.json
  wrangler.toml
  src/
    index.ts
    env.ts
    router.ts
    errors.ts
    auth/
    chat/
    attachments/
    translation/
    reports/
    settings/
    admin/
    storage/
    db/
      schema.sql
      queries.ts
    cron/
  tests/
    unit/
    integration/
    load/
```

前端保留在 `frontend/`。Cloudflare 构建命令负责先构建前端，再构建并部署 Worker。

## 数据设计

### D1 表

D1 保留当前核心表语义：

- `users`
- `invite_codes`
- `chat_sessions`
- `messages`
- `attachments`
- `reports`
- `translation_entries`
- `translation_dictionary_entries`
- `app_settings`

### 必要索引

为 10 人并发和常用列表查询添加索引：

- `users.email`
- `invite_codes.code`
- `chat_sessions.user_id, updated_at`
- `chat_sessions.user_id, is_archived, updated_at`
- `messages.session_id, created_at`
- `attachments.user_id, expires_at`
- `reports.user_id, report_type, period`
- `translation_entries.user_id, created_at`
- `translation_entries.user_id, source_kind, created_at`
- `translation_dictionary_entries.source_text`
- `app_settings.key`

### 数据迁移

提供脚本从现有 SQLite 导出为 SQL/JSON，再导入 D1：

1. 备份 `data/app.db`。
2. 导出结构化数据。
3. 创建 D1 schema。
4. 导入用户、邀请码、会话、消息、翻译、设置、报告索引。
5. 上传 `data/uploads` 和 `data/reports` 到 R2。
6. 将旧文件路径映射为 R2 object key。
7. 迁移后运行只读校验脚本，比对记录数和关键用户数据。

## R2 存储设计

R2 bucket 按环境拆分：

- `dailyreview-prod-assets`
- `dailyreview-preview-assets`

Object key 规范：

```text
uploads/user-{userId}/{yyyy}/{mm}/{uuid}.{ext}
reports/user-{userId}/{reportType}/{period}.md
reports/user-{userId}/{reportType}/{period}.html
reports/user-{userId}/{reportType}/{period}.pdf
```

附件元数据保存在 D1，二进制内容只在 R2。附件下载由 Worker 校验登录态和用户归属后返回对象内容，不公开未授权 object key。

## API 设计

保留当前前端调用路径：

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/invites`
- `GET /api/invites`
- `POST /api/sessions`
- `GET /api/sessions`
- `PATCH /api/sessions/:id/archive`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/messages`
- `POST /api/attachments`
- `GET /api/attachments/:id/content`
- `POST /api/chat/stream`
- `GET /api/reports`
- `GET /api/reports/:id`
- `GET /api/reports/:id/pdf`
- `GET /api/admin/ai-config`
- `PUT /api/admin/ai-config`
- `POST /api/admin/ai-config/test`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/translation/prompt`
- `PUT /api/translation/prompt`
- `GET /api/translation/entries`
- `POST /api/translation/dictionary-entry`
- `POST /api/translation`
- `GET /api/health`

Worker 路由返回与现有 `frontend/src/api.ts` 类型兼容的 JSON。错误响应统一为：

```json
{ "detail": "错误信息" }
```

## 认证与安全

- 登录后写入 `HttpOnly`、`Secure`、`SameSite=Lax` cookie。
- JWT 使用 Cloudflare Secret `SECRET_KEY` 签名。
- 密码哈希使用 Web Crypto 可支持的 PBKDF2 或 scrypt 兼容实现；旧数据库迁移时保留兼容校验路径，用户下一次登录后升级哈希格式。
- 管理员接口必须校验 `role = admin`。
- AI API Key 只存在 Cloudflare Secret 或 D1 加密字段中；README 不写真实值。
- 不记录 Authorization、Cookie、AI key、Cloudflare token。

## AI 流式聊天

`/api/chat/stream` 使用 Worker `ReadableStream` 返回 SSE，行为与前端当前 `streamChat` 兼容。

流程：

1. 校验用户和 session 归属。
2. 写入用户消息和附件关联。
3. 读取近期会话历史，限制上下文长度。
4. 调用配置中的 OpenAI-compatible API。
5. 流式转发 token。
6. 完整回复落 D1。
7. 失败时写入可读错误，不留下半成品助手消息。

性能策略：

- 控制历史消息条数和总字符数。
- 对外部 AI 请求设置超时。
- 对 D1 写入拆为少量事务。
- 对 503/429 给出明确错误，不无限重试。

## 翻译模块

翻译模块保留当前三个能力：

- 翻译 prompt 配置。
- 近期翻译记录。
- 词典词条缓存。

词条详情补全从 Python 后台队列迁到 Cron/Queue 风格任务：

- 用户请求时先返回已有或 queued 状态。
- Cron 扫描 `detail_status = queued` 的少量记录。
- 单次 Cron 处理有限数量，避免超时。

## 报告模块

报告生成迁移到 Cron Triggers：

- 每日按 `daily_report_time` 生成日报。
- 每周按 `weekly_report_day` 和 `weekly_report_time` 生成周报。
- 每月在月末生成月报。

由于 Workers 中不能依赖本机 Chrome，报告 PDF 导出策略：

- 第一阶段：报告 Markdown 和 HTML 存 R2，`/pdf` 返回 HTML 转存或提示 PDF 暂不可用。
- 第二阶段可选：接入外部 PDF 服务或 Cloudflare Browser Rendering。

这点需要在 README 中明确，避免迁移后误以为本地 Chrome PDF 仍可用。

## 清理策略

Cron 定期清理：

- 超过 7 天且未归档、无保留价值的会话和消息。
- 过期附件元数据和 R2 对象。
- 过期邀请码。
- 长期报告不删除。

清理过程分批执行，并记录处理数量，避免单次任务过大。

## 前端改动

前端 API 路径尽量不改。必要改动：

- 适配 Worker 静态资源路径。
- 对 `/api/reports/:id/pdf` 的降级响应做用户可理解提示。
- 如果 Worker 部署域名与 API 同域，继续使用 `credentials: "same-origin"`。

## Cloudflare 配置

`worker/wrangler.toml` 定义：

- `name`
- `main`
- `compatibility_date`
- `assets`
- `d1_databases`
- `r2_buckets`
- `triggers.crons`
- `vars` 中仅放非敏感默认值

Secrets 使用 Cloudflare 或 GitHub 配置：

- `SECRET_KEY`
- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_DEFAULT_MODEL`
- `AI_COMPLEX_MODEL`
- `ADMIN_EMAIL`
- `ADMIN_INITIAL_PASSWORD`

生产和预览环境使用独立 D1/R2 binding，避免测试分支污染生产数据。

## GitHub 部署

Cloudflare Workers Builds 指向分支：

```text
cloudflare-workers-deploy
```

推荐构建命令：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix worker ci
npm --prefix worker run build
```

部署由 Cloudflare Builds 执行。若使用 GitHub Actions，则使用 GitHub Secrets 存放 Cloudflare 凭证，不提交 token。

## 测试设计

### 单元测试

- 路由参数校验。
- 认证 cookie/JWT。
- 密码哈希与旧哈希兼容。
- D1 查询封装。
- R2 object key 生成。
- 错误响应格式。

### 集成测试

使用 Miniflare 或 Wrangler local：

- 注册、登录、获取当前用户。
- 管理员创建邀请码。
- 创建会话、发送消息、读取消息。
- 上传图片、读取附件。
- 翻译缓存与翻译记录。
- 报告列表和报告内容。
- Cron 清理任务。

### 压测

新增脚本覆盖 10 人并发关键路径：

- 10 个用户登录。
- 每个用户创建会话。
- 每个用户连续拉取会话和消息。
- 并发发送短消息到 `/api/chat/stream`，AI 请求可用 mock 模式。
- 并发上传小图到 R2。
- 查询翻译和报告。

验收指标：

- 健康检查 100% 成功。
- 非 AI 核心接口 p95 小于 500ms。
- AI mock 流式首 token p95 小于 1000ms。
- 10 人并发 3 分钟无 5xx。
- D1 查询无明显全表扫描热点。

## 稳定性策略

- 所有外部调用设置超时。
- AI 请求失败返回明确错误。
- D1 写入用事务保护关键一致性。
- 附件先写 R2，再写 D1；失败时清理孤儿对象。
- Cron 分批处理，并在下一次继续。
- API 返回统一错误结构。
- README 包含回滚：切回旧分支或关闭 Cloudflare 生产路由。

## 实施顺序

1. 创建 Worker 工程和 Cloudflare 配置。
2. 建立 D1 schema、查询封装和测试。
3. 实现认证和用户模块。
4. 实现会话、消息、附件模块。
5. 实现 AI 流式聊天。
6. 实现翻译模块。
7. 实现报告和 Cron。
8. 前端适配和构建联调。
9. 增加压测脚本。
10. 完善 README。
11. 本地测试、压测、提交并推送。

## 验收标准

- `frontend` 构建通过。
- `worker` 类型检查和测试通过。
- D1 schema 可初始化。
- Worker 本地预览能完成登录、会话、聊天、上传、翻译、报告主要路径。
- 压测脚本能验证 10 人并发核心路径。
- README 覆盖技术栈、部署、Secrets、D1/R2、数据迁移、压测和回滚。
- 分支 `cloudflare-workers-deploy` 已推送到 GitHub。

## 风险与处理

- **Python 后端逻辑重写风险**：通过 API 契约测试和前端 smoke test 降低风险。
- **D1 与 SQLAlchemy 行为差异**：不用 ORM，显式 SQL 和索引。
- **PDF 导出能力下降**：README 明确第一阶段降级策略，后续独立接入 PDF 服务。
- **Cloudflare token 泄露风险**：不使用已暴露 token，要求用户轮换并配置 Secrets。
- **AI 接口不稳定**：压测使用 mock，真实模式增加超时和错误处理。
- **Cron 执行时间限制**：任务分批、可重入、可重复执行。
