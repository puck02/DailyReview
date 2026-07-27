import { z } from "zod";

import { attachmentResponse, type AttachmentRow } from "../attachments/routes";
import { getAiConfig } from "../admin/routes";
import { requireUser } from "../auth/routes";
import { all, boolFromDb, boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { isAiConfigured, streamChatCompletionWithUsage, type AiConfig, type ChatMessage } from "../ai/client";
import { aiTextModel } from "../ai/client";
import { withMathMarkdownProtocol } from "../ai/prompting";
import { resolveChatModel } from "../ai/providers";
import { scheduleTokenUsage } from "../ai/usage";
import { selectChatContext, type ContextMessage } from "./context";
import { acquireGenerationLock, activeGenerationLock, releaseGenerationLock } from "./generation-lock";
import {
  createChatTelemetryContext,
  emitChatTelemetry,
  safeChatErrorType,
  type ChatTelemetryContext
} from "./telemetry";

type SessionRow = Row & {
  id: number;
  user_id: number;
  title: string;
  default_model: string;
  image_context: string;
  is_archived: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = Row & {
  id: number;
  session_id: number;
  role: string;
  content: string;
  model: string | null;
  turn_id: string | null;
  status: "pending" | "streaming" | "complete" | "failed" | "cancelled";
  created_at: string;
};

const sessionCreateSchema = z.object({
  title: z.string().max(255).default("新会话"),
  model: z.string().default("gpt-5.4-mini")
});

const archiveSchema = z.object({
  archived: z.boolean()
});

const chatStreamSchema = z.object({
  session_id: z.number().int(),
  turn_id: z.string().min(1).max(100).optional(),
  content: z.string().max(20_000).default(""),
  model: z.string().default("gpt-5.4-mini"),
  attachment_ids: z.array(z.number().int()).default([]),
  image_data_urls: z.array(z.string().startsWith("data:image/")).default([])
}).refine((payload) => payload.content.trim() || payload.attachment_ids.length > 0, {
  message: "消息不能为空"
});

const chatRegenerateSchema = z.object({
  session_id: z.number().int(),
  assistant_message_id: z.number().int(),
  turn_id: z.string().min(1).max(100).nullable().optional(),
  model: z.string().default("gpt-5.4-mini"),
  content: z.string().max(20_000).optional(),
  attachment_ids: z.array(z.number().int()).optional()
});

const MAX_CHAT_IMAGES = 4;
const IMAGE_CONTEXT_SYSTEM_PREFIX = "图片记忆：";
const MAX_IMAGE_CONTEXT_CHARS = 12000;

function maxImagePayloadBytes(env: Env): number {
  return Number.parseInt(env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
}

function validateImagePayload(env: Env, attachmentIds: number[], imageDataUrls: string[]): void {
  const imageCount = Math.max(attachmentIds.length, imageDataUrls.length);
  if (imageCount > MAX_CHAT_IMAGES) {
    throw new HttpError(400, `一次最多发送 ${MAX_CHAT_IMAGES} 张图片`);
  }
  const totalDataUrlBytes = imageDataUrls.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);
  if (totalDataUrlBytes > maxImagePayloadBytes(env)) {
    throw new HttpError(413, `图片总大小不能超过 ${Math.floor(maxImagePayloadBytes(env) / 1024 / 1024)}MB`);
  }
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function sessionResponse(session: SessionRow): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    default_model: session.default_model,
    is_archived: boolFromDb(session.is_archived),
    created_at: session.created_at,
    updated_at: session.updated_at
  };
}

async function getSession(env: Env, id: number): Promise<SessionRow | null> {
  return await first<SessionRow>(env.DB.prepare("SELECT * FROM chat_sessions WHERE id = ?").bind(id));
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = sessionCreateSchema.parse(await parseJson<unknown>(request));
  const aiConfig = await getAiConfig(env);
  const defaultModel = aiTextModel(aiConfig);
  const now = nowIso();
  const result = await env.DB.prepare(
    "INSERT INTO chat_sessions (user_id, title, default_model, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(user.id, payload.title || "新会话", defaultModel, boolToDb(false), now, now)
    .run();
  const session = await getSession(env, await insertAndReturnId(result));
  if (!session) {
    throw new HttpError(500, "服务器内部错误");
  }
  return json(sessionResponse(session));
}

async function listSessions(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sessions = await all<SessionRow>(
    env.DB.prepare(
      `SELECT s.*
       FROM chat_sessions s
       WHERE s.user_id = ?
         AND (s.updated_at >= ? OR s.is_archived = 1)
         AND (s.is_archived = 1 OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id))
       ORDER BY s.is_archived ASC, s.updated_at DESC`
    ).bind(user.id, cutoff)
  );
  return json(sessions.map(sessionResponse));
}

async function archiveSession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(id) ? await getSession(env, id) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  const payload = archiveSchema.parse(await parseJson<unknown>(request));
  await env.DB.prepare("UPDATE chat_sessions SET is_archived = ?, updated_at = ? WHERE id = ?")
    .bind(boolToDb(payload.archived), payload.archived ? session.updated_at : nowIso(), session.id)
    .run();
  const updated = await getSession(env, session.id);
  return json(sessionResponse(updated || session));
}

async function listMessages(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(id) ? await getSession(env, id) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  const beforeValue = new URL(request.url).searchParams.get("before_id");
  const beforeId = beforeValue === null ? null : Number.parseInt(beforeValue, 10);
  if (beforeValue !== null && (!Number.isInteger(beforeId) || (beforeId || 0) <= 0 || String(beforeId) !== beforeValue)) {
    throw new HttpError(400, "消息游标无效");
  }
  const candidates = await all<MessageRow>(
    beforeId === null
      ? env.DB.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 101").bind(session.id)
      : env.DB.prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT 101").bind(session.id, beforeId)
  );
  const hasMore = candidates.length > 100;
  const messages = candidates.slice(0, 100).reverse();
  const messageIds = messages.map((message) => message.id);
  const attachments = messageIds.length
    ? await all<AttachmentRow>(
        env.DB.prepare(`SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => "?").join(", ")}) ORDER BY id ASC`)
          .bind(...messageIds)
      )
    : [];
  const byMessage = new Map<number, AttachmentRow[]>();
  for (const attachment of attachments) {
    if (attachment.message_id !== null) {
      byMessage.set(attachment.message_id, [...(byMessage.get(attachment.message_id) || []), attachment]);
    }
  }
  return json({
    items: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      model: message.model,
      turn_id: message.turn_id,
      status: message.status,
      created_at: message.created_at,
      attachments: (byMessage.get(message.id) || []).map(attachmentResponse)
    })),
    next_before_id: hasMore ? messages[0]?.id ?? null : null
  });
}

