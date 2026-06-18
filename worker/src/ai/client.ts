import type { Env } from "../env";
import {
  candidateModelsForRequest,
  hasAnyConfiguredProvider,
  isProviderConfigured,
  modelProvider,
  resolveTextModel,
  resolveTranslationModel,
  resolveVisionModel,
  resolveReportModel,
  type AiConfig,
  type AiModelKind,
  type AiProviderConfig
} from "./providers";

export type { AiConfig, AiProviderConfig } from "./providers";

export type ChatMessage = {
  role: string;
  content: unknown;
};

export type ChatCompletionResult = {
  content: string;
  totalTokens: number | null;
  model: string;
};

export type ChatStreamEvent = {
  content: string;
  totalTokens?: number | null;
  model?: string;
};

type AiRequestOptions = {
  allowProviderFallback?: boolean;
};

function providerConfig(config: AiConfig, provider: keyof AiConfig["providers"]): AiProviderConfig {
  return config.providers[provider];
}

export function isAiConfigured(config: AiConfig, model?: string, kind: AiModelKind = "text"): boolean {
  if (!model) {
    return hasAnyConfiguredProvider(config);
  }
  const provider = modelProvider(config, model, kind);
  return Boolean(provider && isProviderConfigured(config, provider));
}

function chatCompletionsUrl(config: AiConfig, provider: keyof AiConfig["providers"]): string {
  return `${providerConfig(config, provider).base_url.replace(/\/+$/, "")}/chat/completions`;
}

function authHeaders(config: AiConfig, provider: keyof AiConfig["providers"]): HeadersInit {
  return {
    Authorization: `Bearer ${providerConfig(config, provider).api_key}`,
    "Content-Type": "application/json"
  };
}

function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
      ? message.content.some((part) => {
          if (!part || typeof part !== "object") return false;
          return (part as { type?: unknown }).type === "image_url";
        })
      : false
  );
}

function requestedProvider(config: AiConfig, model: string, hasImages: boolean): keyof AiConfig["providers"] | null {
  const normalized = model.trim();
  if (!normalized) return null;
  return modelProvider(config, normalized, hasImages ? "vision" : "text");
}

export function safeAiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "连接上游服务超时";
  }
  return "AI 服务测试失败";
}

export async function completeChat(
  messages: ChatMessage[],
  model: string,
  fallback: string,
  _env: Env,
  config: AiConfig
): Promise<string> {
  return (await completeChatWithUsage(messages, model, fallback, _env, config)).content;
}

export async function completeChatWithUsage(
  messages: ChatMessage[],
  model: string,
  fallback: string,
  _env: Env,
  config: AiConfig,
  options: AiRequestOptions = {}
): Promise<ChatCompletionResult> {
  const hasImages = messagesHaveImages(messages);
  if (!hasAnyConfiguredProvider(config)) {
    return { content: fallback, totalTokens: null, model };
  }
  const requested = requestedProvider(config, model, hasImages);
  if (requested && !isProviderConfigured(config, requested)) {
    return { content: fallback, totalTokens: null, model };
  }
  const candidates =
    requested && options.allowProviderFallback === false
      ? candidateModelsForRequest(config, model, hasImages).filter(
          (candidate) => modelProvider(config, candidate, hasImages ? "vision" : "text") === requested
        )
      : candidateModelsForRequest(config, model, hasImages);
  for (const candidate of candidates) {
    const provider = modelProvider(config, candidate, hasImages ? "vision" : "text");
    if (!provider || !isProviderConfigured(config, provider)) {
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(chatCompletionsUrl(config, provider), {
        method: "POST",
        headers: authHeaders(config, provider),
        body: JSON.stringify({ model: candidate, messages, stream: false }),
        signal: controller.signal
      });
      if (!response.ok) {
        continue;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number; totalTokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return {
          content,
          totalTokens: data.usage?.total_tokens ?? data.usage?.totalTokens ?? null,
          model: candidate
        };
      }
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { content: fallback, totalTokens: null, model };
}

async function streamResponse(
  messages: ChatMessage[],
  model: string,
  config: AiConfig,
  provider: keyof AiConfig["providers"],
  includeUsage: boolean
): Promise<Response> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (includeUsage) {
    body.stream_options = { include_usage: true };
  }
  return await fetch(chatCompletionsUrl(config, provider), {
    method: "POST",
    headers: authHeaders(config, provider),
    body: JSON.stringify(body)
  });
}

export async function* streamChatCompletion(
  messages: ChatMessage[],
  model: string,
  _env: Env,
  config: AiConfig
): AsyncIterable<string> {
  for await (const event of streamChatCompletionWithUsage(messages, model, _env, config)) {
    if (event.content) {
      yield event.content;
    }
  }
}

export async function* streamChatCompletionWithUsage(
  messages: ChatMessage[],
  model: string,
  _env: Env,
  config: AiConfig,
  options: AiRequestOptions = {}
): AsyncIterable<ChatStreamEvent> {
  const hasImages = messagesHaveImages(messages);
  if (!hasAnyConfiguredProvider(config)) {
    yield { content: "这是一个本地测试回答。生产环境会使用配置的 AI API。", totalTokens: null, model };
    return;
  }
  const requested = requestedProvider(config, model, hasImages);
  if (requested && !isProviderConfigured(config, requested)) {
    throw new Error(`AI provider ${requested} is not configured`);
  }
  let selectedModel = model;
  let response: Response | null = null;
  const candidates =
    requested && options.allowProviderFallback === false
      ? candidateModelsForRequest(config, model, hasImages).filter(
          (candidate) => modelProvider(config, candidate, hasImages ? "vision" : "text") === requested
        )
      : candidateModelsForRequest(config, model, hasImages);
  for (const candidate of candidates) {
    const provider = modelProvider(config, candidate, hasImages ? "vision" : "text");
    if (!provider || !isProviderConfigured(config, provider)) {
      continue;
    }
    response = await streamResponse(messages, candidate, config, provider, true);
    if (response.status === 400) {
      response = await streamResponse(messages, candidate, config, provider, false);
    }
    if (response.ok && response.body) {
      selectedModel = candidate;
      break;
    }
    response = null;
  }
  if (!response || !response.ok || !response.body) {
    throw new Error("AI HTTP unavailable");
  }
  yield { content: "", model: selectedModel };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { total_tokens?: number; totalTokens?: number } | null;
      };
      const totalTokens = chunk.usage?.total_tokens ?? chunk.usage?.totalTokens;
      if (typeof totalTokens === "number") {
        yield { content: "", totalTokens };
      }
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) yield { content };
    }
  }
}

export async function testAiConnection(config: AiConfig, model: string): Promise<string> {
  const provider = modelProvider(config, model, "text");
  if (!provider || !isProviderConfigured(config, provider)) {
    throw new Error("AI config incomplete");
  }
  const response = await fetch(chatCompletionsUrl(config, provider), {
    method: "POST",
    headers: authHeaders(config, provider),
    body: JSON.stringify({ model, messages: [{ role: "user", content: "请只回复 OK" }], stream: false })
  });
  if (!response.ok) {
    throw new Error(`AI HTTP ${response.status}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  if (!data.choices?.[0]?.message?.content) {
    throw new Error("Missing assistant content");
  }
  return "AI 连接正常";
}

export function aiTextModel(config: AiConfig): string {
  return resolveTextModel(config);
}

export function aiTranslationModel(config: AiConfig): string {
  return resolveTranslationModel(config);
}

export function aiReportModel(config: AiConfig): string {
  return resolveReportModel(config);
}

export function aiVisionModel(config: AiConfig): string {
  return resolveVisionModel(config);
}
