import { z } from "zod";

import { attachmentResponse, getAttachment, type AttachmentRow } from "../attachments/routes";
import { getAiConfig } from "../admin/routes";
import { requireUser } from "../auth/routes";
import { all, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { aiTextModel, aiVisionModel, completeChatWithUsage, type ChatMessage } from "../ai/client";
import { recordTokenUsage } from "../ai/usage";
import { resolveChatModel } from "../ai/providers";

type EssaySessionRow = Row & {
  id: number;
  user_id: number;
  title: string;
  default_model: string;
  draft_text: string;
  topic_attachment_id: number | null;
  ocr_text: string;
  objective_description: string;
  created_at: string;
  updated_at: string;
};

const DEFAULT_ESSAY_TITLE = "考研英语作文";
const MAX_TITLE_LENGTH = 255;
const MAX_DRAFT_LENGTH = 30000;
const ESSAY_IMAGE_CONTEXT_SYSTEM_PROMPT = `你是一名考研英语一作文题目图片解析器。
请只输出 JSON，不要输出 Markdown、代码块、解释或额外文本。
JSON 结构：
{
  "ocr_text": "图片中能看清的全部题干文字，逐行保留原始顺序",
  "objective_description": "纯客观描述图片内容，只写能直接看见的元素、关系、动作和场景，不推断立意，不评价，不延伸"
}
要求：
- ocr_text 只保留能辨认的文字，无法确认的内容可省略。
- objective_description 只做客观描述，不要使用“主题是”“说明了”等推断性表述。
- 语言尽量简洁。`;
const ESSAY_SUGGESTION_SYSTEM_PROMPT = `你是一名考研英语一作文停顿补全助手。
请严格基于题目 OCR、图像客观描述和当前草稿生成 3 条可直接插入的补全候选。
只输出 JSON 数组，不要输出 Markdown、代码块、解释或额外文本。
每个数组项都必须包含：
{
  "kind": "word" | "sentence",
  "text": "英文补全内容",
  "reason": "简短理由",
  "confidence": 0.0
}
要求：
- text 必须是英文。
- kind 为 word 时，优先给短语、连接词或句首表达。
- kind 为 sentence 时，优先给 1 句或 2 句可直接接在当前草稿后的内容。
- 不要编造题图里不存在的具体事实。
- 不要写成讲解文案，只给可用补全。`;

const essaySessionCreateSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LENGTH).optional(),
  model: z.string().trim().max(128).optional()
});

const essaySessionPatchSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LENGTH).optional(),
  draft_text: z.string().max(MAX_DRAFT_LENGTH).optional(),
  model: z.string().trim().max(128).optional(),
  clear_topic_image: z.boolean().optional()
});

const essayImageContextSchema = z.object({
  attachment_id: z.number().int()
});

const essaySuggestionSchema = z.object({
  session_id: z.number().int(),
  content: z.string().max(MAX_DRAFT_LENGTH).default(""),
  model: z.string().trim().max(128).optional()
});

const essayTablesReady = new WeakSet<D1Database>();

