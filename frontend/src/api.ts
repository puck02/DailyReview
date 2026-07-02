export type User = {
  id: number;
  email: string;
  role: "admin" | "user";
};

export type ChatSession = {
  id: number;
  title: string;
  default_model: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  created_at: string;
  attachments: Attachment[];
};

export type EssaySession = {
  id: number;
  title: string;
  default_model: string;
  draft_text: string;
  has_topic_image: boolean;
  topic_attachment: Attachment | null;
  ocr_text: string;
  objective_description: string;
  created_at: string;
  updated_at: string;
};

export type EssayParagraphStage = "opening" | "development" | "transition" | "conclusion" | "unknown";

export type EssaySuggestion = {
  kind: "word" | "phrase" | "sentence" | "rewrite";
  text: string;
  reason: string;
  confidence: number;
  insert_mode?: "inline" | "replace";
};

export type EssaySuggestionRequest = {
  session_id: number;
  content: string;
  model?: string;
  prefix?: string;
  suffix?: string;
  cursor_index?: number;
  word_count?: number;
  paragraph_stage?: EssayParagraphStage;
};

export type Attachment = {
  id: number;
  mime_type: string;
  size: number;
  expires_at: string;
  url: string;
};

export type Invite = {
  code: string;
  is_used: boolean;
  expires_at: string | null;
  created_at: string;
};

export type TokenUsageSummary = {
  user_id: number;
  email: string;
  role: "admin" | "user";
  today_total_tokens: number;
  last_7d_total_tokens: number;
};

export type ReportItem = {
  id: number;
  report_type: "daily" | "weekly" | "monthly";
  period: string;
  stats: Record<string, unknown>;
  created_at: string;
};

export type ReportContent = ReportItem & {
  markdown: string;
};

