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

export type AiConfig = {
  base_url: string;
  has_api_key: boolean;
  api_key_preview: string | null;
};

export type AiConfigTest = {
  ok: boolean;
  message: string;
};

export type AppSettings = {
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

export const pdfDowngradeMessage = "Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
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
  upload: async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", file);
    let response: Response;
    try {
      response = await fetch("/api/attachments", {
        method: "POST",
        body: form,
        credentials: "same-origin"
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
  report: (id: number) => request<ReportContent>(`/api/reports/${id}`),
  reportPdf: async (id: number): Promise<Blob> => {
    const response = await fetch(`/api/reports/${id}/pdf`, { credentials: "same-origin" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({ detail: response.status === 501 ? pdfDowngradeMessage : "PDF 导出失败" }));
      throw new Error(data.detail || "PDF 导出失败");
    }
    return response.blob();
  },
  aiConfig: () => request<AiConfig>("/api/admin/ai-config"),
  updateAiConfig: (baseUrl: string, apiKey: string) =>
    request<AiConfig>("/api/admin/ai-config", {
      method: "PUT",
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey })
    }),
  testAiConfig: (baseUrl: string, apiKey: string) =>
    request<AiConfigTest>("/api/admin/ai-config/test", {
      method: "POST",
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey })
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
  payload: { session_id: number; content: string; model: string; attachment_ids: number[] },
  onToken: (token: string) => void
): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
