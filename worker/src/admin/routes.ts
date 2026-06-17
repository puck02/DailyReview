import { z } from "zod";

import type { Env } from "../env";
import { all, first, nowIso, type Row } from "../db/d1";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { requireAdmin, requireUser } from "../auth/routes";
import { safeAiErrorMessage, testAiConnection, type AiConfig } from "../ai/client";
import { summarizeTokenUsage } from "../ai/usage";
import {
  AI_PROVIDER_NAMES,
  configResponse,
  normalizeProviderName,
  providerModels,
  type AiProviderConfig,
  type AiProviderName
} from "../ai/providers";

export const ACTIVE_PROVIDER_KEY = "ai_active_provider";
const GPT_BASE_URL_KEY = "ai_provider_gpt_base_url";
const GPT_API_KEY_KEY = "ai_provider_gpt_api_key";
const GPT_TEXT_MODEL_KEY = "ai_provider_gpt_text_model";
const GPT_VISION_MODEL_KEY = "ai_provider_gpt_vision_model";
const GPT_TRANSLATION_MODEL_KEY = "ai_provider_gpt_translation_model";
const GPT_REPORT_MODEL_KEY = "ai_provider_gpt_report_model";
const ZHIPU_BASE_URL_KEY = "ai_provider_zhipu_base_url";
const ZHIPU_API_KEY_KEY = "ai_provider_zhipu_api_key";
const ZHIPU_TEXT_MODEL_KEY = "ai_provider_zhipu_text_model";
const ZHIPU_VISION_MODEL_KEY = "ai_provider_zhipu_vision_model";
const ZHIPU_TRANSLATION_MODEL_KEY = "ai_provider_zhipu_translation_model";
const ZHIPU_REPORT_MODEL_KEY = "ai_provider_zhipu_report_model";
const LEGACY_AI_BASE_URL_KEY = "ai_base_url";
const LEGACY_AI_API_KEY_KEY = "ai_api_key";
const LEGACY_REPORT_MODEL_KEY = "report_model";
const DEFAULT_GPT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_GPT_VISION_MODEL = DEFAULT_GPT_TEXT_MODEL;
const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_ZHIPU_TEXT_MODEL = "glm-5";
const DEFAULT_ZHIPU_VISION_MODEL = "glm-4.6v-flash";

const providerPatchSchema = z.object({
  base_url: z.string().max(2048).optional(),
  api_key: z.string().max(4096).nullable().optional(),
  text_model: z.string().max(64).optional(),
  vision_model: z.string().max(64).optional(),
  translation_model: z.string().max(64).optional(),
  report_model: z.string().max(64).optional()
});

const adminAiConfigSchema = z.object({
  active_provider: z.enum(AI_PROVIDER_NAMES).optional(),
  providers: z
    .object({
      gpt: providerPatchSchema.optional(),
      zhipu: providerPatchSchema.optional()
    })
    .optional(),
  base_url: z.string().max(2048).optional(),
  api_key: z.string().max(4096).nullable().optional(),
  report_model: z.string().optional()
});

async function getSettingsMap(env: Env, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = await all<Row & { key: string; value: string }>(
    env.DB.prepare(`SELECT key, value FROM app_settings WHERE key IN (${placeholders})`).bind(...keys)
  );
  return new Map(rows.map((row) => [row.key, row.value]));
}

export async function setAiSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, value, nowIso())
    .run();
}

