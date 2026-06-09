# DailyReview

轻量 AI 辅助学习 Web 应用，面向 1-5 人使用。后端使用 FastAPI + SQLite，前端使用 Vite + React，生产环境由 FastAPI 托管构建后的静态文件。

## 功能

- 邀请码注册与登录。
- 管理员只管理邀请码。
- 最近 7 天聊天会话。
- 文字问答、图片上传、剪贴板图片粘贴。
- 流式 AI 回复。
- 每天 23:00 生成个人学习日报。
- 周日生成周报，月底生成月报。
- 聊天和上传图片保留 7 天，报告长期保留。

## 环境变量

复制 `.env.example` 为 `.env`，并设置真实值：

```bash
APP_HOST=0.0.0.0
APP_PORT=8082
APP_TIMEZONE=Asia/Shanghai
DATABASE_URL=sqlite:///../data/app.db
UPLOAD_DIR=../data/uploads
REPORT_DIR=../data/reports
SECRET_KEY=change-me
ADMIN_EMAIL=admin@example.com
ADMIN_INITIAL_PASSWORD=change-me
AI_BASE_URL=https://example.com/v1
AI_API_KEY=change-me
AI_DEFAULT_MODEL=gpt-5.4-mini
AI_COMPLEX_MODEL=5.5
```

`.env` 不应提交到 Git。

## 开发

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

```bash
cd frontend
npm install
npm run build
```

## 运行

PDF 导出依赖系统可执行的 `google-chrome`/`chromium`；如不在 `PATH` 中，可通过 `CHROME_BIN` 指定。

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8082
```

访问：

```text
http://<server-ip>:8082
```

## systemd 用户服务

```bash
mkdir -p ~/.config/systemd/user
cp deploy/dailyreview.service ~/.config/systemd/user/dailyreview.service
systemctl --user daemon-reload
systemctl --user enable --now dailyreview.service
systemctl --user status --no-pager dailyreview.service
```

健康检查：

```bash
curl -sSf http://127.0.0.1:8082/api/health
```

## 数据

- SQLite：`data/app.db`
- 上传图片：`data/uploads`
- 报告 Markdown：`data/reports`

建议定期备份 `data/` 目录。
