import type { Env } from "../env";

export type AiConfig = {
  base_url: string;
  api_key: string;
  report_model: string;
};

export type ChatMessage = {
  role: string;
  content: unknown;
};

export function isAiConfigured(config: AiConfig): boolean {
  return Boolean(config.base_url && config.api_key && config.api_key !== "change-me");
}

function chatCompletionsUrl(config: AiConfig): string {
  return `${config.base_url.replace(/\/+$/, "")}/chat/completions`;
}

function authHeaders(config: AiConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.api_key}`,
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
  if (!isAiConfigured(config)) {
    return fallback;
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
      return fallback;
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export async function* streamChatCompletion(
  messages: ChatMessage[],
  model: string,
  _env: Env,
  config: AiConfig
): AsyncIterable<string> {
  if (!isAiConfigured(config)) {
    yield "这是一个本地测试回答。生产环境会使用配置的 AI API。";
    return;
  }
  const response = await fetch(chatCompletionsUrl(config), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ model, messages, stream: true })
  });
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
      const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) yield content;
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
