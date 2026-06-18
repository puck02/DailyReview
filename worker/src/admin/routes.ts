import { z } from "zod";

import type { Env } from "../env";
import { all, nowIso, type Row } from "../db/d1";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { requireAdmin, requireUser } from "../auth/routes";
import { safeAiErrorMessage, testAiConnection, type AiConfig } from "../ai/client";
import { summarizeTokenUsage } from "../ai/usage";
import {
  AI_PROVIDER_NAMES,
  configResponse,
  defaultEnabledModels,
  enabledModels,
  isProviderConfigured,
  modelProvider,
  normalizeProviderName,
  providerModels,
  resolveReportModel,
  resolveTextModel,
  resolveTranslationModel,
  resolveVisionModel,
  uniqueModels,
  type AiModelKind,
  type AiProviderConfig,
  type AiProviderName
} from "../ai/providers";

export const ACTIVE_PROVIDER_KEY = "ai_active_provider";
export const DEFAULT_TEXT_MODEL_KEY = "ai_default_text_model";
const DEFAULT_VISION_MODEL_KEY = "ai_default_vision_model";
const TRANSLATION_MODEL_KEY = "ai_translation_model";
const REPORT_MODEL_KEY = "ai_report_model";
const LEGACY_AI_BASE_URL_KEY = "ai_base_url";
const LEGACY_AI_API_KEY_KEY = "ai_api_key";
const LEGACY_REPORT_MODEL_KEY = "report_model";
const DEFAULT_GPT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_GPT_VISION_MODEL = DEFAULT_GPT_TEXT_MODEL;
const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_ZHIPU_TEXT_MODEL = "glm-5";
const DEFAULT_ZHIPU_VISION_MODEL = "glm-4.6v";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_TEXT_MODEL = "deepseek-chat";

type ProviderSettingKeys = {
  base_url: string;
  api_key: string;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
  enabled_text_models: string;
  enabled_vision_models: string;
};

const PROVIDER_SETTING_KEYS: Record<AiProviderName, ProviderSettingKeys> = {
  gpt: {
    base_url: "ai_provider_gpt_base_url",
    api_key: "ai_provider_gpt_api_key",
    text_model: "ai_provider_gpt_text_model",
    vision_model: "ai_provider_gpt_vision_model",
    translation_model: "ai_provider_gpt_translation_model",
    report_model: "ai_provider_gpt_report_model",
    enabled_text_models: "ai_provider_gpt_enabled_text_models",
    enabled_vision_models: "ai_provider_gpt_enabled_vision_models"
  },
  zhipu: {
    base_url: "ai_provider_zhipu_base_url",
    api_key: "ai_provider_zhipu_api_key",
    text_model: "ai_provider_zhipu_text_model",
    vision_model: "ai_provider_zhipu_vision_model",
    translation_model: "ai_provider_zhipu_translation_model",
    report_model: "ai_provider_zhipu_report_model",
    enabled_text_models: "ai_provider_zhipu_enabled_text_models",
    enabled_vision_models: "ai_provider_zhipu_enabled_vision_models"
  },
  deepseek: {
    base_url: "ai_provider_deepseek_base_url",
    api_key: "ai_provider_deepseek_api_key",
    text_model: "ai_provider_deepseek_text_model",
    vision_model: "ai_provider_deepseek_vision_model",
    translation_model: "ai_provider_deepseek_translation_model",
    report_model: "ai_provider_deepseek_report_model",
    enabled_text_models: "ai_provider_deepseek_enabled_text_models",
    enabled_vision_models: "ai_provider_deepseek_enabled_vision_models"
  }
};

const modelNameSchema = z.string().trim().min(1).max(128);
const modelListSchema = z.array(modelNameSchema).max(100);

const providerPatchSchema = z.object({
  base_url: z.string().max(2048).optional(),
  api_key: z.string().max(4096).nullable().optional(),
  text_model: z.string().max(128).optional(),
  vision_model: z.string().max(128).optional(),
  translation_model: z.string().max(128).optional(),
  report_model: z.string().max(128).optional(),
  enabled_text_models: modelListSchema.optional(),
  enabled_vision_models: modelListSchema.optional()
});