function maskApiKey(apiKey: string): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}****${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`;
}

function allowedModels(provider: AiProviderName, kind: "text" | "vision"): readonly string[] {
  if (provider === "zhipu") {
    return kind === "text" ? ["glm-5"] : ["glm-4.6v-flash", "glm-4.6v"];
  }
  return kind === "text" ? ["gpt-5.4-mini", "gpt-5.5"] : ["gpt-5.4-mini", "gpt-5.5"];
}

function normalizeAllowedModel(provider: AiProviderName, kind: "text" | "vision", value: string, fallback: string): string {
  const normalized = value.trim();
  if (allowedModels(provider, kind).includes(normalized)) {
    return normalized;
  }
  if (allowedModels(provider, kind).includes(fallback)) {
    return fallback;
  }
  return allowedModels(provider, kind)[0] || normalized;
}

function validateAllowedModel(provider: AiProviderName, kind: "text" | "vision", value: string): string {
  const normalized = value.trim();
  if (!allowedModels(provider, kind).includes(normalized)) {
    throw new HttpError(400, "AI 模型无效");
  }
  return normalized;
}

function providerDefaults(provider: AiProviderName, env: Env): AiProviderConfig {
  if (provider === "zhipu") {
    return {
      base_url: DEFAULT_ZHIPU_BASE_URL,
      api_key: "",
      text_model: DEFAULT_ZHIPU_TEXT_MODEL,
      vision_model: DEFAULT_ZHIPU_VISION_MODEL,
      translation_model: DEFAULT_ZHIPU_TEXT_MODEL,
      report_model: DEFAULT_ZHIPU_TEXT_MODEL
    };
  }
  const gptText = normalizeAllowedModel(
    "gpt",
    "text",
    env.AI_COMPLEX_MODEL || DEFAULT_GPT_TEXT_MODEL,
    DEFAULT_GPT_TEXT_MODEL
  );
  return {
    base_url: env.AI_BASE_URL || "",
    api_key: env.AI_API_KEY || "",
    text_model: gptText,
    vision_model: env.AI_VISION_MODEL || gptText || DEFAULT_GPT_VISION_MODEL,
    translation_model: env.AI_DEFAULT_MODEL || gptText,
    report_model: gptText
  };
}

function pickProviderConfig(
  provider: AiProviderName,
  env: Env,
  settings: Map<string, string>,
  defaults: AiProviderConfig
): AiProviderConfig {
  if (provider === "zhipu") {
    const baseUrl = settings.get(ZHIPU_BASE_URL_KEY) || DEFAULT_ZHIPU_BASE_URL;
    const apiKey = settings.get(ZHIPU_API_KEY_KEY) || defaults.api_key;
    const textModel = normalizeAllowedModel(
      provider,
      "text",
      settings.get(ZHIPU_TEXT_MODEL_KEY) || DEFAULT_ZHIPU_TEXT_MODEL,
      DEFAULT_ZHIPU_TEXT_MODEL
    );
    const visionModel = normalizeAllowedModel(
      provider,
      "vision",
      settings.get(ZHIPU_VISION_MODEL_KEY) || DEFAULT_ZHIPU_VISION_MODEL,
      DEFAULT_ZHIPU_VISION_MODEL
    );
    const translationModel = normalizeAllowedModel(
      provider,
      "text",
      settings.get(ZHIPU_TRANSLATION_MODEL_KEY) || textModel,
      textModel
    );
    const reportModel = normalizeAllowedModel(provider, "text", settings.get(ZHIPU_REPORT_MODEL_KEY) || textModel, textModel);
    return {
      base_url: baseUrl,
      api_key: apiKey,
      text_model: textModel,
      vision_model: visionModel,
      translation_model: translationModel,
      report_model: reportModel
    };
  }

  const legacyTextModel = normalizeAllowedModel(
    provider,
    "text",
    settings.get(LEGACY_REPORT_MODEL_KEY) || defaults.text_model,
    defaults.text_model
  );
  const baseUrl = settings.get(GPT_BASE_URL_KEY) || settings.get(LEGACY_AI_BASE_URL_KEY) || defaults.base_url;
  const apiKey = settings.get(GPT_API_KEY_KEY) || settings.get(LEGACY_AI_API_KEY_KEY) || defaults.api_key;
  const textModel = normalizeAllowedModel(provider, "text", settings.get(GPT_TEXT_MODEL_KEY) || legacyTextModel, legacyTextModel);
  const visionModel = normalizeAllowedModel(provider, "vision", settings.get(GPT_VISION_MODEL_KEY) || textModel, textModel);
  const translationModel = normalizeAllowedModel(provider, "text", settings.get(GPT_TRANSLATION_MODEL_KEY) || textModel, textModel);
  const reportModel = normalizeAllowedModel(provider, "text", settings.get(GPT_REPORT_MODEL_KEY) || legacyTextModel, legacyTextModel);
  return {
    base_url: baseUrl,
    api_key: apiKey,
    text_model: textModel,
    vision_model: visionModel,
    translation_model: translationModel,
    report_model: reportModel
  };
}

export async function getAiConfig(env: Env): Promise<AiConfig> {
  const settings = await getSettingsMap(env, [
    ACTIVE_PROVIDER_KEY,
    GPT_BASE_URL_KEY,
    GPT_API_KEY_KEY,
    GPT_TEXT_MODEL_KEY,
    GPT_VISION_MODEL_KEY,
    GPT_TRANSLATION_MODEL_KEY,
    GPT_REPORT_MODEL_KEY,
    ZHIPU_BASE_URL_KEY,
    ZHIPU_API_KEY_KEY,
    ZHIPU_TEXT_MODEL_KEY,
    ZHIPU_VISION_MODEL_KEY,
    ZHIPU_TRANSLATION_MODEL_KEY,
    ZHIPU_REPORT_MODEL_KEY,
    LEGACY_AI_BASE_URL_KEY,
    LEGACY_AI_API_KEY_KEY,
    LEGACY_REPORT_MODEL_KEY
  ]);
  const activeProvider = normalizeProviderName(settings.get(ACTIVE_PROVIDER_KEY), "gpt");
  const gptDefaults = providerDefaults("gpt", env);
  const zhipuDefaults = providerDefaults("zhipu", env);
  return {
    active_provider: activeProvider,
    providers: {
      gpt: pickProviderConfig("gpt", env, settings, gptDefaults),
      zhipu: pickProviderConfig("zhipu", env, settings, zhipuDefaults)
    }
  };
}

function mergeProviderConfig(
  provider: AiProviderName,
  current: AiProviderConfig,
  patch: z.infer<typeof providerPatchSchema>,
  legacy: { base_url?: string; api_key?: string | null; text_model?: string; vision_model?: string; report_model?: string } = {}
): AiProviderConfig {
  const legacyBaseUrl = legacy.base_url ? legacy.base_url.trim() : "";
  const baseUrl = patch.base_url !== undefined ? patch.base_url.trim() : legacyBaseUrl || current.base_url;
  const apiKey =
    patch.api_key === undefined
      ? legacy.api_key === undefined || legacy.api_key === null
        ? current.api_key
        : legacy.api_key.trim() || current.api_key
      : patch.api_key === null
        ? ""
        : patch.api_key.trim() || current.api_key;
  const textSource = patch.text_model ?? legacy.text_model ?? current.text_model;
  const visionSource = patch.vision_model ?? legacy.vision_model ?? current.vision_model;
  const translationSource = patch.translation_model ?? current.translation_model;
  const reportSource = patch.report_model ?? legacy.report_model ?? current.report_model;
  const text_model = validateAllowedModel(provider, "text", textSource);
  const vision_model = validateAllowedModel(provider, "vision", visionSource);
  const translation_model = validateAllowedModel(provider, "text", translationSource);
  const report_model = validateAllowedModel(provider, "text", reportSource);
  return { base_url: baseUrl, api_key: apiKey, text_model, vision_model, translation_model, report_model };
}

function buildLegacyPatch(payload: z.infer<typeof adminAiConfigSchema>): {
  base_url?: string;
  api_key?: string | null;
  text_model?: string;
  vision_model?: string;
  report_model?: string;
} {
  const patch: {
    base_url?: string;
    api_key?: string | null;
    text_model?: string;
    vision_model?: string;
    report_model?: string;
  } = {};
  if (payload.base_url !== undefined) patch.base_url = payload.base_url;
  if (payload.api_key !== undefined) patch.api_key = payload.api_key;
  if (payload.report_model !== undefined) {
    patch.report_model = payload.report_model;
  }
  return patch;
}

async function saveProviderConfig(env: Env, config: AiConfig): Promise<void> {
  await setAiSetting(env, ACTIVE_PROVIDER_KEY, config.active_provider);
  await setAiSetting(env, GPT_BASE_URL_KEY, config.providers.gpt.base_url);
  await setAiSetting(env, GPT_API_KEY_KEY, config.providers.gpt.api_key);
  await setAiSetting(env, GPT_TEXT_MODEL_KEY, config.providers.gpt.text_model);
  await setAiSetting(env, GPT_VISION_MODEL_KEY, config.providers.gpt.vision_model);
  await setAiSetting(env, GPT_TRANSLATION_MODEL_KEY, config.providers.gpt.translation_model);
  await setAiSetting(env, GPT_REPORT_MODEL_KEY, config.providers.gpt.report_model);
  await setAiSetting(env, ZHIPU_BASE_URL_KEY, config.providers.zhipu.base_url);
  await setAiSetting(env, ZHIPU_API_KEY_KEY, config.providers.zhipu.api_key);
  await setAiSetting(env, ZHIPU_TEXT_MODEL_KEY, config.providers.zhipu.text_model);
  await setAiSetting(env, ZHIPU_VISION_MODEL_KEY, config.providers.zhipu.vision_model);
  await setAiSetting(env, ZHIPU_TRANSLATION_MODEL_KEY, config.providers.zhipu.translation_model);
  await setAiSetting(env, ZHIPU_REPORT_MODEL_KEY, config.providers.zhipu.report_model);
}

function aiConfigResponse(config: AiConfig): ReturnType<typeof configResponse> {
  return configResponse(config);
}

function aiModelsResponse(config: AiConfig): Record<string, unknown> {
  const active = config.providers[config.active_provider];
  return {
    active_provider: config.active_provider,
    available_models: {
      gpt: {
        text: [...providerModels("gpt").text],
        vision: [...providerModels("gpt").vision]
      },
      zhipu: {
        text: [...providerModels("zhipu").text],
        vision: [...providerModels("zhipu").vision]
      }
    },
    text_model: active.text_model,
    vision_model: active.vision_model,
    translation_model: active.translation_model,
    report_model: active.report_model
  };
}

async function readAiConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return json(aiConfigResponse(await getAiConfig(env)));
}

async function readAiModels(request: Request, env: Env): Promise<Response> {
  await requireUser(request, env);
  return json(aiModelsResponse(await getAiConfig(env)));
}

function withLegacyPatch(config: AiConfig, payload: z.infer<typeof adminAiConfigSchema>): AiConfig {
  const next: AiConfig = {
    active_provider: payload.active_provider ? normalizeProviderName(payload.active_provider, config.active_provider) : config.active_provider,
    providers: {
      gpt: config.providers.gpt,
      zhipu: config.providers.zhipu
    }
  };
  const gptPatch = payload.providers?.gpt || {};
  const zhipuPatch = payload.providers?.zhipu || {};
  const legacyPatch = buildLegacyPatch(payload);
  next.providers.gpt = mergeProviderConfig("gpt", config.providers.gpt, gptPatch, legacyPatch);
  next.providers.zhipu = mergeProviderConfig("zhipu", config.providers.zhipu, zhipuPatch);
  return next;
}

async function updateAiConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = adminAiConfigSchema.parse(await parseJson<unknown>(request));
  const current = await getAiConfig(env);
  const next = withLegacyPatch(current, payload);
  await saveProviderConfig(env, next);
  return json(aiConfigResponse(next));
}

async function testConfig(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = adminAiConfigSchema.parse(await parseJson<unknown>(request));
  const current = await getAiConfig(env);
  const config = withLegacyPatch(current, payload);
  const active = config.providers[config.active_provider];
  if (!active.base_url || !active.api_key) {
    return json({ ok: false, message: "AI 配置不完整" });
  }
  try {
    return json({ ok: true, message: await testAiConnection(config, active.text_model) });
  } catch (error) {
    return json({ ok: false, message: safeAiErrorMessage(error) });
  }
}

async function readTokenUsage(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const nowParam = url.searchParams.get("now");
  const now = nowParam ? new Date(nowParam) : new Date();
  return json(await summarizeTokenUsage(env, Number.isNaN(now.getTime()) ? new Date() : now));
}

export function adminRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/ai-models", (request) => readAiModels(request, env)),
    route("GET", "/api/admin/ai-config", (request) => readAiConfig(request, env)),
    route("PUT", "/api/admin/ai-config", (request) => updateAiConfig(request, env)),
    route("POST", "/api/admin/ai-config/test", (request) => testConfig(request, env)),
    route("GET", "/api/admin/token-usage", (request) => readTokenUsage(request, env))
  ];
}
