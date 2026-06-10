# Cloudflare 数据迁移

这些脚本用于把当前 SQLite + 本地文件迁移到 Cloudflare D1 + R2。先在服务器上完整备份 `data/app.db`、`data/uploads/` 和 `data/reports/`，再执行迁移。

## 1. 导出 SQLite

```bash
node worker/src/migrations/sqlite-export.mjs ./data/app.db ./tmp/dailyreview-export
```

输出目录包含：

- `users.json`、`invite_codes.json`、`chat_sessions.json`、`messages.json`
- `attachments.json`、`reports.json`
- `translation_entries.json`、`translation_dictionary_entries.json`
- `app_settings.json`
- `manifest.json`
- `d1-import.sql`

脚本会把旧字段映射成 Worker D1 字段：

- `attachments.file_path` -> `attachments.object_key`
- `reports.markdown_path` -> `reports.markdown_key`

## 2. 初始化 D1

```bash
npx wrangler d1 execute dailyreview-prod --file worker/src/db/schema.sql
npx wrangler d1 execute dailyreview-prod --file ./tmp/dailyreview-export/d1-import.sql
```

导入后用 `manifest.json` 和 D1 查询结果对比行数。

## 3. 上传 R2 文件

```bash
node worker/src/migrations/r2-upload.mjs ./data/uploads uploads
node worker/src/migrations/r2-upload.mjs ./data/reports reports
```

脚本会打印每条 `wrangler r2 object put` 命令并执行。命令不会打印任何密钥；Cloudflare 认证由本机 `wrangler login` 或环境变量提供。

## 4. 验证

迁移完成后至少验证：

```bash
npx wrangler d1 execute dailyreview-prod --command "SELECT COUNT(*) FROM users"
npx wrangler d1 execute dailyreview-prod --command "SELECT COUNT(*) FROM messages"
npx wrangler d1 execute dailyreview-prod --command "SELECT COUNT(*) FROM reports"
```

然后访问预览部署，检查登录、历史会话、附件预览、Markdown 报告和翻译历史。

## 5. 回滚

如果迁移后发现问题，先把 Cloudflare 路由切回旧服务或旧分支部署。D1/R2 中的迁移数据不要立即删除，保留用于比对和补迁。
