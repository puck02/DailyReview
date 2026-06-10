# 10 人并发压测

本脚本用于验证 DailyReview Worker 在本地或 Cloudflare 预览环境下至少支撑 10 人流畅使用。

## 本地运行

优先使用 Cloudflare `wrangler dev` 启动真实本地 Worker：

```bash
npm --prefix worker run dev
```

如果当前 Linux 发行版无法运行 `workerd`，可使用 Node 内存测试服务器做本机稳定性验证：

```bash
npm --prefix worker run load:local-server
```

再运行压测：

```bash
DAILYREVIEW_BASE_URL=http://127.0.0.1:8787 \
ADMIN_EMAIL=admin@example.com \
ADMIN_INITIAL_PASSWORD=admin-password \
npm --prefix worker run load
```

默认持续 3 分钟，创建或复用 10 个测试用户。快速 smoke 可缩短时长：

```bash
DAILYREVIEW_LOAD_DURATION_MS=15000 npm --prefix worker run load
```

## 预览部署运行

```bash
DAILYREVIEW_BASE_URL=https://your-preview.example.workers.dev \
ADMIN_EMAIL=admin@example.com \
ADMIN_INITIAL_PASSWORD='...' \
npm --prefix worker run load
```

不要把管理员密码或 Cloudflare Token 写进命令历史、README 或仓库文件。生产预览建议使用一次性测试管理员或测试空间。

## 覆盖接口

每个用户会执行：

- 登录或注册测试账号
- 创建会话
- 上传 1x1 PNG 附件
- 调用 `/api/chat/stream`
- 循环读取会话、消息和报告列表

脚本输出每类接口的 `count`、`p50`、`p95`、`max`。

## 通过阈值

- 任意 5xx 直接失败
- 非 AI 接口本地/mock p95 必须小于 500ms
- SSE 首 token p95 必须小于 1000ms

如果失败，先看输出里的 `errors` 和单项接口 p95。通常优先检查 D1 慢查询、R2 上传、SSE 首包和 Worker 冷启动。
