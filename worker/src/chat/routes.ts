import { z } from "zod";

import { attachmentResponse, getAttachment, type AttachmentRow } from "../attachments/routes";
import { getAiConfig } from "../admin/routes";
import { requireUser } from "../auth/routes";
import { all, boolFromDb, boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { isAiConfigured, streamChatCompletion, type AiConfig, type ChatMessage } from "../ai/client";

type SessionRow = Row & {
  id: number;
  user_id: number;
  title: string;
  default_model: string;
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
  content: z.string().min(1),
  model: z.string().default("gpt-5.4-mini"),
  attachment_ids: z.array(z.number().int()).default([]),
  image_data_urls: z.array(z.string().startsWith("data:image/")).default([])
});

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
  const now = nowIso();
  const result = await env.DB.prepare(
    "INSERT INTO chat_sessions (user_id, title, default_model, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(user.id, payload.title || "新会话", payload.model, boolToDb(false), now, now)
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
  const messages = await all<MessageRow>(
    env.DB.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC").bind(session.id)
  );
  const attachments = await all<AttachmentRow>(
    env.DB.prepare(
      `SELECT a.*
       FROM attachments a
       JOIN messages m ON a.message_id = m.id
       WHERE m.session_id = ?
       ORDER BY a.id ASC`
    ).bind(session.id)
  );
  const byMessage = new Map<number, AttachmentRow[]>();
  for (const attachment of attachments) {
    if (attachment.message_id !== null) {
      byMessage.set(attachment.message_id, [...(byMessage.get(attachment.message_id) || []), attachment]);
    }
  }
  return json(
    messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      model: message.model,
      created_at: message.created_at,
      attachments: (byMessage.get(message.id) || []).map(attachmentResponse)
    }))
  );
}

async function deleteSession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.session_id || "", 10);
  const session = Number.isFinite(id) ? await getSession(env, id) : null;
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  await env.DB.prepare("UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)")
    .bind(session.id)
    .run();
  await env.DB.prepare("DELETE FROM messages WHERE session_id = ?").bind(session.id).run();
  await env.DB.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(session.id).run();
  return json({ status: "ok" });
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
  const parts: ChatContentPart[] = [{ type: "text", text: content }];
  for (const [index, attachment] of attachments.entries()) {
    const url = imageDataUrls[index] || (await dataUrlForAttachment(env, attachment));
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

async function historyForSession(
  env: Env,
  sessionId: number,
  aiConfig: AiConfig,
  imageMessageId: number | null,
  imageDataUrls: string[] = []
): Promise<ChatMessage[]> {
  const messages = await all<MessageRow>(
    env.DB.prepare("SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC").bind(sessionId)
  );
  if (!imageMessageId || !isAiConfigured(aiConfig)) {
    return messages.map((message) => ({ role: message.role, content: message.content }));
  }
  const attachments = await all<AttachmentRow>(
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC").bind(imageMessageId)
  );
  const history: ChatMessage[] = [];
  for (const message of messages) {
    if (message.id === imageMessageId && attachments.length > 0) {
      history.push({ role: message.role, content: await contentWithAttachments(env, message.content, attachments, imageDataUrls) });
    } else {
      history.push({ role: message.role, content: message.content });
    }
  }
  return history;
}

async function streamChat(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = chatStreamSchema.parse(await parseJson<unknown>(request));
  const session = await getSession(env, payload.session_id);
  if (!session || session.user_id !== user.id) {
    throw new HttpError(404, "会话不存在");
  }
  const now = nowIso();
  const userInsert = await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'user', ?, ?, ?)")
    .bind(session.id, payload.content, payload.model, now)
    .run();
  const userMessageId = await insertAndReturnId(userInsert);
  const title = session.title === "新会话" ? payload.content.slice(0, 32) : session.title;
  await env.DB.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?").bind(title, now, session.id).run();

  for (const attachmentId of payload.attachment_ids) {
    const attachment = await getAttachment(env, attachmentId);
    if (!attachment || attachment.user_id !== user.id) {
      throw new HttpError(400, "附件不存在");
    }
    await env.DB.prepare("UPDATE attachments SET message_id = ? WHERE id = ?").bind(userMessageId, attachment.id).run();
  }

  const aiConfig = await getAiConfig(env);
  const history = await historyForSession(env, session.id, aiConfig, userMessageId, payload.image_data_urls);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const parts: string[] = [];
      try {
        for await (const token of streamChatCompletion(history, payload.model, env, aiConfig)) {
          parts.push(token);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(token)}\n\n`));
        }
      } catch {
        const token = "AI 服务连接失败，请稍后重试。";
        parts.push(token);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(token)}\n\n`));
      }
      const assistantContent = parts.join("");
      await env.DB.prepare("INSERT INTO messages (session_id, role, content, model, created_at) VALUES (?, 'assistant', ?, ?, ?)")
        .bind(session.id, assistantContent, payload.model, nowIso())
        .run();
      await env.DB.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").bind(nowIso(), session.id).run();
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

export function chatRoutes(env: Env): Route[] {
  return [
    route("POST", "/api/sessions", (request) => createSession(request, env)),
    route("GET", "/api/sessions", (request) => listSessions(request, env)),
    route("PATCH", "/api/sessions/:session_id/archive", (request, params) => archiveSession(request, env, params)),
    route("GET", "/api/sessions/:session_id/messages", (request, params) => listMessages(request, env, params)),
    route("DELETE", "/api/sessions/:session_id", (request, params) => deleteSession(request, env, params)),
    route("POST", "/api/chat/stream", (request) => streamChat(request, env))
  ];
}