async function ensureEssayTables(env: Env): Promise<void> {
  if (essayTablesReady.has(env.DB)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS essay_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '${DEFAULT_ESSAY_TITLE}',
      default_model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
      draft_text TEXT NOT NULL DEFAULT '',
      topic_attachment_id INTEGER,
      ocr_text TEXT NOT NULL DEFAULT '',
      objective_description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_essay_sessions_user_updated ON essay_sessions(user_id, updated_at DESC)").run();
  essayTablesReady.add(env.DB);
}

function safeJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function safeJsonArray(text: string): unknown[] {
  const object = safeJsonObject(text);
  if (object && Array.isArray(object.suggestions)) {
    return object.suggestions;
  }
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end <= start) {
      return [];
    }
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function essayTitleFromDraft(draft: string): string {
  const firstLine = draft
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return DEFAULT_ESSAY_TITLE;
  return firstLine.length > 32 ? `${firstLine.slice(0, 32)}...` : firstLine;
}

function emptyEssaySuggestion(kind: "word" | "sentence", text: string, reason: string, confidence: number) {
  return { kind, text, reason, confidence };
}

function fallbackEssaySuggestions(content: string, context: string): Array<{ kind: "word" | "sentence"; text: string; reason: string; confidence: number }> {
  const draft = content.trim();
  const hasContext = Boolean(context.trim());
  if (!draft) {
    return [
      emptyEssaySuggestion("sentence", "As is vividly shown in the picture, ", hasContext ? "适合作为图画作文开头" : "适合作为开头模板", 0.64),
      emptyEssaySuggestion("sentence", "The picture reveals a common phenomenon that deserves our attention. ", "适合引出话题", 0.58),
      emptyEssaySuggestion("word", "However, ", "可用于自然转折", 0.54)
    ];
  }
  return [
    emptyEssaySuggestion("sentence", "This simple picture reminds us that small actions can lead to meaningful change. ", "承接当前草稿并推进论证", 0.63),
    emptyEssaySuggestion("word", "Moreover, ", "适合继续展开第二层论证", 0.57),
    emptyEssaySuggestion("sentence", "Only by taking practical steps can we turn this message into reality. ", "适合收束段落", 0.55)
  ];
}

function normalizeSuggestion(value: unknown): { kind: "word" | "sentence"; text: string; reason: string; confidence: number } | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const kind = source.kind === "word" ? "word" : source.kind === "sentence" ? "sentence" : null;
  const text = String(source.text || "").trim();
  const reason = String(source.reason || "").trim();
  const confidence = Number(source.confidence);
  if (!kind || !text || !reason) return null;
  return {
    kind,
    text,
    reason,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

function attachmentDataUrl(attachment: AttachmentRow, bytes: Uint8Array): string {
  return `data:${attachment.mime_type};base64,${bytesToBase64(bytes)}`;
}

async function getEssaySession(env: Env, id: number): Promise<EssaySessionRow | null> {
  await ensureEssayTables(env);
  return await first<EssaySessionRow>(env.DB.prepare("SELECT * FROM essay_sessions WHERE id = ?").bind(id));
}

async function getEssayAttachment(env: Env, attachmentId: number, userId: number): Promise<AttachmentRow | null> {
  const attachment = Number.isFinite(attachmentId) ? await getAttachment(env, attachmentId) : null;
  if (!attachment || attachment.user_id !== userId) return null;
  return attachment;
}

async function essaySessionResponse(env: Env, session: EssaySessionRow): Promise<Record<string, unknown>> {
  const attachment = session.topic_attachment_id ? await getAttachment(env, session.topic_attachment_id) : null;
  return {
    id: session.id,
    title: session.title,
    default_model: session.default_model,
    draft_text: session.draft_text,
    has_topic_image: Boolean(session.topic_attachment_id),
    topic_attachment: attachment && attachment.user_id === session.user_id ? attachmentResponse(attachment) : null,
    ocr_text: session.ocr_text,
    objective_description: session.objective_description,
    created_at: session.created_at,
    updated_at: session.updated_at
  };
}

async function listEssaySessions(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  await ensureEssayTables(env);
  const sessions = await all<EssaySessionRow>(
    env.DB.prepare("SELECT * FROM essay_sessions WHERE user_id = ? ORDER BY updated_at DESC, id DESC").bind(user.id)
  );
  const items = [];
  for (const session of sessions) {
    items.push(await essaySessionResponse(env, session));
  }
  return json(items);
}

async function createEssaySession(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = essaySessionCreateSchema.parse(await parseJson<unknown>(request));
  await ensureEssayTables(env);
  const aiConfig = await getAiConfig(env);
  const now = nowIso();
  const result = await env.DB.prepare(
    "INSERT INTO essay_sessions (user_id, title, default_model, draft_text, topic_attachment_id, ocr_text, objective_description, created_at, updated_at) VALUES (?, ?, ?, '', NULL, '', '', ?, ?)"
  )
    .bind(user.id, payload.title || DEFAULT_ESSAY_TITLE, payload.model || aiTextModel(aiConfig), now, now)
    .run();
  const session = await getEssaySession(env, await insertAndReturnId(result));
  if (!session) throw new HttpError(500, "服务器内部错误");
  return json(await essaySessionResponse(env, session));
}

async function updateEssaySession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const sessionId = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(sessionId) ? await getEssaySession(env, sessionId) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "作文会话不存在");
  }
  const payload = essaySessionPatchSchema.parse(await parseJson<unknown>(request));
  const nextTitle = payload.title?.trim()
    || (payload.draft_text && (!session.title.trim() || session.title === DEFAULT_ESSAY_TITLE) ? essayTitleFromDraft(payload.draft_text) : session.title);
  const nextDraft = payload.draft_text ?? session.draft_text;
  const nextModel = payload.model?.trim() || session.default_model;
  if (payload.clear_topic_image) {
    await env.DB.prepare(
      "UPDATE essay_sessions SET title = ?, default_model = ?, draft_text = ?, topic_attachment_id = NULL, ocr_text = '', objective_description = '', updated_at = ? WHERE id = ?"
    )
      .bind(nextTitle, nextModel, nextDraft, nowIso(), session.id)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE essay_sessions SET title = ?, default_model = ?, draft_text = ?, updated_at = ? WHERE id = ?"
    )
      .bind(nextTitle, nextModel, nextDraft, nowIso(), session.id)
      .run();
  }
  const updated = await getEssaySession(env, session.id);
  if (!updated) throw new HttpError(500, "服务器内部错误");
  return json(await essaySessionResponse(env, updated));
}

