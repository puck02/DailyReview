# DailyReview

DailyReview 是一个 AI 辅助学习 Web 应用。当前 `cloudflare-workers-deploy` 分支用于整体迁移到 Cloudflare Workers，目标是支持至少 10 人并发流畅使用。

`main` 分支仍保留原 FastAPI + SQLite 部署方式；本分支的生产后端改为 Cloudflare Worker。

## 功能

- 邀请码注册、登录、管理员邀请管理。
- 最近 7 天聊天会话，归档会话长期可见。
- 流式 AI 问答、图片上传、剪贴板图片粘贴。
- 中英翻译、词汇讲解、个人提示词。
- 日报、周报、月报 Markdown 报告。
- Cron 定时生成报告、清理过期会话和附件。
- PDF 导出在 Workers 首版中稳定降级为 501 JSON。

## 技术栈

前端：

- React
- TypeScript
- Vite
- react-markdown、remark-gfm、remark-math、rehype-katex、rehype-highlight
- lucide-react

Cloudflare 后端：

- TypeScript Cloudflare Worker
- Cloudflare D1：用户、会话、消息、翻译、报告索引
- Cloudflare R2：上传图片和 Markdown 报告
- Cloudflare Cron Triggers：报告生成、清理、队列处理
- Wrangler：本地开发、资源管理、部署
- Vitest：Worker 单元和集成测试
- Node.js load script：10 人并发压测

旧本地后端：

- FastAPI
- SQLite
- APScheduler
- 本地文件存储

## 分支用途

Cloudflare Workers Builds 应绑定：

- GitHub repo：`puck02/DailyReview`
- 分支：`cloudflare-workers-deploy`
- Worker 配置：`worker/wrangler.toml`

不要把 Cloudflare API Token、AI Key、`.dev.vars`、D1 导出数据或 R2 文件提交到仓库。

## Cloudflare 资源

创建 D1：

```bash
npx wrangler d1 create dailyreview-prod
```

把返回的 `database_id` 填入 `worker/wrangler.toml`。

创建 R2：

```bash
npx wrangler r2 bucket create dailyreview-prod-assets
```

初始化 D1 schema：

```bash
npx wrangler d1 execute dailyreview-prod --file worker/src/db/schema.sql
```

设置 secrets：

```bash
npx wrangler secret put SECRET_KEY
npx wrangler secret put AI_BASE_URL
npx wrangler secret put AI_API_KEY
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_INITIAL_PASSWORD
```

`.env.example.cloudflare` 只提供占位示例。真实值用 Wrangler secrets 或 Cloudflare 控制台配置。

## GitHub 部署

Cloudflare Workers Builds 可使用：

```bash
npm --prefix frontend ci && npm --prefix frontend run build && npm --prefix worker ci && npm --prefix worker run build
```

部署命令使用 Cloudflare 默认 Worker deploy，或手动：

```bash
npm --prefix worker run deploy
```

Worker 会通过 `[assets]` 绑定托管 `frontend/dist`。

## 本地开发

安装依赖：

```bash
npm --prefix frontend install
npm --prefix worker install
```

构建前端：

```bash
npm --prefix frontend run build
```

启动 Worker：

```bash
npm --prefix worker run dev
```

如果当前 Linux 系统无法运行 Cloudflare `workerd`，可用内存测试服务器做本地稳定性验证：

```bash
npm --prefix worker run load:local-server
```

再访问或压测 `http://127.0.0.1:8787`。如果端口被占用：

```bash
PORT=8790 npm --prefix worker run load:local-server
```

## 数据迁移

先备份：

- `data/app.db`
- `data/uploads/`
- `data/reports/`

导出 SQLite：

```bash
node worker/src/migrations/sqlite-export.mjs ./data/app.db ./tmp/dailyreview-export
```

导入 D1：

```bash
npx wrangler d1 execute dailyreview-prod --file worker/src/db/schema.sql
npx wrangler d1 execute dailyreview-prod --file ./tmp/dailyreview-export/d1-import.sql
```

上传 R2：

```bash
node worker/src/migrations/r2-upload.mjs ./data/uploads uploads
node worker/src/migrations/r2-upload.mjs ./data/reports reports
```

更详细流程见 `worker/src/migrations/README.md`。

## PDF 降级

Workers 首版不在边缘环境内生成 PDF。接口固定返回：

```json
{
  "detail": "Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。"
}
```

状态码为 `501`。前端会显示这条错误，不会下载损坏 PDF。用户仍可查看 Markdown 报告。后续可升级为 Cloudflare Browser Rendering 或外部 PDF 服务。

## 测试

前端：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
```

Worker：

```bash
npm --prefix worker run test
npm --prefix worker run build
```

压测：

```bash
DAILYREVIEW_BASE_URL=http://127.0.0.1:8787 npm --prefix worker run load
```

压测默认 10 用户、3 分钟。通过阈值：

- 无 5xx。
- 非 AI 接口 p95 小于 500ms。
- SSE 首 token p95 小于 1000ms。

快速 smoke：

```bash
DAILYREVIEW_LOAD_DURATION_MS=15000 npm --prefix worker run load
```

## 回滚

如果 Cloudflare 部署异常：

1. 将 Cloudflare Builds 或路由切回旧分支/旧服务。
2. 保留 D1/R2 数据用于比对。
3. 使用 `main` 分支的 FastAPI + SQLite 部署继续服务。
4. 修复后重新从 `cloudflare-workers-deploy` 部署。

## 旧 FastAPI 运行

旧方式只适用于 `main` 分支或回滚场景：

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8082
```

旧数据位置：

- SQLite：`data/app.db`
- 上传图片：`data/uploads`
- 报告 Markdown：`data/reports`