const adminAiConfigSchema = z.object({
  active_provider: z.enum(AI_PROVIDER_NAMES).optional(),
  default_text_model: z.string().max(128).optional(),
  default_vision_model: z.string().max(128).optional(),
  translation_model: z.string().max(128).optional(),
  report_model: z.string().max(128).optional(),
  providers: z
    .object({
      gpt: providerPatchSchema.optional(),
      zhipu: providerPatchSchema.optional(),
      deepseek: providerPatchSchema.optional()
    })
    .optional(),
  base_url: z.string().max(2048).optional(),
  api_key: z.string().max(4096).nullable().optional()
});

const modelDiscoverySchema = z.object({
  provider: z.enum(AI_PROVIDER_NAMES),
  base_url: z.string().max(2048).optional(),
  api_key: z.string().max(4096).nullable().optional()
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

function settingKeys(): string[] {
  return [
    ACTIVE_PROVIDER_KEY,
    DEFAULT_TEXT_MODEL_KEY,
    DEFAULT_VISION_MODEL_KEY,
    TRANSLATION_MODEL_KEY,
    REPORT_MODEL_KEY,
    LEGACY_AI_BASE_URL_KEY,
    LEGACY_AI_API_KEY_KEY,
    LEGACY_REPORT_MODEL_KEY,
    ...AI_PROVIDER_NAMES.flatMap((provider) => Object.values(PROVIDER_SETTING_KEYS[provider]))
  ];
}

function parseModelList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [...fallback];
    }
    return uniqueModels(parsed.filter((item): item is string => typeof item === "string" && item.length <= 128));
  } catch {
    return [...fallback];
  }
}

function normalizeProviderModelList(provider: AiProviderName, kind: AiModelKind, models: readonly string[]): string[] {
  return uniqueModels(
    models.map((model) => (provider === "zhipu" && kind === "vision" && model.trim() === "glm-4.6v-flash" ? "glm-4.6v" : model))
  );
}

function stringifyModelList(models: readonly string[]): string {
  return JSON.stringify(uniqueModels(models));
}

function defaultProviderModels(provider: AiProviderName, kind: AiModelKind): string[] {
  return defaultEnabledModels(provider)[kind];
}

function normalizeKnownModel(provider: AiProviderName, kind: AiModelKind, value: string, fallback: string): string {
  const models = providerModels(provider)[kind];
  const normalized = value.trim();
  if (models.includes(normalized)) {
    return normalized;
  }
  if (models.includes(fallback)) {
    return fallback;
  }
  return models[0] || normalized || fallback;
}

function normalizeKnownVisionModel(provider: AiProviderName, value: string, fallback: string): string {
  const normalized = value.trim();
  if (provider === "zhipu" && normalized === "glm-4.6v-flash") {
    return "glm-4.6v";
  }
  return normalizeKnownModel(provider, "vision", normalized, fallback);
}

function normalizeProviderModel(
  value: string,
  enabled: readonly string[],
  fallback: string,
  allowEmpty = false
): string {
  const normalized = value.trim();
  if (!normalized && allowEmpty) return "";
  if (enabled.includes(normalized)) return normalized;
  if (enabled.includes(fallback)) return fallback;
  return enabled[0] || normalized || fallback;
}

function validateProviderModel(value: string, enabled: readonly string[], allowEmpty = false): string {
  const normalized = value.trim();
  if (!normalized && allowEmpty) return "";
  if (!enabled.includes(normalized)) {
    throw new HttpError(400, "AI 模型无效");
  }
  return normalized;
}