async function deleteSession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(id) ? await getSession(env, id) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  if (await activeGenerationLock(env, session.id)) {
    throw new HttpError(409, "当前会话正在生成回复");
  }
  const deletionTurnId = `delete:${crypto.randomUUID()}`;
  if (!(await acquireGenerationLock(env, session.id, deletionTurnId))) {
    throw new HttpError(409, "当前会话正在生成回复");
  }
  try {
    await env.DB.prepare("UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)")
      .bind(session.id)
      .run();
    await env.DB.prepare("DELETE FROM messages WHERE session_id = ?").bind(session.id).run();
    await env.DB.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(session.id).run();
    return json({ status: "ok" });
  } finally {
    await releaseGenerationLock(env, session.id, deletionTurnId);
  }
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

async function dataUrlForAttachment(env: Env, attachment: AttachmentRow): Promise<string> {
  const object = await env.BUCKET.get(attachment.object_key);
  if (!object) {
    throw new HttpError(400, "附件不存在");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return `data:${attachment.mime_type};base64,${bytesToBase64(bytes)}`;
}

async function contentWithAttachments(
  env: Env,
  content: string,
  attachments: AttachmentRow[],
  imageDataUrls: string[]
): Promise<ChatContentPart[]> {
  const parts: ChatContentPart[] = [{ type: "text", text: content.trim() || "请分析这张图片" }];
  for (const [index, attachment] of attachments.entries()) {
    const url = imageDataUrls[index] || (await dataUrlForAttachment(env, attachment));
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

async function historyForSession(
  env: Env,
  session: SessionRow,
  aiConfig: AiConfig,
  imageMessageId: number | null,
  imageDataUrls: string[] = [],
  excludedAssistantMessageId: number | null = null
): Promise<ChatMessage[]> {
  const candidates = await all<ContextMessage>(
    env.DB.prepare(
      `SELECT id, role, content, status
       FROM (
         SELECT id, role, content, status, created_at
         FROM messages
         WHERE session_id = ? AND id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 120
       )
       ORDER BY created_at ASC, id ASC`
    ).bind(session.id, excludedAssistantMessageId ?? -1)
  );
  const messages = selectChatContext(candidates);
  const history: ChatMessage[] = [];
  const imageContext = session.image_context.trim();
  if (imageContext) {
    history.push({ role: "system", content: `${IMAGE_CONTEXT_SYSTEM_PREFIX}\n${imageContext}` });
  }
  if (!imageMessageId || !isAiConfigured(aiConfig)) {
    history.push(...messages.map((message) => ({ role: message.role, content: message.content })));
    return history;
  }
  const attachments = await all<AttachmentRow>(
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC").bind(imageMessageId)
  );
  for (const message of messages) {
    if (message.id === imageMessageId && attachments.length > 0) {
      history.push({ role: message.role, content: await contentWithAttachments(env, message.content, attachments, imageDataUrls) });
    } else {
      history.push({ role: message.role, content: message.content });
    }
  }
  return history;
}

function appendImageContext(current: string, entry: string): string {
  const next = [current.trim(), entry.trim()].filter(Boolean).join("\n\n---\n\n");
  if (next.length <= MAX_IMAGE_CONTEXT_CHARS) return next;
  return next.slice(next.length - MAX_IMAGE_CONTEXT_CHARS);
}

async function appendSessionImageContext(
  env: Env,
  sessionId: number,
  userContent: string,
  assistantContent: string
): Promise<void> {
  const answer = assistantContent.trim();
  if (!answer) return;
  const prompt = userContent.trim() || "请分析这张图片";
  const entry = `用户问题：${prompt}\n视觉模型回答：${answer}`;
  const row = await first<{ image_context: string }>(
    env.DB.prepare("SELECT image_context FROM chat_sessions WHERE id = ?").bind(sessionId)
  );
  const next = appendImageContext(row?.image_context || "", entry);
  await env.DB.prepare("UPDATE chat_sessions SET image_context = ? WHERE id = ?").bind(next, sessionId).run();
}

function isRequestAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError" && Boolean(signal?.aborted));
}

type StreamAssistantOptions = {
  assistantMessageId: number;
  generationTurnId: string;
  telemetry: ChatTelemetryContext;
  requestSignal?: AbortSignal;
  imageContextUserContent?: string | null;
  ctx?: ExecutionContext;
};

const emptyAssistantReplyMessage = "AI 没有返回内容，请重试或切换模型。";

async function streamAssistantResponse(
  env: Env,
  sessionId: number,
  aiConfig: AiConfig,
  aiModel: string,
  history: ChatMessage[],
  userId: number,
  options: StreamAssistantOptions
): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const parts: string[] = [];
      let totalTokens: number | null = null;
      let actualModel = aiModel;
      let failed = false;
      let abortedByRequest = false;
      let errorType: string | undefined;
      let telemetryFinished = false;
      const enqueue = (value: string) => {
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          return false;
        }
        return true;
      };
      const heartbeatMs = Number.parseInt(env.CHAT_HEARTBEAT_MS || "", 10) || 15_000;
      const heartbeat = setInterval(() => enqueue(": ping\n\n"), heartbeatMs);
      emitChatTelemetry(options.telemetry, { phase: "start", outcome: "started" });
      try {
        await env.DB.prepare("UPDATE messages SET content = '', model = ?, status = 'streaming', created_at = ? WHERE id = ? AND session_id = ?")
          .bind(aiModel, nowIso(), options.assistantMessageId, sessionId)
          .run();
        try {
          for await (const chunk of streamChatCompletionWithUsage(history, aiModel, env, aiConfig, {
            allowProviderFallback: false,
            ...(options.requestSignal ? { signal: options.requestSignal } : {})
          })) {
            if (chunk.model) {
              actualModel = chunk.model;
            }
            if (typeof chunk.totalTokens === "number") {
              totalTokens = chunk.totalTokens;
            }
            if (!chunk.content) {
              continue;
            }
            parts.push(chunk.content);
            enqueue(`data: ${JSON.stringify(chunk.content)}\n\n`);
          }
        } catch (error) {
          abortedByRequest = isRequestAbort(error, options.requestSignal);
          errorType = abortedByRequest ? "request_aborted" : safeChatErrorType(error);
          if (!abortedByRequest) {
            failed = true;
            const token = "AI 服务连接失败，请稍后重试。";
            if (parts.length) {
              parts.push("\n\n");
            }
            parts.push(token);
            enqueue(`data: ${JSON.stringify(token)}\n\n`);
          }
        }
        const assistantContent = parts.join("");
        if (!assistantContent && !failed && !abortedByRequest) {
          failed = true;
          errorType = "empty_response";
          parts.push(emptyAssistantReplyMessage);
          enqueue(`data: ${JSON.stringify(emptyAssistantReplyMessage)}\n\n`);
        }
        if (!parts.length && abortedByRequest) {
          parts.push("已停止生成。");
        }
        const finalAssistantContent = parts.join("");
        const finalStatus = abortedByRequest ? "cancelled" : failed ? "failed" : "complete";
        await env.DB.prepare("UPDATE messages SET content = ?, model = ?, status = ?, created_at = ? WHERE id = ? AND session_id = ?")
          .bind(finalAssistantContent, actualModel, finalStatus, nowIso(), options.assistantMessageId, sessionId)
          .run();
        if (options.imageContextUserContent && finalStatus === "complete") {
          await appendSessionImageContext(env, sessionId, options.imageContextUserContent, finalAssistantContent);
        }
        await scheduleTokenUsage(options.ctx, env, userId, aiConfig, actualModel, totalTokens);
        await env.DB.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").bind(nowIso(), sessionId).run();
        emitChatTelemetry(options.telemetry, {
          phase: "finish",
          outcome: finalStatus,
          model: actualModel,
          outputChars: finalAssistantContent.length,
          ...(errorType ? { errorType } : {})
        });
        telemetryFinished = true;
        enqueue("data: [DONE]\n\n");
        try {
          controller.close();
        } catch {
          // The browser may already have closed the response after an explicit abort.
        }
      } catch (error) {
        if (!telemetryFinished) {
          emitChatTelemetry(options.telemetry, {
            phase: "error",
            outcome: "failed",
            model: actualModel,
            outputChars: parts.join("").length,
            errorType: safeChatErrorType(error)
          });
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        await releaseGenerationLock(env, sessionId, options.generationTurnId);
      }
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

function storedAssistantResponse(message: MessageRow): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (message.content) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message.content)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

async function messagesForTurn(env: Env, sessionId: number, turnId: string): Promise<{ user: MessageRow | null; assistant: MessageRow | null }> {
  const messages = await all<MessageRow>(
    env.DB.prepare("SELECT * FROM messages WHERE session_id = ? AND turn_id = ? ORDER BY id ASC").bind(sessionId, turnId)
  );
  return {
    user: messages.find((message) => message.role === "user") || null,
    assistant: messages.find((message) => message.role === "assistant") || null
  };
}

async function streamChat(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = chatStreamSchema.parse(await parseJson<unknown>(request));
  validateImagePayload(env, payload.attachment_ids, payload.image_data_urls);
  const session = await getSession(env, payload.session_id);
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  const turnId = payload.turn_id || crypto.randomUUID();
  const existingTurn = await messagesForTurn(env, session.id, turnId);
  if (existingTurn.user || existingTurn.assistant) {
    if (existingTurn.user?.content !== payload.content) {
      throw new HttpError(409, "消息标识已被其他内容使用");
    }
    if (existingTurn.assistant && ["complete", "failed", "cancelled"].includes(existingTurn.assistant.status)) {
      return storedAssistantResponse(existingTurn.assistant);
    }
    throw new HttpError(409, "该消息正在生成");
  }
  let attachments: AttachmentRow[] = [];
  if (payload.attachment_ids.length > 0) {
    const placeholders = payload.attachment_ids.map(() => "?").join(", ");
    attachments = await all<AttachmentRow>(
      env.DB.prepare(`SELECT * FROM attachments WHERE user_id = ? AND id IN (${placeholders})`)
        .bind(user.id, ...payload.attachment_ids)
    );
    if (attachments.length !== payload.attachment_ids.length) {
      throw new HttpError(400, "附件不存在");
    }
  }
  const aiConfig = await getAiConfig(env);
  const hasImages = payload.attachment_ids.length > 0 || payload.image_data_urls.length > 0;
  const aiModel = resolveChatModel(aiConfig, payload.model, hasImages);
  if (!(await acquireGenerationLock(env, session.id, turnId))) {
    throw new HttpError(409, "当前会话正在生成回复");
  }
  try {
    const now = nowIso();
    const title = session.title === "新会话" ? payload.content.slice(0, 32) : session.title;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO messages (session_id, role, content, model, turn_id, status, created_at) VALUES (?, 'user', ?, ?, ?, 'complete', ?)"
      ).bind(session.id, payload.content, aiModel, turnId, now),
      env.DB.prepare(
        "INSERT OR IGNORE INTO messages (session_id, role, content, model, turn_id, status, created_at) VALUES (?, 'assistant', '', ?, ?, 'pending', ?)"
      ).bind(session.id, aiModel, turnId, now),
      env.DB.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?").bind(title, now, session.id)
    ]);
    const storedTurn = await messagesForTurn(env, session.id, turnId);
    if (!storedTurn.user || !storedTurn.assistant || storedTurn.user.content !== payload.content) {
      throw new HttpError(409, "消息标识冲突");
    }
    if (storedTurn.assistant.status !== "pending") {
      return storedTurn.assistant.status === "streaming"
        ? json({ detail: "该消息正在生成" }, { status: 409 })
        : storedAssistantResponse(storedTurn.assistant);
    }
    const userMessageId = storedTurn.user.id;

    if (attachments.length > 0) {
      await env.DB.batch(
        attachments.map((attachment) =>
          env.DB.prepare("UPDATE attachments SET message_id = ? WHERE id = ?").bind(userMessageId, attachment.id)
        )
      );
    }

    await env.DB.prepare("UPDATE messages SET model = ? WHERE id = ?").bind(aiModel, userMessageId).run();
    const history = await historyForSession(
      env,
      session,
      aiConfig,
      hasImages ? userMessageId : null,
      payload.image_data_urls,
      storedTurn.assistant.id
    );
    const streamOptions: StreamAssistantOptions = {
      assistantMessageId: storedTurn.assistant.id,
      generationTurnId: turnId,
      telemetry: createChatTelemetryContext(request, turnId, session.id, user.id, aiModel),
      requestSignal: request.signal,
      ...(ctx ? { ctx } : {}),
      ...(hasImages ? { imageContextUserContent: payload.content } : {})
    };
    return await streamAssistantResponse(env, session.id, aiConfig, aiModel, withMathMarkdownProtocol(history), user.id, streamOptions);
  } catch (error) {
    await releaseGenerationLock(env, session.id, turnId);
    throw error;
  }
}

