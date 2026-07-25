export type AiProviderName = "gpt" | "zhipu" | "deepseek" | "grok";
export type AiModelKind = "text" | "vision";

export const AI_PROVIDER_NAMES = ["gpt", "zhipu", "deepseek", "grok"] as const;
export const GPT_TEXT_MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
export const GPT_VISION_MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
export const ZHIPU_TEXT_MODELS = ["glm-5"] as const;
export const ZHIPU_VISION_MODELS = ["glm-4.6v"] as const;
export const DEEPSEEK_TEXT_MODELS = ["deepseek-chat", "deepseek-reasoner"] as const;
export const DEEPSEEK_VISION_MODELS = [] as const;
export const GROK_TEXT_MODELS = ["grok-4", "grok-4-fast-reasoning"] as const;
export const GROK_VISION_MODELS = [] as const;

export type AiModelSet = { text: string[]; vision: string[] };

export type AiProviderConfig = {
  base_url: string;
  api_key: string;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
  enabled_text_models: string[];
  enabled_vision_models: string[];
};

export type AiConfig = {
  active_provider: AiProviderName;
  default_text_model: string;
  default_vision_model: string;
  translation_model: string;
  report_model: string;
  providers: Record<AiProviderName, AiProviderConfig>;
};

export type AiProviderConfigResponse = {
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string | null;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
  enabled_text_models: string[];
  enabled_vision_models: string[];
};

export type AiConfigResponse = {
  active_provider: AiProviderName;
  default_text_model: string;
  default_vision_model: string;
  providers: Record<AiProviderName, AiProviderConfigResponse>;
  available_models: Record<AiProviderName, AiModelSet>;
  enabled_models: Record<AiProviderName, AiModelSet>;
  text_models: string[];
  vision_models: string[];
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string | null;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
};

export function normalizeProviderName(value: string | null | undefined, fallback: AiProviderName = "gpt"): AiProviderName {
  if (value === "gpt" || value === "zhipu" || value === "deepseek" || value === "grok") {
    return value;
  }
  return fallback;
}

export function providerModels(provider: AiProviderName): { text: readonly string[]; vision: readonly string[] } {
  if (provider === "zhipu") {
    return { text: ZHIPU_TEXT_MODELS, vision: ZHIPU_VISION_MODELS };
  }
  if (provider === "deepseek") {
    return { text: DEEPSEEK_TEXT_MODELS, vision: DEEPSEEK_VISION_MODELS };
  }
  if (provider === "grok") {
    return { text: GROK_TEXT_MODELS, vision: GROK_VISION_MODELS };
  }
  return { text: GPT_TEXT_MODELS, vision: GPT_VISION_MODELS };
}

function normalizeModel(value: string): string {
  return value.trim();
}

export function uniqueModels(models: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const model = normalizeModel(item);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    unique.push(model);
  }
  return unique;
}

export function defaultEnabledModels(provider: AiProviderName): AiModelSet {
  const models = providerModels(provider);
  return {
    text: uniqueModels([...models.text]),
    vision: uniqueModels([...models.vision])
  };
}

export function isKnownTextModel(provider: AiProviderName, model: string): boolean {
  return providerModels(provider).text.includes(model);
}

export function isKnownVisionModel(provider: AiProviderName, model: string): boolean {
  return providerModels(provider).vision.includes(model);
}

function providerEnabledModels(config: AiConfig, provider: AiProviderName, kind: AiModelKind): string[] {
  const providerConfig = config.providers[provider];
  return kind === "vision" ? providerConfig.enabled_vision_models : providerConfig.enabled_text_models;
}

export function enabledModels(config: AiConfig, kind: AiModelKind): string[] {
  const models: string[] = [];
  for (const provider of AI_PROVIDER_NAMES) {
    models.push(...providerEnabledModels(config, provider, kind));
  }
  return uniqueModels(models);
}

export function modelProvider(config: AiConfig, model: string, kind: AiModelKind): AiProviderName | null {
  const candidate = normalizeModel(model);
  if (!candidate) return null;
  const preferred = normalizeProviderName(config.active_provider, "gpt");
  if (providerEnabledModels(config, preferred, kind).includes(candidate)) {
    return preferred;
  }
  for (const provider of AI_PROVIDER_NAMES) {
    if (provider === preferred) continue;
    if (providerEnabledModels(config, provider, kind).includes(candidate)) {
      return provider;
    }
  }
  return null;
}

export function providerForAnyModel(config: AiConfig, model: string): AiProviderName | null {
  return modelProvider(config, model, "text") || modelProvider(config, model, "vision");
}

export function isProviderConfigured(config: AiConfig, provider: AiProviderName): boolean {
  const providerConfig = config.providers[provider];
  return Boolean(providerConfig.base_url && providerConfig.api_key && providerConfig.api_key !== "change-me");
}

export function isAiModelConfigured(config: AiConfig, model: string, kind: AiModelKind): boolean {
  const provider = modelProvider(config, model, kind);
  return Boolean(provider && isProviderConfigured(config, provider));
}

