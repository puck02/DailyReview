import { ACTIVE_PROVIDER_KEY, DEFAULT_TEXT_MODEL_KEY, getAiConfig, setAiSetting } from "../admin/routes";
import type { Env } from "../env";
import { AI_PROVIDER_NAMES, resolveTextModel, type AiConfig, type AiProviderName } from "./providers";

function providerChatCompletionsUrl(config: AiConfig, provider: AiProviderName): string {
  return `${config.providers[provider].base_url.replace(/\/+$/, "")}/chat/completions`;
}

function providerConfig(config: AiConfig, provider: AiProviderName) {
  return config.providers[provider];
}

function configForProvider(config: AiConfig, provider: AiProviderName): AiConfig {
  return {
    ...config,
    active_provider: provider,
    default_text_model: config.providers[provider].text_model
  };
}

async function probeProvider(config: AiConfig, provider: AiProviderName): Promise<boolean> {
  const current = providerConfig(config, provider);
  if (!current.base_url || !current.api_key || current.api_key === "change-me") {
    return false;
  }
  const scoped = configForProvider(config, provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(providerChatCompletionsUrl(config, provider), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${current.api_key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: current.text_model || resolveTextModel(scoped),
        messages: [{ role: "user", content: "请只回复 OK" }],
        stream: false
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      return false;
    }
    const data = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    return Boolean(data?.choices?.[0]?.message?.content);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkAndSwitchAiProvider(env: Env): Promise<AiProviderName> {
  const config = await getAiConfig(env);
  if (await probeProvider(config, config.active_provider)) {
    return config.active_provider;
  }
  for (const provider of AI_PROVIDER_NAMES) {
    if (provider === config.active_provider) continue;
    if (await probeProvider(config, provider)) {
      await setAiSetting(env, ACTIVE_PROVIDER_KEY, provider);
      await setAiSetting(env, DEFAULT_TEXT_MODEL_KEY, config.providers[provider].text_model);
      console.warn(`AI provider switched to ${provider} after health check`);
      return provider;
    }
  }
  return config.active_provider;
}
