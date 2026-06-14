export type AiProviderName = "gpt" | "zhipu";

export const AI_PROVIDER_NAMES = ["gpt", "zhipu"] as const;
export const GPT_TEXT_MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
export const GPT_VISION_MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
export const ZHIPU_TEXT_MODELS = ["glm-5"] as const;
export const ZHIPU_VISION_MODELS = ["glm-4.6v-flash", "glm-4.6v"] as const;

export type AiProviderConfig = {
  base_url: string;
  api_key: string;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
};

export type AiConfig = {
  active_provider: AiProviderName;
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
};

export type AiConfigResponse = {
  active_provider: AiProviderName;
  providers: Record<AiProviderName, AiProviderConfigResponse>;
  available_models: Record<AiProviderName, { text: string[]; vision: string[] }>;
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string | null;
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
};

export function normalizeProviderName(value: string | null | undefined, fallback: AiProviderName = "gpt"): AiProviderName {
  if (value === "gpt" || value === "zhipu") {
    return value;
  }
  return fallback;
}

export function providerModels(provider: AiProviderName): { text: readonly string[]; vision: readonly string[] } {
  return provider === "zhipu"
    ? { text: ZHIPU_TEXT_MODELS, vision: ZHIPU_VISION_MODELS }
    : { text: GPT_TEXT_MODELS, vision: GPT_VISION_MODELS };
}

export function isAllowedTextModel(provider: AiProviderName, model: string): boolean {
  return providerModels(provider).text.includes(model);
}

export function isAllowedVisionModel(provider: AiProviderName, model: string): boolean {
  return providerModels(provider).vision.includes(model);
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
    report_model: config.report_model
  };
}

export function configResponse(config: AiConfig): AiConfigResponse {
  const active = config.providers[config.active_provider];
  return {
    active_provider: config.active_provider,
    providers: {
      gpt: providerResponse(config.providers.gpt),
      zhipu: providerResponse(config.providers.zhipu)
    },
    available_models: {
      gpt: {
        text: [...GPT_TEXT_MODELS],
        vision: [...GPT_VISION_MODELS]
      },
      zhipu: {
        text: [...ZHIPU_TEXT_MODELS],
        vision: [...ZHIPU_VISION_MODELS]
      }
    },
    base_url: active.base_url,
    has_api_key: Boolean(active.api_key),
    api_key_preview: maskApiKey(active.api_key),
    text_model: active.text_model,
    vision_model: active.vision_model,
    translation_model: active.translation_model,
    report_model: active.report_model
  };
}

function fallbackTextModel(provider: AiProviderName, fallback: string): string {
  const models = providerModels(provider).text;
  return models.includes(fallback) ? fallback : models[0] || fallback;
}

export function resolveTextModel(config: AiConfig): string {
  const provider = config.active_provider;
  const textModel = config.providers[provider].text_model.trim();
  if (isAllowedTextModel(provider, textModel)) {
    return textModel;
  }
  return fallbackTextModel(provider, textModel);
}

export function resolveTranslationModel(config: AiConfig): string {
  const provider = config.active_provider;
  const model = config.providers[provider].translation_model.trim();
  if (isAllowedTextModel(provider, model)) {
    return model;
  }
  return resolveTextModel(config);
}

export function resolveReportModel(config: AiConfig): string {
  const provider = config.active_provider;
  const model = config.providers[provider].report_model.trim();
  if (isAllowedTextModel(provider, model)) {
    return model;
  }
  return resolveTextModel(config);
}

export function resolveVisionModel(config: AiConfig): string {
  const provider = config.active_provider;
  const visionModel = config.providers[provider].vision_model.trim();
  if (isAllowedVisionModel(provider, visionModel)) {
    return visionModel;
  }
  return providerModels(provider).vision[0] || visionModel;
}

export function resolveChatModel(config: AiConfig, requestedModel: string | null | undefined, hasImages: boolean): string {
  const provider = config.active_provider;
  if (hasImages) {
    return resolveVisionModel(config);
  }
  const candidate = (requestedModel || "").trim();
  if (candidate && isAllowedTextModel(provider, candidate)) {
    return candidate;
  }
  return resolveTextModel(config);
}
