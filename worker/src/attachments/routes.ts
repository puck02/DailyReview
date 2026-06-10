import type { Env } from "../env";
import { boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import { HttpError, json, route, type Route } from "../http";
import { requireUser } from "../auth/routes";

export type AttachmentRow = Row & {
  id: number;
  message_id: number | null;
  user_id: number;
  object_key: string;
  mime_type: string;
  size: number;
  expires_at: string;
  created_at: string;
};

const IMAGE_TYPES: Array<{ signature: number[]; mime: string; suffix: string }> = [
  { signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png", suffix: ".png" },
  { signature: [0xff, 0xd8, 0xff], mime: "image/jpeg", suffix: ".jpg" },
  { signature: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mime: "image/gif", suffix: ".gif" },
  { signature: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mime: "image/gif", suffix: ".gif" }
];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImageType(bytes: Uint8Array): { mime: string; suffix: string } | null {
  for (const type of IMAGE_TYPES) {
    if (startsWith(bytes, type.signature)) {
      return type;
    }
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", suffix: ".webp" };
  }
  return null;
}

export function attachmentResponse(attachment: AttachmentRow): Record<string, unknown> {
  return {
    id: attachment.id,
    mime_type: attachment.mime_type,
    size: attachment.size,
    expires_at: attachment.expires_at,
    url: `/api/attachments/${attachment.id}/content`
  };
}

export async function getAttachment(env: Env, id: number): Promise<AttachmentRow | null> {
  return await first<AttachmentRow>(env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id));
}

async function uploadAttachment(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "图片为空，请重新粘贴或选择图片");
  }
  const maxUploadBytes = Number.parseInt(env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) {
    throw new HttpError(400, "图片为空，请重新粘贴或选择图片");
  }
  if (bytes.byteLength > maxUploadBytes) {
    throw new HttpError(413, `图片不能超过 ${Math.floor(maxUploadBytes / 1024 / 1024)}MB`);
  }
  const detected = detectImageType(bytes);
  if (!detected) {
    throw new HttpError(400, "只支持 PNG、JPEG、WebP 或 GIF 图片");
  }
  const now = new Date();
  const objectKey = `uploads/user-${user.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}${detected.suffix}`;
  await env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: detected.mime } });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO attachments (message_id, user_id, object_key, mime_type, size, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(null, user.id, objectKey, detected.mime, bytes.byteLength, expiresAt, nowIso())
    .run();
  const id = await insertAndReturnId(result);
  const attachment = await getAttachment(env, id);
  if (!attachment) {
    throw new HttpError(500, "服务器内部错误");
  }
  return json(attachmentResponse(attachment));
}

async function attachmentContent(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.attachment_id || "", 10);
  const attachment = Number.isFinite(id) ? await getAttachment(env, id) : null;
  if (!attachment || attachment.user_id !== user.id) {
    throw new HttpError(404, "附件不存在");
  }
  const object = await env.BUCKET.get(attachment.object_key);
  if (!object?.body) {
    throw new HttpError(404, "附件不存在");
  }
  return new Response(object.body, {
    headers: { "content-type": attachment.mime_type, "cache-control": "private, max-age=3600" }
  });
}

export function attachmentRoutes(env: Env): Route[] {
  return [
    route("POST", "/api/attachments", (request) => uploadAttachment(request, env)),
    route("GET", "/api/attachments/:attachment_id/content", (request, params) => attachmentContent(request, env, params))
  ];
}