async function deleteEssaySession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const sessionId = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(sessionId) ? await getEssaySession(env, sessionId) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "作文会话不存在");
  }
  await env.DB.prepare("DELETE FROM essay_sessions WHERE id = ?").bind(session.id).run();
  return json({ status: "ok" });
}

async function generateEssayImageContext(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const sessionId = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(sessionId) ? await getEssaySession(env, sessionId) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "作文会话不存在");
  }
  const payload = essayImageContextSchema.parse(await parseJson<unknown>(request));
  const attachment = await getEssayAttachment(env, payload.attachment_id, user.id);
  if (!attachment) {
    throw new HttpError(400, "题目图片不存在");
  }

  const object = await env.BUCKET.get(attachment.object_key);
  if (!object?.body) {
    throw new HttpError(400, "题目图片不存在");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const dataUrl = attachmentDataUrl(attachment, bytes);
  const aiConfig = await getAiConfig(env);
  const fallback = JSON.stringify({
    ocr_text: "",
    objective_description: "已保存题目图片，等待后续补全时再结合上下文生成客观描述。"
  });

  let content = fallback;
  let model = aiVisionModel(aiConfig);
  let totalTokens: number | null = null;
  try {
    const response = await completeChatWithUsage(
      [
        {
          role: "system",
          content: ESSAY_IMAGE_CONTEXT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请解析这道考研英语一作文题目图片，并只输出 JSON。"
            },
            {
              type: "image_url",
              image_url: { url: dataUrl }
            }
          ]
        }
      ] as ChatMessage[],
      model,
      fallback,
      env,
      aiConfig
    );
    content = response.content || fallback;
    model = response.model || model;
    totalTokens = response.totalTokens;
  } catch {
    content = fallback;
  }

  const parsed = safeJsonObject(content);
  const ocrText = String(parsed?.ocr_text || "").trim();
  const objectiveDescription = String(parsed?.objective_description || "").trim();
  const nextOcrText = ocrText || "";
  const nextObjectiveDescription = objectiveDescription || "已保存题目图片，等待后续补全时再结合上下文生成客观描述。";
  await env.DB.prepare(
    "UPDATE essay_sessions SET topic_attachment_id = ?, ocr_text = ?, objective_description = ?, updated_at = ? WHERE id = ?"
  )
    .bind(attachment.id, nextOcrText, nextObjectiveDescription, nowIso(), session.id)
    .run();
  await recordTokenUsage(env, user.id, aiConfig, model, totalTokens);
  const updated = await getEssaySession(env, session.id);
  if (!updated) throw new HttpError(500, "服务器内部错误");
  return json(await essaySessionResponse(env, updated));
}

async function suggestEssayCompletion(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  await ensureEssayTables(env);
  const payload = essaySuggestionSchema.parse(await parseJson<unknown>(request));
  const session = await getEssaySession(env, payload.session_id);
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "作文会话不存在");
  }
  const content = payload.content.trim();
  const context = [session.ocr_text.trim(), session.objective_description.trim()].filter(Boolean).join("\n\n");
  const fallback = fallbackEssaySuggestions(content, context);
  const aiConfig = await getAiConfig(env);
  const model = resolveChatModel(aiConfig, payload.model || session.default_model || aiTextModel(aiConfig), false);
  let suggestions = fallback;
  let totalTokens: number | null = null;

  try {
    const response = await completeChatWithUsage(
      [
        {
          role: "system",
          content: ESSAY_SUGGESTION_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: `题目 OCR：\n${session.ocr_text.trim() || "（空）"}\n\n图像客观描述：\n${session.objective_description.trim() || "（空）"}\n\n当前草稿：\n${content || "（空）"}`
        }
      ],
      model,
      JSON.stringify(fallback),
      env,
      aiConfig
    );
    totalTokens = response.totalTokens;
    const parsed = safeJsonArray(response.content);
    const normalized = parsed.map(normalizeSuggestion).filter(Boolean) as Array<{
      kind: "word" | "sentence";
      text: string;
      reason: string;
      confidence: number;
    }>;
    if (normalized.length) {
      suggestions = normalized.slice(0, 3);
    }
  } catch {
    suggestions = fallback;
  }

  await recordTokenUsage(env, user.id, aiConfig, model, totalTokens);
  return json({ suggestions });
}

export function essayRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/essay/sessions", (request) => listEssaySessions(request, env)),
    route("POST", "/api/essay/sessions", (request) => createEssaySession(request, env)),
    route("PATCH", "/api/essay/sessions/:session_id", (request, params) => updateEssaySession(request, env, params)),
    route("DELETE", "/api/essay/sessions/:session_id", (request, params) => deleteEssaySession(request, env, params)),
    route("POST", "/api/essay/sessions/:session_id/image-context", (request, params) =>
      generateEssayImageContext(request, env, params)
    ),
    route("POST", "/api/essay/suggest", (request) => suggestEssayCompletion(request, env))
  ];
}
