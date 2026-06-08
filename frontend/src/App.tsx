import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  CalendarDays,
  ImagePlus,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  MessageSquareText,
  Plus,
  Send,
  FileText,
  Trash2,
  X
} from "lucide-react";
import {
  api,
  AiConfig,
  Attachment,
  ChatSession,
  Invite,
  Message,
  ReportContent,
  ReportItem,
  streamChat,
  User
} from "./api";
import { removeAttachmentPreview } from "./attachmentPreviews";
import { firstClipboardImage } from "./clipboard";
import { normalizeMarkdownMath } from "./markdown";
import appIconUrl from "./assets/app-icon.svg?url";
import "katex/dist/katex.min.css";

type View = "chat" | "reports" | "admin";
type AuthMode = "login" | "register";
type PendingAttachment = Attachment & { previewUrl: string; name: string };

const defaultModel = "gpt-5.4-mini";
const complexModel = "5.5";
const openingLines = [
  "准备好了，随时开始",
  "有什么想学的，直接开始",
  "把问题丢给我，我们一起拆开看",
  "今天想推进哪一块？",
  "从一个问题开始就行"
];

function randomOpeningLine() {
  return openingLines[Math.floor(Math.random() * openingLines.length)];
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function monthValue() {
  return new Date().toISOString().slice(0, 7);
}

function safeMarkdownUrl(href: string) {
  try {
    const url = new URL(href, window.location.origin);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return href;
  } catch {
    return "";
  }
  return "";
}

const markdownComponents: Components = {
  a({ href = "", children }) {
    const safeHref = safeMarkdownUrl(href);
    if (!safeHref) return <>{children}</>;
    return (
      <a href={safeHref} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  code({ className, children, node: _node, ...props }) {
    const isMath = className?.includes("language-math");
    const isInlineMath = className?.includes("math-inline");
    return (
      <code
        className={
          isMath
            ? isInlineMath
              ? "markdown-math-inline"
              : "markdown-math-block"
            : className
              ? `markdown-inline-code ${className}`
              : "markdown-inline-code"
        }
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="markdown-code">{children}</pre>;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table className="markdown-table">{children}</table>
      </div>
    );
  },
  ul({ children }) {
    return <ul className="markdown-list">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="markdown-list">{children}</ol>;
  }
};

function MarkdownRenderer({ markdown, className }: { markdown: string; className: string }) {
  const normalizedMarkdown = normalizeMarkdownMath(markdown);
  return (
    <div className={className}>
      <ReactMarkdown
        key={normalizedMarkdown}
        components={markdownComponents}
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath]}
        skipHtml
        urlTransform={(url) => safeMarkdownUrl(url)}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  return <MarkdownRenderer markdown={markdown} className="markdown-preview" />;
}

function MessageMarkdown({ markdown }: { markdown: string }) {
  return <MarkdownRenderer markdown={markdown} className="message-markdown" />;
}

function AppIcon({ size = 22 }: { size?: number }) {
  return <img className="app-icon" src={appIconUrl} width={size} height={size} alt="" />;
}

function ChatGptAvatar() {
  return (
    <div className="message-avatar ai-avatar" aria-label="AI">
      <img src={appIconUrl} alt="" />
    </div>
  );
}

function AuthScreen({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user =
        mode === "login" ? await api.login(email, password) : await api.register(email, password, inviteCode);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <AppIcon />
          <span>DailyReview</span>
        </div>
        <h1>AI 学习工作台</h1>
        <p>用问答推进学习，用日报沉淀复盘。</p>
        <form onSubmit={submit} className="auth-form">
          <label>
            邮箱
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          <label>
            密码
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
          </label>
          {mode === "register" && (
            <label>
              邀请码
              <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required />
            </label>
          )}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={busy}>
            {busy ? "处理中..." : mode === "login" ? "登录" : "注册"}
          </button>
        </form>
        <button className="text-button" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "使用邀请码注册" : "已有账号，返回登录"}
        </button>
      </section>
    </main>
  );
}

function ChatView() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<ChatSession | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [error, setError] = useState("");
  const [openingLine, setOpeningLine] = useState(randomOpeningLine);

  async function refreshSessions() {
    const items = await api.sessions();
    setSessions(items);
    if (!active && items[0]) {
      setActive(items[0]);
    }
  }

  useEffect(() => {
    refreshSessions().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!active) {
      setMessages([]);
      return;
    }
    api.messages(active.id).then(setMessages).catch((err) => setError(err.message));
  }, [active?.id]);

  useEffect(() => {
    setOpeningLine(randomOpeningLine());
  }, [active?.id]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 88)}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    };
  }, []);

  useEffect(() => {
    function handleDocumentPaste(event: globalThis.ClipboardEvent) {
      const file = firstClipboardImage(event.clipboardData);
      if (!file) return;

      event.preventDefault();
      uploadFile(file).catch((err) => setError(err.message));
    }

    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, []);

  async function newSession() {
    const created = await api.createSession("新会话", model);
    setSessions([created, ...sessions]);
    setActive(created);
    setMessages([]);
    setOpeningLine(randomOpeningLine());
    if (isMobileViewport()) setSidebarOpen(false);
  }

  function selectSession(session: ChatSession) {
    setActive(session);
    if (isMobileViewport()) setSidebarOpen(false);
  }

  async function deleteSession(session: ChatSession) {
    if (!window.confirm(`删除会话「${session.title}」？`)) return;
    try {
      setError("");
      await api.deleteSession(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (active?.id === session.id) {
        const nextSession = remaining[0] || null;
        setActive(nextSession);
        if (!nextSession) {
          setMessages([]);
          setOpeningLine(randomOpeningLine());
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function uploadFile(file: File) {
    setUploadingCount((current) => current + 1);
    try {
      const uploaded = await api.upload(file);
      setError("");
      setAttachments((current) => [
        ...current,
        {
          ...uploaded,
          previewUrl: URL.createObjectURL(file),
          name: file.name || "图片"
        }
      ]);
    } finally {
      setUploadingCount((current) => Math.max(0, current - 1));
    }
  }

  function removeAttachment(id: number) {
    setAttachments((current) => {
      const result = removeAttachmentPreview(current, id);
      if (result.removed) URL.revokeObjectURL(result.removed.previewUrl);
      return result.remaining;
    });
  }

  function clearAttachments() {
    setAttachments((current) => {
      current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      return [];
    });
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) uploadFile(file).catch((err) => setError(err.message));
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || busy) return;
    if (uploadingCount > 0) {
      setError("图片上传中，请稍等");
      return;
    }
    let session = active;
    if (!session) {
      session = await api.createSession(content.slice(0, 24), model);
      setActive(session);
      setSessions([session, ...sessions]);
    }
    const pendingUser: Message = {
      id: Date.now(),
      role: "user",
      content,
      model,
      created_at: new Date().toISOString(),
      attachments
    };
    const assistant: Message = {
      id: Date.now() + 1,
      role: "assistant",
      content: "",
      model,
      created_at: new Date().toISOString(),
      attachments: []
    };
    setInput("");
    clearAttachments();
    setMessages((current) => [...current, pendingUser, assistant]);
    setBusy(true);
    setError("");
    try {
      await streamChat(
        { session_id: session.id, content, model, attachment_ids: attachments.map((item) => item.id) },
        (token) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistant.id ? { ...message, content: message.content + token } : message
            )
          );
        }
      );
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  const isEmptyChat = messages.length === 0;
  const isUploading = uploadingCount > 0;
  const composer = (
    <footer className={`composer ${isEmptyChat ? "composer-floating" : ""}`}>
      {attachments.length > 0 && (
        <div className="attachment-grid" aria-label="已附加图片">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="attachment-preview">
              <img src={attachment.previewUrl} alt={attachment.name} />
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(attachment.id)}
                aria-label="删除图片"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {isUploading && <div className="upload-status">图片上传中...</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="composer-row">
        <label className={`icon-button ${isUploading ? "disabled" : ""}`} title="上传图片" aria-disabled={isUploading}>
          <ImagePlus size={18} />
          <input type="file" accept="image/*" hidden onChange={handleFileSelect} disabled={isUploading} />
        </label>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="输入问题，或直接粘贴图片..."
          rows={1}
        />
        <button className="send-button" onClick={sendMessage} disabled={busy || isUploading}>
          <Send size={18} />
        </button>
      </div>
    </footer>
  );

  return (
    <div className={sidebarOpen ? "workspace" : "workspace sidebar-collapsed"}>
      <aside className="sessions-pane">
        {sidebarOpen && (
          <>
            <button className="new-session" onClick={newSession}>
              <Plus size={16} />
              新会话
            </button>
            <p className="session-retention-note">最近 7 天会话会保留，报告长期保存。</p>
            <div className="session-list">
              {sessions.map((session) => (
                <div key={session.id} className={active?.id === session.id ? "session-row active" : "session-row"}>
                  <button className="session-item" onClick={() => selectSession(session)}>
                    <MessageSquareText size={15} />
                    <span>{session.title}</span>
                  </button>
                  <button
                    type="button"
                    className="delete-session"
                    onClick={() => deleteSession(session)}
                    aria-label={`删除会话 ${session.title}`}
                    title="删除会话"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
      <section className="chat-pane">
        <header className="pane-header">
          <div className="pane-title-group">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((current) => !current)}
              aria-label={sidebarOpen ? "收起会话历史" : "展开会话历史"}
              title={sidebarOpen ? "收起会话历史" : "展开会话历史"}
            >
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            <div>
              <h2>{active?.title || "新会话"}</h2>
            </div>
          </div>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value={defaultModel}>{defaultModel}</option>
            <option value={complexModel}>{complexModel}</option>
          </select>
        </header>
        <div className={isEmptyChat ? "messages empty-chat" : "messages"}>
          {isEmptyChat ? (
            <div className="empty-chat-content">
              <h1 className="empty-chat-greeting">{openingLine}</h1>
              {composer}
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" && <ChatGptAvatar />}
                <div className="message-content">
                  {message.attachments.length > 0 && (
                    <div className="message-attachments" aria-label="消息图片">
                      {message.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          className="message-attachment-thumb"
                          href={attachment.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img src={attachment.url} alt="消息图片" />
                        </a>
                      ))}
                    </div>
                  )}
                  <MessageMarkdown markdown={message.content} />
                </div>
              </div>
            ))
          )}
        </div>
        {!isEmptyChat && composer}
      </section>
    </div>
  );
}

function ReportsView() {
  const [month, setMonth] = useState(monthValue());
  const [type, setType] = useState<ReportItem["report_type"]>("daily");
  const [items, setItems] = useState<ReportItem[]>([]);
  const [active, setActive] = useState<ReportContent | null>(null);

  useEffect(() => {
    api.reports(type, month).then((reports) => {
      setItems(reports);
      if (reports[0]) api.report(reports[0].id).then(setActive);
      else setActive(null);
    });
  }, [month, type]);

  const totalMessages = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.stats.message_count || 0), 0),
    [items]
  );

  return (
    <div className="report-layout">
      <section className="report-sidebar">
        <div className="filters">
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          <select value={type} onChange={(event) => setType(event.target.value as ReportItem["report_type"])}>
            <option value="daily">日报</option>
            <option value="weekly">周报</option>
            <option value="monthly">月报</option>
          </select>
        </div>
        <div className="stats-strip">
          <span>{items.length} 份报告</span>
          <span>{totalMessages} 条问答</span>
        </div>
        {items.map((item) => (
          <button key={item.id} className="report-item" onClick={() => api.report(item.id).then(setActive)}>
            <FileText size={15} />
            <span>{item.period}</span>
          </button>
        ))}
      </section>
      <section className="report-content">
        {active ? <MarkdownPreview markdown={active.markdown} /> : <div className="empty-state">这个月份还没有报告。</div>}
      </section>
    </div>
  );
}

function AdminView() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  async function refresh() {
    const [inviteItems, config] = await Promise.all([api.invites(), api.aiConfig()]);
    setInvites(inviteItems);
    setAiConfig(config);
    setBaseUrl(config.base_url);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  async function createInvite() {
    try {
      setError("");
      await api.createInvite();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  }

  async function saveAiConfig(event: FormEvent) {
    event.preventDefault();
    try {
      setError("");
      setSaved("");
      setTestResult("");
      const config = await api.updateAiConfig(baseUrl, apiKey);
      setAiConfig(config);
      setBaseUrl(config.base_url);
      setApiKey("");
      setSaved("AI 配置已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function testAiConfig() {
    try {
      setError("");
      setSaved("");
      setTestResult("");
      setTesting(true);
      const result = await api.testAiConfig(baseUrl, apiKey);
      setTestResult(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="admin-panel">
      {error && <div className="form-error admin-error">{error}</div>}
      <section className="admin-section">
        <header className="pane-header">
          <div>
            <h2>AI 配置</h2>
            <p>只保存调用地址和密钥，不在页面回显密钥明文。</p>
          </div>
        </header>
        <form className="admin-form" onSubmit={saveAiConfig}>
          <label>
            Base URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
          </label>
          <label>
            API Key
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              placeholder={aiConfig?.has_api_key ? "留空则保持当前密钥" : "请输入 API Key"}
            />
          </label>
          <div className="admin-actions">
            <span>{aiConfig?.api_key_preview ? `当前密钥 ${aiConfig.api_key_preview}` : "密钥未配置"}</span>
            <div className="admin-action-buttons">
              <button className="secondary-button compact" type="button" onClick={testAiConfig} disabled={testing}>
                {testing ? "测试中..." : "测试连接"}
              </button>
              <button className="primary-button compact" type="submit">
                保存 AI 配置
              </button>
            </div>
          </div>
        </form>
        {testResult && <div className="form-success">{testResult}</div>}
        {saved && <div className="form-success">{saved}</div>}
      </section>
      <section className="admin-section">
        <header className="pane-header">
          <div>
            <h2>邀请码</h2>
            <p>管理员只管理邀请，不查看用户聊天和报告。</p>
          </div>
          <button className="primary-button compact" onClick={createInvite}>
            <KeyRound size={16} />
            生成邀请码
          </button>
        </header>
      <div className="invite-table">
        {invites.map((invite) => (
          <div key={invite.code} className="invite-row">
            <code>{invite.code}</code>
            <span>{invite.is_used ? "已使用" : "未使用"}</span>
            <span>{invite.expires_at ? invite.expires_at.slice(0, 10) : "不过期"}</span>
          </div>
        ))}
      </div>
      </section>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<View>("chat");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">加载中...</div>;
  if (!user) return <AuthScreen onAuthed={setUser} />;

  async function logout() {
    await api.logout();
    setUser(null);
  }

  return (
    <main className="app-shell">
      <nav className="app-nav">
        <div className="nav-brand">
          <AppIcon size={20} />
          <span>DailyReview</span>
        </div>
        <button
          className={view === "chat" ? "active" : ""}
          onClick={() => setView("chat")}
          aria-label="问答"
          title="问答"
        >
          <MessageSquareText size={17} />
          <span className="nav-label">问答</span>
        </button>
        <button
          className={view === "reports" ? "active" : ""}
          onClick={() => setView("reports")}
          aria-label="报告"
          title="报告"
        >
          <CalendarDays size={17} />
          <span className="nav-label">报告</span>
        </button>
        {user.role === "admin" && (
          <button
            className={view === "admin" ? "active" : ""}
            onClick={() => setView("admin")}
            aria-label="AI 设置"
            title="AI 设置"
          >
            <KeyRound size={17} />
            <span className="nav-label">AI 设置</span>
          </button>
        )}
        <div className="nav-spacer" />
        <div className="user-chip">{user.email}</div>
        <button onClick={logout} aria-label="退出" title="退出">
          <LogOut size={17} />
          <span className="nav-label">退出</span>
        </button>
      </nav>
      <section className="app-content">
        {view === "chat" && <ChatView />}
        {view === "reports" && <ReportsView />}
        {view === "admin" && <AdminView />}
      </section>
    </main>
  );
}