export type ReportGenerationStatus = {
  report_type: ReportItem["report_type"];
  period: string;
  status: "running" | "success" | "failed" | "skipped";
  message: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type AiProviderName = "gpt" | "zhipu" | "deepseek";

export type AiModelSet = { text: string[]; vision: string[] };

export type AiProviderConfig = {
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

export type AiConfig = {
  active_provider: AiProviderName;
  default_text_model: string;
  default_vision_model: string;
  providers: Record<AiProviderName, AiProviderConfig>;
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

export type AiModels = {
  active_provider: AiProviderName;
  available_models: Record<AiProviderName, AiModelSet>;
  enabled_models: Record<AiProviderName, AiModelSet>;
  text_models: string[];
  vision_models: string[];
  text_model: string;
  vision_model: string;
  translation_model: string;
  report_model: string;
};

export type AiConfigPatch = {
  active_provider?: AiProviderName;
  default_text_model?: string;
  default_vision_model?: string;
  translation_model?: string;
  report_model?: string;
  providers: Partial<
    Record<
      AiProviderName,
      {
        base_url?: string;
        api_key?: string;
        text_model?: string;
        vision_model?: string;
        translation_model?: string;
        report_model?: string;
        enabled_text_models?: string[];
        enabled_vision_models?: string[];
      }
    >
  >;
};

export type AiModelDiscovery = {
  ok: boolean;
  provider: AiProviderName;
  models: string[];
  message: string;
};

export type AiConfigTest = {
  ok: boolean;
  message: string;
};

export type AppSettings = {
  daily_report_enabled: boolean;
  daily_report_time: string;
  weekly_report_time: string;
  weekly_report_day: string;
  word_cloud_enabled: boolean;
};

export type TranslationEntry = {
  id: number;
  source_text: string;
  source_kind: "chinese" | "english" | "word";
  phonetic: string | null;
  result_markdown: string;
  detail_status: "queued" | "processing" | "ready" | "failed";
  is_auto_detail: boolean;
  created_at: string;
};

export type TranslationPrompt = {
  system_prompt: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: init?.cache ?? "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: "请求失败" }));
    throw new Error(data.detail || "请求失败");
  }
  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<User>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<User>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  register: (email: string, password: string, inviteCode: string) =>
    request<User>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, invite_code: inviteCode })
    }),
  logout: () => request<{ status: string }>("/api/auth/logout", { method: "POST" }),
  createInvite: () =>
    request<Invite>("/api/invites", {
      method: "POST",
      body: JSON.stringify({ expires_days: 7 })
    }),
  invites: () => request<Invite[]>("/api/invites"),
  tokenUsage: () => request<TokenUsageSummary[]>("/api/admin/token-usage"),
  sessions: () => request<ChatSession[]>("/api/sessions"),
  createSession: (title: string, model: string) =>
    request<ChatSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title, model })
    }),
  deleteSession: (sessionId: number) =>
    request<{ status: string }>(`/api/sessions/${sessionId}`, {
      method: "DELETE"
    }),
  archiveSession: (sessionId: number, archived: boolean) =>
    request<ChatSession>(`/api/sessions/${sessionId}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived })
    }),
  messages: (sessionId: number) => request<Message[]>(`/api/sessions/${sessionId}/messages`),
  essaySessions: () => request<EssaySession[]>("/api/essay/sessions"),
  createEssaySession: (payload: { title?: string; model?: string }) =>
    request<EssaySession>("/api/essay/sessions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateEssaySession: (sessionId: number, payload: { title?: string; draft_text?: string; model?: string; clear_topic_image?: boolean }) =>
    request<EssaySession>(`/api/essay/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteEssaySession: (sessionId: number) =>
    request<{ status: string }>(`/api/essay/sessions/${sessionId}`, {
      method: "DELETE"
    }),
  essayImageContext: (sessionId: number, attachmentId: number) =>
    request<EssaySession>(`/api/essay/sessions/${sessionId}/image-context`, {
      method: "POST",
      body: JSON.stringify({ attachment_id: attachmentId })
    }),
  essaySuggest: (
    payload: EssaySuggestionRequest,
    init?: RequestInit
  ) =>
    request<{ suggestions: EssaySuggestion[] }>("/api/essay/suggest", {
      ...init,
      method: "POST",
      body: JSON.stringify(payload)
    }),
  upload: async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", file);
    let response: Response;
    try {
      response = await fetch("/api/attachments", {
        method: "POST",
        body: form,
        credentials: "include",
        cache: "no-store"
      });
    } catch (error) {
      throw new Error("图片上传失败，请检查网络后重试");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({ detail: "上传失败" }));
      throw new Error(data.detail || "上传失败");
    }
    return response.json().catch(() => {
      throw new Error("上传失败");
    });
  },
  reports: (reportType: ReportItem["report_type"], month: string) =>
    request<ReportItem[]>(`/api/reports?report_type=${reportType}&month=${month}`),
  reportGenerationStatuses: (reportType: ReportItem["report_type"], month: string) =>
    request<ReportGenerationStatus[]>(`/api/reports/generation-status?report_type=${reportType}&month=${month}`),
  report: (id: number) => request<ReportContent>(`/api/reports/${id}`),
  reportPdf: async (id: number): Promise<Blob> => {
    const response = await fetch(`/api/reports/${id}/pdf`, { credentials: "include", cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({ detail: "PDF 导出失败" }));
      throw new Error(data.detail || "PDF 导出失败");
    }
    return response.blob();
  },
  aiConfig: () => request<AiConfig>("/api/admin/ai-config"),
  aiModels: () => request<AiModels>("/api/ai-models"),
  updateAiConfig: (payload: AiConfigPatch) =>
    request<AiConfig>("/api/admin/ai-config", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  testAiConfig: (payload: AiConfigPatch) =>
    request<AiConfigTest>("/api/admin/ai-config/test", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  discoverAiModels: (payload: { provider: AiProviderName; base_url?: string; api_key?: string }) =>
    request<AiModelDiscovery>("/api/admin/ai-config/models", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  settings: () => request<AppSettings>("/api/settings"),
  updateSettings: (payload: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  translationPrompt: () => request<TranslationPrompt>("/api/translation/prompt"),
  updateTranslationPrompt: (systemPrompt: string) =>
    request<TranslationPrompt>("/api/translation/prompt", {
      method: "PUT",
      body: JSON.stringify({ system_prompt: systemPrompt })
    }),
  translationEntries: () => request<TranslationEntry[]>("/api/translation/entries"),
  clearTranslationEntries: () => request<{ status: string }>("/api/translation/entries", { method: "DELETE" }),
  translationDictionaryEntry: (text: string) =>
    request<TranslationEntry>("/api/translation/dictionary-entry", {
      method: "POST",
      body: JSON.stringify({ text })
    }),
  translate: (text: string) =>
    request<TranslationEntry>("/api/translation", {
      method: "POST",
      body: JSON.stringify({ text })
    })
};

export async function streamChat(
  payload: { session_id: number; content: string; model: string; attachment_ids: number[]; image_data_urls?: string[] },
  onToken: (token: string) => void,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  await streamChatEndpoint("/api/chat/stream", payload, onToken, options);
}

export async function regenerateChat(
  payload: { session_id: number; assistant_message_id: number; model: string; content?: string; attachment_ids?: number[] },
  onToken: (token: string) => void,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  await streamChatEndpoint("/api/chat/regenerate", payload, onToken, options);
}

async function streamChatEndpoint(
  path: string,
  payload: { session_id: number; content?: string; model: string; attachment_ids?: number[]; image_data_urls?: string[]; assistant_message_id?: number },
  onToken: (token: string) => void,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({ detail: "发送失败" }));
    throw new Error(data.detail || "发送失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      const token = line.replace(/^data:\s?/, "");
      if (token === "[DONE]") continue;
      try {
        const parsed = JSON.parse(token);
        onToken(typeof parsed === "string" ? parsed : token);
      } catch {
        onToken(token);
      }
    }
  }
}