function providerDefaults(provider: AiProviderName, env: Env): AiProviderConfig {
  if (provider === "zhipu") {
    return {
      base_url: env.ZHIPU_BASE_URL || DEFAULT_ZHIPU_BASE_URL,
      api_key: env.ZHIPU_API_KEY || "",
      text_model: DEFAULT_ZHIPU_TEXT_MODEL,
      vision_model: DEFAULT_ZHIPU_VISION_MODEL,
      translation_model: DEFAULT_ZHIPU_TEXT_MODEL,
      report_model: DEFAULT_ZHIPU_TEXT_MODEL,
      enabled_text_models: defaultProviderModels(provider, "text"),
      enabled_vision_models: defaultProviderModels(provider, "vision")
    };
  }
  if (provider === "deepseek") {
    return {
      base_url: env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
      api_key: env.DEEPSEEK_API_KEY || "",
      text_model: DEFAULT_DEEPSEEK_TEXT_MODEL,
      vision_model: "",
      translation_model: DEFAULT_DEEPSEEK_TEXT_MODEL,
      report_model: DEFAULT_DEEPSEEK_TEXT_MODEL,
      enabled_text_models: defaultProviderModels(provider, "text"),
      enabled_vision_models: defaultProviderModels(provider, "vision")
    };
  }
  const gptText = normalizeKnownModel("gpt", "text", env.AI_COMPLEX_MODEL || DEFAULT_GPT_TEXT_MODEL, DEFAULT_GPT_TEXT_MODEL);
  const gptVision = normalizeKnownModel("gpt", "vision", env.AI_VISION_MODEL || gptText || DEFAULT_GPT_VISION_MODEL, gptText);
  return {
    base_url: env.AI_BASE_URL || "",
    api_key: env.AI_API_KEY || "",
    text_model: gptText,
    vision_model: gptVision,
    translation_model: normalizeKnownModel("gpt", "text", env.AI_DEFAULT_MODEL || gptText, gptText),
    report_model: gptText,
    enabled_text_models: defaultProviderModels(provider, "text"),
    enabled_vision_models: defaultProviderModels(provider, "vision")
  };
}

function pickProviderConfig(
  provider: AiProviderName,
  env: Env,
  settings: Map<string, string>,
  defaults: AiProviderConfig
): AiProviderConfig {
  const keys = PROVIDER_SETTING_KEYS[provider];
  const legacyTextModel =
    provider === "gpt"
      ? normalizeProviderModel(
          settings.get(LEGACY_REPORT_MODEL_KEY) || defaults.text_model,
          defaults.enabled_text_models,
          defaults.text_model
        )
      : defaults.text_model;
  const baseUrl =
    settings.get(keys.base_url) || (provider === "gpt" ? settings.get(LEGACY_AI_BASE_URL_KEY) : undefined) || defaults.base_url;
  const apiKey =
    settings.get(keys.api_key) || (provider === "gpt" ? settings.get(LEGACY_AI_API_KEY_KEY) : undefined) || defaults.api_key;
  const enabledTextModels = normalizeProviderModelList(
    provider,
    "text",
    parseModelList(settings.get(keys.enabled_text_models), defaults.enabled_text_models)
  );
  const enabledVisionModels = normalizeProviderModelList(
    provider,
    "vision",
    parseModelList(settings.get(keys.enabled_vision_models), defaults.enabled_vision_models)
  );
  const textModel = normalizeProviderModel(settings.get(keys.text_model) || legacyTextModel, enabledTextModels, legacyTextModel);
  const visionModel = normalizeProviderModel(
    normalizeKnownVisionModel(provider, settings.get(keys.vision_model) || defaults.vision_model, defaults.vision_model),
    enabledVisionModels,
    defaults.vision_model,
    enabledVisionModels.length === 0
  );
  const translationModel = normalizeProviderModel(
    settings.get(keys.translation_model) || textModel,
    enabledTextModels,
    textModel
  );
  const reportModel = normalizeProviderModel(settings.get(keys.report_model) || textModel, enabledTextModels, textModel);
  return {
    base_url: baseUrl,
    api_key: apiKey,
    text_model: textModel,
    vision_model: visionModel,
    translation_model: translationModel,
    report_model: reportModel,
    enabled_text_models: enabledTextModels,
    enabled_vision_models: enabledVisionModels
  };
}

function normalizeGlobalModel(config: AiConfig, kind: AiModelKind, value: string, fallback: string, allowEmpty = false): string {
  const normalized = value.trim();
  if (!normalized && allowEmpty) return "";
  if (normalized && modelProvider(config, normalized, kind)) {
    return normalized;
  }
  if (fallback && modelProvider(config, fallback, kind)) {
    return fallback;
  }
  const models = enabledModels(config, kind);
  return models[0] || normalized || fallback;
}

function validateGlobalModel(config: AiConfig, kind: AiModelKind, value: string, allowEmpty = false): string {
  const normalized = value.trim();
  if (!normalized && allowEmpty) return "";
  if (!modelProvider(config, normalized, kind)) {
    throw new HttpError(400, "AI 模型无效");
  }
  return normalized;
}

