# 对话稳定性加固设计

## 目标

在不自动重复提交非幂等 AI 请求的前提下，使聊天在移动网络、页面后台恢复、客户端中止、上游断流、多标签并发和长会话场景下保持可恢复、可判定和可观测。

## 核心模型

一次用户提问及其 assistant 回复组成一个 turn。前端在发送前生成 UUID `turn_id`，服务端在调用模型前原子创建两条消息：

- user 消息：`turn_id` 相同，状态为 `complete`。
- assistant 占位消息：`turn_id` 相同，初始状态为 `pending`。

`messages(session_id, turn_id, role)` 建立唯一索引。相同 `turn_id` 的重复请求不会重复插入用户消息或再次调用模型；已完成的请求返回已保存回复，仍在生成的请求返回明确冲突状态。

assistant 状态限定为 `pending`、`streaming`、`complete`、`failed`、`cancelled`。重新生成按确切 assistant ID 或 `turn_id` 定位，不再退回到最近一条 assistant，也不再按用户文本猜测目标。

## 流生命周期

- Wrangler 启用 `enable_request_signal`，让浏览器断开能够中止上游模型请求。
- Worker 每 15 秒发送一次 SSE 注释心跳，保持下行连接活跃；前端忽略注释事件。
- 上游 OpenAI 兼容流必须出现 `[DONE]`。EOF 未出现 `[DONE]` 视为中断，assistant 标记为 `failed`。
- 用户主动停止时保存已收到的部分内容并标记 `cancelled`；没有内容时保存“已停止生成。”。
- 无论成功、失败还是中止，前端最终都重新读取当前会话的权威消息页，替换临时 ID 和状态。

## 并发和删除

新增 `chat_generation_locks` 表，以 `session_id` 为主键保存 `turn_id` 和租约过期时间。同一会话同时只允许一个发送或重新生成操作。租约允许 Worker 异常退出后自动恢复；释放时必须同时匹配 session 和 turn，避免旧请求释放新锁。

生成中的会话不能删除。前端锁仍保留用于即时交互反馈，服务端锁负责多标签页和直接 API 请求的一致性。

## 上下文和分页

- 单条用户文本最大 20,000 字符。
- 服务端先取最近候选消息，再按 80,000 字符预算从后向前选择完整上下文，丢弃开头孤立的 assistant，并排除 `pending`、`failed` 状态回复。
- 消息接口使用每页 100 条的向前游标 `before_id`，返回 `{items, next_before_id}`。
- 前端默认加载最新一页，提供“加载更早消息”，加载时保持当前滚动位置。

## 观测

聊天流记录结构化事件：`requestId`、`turnId`、`sessionId`、`userId`、模型、阶段、结果、耗时、输出字符数和安全错误类型。不得记录用户正文、图片内容、API Key 或 Cookie。

## 数据迁移

新增 D1 migration：

- `messages.turn_id TEXT`
- `messages.status TEXT NOT NULL DEFAULT 'complete'`
- turn 唯一索引
- `chat_generation_locks` 表及过期索引

`schema.sql` 同步为新建数据库的完整结构。部署工作流在发布 Worker 前执行 `wrangler d1 migrations apply --remote`，保证代码不会先于数据库结构上线。

## 测试

- 配置测试确认 `enable_request_signal`。
- 流测试覆盖心跳、主动中止、无 `[DONE]`、部分回答断流和状态落库。
- 一致性测试覆盖重复 `turn_id`、停止后重新生成、过期 ID 不覆盖旧回复、同会话并发和生成中删除。
- 上下文测试覆盖字符预算、完整 turn 边界和状态过滤。
- 分页测试覆盖游标、无重复和前端向前合并。
- 负载冒烟增加同会话并发冲突和 SSE 完成标记断言。

