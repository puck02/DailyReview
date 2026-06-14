# AI Provider Switch and ZHIPU Adapter Design

## 目标

把 DailyReview 的 AI 调用改成可全局切换的提供商模式，默认保留当前 GPT 行为，同时新增 ZHIPU 作为可选提供商。设置页需要保留两套配置，管理员可以随时切换当前生效的 provider，并分别配置文本模型和视觉模型。

## 已确认范围

- 当前生效 provider 只有一个，切换是全局级别，不做按用户或按会话的 provider 分流。
- 两套配置都要保留：GPT 配置和 ZHIPU 配置并存，切换 provider 时不覆盖另一套。
- ZHIPU 的文本模型只提供 `glm-5`。
- ZHIPU 的视觉模型提供 `glm-4.6v-flash` 和 `glm-4.6v`。
- 当前系统里所有文本类 AI 调用都要走当前 provider 的文本模型。
- 带图片的聊天请求要走当前 provider 的视觉模型。
- 报告、翻译和其它纯文本任务不需要单独的 provider 配置，它们复用当前 provider 的文本模型。
- 不引入自动故障切换；provider 切换由管理员手动完成，避免把不同供应商的计费、速率限制和错误语义混在一起。

## 技术方案

推荐采用一个轻量 provider 适配层，而不是把 ZHIPU 逻辑散落到各个路由里。

- `worker/src/ai/` 负责提供商能力描述、模型解析、请求体构造和调用封装。
- `worker/src/admin/routes.ts` 负责读取和保存 provider 配置。
- `worker/src/chat/routes.ts`、`worker/src/translation/routes.ts`、`worker/src/reports/service.ts` 通过统一的 provider 解析函数获取当前文本模型或视觉模型。
- `frontend/src/App.tsx` 的 AI 配置区域改成 provider 切换 + provider 专属模型选择。

ZHIPU 和当前 GPT 路径都使用 OpenAI-compatible 的 `chat/completions` 形式，因此适配层主要处理：

- base URL
- API key
- provider 当前值
- capability 到模型名的映射
- 带图消息体和纯文本消息体的统一构造

## 配置模型

不新增数据库表，继续使用 `app_settings` 存储配置。

建议使用以下配置键：

- `ai_active_provider`
- `ai_provider_gpt_base_url`
- `ai_provider_gpt_api_key`
- `ai_provider_gpt_text_model`
- `ai_provider_gpt_vision_model`
- `ai_provider_zhipu_base_url`
- `ai_provider_zhipu_api_key`
- `ai_provider_zhipu_text_model`
- `ai_provider_zhipu_vision_model`

兼容策略：

- 现有 GPT 配置迁移到 `ai_provider_gpt_*`。
- 旧的单一 AI 配置字段保留为兼容读取路径，直到前端和后端都切到新结构。
- 默认 `ai_active_provider = gpt`，保证升级后不改现有行为。

每个 provider 配置至少包含：

- `base_url`
- `api_key`
- `text_model`
- `vision_model`

对于 GPT provider，视觉模型可以先沿用当前文本模型，保持现有图片聊天行为不变。ZHIPU provider 使用独立的视觉模型选择。

## 运行时路由

### 文本请求

以下路径都应使用当前 provider 的 `text_model`：

- 普通聊天
- 翻译
- 日报生成
- 周报、月报生成
- AI 配置连接测试

### 视觉请求

以下路径在请求体包含图片时使用当前 provider 的 `vision_model`：

- 聊天消息带图片附件
- 未来需要图像理解的其它请求

### 模型选择规则

- 如果当前 provider 是 GPT，沿用现有可用的文本模型选择。
- 如果当前 provider 是 ZHIPU，文本模型只允许 `glm-5`。
- 视觉模型只在支持图像输入的请求里生效，不在普通文本请求里暴露给用户。
- 当 provider 切换时，前端把当前会话的可选文本模型重置为该 provider 的默认文本模型，避免保留不兼容的旧模型名。

## 设置页

管理员 AI 配置区改成 provider 视图。

建议布局：

- 顶部提供一个 provider 切换控件，选项为 `GPT` 和 `ZHIPU`。
- 下面显示当前 provider 的配置卡片。
- 每个 provider 卡片都能保存自己的 base URL、API key、文本模型、视觉模型。
- `测试连接` 按钮只测试当前 provider 当前选中的文本模型。
- 页面继续隐藏 API key 明文，只显示掩码预览。

模型选项：

- GPT provider：保留当前可用模型作为文本模型选项。
- ZHIPU provider：文本模型只显示 `glm-5`，视觉模型只显示 `glm-4.6v-flash` 和 `glm-4.6v`。

## API 变化

`GET /api/admin/ai-config` 需要返回：

- `active_provider`
- 当前 provider 的配置
- 两个 provider 的可用模型信息

`PUT /api/admin/ai-config` 需要支持：

- 切换 active provider
- 保存 GPT 配置
- 保存 ZHIPU 配置

`POST /api/admin/ai-config/test` 需要测试当前 provider 的文本模型连接。

前端 `frontend/src/api.ts` 的 AI 配置类型需要扩展，不能再只假定单一 `report_model`。

## 数据流

1. 管理员在设置页选择当前 provider。
2. 前端保存当前 provider 及对应 provider 配置。
3. 后端在每次 AI 调用前解析当前 provider。
4. 文本类请求取当前 provider 的 `text_model`。
5. 图像类请求取当前 provider 的 `vision_model`。
6. 请求通过统一的 OpenAI-compatible 调用层发送到对应 base URL。
7. 出错时沿用现有错误返回格式，不泄露 API key。

## 兼容与迁移

- 默认保留 GPT 为当前生效 provider，避免升级后立即影响线上。
- 老配置仍可读，第一次保存新设置时再写入新的 provider 键。
- 已存在的聊天、报告、翻译记录不需要迁移数据结构。
- 旧会话里的历史消息不回写模型名；只影响未来 AI 调用。

## 测试

必须补充以下测试：

- provider 配置读写测试：保存 GPT 和 ZHIPU 两套配置后，读取结果不串台。
- provider 切换测试：切换 active provider 后，文本调用和视觉调用分别命中正确模型。
- chat 视觉请求测试：带图片消息时使用 provider 的视觉模型。
- 翻译和日报测试：纯文本任务使用 provider 的文本模型。
- AI 连接测试：测试当前 provider 的文本模型时返回正确成功/失败信息。
- 前端设置页测试：provider 切换后，模型下拉与当前 provider 一致。

## 验收标准

- 管理员可以在设置页保留并编辑 GPT 和 ZHIPU 两套配置。
- 管理员可以随时切换当前生效 provider。
- ZHIPU 文本请求默认只用 `glm-5`。
- ZHIPU 视觉请求可在 `glm-4.6v-flash` 和 `glm-4.6v` 之间选择。
- 当前 GPT 行为在切换前保持不变。
- 所有现有测试和新增 provider 测试都通过。