export async function getAiConfig(env: Env): Promise<AiConfig> {
  const settings = await getSettingsMap(env, settingKeys());
  const gptDefaults = providerDefaults("gpt", env);
  const zhipuDefaults = providerDefaults("zhipu", env);
  const deepseekDefaults = providerDefaults("deepseek", env);
  const activeProvider = normalizeProviderName(settings.get(ACTIVE_PROVIDER_KEY), "gpt");
  const providers: Record<AiProviderName, AiProviderConfig> = {
    gpt: pickProviderConfig("gpt", env, settings, gptDefaults),
    zhipu: pickProviderConfig("zhipu", env, settings, zhipuDefaults),
    deepseek: pickProviderConfig("deepseek", env, settings, deepseekDefaults)
  };
  const config: AiConfig = {
    active_provider: activeProvider,
    default_text_model: providers[activeProvider].text_model,
    default_vision_model: providers[activeProvider].vision_model,
    translation_model: providers[activeProvider].translation_model,
    report_model: providers[activeProvider].report_model,
    providers
  };
  config.default_text_model = normalizeGlobalModel(
    config,
    "text",
    settings.get(DEFAULT_TEXT_MODEL_KEY) || providers[activeProvider].text_model,
    providers[activeProvider].text_model
  );
  const defaultProvider = modelProvider(config, config.default_text_model, "text");
  if (defaultProvider) {
    config.active_provider = defaultProvider;
  }
  config.default_vision_model = normalizeGlobalModel(
    config,
    "vision",
    settings.get(DEFAULT_VISION_MODEL_KEY) || providers[config.active_provider].vision_model,
    providers[config.active_provider].vision_model,
    enabledModels(config, "vision").length === 0
  );
  config.translation_model = normalizeGlobalModel(
    config,
    "text",
    settings.get(TRANSLATION_MODEL_KEY) || providers[config.active_provider].translation_model,
    config.default_text_model
  );
  config.report_model = normalizeGlobalModel(
    config,
    "text",
    settings.get(REPORT_MODEL_KEY) || settings.get(LEGACY_REPORT_MODEL_KEY) || providers[config.active_provider].report_model,
    config.default_text_model
  );
  return config;
}

function mergeProviderConfig(
  provider: AiProviderName,
  current: AiProviderConfig,
  patch: z.infer<typeof providerPatchSchema>,
  legacy: { base_url?: string; api_key?: string | null } = {}
): AiProviderConfig {
  const baseUrl = patch.base_url !== undefined ? patch.base_url.trim() : legacy.base_url?.trim() || current.base_url;
  const apiKey =
    patch.api_key === undefined
      ? legacy.api_key === undefined || legacy.api_key === null
        ? current.api_key
        : legacy.api_key.trim() || current.api_key
      : patch.api_key === null
        ? ""
        : patch.api_key.trim() || current.api_key;
  const enabledTextModels =
    patch.enabled_text_models !== undefined
      ? normalizeProviderModelList(provider, "text", patch.enabled_text_models)
      : current.enabled_text_models;
  const enabledVisionModels =
    patch.enabled_vision_models !== undefined
      ? normalizeProviderModelList(provider, "vision", patch.enabled_vision_models)
      : current.enabled_vision_models;
  const text_model =
    patch.text_model !== undefined
      ? validateProviderModel(patch.text_model, enabledTextModels)
      : normalizeProviderModel(current.text_model, enabledTextModels, current.text_model);
  const vision_model =
    patch.vision_model !== undefined
      ? validateProviderModel(
          provider === "zhipu" && patch.vision_model.trim() === "glm-4.6v-flash" ? "glm-4.6v" : patch.vision_model,
          enabledVisionModels,
          enabledVisionModels.length === 0
        )
      : normalizeProviderModel(current.vision_model, enabledVisionModels, current.vision_model, enabledVisionModels.length === 0);
  const translation_model =
    patch.translation_model !== undefined
      ? validateProviderModel(patch.translation_model, enabledTextModels)
      : normalizeProviderModel(current.translation_model, enabledTextModels, text_model);
  const reportSource = patch.report_model;
  const report_model =
    reportSource !== undefined
      ? validateProviderModel(reportSource, enabledTextModels)
      : normalizeProviderModel(current.report_model, enabledTextModels, text_model);
  return {
    base_url: baseUrl,
    api_key: apiKey,
    text_model,
    vision_model,
    translation_model,
    report_model,
    enabled_text_models: enabledTextModels,
    enabled_vision_models: enabledVisionModels
  };
}