export function hasAnyConfiguredProvider(config: AiConfig): boolean {
  return AI_PROVIDER_NAMES.some((provider) => isProviderConfigured(config, provider));
}

export function maskApiKey(apiKey: string): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}****${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`;
}

export function providerResponse(config: AiProviderConfig): AiProviderConfigResponse {
  return {
    base_url: config.base_url,
    has_api_key: Boolean(config.api_key),
    api_key_preview: maskApiKey(config.api_key),
    text_model: config.text_model,
    vision_model: config.vision_model,
    translation_model: config.translation_model,
    report_model: config.report_model,
    enabled_text_models: [...config.enabled_text_models],
    enabled_vision_models: [...config.enabled_vision_models]
  };
}

export function enabledModelRecord(config: AiConfig): Record<AiProviderName, AiModelSet> {
  return {
    gpt: {
      text: [...config.providers.gpt.enabled_text_models],
      vision: [...config.providers.gpt.enabled_vision_models]
    },
    zhipu: {
      text: [...config.providers.zhipu.enabled_text_models],
      vision: [...config.providers.zhipu.enabled_vision_models]
    },
    deepseek: {
      text: [...config.providers.deepseek.enabled_text_models],
      vision: [...config.providers.deepseek.enabled_vision_models]
    },
    grok: {
      text: [...config.providers.grok.enabled_text_models],
      vision: [...config.providers.grok.enabled_vision_models]
    }
  };
}

export function availableModelRecord(): Record<AiProviderName, AiModelSet> {
  return {
    gpt: defaultEnabledModels("gpt"),
    zhipu: defaultEnabledModels("zhipu"),
    deepseek: defaultEnabledModels("deepseek"),
    grok: defaultEnabledModels("grok")
  };
}

export function configResponse(config: AiConfig): AiConfigResponse {
  const active = config.providers[config.active_provider];
  return {
    active_provider: config.active_provider,
    default_text_model: config.default_text_model,
    default_vision_model: config.default_vision_model,
    providers: {
      gpt: providerResponse(config.providers.gpt),
      zhipu: providerResponse(config.providers.zhipu),
      deepseek: providerResponse(config.providers.deepseek),
      grok: providerResponse(config.providers.grok)
    },
    available_models: availableModelRecord(),
    enabled_models: enabledModelRecord(config),
    text_models: enabledModels(config, "text"),
    vision_models: enabledModels(config, "vision"),
    base_url: active.base_url,
    has_api_key: Boolean(active.api_key),
    api_key_preview: maskApiKey(active.api_key),
    text_model: resolveTextModel(config),
    vision_model: resolveVisionModel(config),
    translation_model: resolveTranslationModel(config),
    report_model: resolveReportModel(config)
  };
}

function firstEnabledProviderModel(config: AiConfig, provider: AiProviderName, kind: AiModelKind): string {
  return providerEnabledModels(config, provider, kind)[0] || providerModels(provider)[kind][0] || "";
}

function fallbackModel(config: AiConfig, kind: AiModelKind, fallback: string): string {
  const configured = enabledModels(config, kind);
  if (configured.includes(fallback)) {
    return fallback;
  }
  const activeFallback = firstEnabledProviderModel(config, config.active_provider, kind);
  return activeFallback || configured[0] || fallback;
}

export function resolveTextModel(config: AiConfig): string {
  const candidate = normalizeModel(config.default_text_model || config.providers[config.active_provider].text_model);
  if (candidate && modelProvider(config, candidate, "text")) {
    return candidate;
  }
  return fallbackModel(config, "text", candidate);
}

export function resolveTranslationModel(config: AiConfig): string {
  const candidate = normalizeModel(config.translation_model || config.default_text_model);
  if (candidate && modelProvider(config, candidate, "text")) {
    return candidate;
  }
  return resolveTextModel(config);
}

export function resolveReportModel(config: AiConfig): string {
  const candidate = normalizeModel(config.report_model || config.default_text_model);
  if (candidate && modelProvider(config, candidate, "text")) {
    return candidate;
  }
  return resolveTextModel(config);
}

export function resolveVisionModel(config: AiConfig): string {
  const candidate = normalizeModel(config.default_vision_model || config.providers[config.active_provider].vision_model);
  if (candidate && modelProvider(config, candidate, "vision")) {
    return candidate;
  }
  return fallbackModel(config, "vision", candidate || resolveTextModel(config));
}

export function resolveChatModel(config: AiConfig, requestedModel: string | null | undefined, hasImages: boolean): string {
  if (hasImages) {
    return resolveVisionModel(config);
  }
  const candidate = normalizeModel(requestedModel || "");
  if (candidate && modelProvider(config, candidate, "text")) {
    return candidate;
  }
  return resolveTextModel(config);
}

export function candidateModelsForRequest(config: AiConfig, requestedModel: string, hasImages: boolean): string[] {
  const kind: AiModelKind = hasImages ? "vision" : "text";
  const primary = hasImages ? resolveVisionModel(config) : requestedModel || resolveTextModel(config);
  const models = enabledModels(config, kind);
  return uniqueModels([primary, ...models]).filter((model) => Boolean(modelProvider(config, model, kind)));
}
