import type { Env } from "../env";
import {
  resolveTextModel,
  resolveTranslationModel,
  resolveVisionModel,
  resolveReportModel,
  type AiConfig,
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
};

export type ChatStreamEvent = {
  content: string;
  totalTokens?: number | null;
};

function activeProviderConfig(config: AiConfig): AiProviderConfig {
  return config.providers[config.active_provider];
}

export function isAiConfigured(config: AiConfig): boolean {
  const provider = activeProviderConfig(config);
  return Boolean(provider.base_url && provider.api_key && provider.api_key !== "change-me");
}

function chatCompletionsUrl(config: AiConfig): string {
  return `${activeProviderConfig(config).base_url.replace(/\/+$/, "")}/chat/completions`;
}

function authHeaders(config: AiConfig): HeadersInit {
  return {
    Authorization: `Bearer ${activeProviderConfig(config).api_key}`,
    "Content-Type": "application/json"
  };
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
  config: AiConfig
): Promise<ChatCompletionResult> {
  if (!isAiConfigured(config)) {
    return { content: fallback, totalTokens: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(chatCompletionsUrl(config), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal
    });
    if (!response.ok) {
      return { content: fallback, totalTokens: null };
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; totalTokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content || fallback,
      totalTokens: data.usage?.total_tokens ?? data.usage?.totalTokens ?? null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function streamResponse(messages: ChatMessage[], model: string, config: AiConfig, includeUsage: boolean): Promise<Response> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (includeUsage) {
    body.stream_options = { include_usage: true };
  }
  return await fetch(chatCompletionsUrl(config), {
    method: "POST",
    headers: authHeaders(config),
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
  config: AiConfig
): AsyncIterable<ChatStreamEvent> {
  if (!isAiConfigured(config)) {
    yield { content: "这是一个本地测试回答。生产环境会使用配置的 AI API。", totalTokens: null };
    return;
  }
  let response = await streamResponse(messages, model, config, true);
  if (response.status === 400) {
    response = await streamResponse(messages, model, config, false);
  }
  if (!response.ok || !response.body) {
    throw new Error(`AI HTTP ${response.status}`);
  }
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
  const response = await fetch(chatCompletionsUrl(config), {
    method: "POST",
    headers: authHeaders(config),
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
