import { z } from "zod";

import type { Env } from "../env";
import { first, nowIso, type Row } from "../db/d1";
import { json, parseJson, route, type Route } from "../http";
import { requireAdmin } from "../auth/routes";
import { safeAiErrorMessage, testAiConnection, type AiConfig } from "../ai/client";

const AI_BASE_URL_KEY = "ai_base_url";
const AI_API_KEY_KEY = "ai_api_key";

const aiConfigSchema = z.object({
  base_url: z.string().max(2048).default(""),
  api_key: z.string().max(4096).nullable().optional()
});

async function getSetting(env: Env, key: string): Promise<string> {
  const row = await first<Row & { value: string }>(env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key));
  return row?.value || "";
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, value, nowIso())
    .run();
}

export async function getAiConfig(env: Env): Promise<AiConfig> {
  return {
    base_url: (await getSetting(env, AI_BASE_URL_KEY)) || env.AI_BASE_URL || "",
    api_key: (await getSetting(env, AI_API_KEY_KEY)) || env.AI_API_KEY || ""
  };
}

function maskApiKey(apiKey: string): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}****${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`;
}

function aiConfigResponse(config: AiConfig): Record<string, unknown> {
  return {
    base_url: config.base_url,
    has_api_key: Boolean(config.api_key),
    api_key_preview: maskApiKey(config.api_key)
  };
}

async function readAiConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return json(aiConfigResponse(await getAiConfig(env)));
}

async function updateAiConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = aiConfigSchema.parse(await parseJson<unknown>(request));
  await setSetting(env, AI_BASE_URL_KEY, payload.base_url.trim());
  if (payload.api_key) {
    await setSetting(env, AI_API_KEY_KEY, payload.api_key.trim());
  }
  return json(aiConfigResponse(await getAiConfig(env)));
}

async function testConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const current = await getAiConfig(env);
  const payload = aiConfigSchema.parse(await parseJson<unknown>(request));
  const config = {
    base_url: payload.base_url.trim(),
    api_key: (payload.api_key || current.api_key).trim()
  };
  if (!config.base_url || !config.api_key) {
    return json({ ok: false, message: "AI 配置不完整" });
  }
  try {
    return json({ ok: true, message: await testAiConnection(config, env.AI_DEFAULT_MODEL) });
  } catch (error) {
    return json({ ok: false, message: safeAiErrorMessage(error) });
  }
}

export function adminRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/admin/ai-config", (request) => readAiConfig(request, env)),
    route("PUT", "/api/admin/ai-config", (request) => updateAiConfig(request, env)),
    route("POST", "/api/admin/ai-config/test", (request) => testConfig(request, env))
  ];
}