function buildLegacyPatch(payload: z.infer<typeof adminAiConfigSchema>): {
  base_url?: string;
  api_key?: string | null;
} {
  const patch: { base_url?: string; api_key?: string | null } = {};
  if (payload.base_url !== undefined) patch.base_url = payload.base_url;
  if (payload.api_key !== undefined) patch.api_key = payload.api_key;
  return patch;
}

async function saveProviderConfig(env: Env, config: AiConfig): Promise<void> {
  await setAiSetting(env, ACTIVE_PROVIDER_KEY, config.active_provider);
  await setAiSetting(env, DEFAULT_TEXT_MODEL_KEY, config.default_text_model);
  await setAiSetting(env, DEFAULT_VISION_MODEL_KEY, config.default_vision_model);
  await setAiSetting(env, TRANSLATION_MODEL_KEY, config.translation_model);
  await setAiSetting(env, REPORT_MODEL_KEY, config.report_model);
  for (const provider of AI_PROVIDER_NAMES) {
    const keys = PROVIDER_SETTING_KEYS[provider];
    const providerConfig = config.providers[provider];
    await setAiSetting(env, keys.base_url, providerConfig.base_url);
    await setAiSetting(env, keys.api_key, providerConfig.api_key);
    await setAiSetting(env, keys.text_model, providerConfig.text_model);
    await setAiSetting(env, keys.vision_model, providerConfig.vision_model);
    await setAiSetting(env, keys.translation_model, providerConfig.translation_model);
    await setAiSetting(env, keys.report_model, providerConfig.report_model);
    await setAiSetting(env, keys.enabled_text_models, stringifyModelList(providerConfig.enabled_text_models));
    await setAiSetting(env, keys.enabled_vision_models, stringifyModelList(providerConfig.enabled_vision_models));
  }
}

function aiConfigResponse(config: AiConfig): ReturnType<typeof configResponse> {
  return configResponse(config);
}

function configuredModelRecord(config: AiConfig): Record<AiProviderName, { text: string[]; vision: string[] }> {
  return {
    gpt: isProviderConfigured(config, "gpt")
      ? {
          text: [...config.providers.gpt.enabled_text_models],
          vision: [...config.providers.gpt.enabled_vision_models]
        }
      : { text: [], vision: [] },
    zhipu: isProviderConfigured(config, "zhipu")
      ? {
          text: [...config.providers.zhipu.enabled_text_models],
          vision: [...config.providers.zhipu.enabled_vision_models]
        }
      : { text: [], vision: [] },
    deepseek: isProviderConfigured(config, "deepseek")
      ? {
          text: [...config.providers.deepseek.enabled_text_models],
          vision: [...config.providers.deepseek.enabled_vision_models]
        }
      : { text: [], vision: [] }
  };
}

function configuredModels(config: AiConfig, kind: AiModelKind): string[] {
  const record = configuredModelRecord(config);
  return uniqueModels(AI_PROVIDER_NAMES.flatMap((provider) => record[provider][kind]));
}

function resolveConfiguredModel(config: AiConfig, kind: AiModelKind, preferred: string): string {
  const models = configuredModels(config, kind);
  if (!models.length) {
    return preferred;
  }
  const provider = modelProvider(config, preferred, kind);
  if (provider && isProviderConfigured(config, provider) && models.includes(preferred)) {
    return preferred;
  }
  return models[0] || preferred;
}