async function regenerateChat(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = chatRegenerateSchema.parse(await parseJson<unknown>(request));
  const session = await getSession(env, payload.session_id);
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  const assistantMessage = await first<MessageRow>(
    env.DB.prepare(
      "SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = 'assistant' AND (? IS NULL OR turn_id = ?)"
    ).bind(payload.assistant_message_id, session.id, payload.turn_id ?? null, payload.turn_id ?? null)
  );
  if (!assistantMessage) {
    throw new HttpError(404, "回复不存在");
  }
  const previousUserQuery = assistantMessage.turn_id
    ? env.DB.prepare("SELECT * FROM messages WHERE session_id = ? AND turn_id = ? AND role = 'user'")
      .bind(session.id, assistantMessage.turn_id)
    : payload.content === undefined
    ? env.DB.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user' AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      ).bind(session.id, assistantMessage.created_at, assistantMessage.created_at, assistantMessage.id)
    : env.DB.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND role = 'user' AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      ).bind(session.id, assistantMessage.created_at, assistantMessage.created_at, assistantMessage.id);
  const lastUserMessage = await first<MessageRow>(previousUserQuery);
  if (!lastUserMessage) {
    throw new HttpError(400, "没有可重新生成的用户消息");
  }
  const aiConfig = await getAiConfig(env);
  const attachments = await all<AttachmentRow>(
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC").bind(lastUserMessage.id)
  );
  const hasImages = attachments.length > 0;
  const aiModel = resolveChatModel(aiConfig, payload.model, hasImages);
  const generationTurnId = assistantMessage.turn_id || crypto.randomUUID();
  if (!(await acquireGenerationLock(env, session.id, generationTurnId))) {
    throw new HttpError(409, "当前会话正在生成回复");
  }
  try {
    await env.DB.prepare("UPDATE messages SET model = ? WHERE id = ?").bind(aiModel, lastUserMessage.id).run();
    const history = await historyForSession(env, session, aiConfig, hasImages ? lastUserMessage.id : null, [], assistantMessage.id);
    const streamOptions: StreamAssistantOptions = {
      assistantMessageId: assistantMessage.id,
      generationTurnId,
      telemetry: createChatTelemetryContext(request, generationTurnId, session.id, user.id, aiModel),
      requestSignal: request.signal,
      ...(ctx ? { ctx } : {}),
      ...(hasImages ? { imageContextUserContent: lastUserMessage.content } : {})
    };
    return await streamAssistantResponse(env, session.id, aiConfig, aiModel, withMathMarkdownProtocol(history), user.id, streamOptions);
  } catch (error) {
    await releaseGenerationLock(env, session.id, generationTurnId);
    throw error;
  }
}

export function chatRoutes(env: Env): Route[] {
  return [
    route("POST", "/api/sessions", (request) => createSession(request, env)),
    route("GET", "/api/sessions", (request) => listSessions(request, env)),
    route("PATCH", "/api/sessions/:session_id/archive", (request, params) => archiveSession(request, env, params)),
    route("GET", "/api/sessions/:session_id/messages", (request, params) => listMessages(request, env, params)),
    route("DELETE", "/api/sessions/:session_id", (request, params) => deleteSession(request, env, params)),
    route("POST", "/api/chat/stream", (request, _params, ctx) => streamChat(request, env, ctx)),
    route("POST", "/api/chat/regenerate", (request, _params, ctx) => regenerateChat(request, env, ctx))
  ];
}