function aiModelsResponse(config: AiConfig): Record<string, unknown> {
  const models = configuredModelRecord(config);
  const textModels = configuredModels(config, "text");
  const visionModels = configuredModels(config, "vision");
  return {
    active_provider: config.active_provider,
    available_models: models,
    enabled_models: models,
    text_models: textModels,
    vision_models: visionModels,
    text_model: resolveConfiguredModel(config, "text", resolveTextModel(config)),
    vision_model: resolveConfiguredModel(config, "vision", resolveVisionModel(config)),
    translation_model: resolveConfiguredModel(config, "text", resolveTranslationModel(config)),
    report_model: resolveConfiguredModel(config, "text", resolveReportModel(config))
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
    default_text_model: config.default_text_model,
    default_vision_model: config.default_vision_model,
    translation_model: config.translation_model,
    report_model: config.report_model,
    providers: {
      gpt: config.providers.gpt,
      zhipu: config.providers.zhipu,
      deepseek: config.providers.deepseek
    }
  };
  const legacyPatch = buildLegacyPatch(payload);
  for (const provider of AI_PROVIDER_NAMES) {
    next.providers[provider] = mergeProviderConfig(
      provider,
      config.providers[provider],
      payload.providers?.[provider] || {},
      provider === "gpt" ? legacyPatch : {}
    );
  }
  const activePatch = payload.providers?.[next.active_provider];
  const defaultTextSource =
    payload.default_text_model ??
    activePatch?.text_model ??
    (payload.active_provider ? next.providers[next.active_provider].text_model : next.default_text_model);
  next.default_text_model =
    payload.default_text_model !== undefined
      ? validateGlobalModel(next, "text", payload.default_text_model)
      : normalizeGlobalModel(next, "text", defaultTextSource, next.providers[next.active_provider].text_model);
  const activeProvider = modelProvider(next, next.default_text_model, "text");
  if (activeProvider) {
    next.active_provider = activeProvider;
  }
  next.default_vision_model =
    payload.default_vision_model !== undefined
      ? validateGlobalModel(next, "vision", payload.default_vision_model, enabledModels(next, "vision").length === 0)
      : normalizeGlobalModel(
          next,
          "vision",
          activePatch?.vision_model ?? next.default_vision_model,
          next.providers[next.active_provider].vision_model,
          enabledModels(next, "vision").length === 0
        );
  next.translation_model =
    payload.translation_model !== undefined
      ? validateGlobalModel(next, "text", payload.translation_model)
      : normalizeGlobalModel(next, "text", activePatch?.translation_model ?? next.translation_model, next.default_text_model);
  next.report_model =
    payload.report_model !== undefined
      ? validateGlobalModel(next, "text", payload.report_model)
      : normalizeGlobalModel(next, "text", activePatch?.report_model ?? next.report_model, next.default_text_model);
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
  const model = resolveTextModel(config);
  const provider = modelProvider(config, model, "text");
  const active = provider ? config.providers[provider] : null;
  if (!active?.base_url || !active.api_key) {
    return json({ ok: false, message: "AI 配置不完整" });
  }
  try {
    return json({ ok: true, message: await testAiConnection(config, model) });
  } catch (error) {
    return json({ ok: false, message: safeAiErrorMessage(error) });
  }
}

async function discoverModels(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = modelDiscoverySchema.parse(await parseJson<unknown>(request));
  const current = await getAiConfig(env);
  const providerConfig = current.providers[payload.provider];
  const baseUrl = payload.base_url !== undefined ? payload.base_url.trim() : providerConfig.base_url;
  const apiKey =
    payload.api_key === undefined
      ? providerConfig.api_key
      : payload.api_key === null
        ? ""
        : payload.api_key.trim() || providerConfig.api_key;
  if (!baseUrl || !apiKey) {
    return json({ ok: false, provider: payload.provider, models: [], message: "AI 配置不完整" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      return json({ ok: false, provider: payload.provider, models: [], message: `模型检测失败：HTTP ${response.status}` });
    }
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = uniqueModels((data.data || []).map((item) => (typeof item.id === "string" ? item.id : "")));
    if (!models.length) {
      return json({ ok: false, provider: payload.provider, models: [], message: "未检测到可用模型" });
    }
    return json({ ok: true, provider: payload.provider, models, message: `检测到 ${models.length} 个模型` });
  } catch (error) {
    return json({
      ok: false,
      provider: payload.provider,
      models: [],
      message: error instanceof Error && error.name === "AbortError" ? "模型检测超时" : "模型检测失败"
    });
  } finally {
    clearTimeout(timeout);
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
    route("POST", "/api/admin/ai-config/models", (request) => discoverModels(request, env)),
    route("GET", "/api/admin/token-usage", (request) => readTokenUsage(request, env))
  ];
}
