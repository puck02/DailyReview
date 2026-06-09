import {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  CalendarDays,
  Check,
  Copy,
  Download,
  ImagePlus,
  KeyRound,
  Languages,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  MessageSquareText,
  Plus,
  Send,
  FileText,
  Sun,
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
  TranslationEntry,
  streamChat,
  User
} from "./api";
import { removeAttachmentPreview } from "./attachmentPreviews";
import { firstClipboardImage } from "./clipboard";
import { normalizeMarkdownMath } from "./markdown";
import appIconUrl from "./assets/app-icon.svg?url";
import "katex/dist/katex.min.css";

type View = "chat" | "translate" | "reports" | "admin";
type AuthMode = "login" | "register";
type ThemePreference = "light" | "dark";
type PendingAttachment = Attachment & { previewUrl: string; name: string };
type TranslationCloudItem = {
  key: string;
  label: string;
  count: number;
  weight: number;
  entry: TranslationEntry;
};

const defaultModel = "gpt-5.4-mini";
const complexModel = "5.5";
const themeStorageKey = "dailyreview.theme";
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

function currentSystemTheme(): ThemePreference {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readThemePreference(): ThemePreference | null {
  const value = localStorage.getItem(themeStorageKey);
  return value === "light" || value === "dark" ? value : null;
}

function applyThemePreference(preference: ThemePreference | null) {
  if (preference) {
    document.documentElement.dataset.theme = preference;
    return;
  }
  delete document.documentElement.dataset.theme;
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

function markdownTextFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownTextFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return markdownTextFromNode(node.props.children);
  return "";
}

async function copyMarkdownText(text: string) {
  const value = text.trim();
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function CopyableMarkdownBlock({
  children,
  text,
  className = ""
}: {
  children: ReactNode;
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!(await copyMarkdownText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className={`copyable-markdown-block ${className}`}>
      {children}
      <button
        type="button"
        className={copied ? "copy-block-button copied" : "copy-block-button"}
        onClick={handleCopy}
        aria-label={copied ? "已复制" : "复制此块"}
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function copyableComponents(copyable: boolean): Components {
  return {
    a({ href = "", children }) {
      const safeHref = safeMarkdownUrl(href);
      if (!safeHref) return <>{children}</>;
      return (
        <a href={safeHref} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    h1({ children }) {
      const heading = <h1>{children}</h1>;
      if (!copyable) return heading;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{heading}</CopyableMarkdownBlock>;
    },
    h2({ children }) {
      const heading = <h2>{children}</h2>;
      if (!copyable) return heading;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{heading}</CopyableMarkdownBlock>;
    },
    h3({ children }) {
      const heading = <h3>{children}</h3>;
      if (!copyable) return heading;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{heading}</CopyableMarkdownBlock>;
    },
    p({ children }) {
      const paragraph = <p className={copyable ? "copyable-text-block" : undefined}>{children}</p>;
      if (!copyable) return paragraph;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{paragraph}</CopyableMarkdownBlock>;
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
      const code = <pre className="markdown-code">{children}</pre>;
      if (!copyable) return code;
      return (
        <CopyableMarkdownBlock className="copyable-code-block" text={markdownTextFromNode(children)}>
          {code}
        </CopyableMarkdownBlock>
      );
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table className="markdown-table">{children}</table>
        </div>
      );
    },
    ul({ children }) {
      const list = <ul className={copyable ? "markdown-list copyable-text-block" : "markdown-list"}>{children}</ul>;
      if (!copyable) return list;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{list}</CopyableMarkdownBlock>;
    },
    ol({ children }) {
      const list = <ol className={copyable ? "markdown-list copyable-text-block" : "markdown-list"}>{children}</ol>;
      if (!copyable) return list;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{list}</CopyableMarkdownBlock>;
    },
    blockquote({ children }) {
      const quote = <blockquote className={copyable ? "copyable-text-block" : undefined}>{children}</blockquote>;
      if (!copyable) return quote;
      return <CopyableMarkdownBlock text={markdownTextFromNode(children)}>{quote}</CopyableMarkdownBlock>;
    }
  };
}

function MarkdownRenderer({
  markdown,
  className,
  copyable = false
}: {
  markdown: string;
  className: string;
  copyable?: boolean;
}) {
  const normalizedMarkdown = normalizeMarkdownMath(markdown);
  const components = useMemo(() => copyableComponents(copyable), [copyable]);
  return (
    <div className={className}>
      <ReactMarkdown
        key={normalizedMarkdown}
        components={components}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { ignoreMissing: true, detect: true }]]}
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

function MessageMarkdown({ markdown, copyable }: { markdown: string; copyable: boolean }) {
  return <MarkdownRenderer markdown={markdown} className="message-markdown" copyable={copyable} />;
}

const englishStopWords = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "not",
  "that",
  "the",
  "this",
  "was",
  "were",
  "with",
  "you"
]);

function compactCloudLabel(text: string) {
  const value = text.trim().replace(/\s+/g, " ");
  return value.length > 28 ? `${value.slice(0, 28)}...` : value;
}

function labelsForTranslationEntry(entry: TranslationEntry) {
  const source = entry.source_text.trim().replace(/\s+/g, " ");
  if (!source) return [];
  if (entry.source_kind === "chinese" || entry.source_kind === "word") return [compactCloudLabel(source)];

  const words = source.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (words.length <= 3) return [compactCloudLabel(source)];
  const labels = words
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2 && !englishStopWords.has(word));
  return Array.from(new Set(labels)).slice(0, 8);
}

function translationCloudItems(entries: TranslationEntry[]) {
  const cloud = new Map<string, TranslationCloudItem>();
  entries.slice(0, 60).forEach((entry) => {
    labelsForTranslationEntry(entry).forEach((label) => {
      const key = label.toLowerCase();
      const existing = cloud.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        cloud.set(key, {
          key,
          label,
          count: 1,
          weight: 1,
          entry
        });
      }
    });
  });

  return Array.from(cloud.values())
    .map((item) => ({
      ...item,
      weight: Math.min(5, 1 + Math.floor(Math.log2(item.count + 1)))
    }))
    .sort((left, right) => right.count - left.count || right.entry.id - left.entry.id)
    .slice(0, 36);
}

function TranslationWordCloud({
  entries,
  activeId,
  onSelect
}: {
  entries: TranslationEntry[];
  activeId: number | null;
  onSelect: (entry: TranslationEntry) => void;
}) {
  const cloudRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ active: false, moved: false, scrollLeft: 0, x: 0 });
  const [dragging, setDragging] = useState(false);
  const items = useMemo(() => translationCloudItems(entries), [entries]);

  useEffect(() => {
    if (!items.length) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    let frame = 0;
    let previous = performance.now();

    function drift(now: number) {
      const element = cloudRef.current;
      if (element && !dragState.current.active && element.scrollWidth > element.clientWidth) {
        const distance = Math.min((now - previous) * 0.012, 0.9);
        const end = element.scrollWidth - element.clientWidth - 4;
        element.scrollLeft = element.scrollLeft >= end ? 0 : element.scrollLeft + distance;
      }
      previous = now;
      frame = window.requestAnimationFrame(drift);
    }

    frame = window.requestAnimationFrame(drift);
    return () => window.cancelAnimationFrame(frame);
  }, [items.length]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const element = cloudRef.current;
    if (!element) return;
    dragState.current = {
      active: true,
      moved: false,
      scrollLeft: element.scrollLeft,
      x: event.clientX
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const element = cloudRef.current;
    const state = dragState.current;
    if (!element || !state.active) return;
    const delta = event.clientX - state.x;
    if (Math.abs(delta) > 4) state.moved = true;
    element.scrollLeft = state.scrollLeft - delta;
    event.preventDefault();
  }

  function handlePointerEnd() {
    dragState.current.active = false;
    setDragging(false);
  }

  function selectItem(item: TranslationCloudItem) {
    if (dragState.current.moved) {
      dragState.current.moved = false;
      return;
    }
    onSelect(item.entry);
  }

  return (
    <section className="translation-cloud">
      <div className="translation-card-head">
        <span>词云</span>
        <strong>{items.length ? `${items.length} 个词 / 短语` : "等待积累"}</strong>
      </div>
      {items.length ? (
        <div
          ref={cloudRef}
          className={dragging ? "word-cloud-stage dragging" : "word-cloud-stage"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onPointerLeave={handlePointerEnd}
        >
          <div className="word-cloud-track">
            {items.map((item) => (
              <button
                key={item.key}
                className={activeId === item.entry.id ? "word-cloud-chip active" : "word-cloud-chip"}
                style={
                  {
                    "--cloud-weight": item.weight
                  } as CSSProperties
                }
                onClick={() => selectItem(item)}
              >
                <span>{item.label}</span>
                {item.count > 1 && <small>{item.count}</small>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="translation-cloud-empty">翻译几次后，这里会积累词和短语。</div>
      )}
    </section>
  );
}

function TranslationLoading() {
  return (
    <div className="translation-loading" role="status" aria-label="正在翻译">
      <span />
      <span />
      <span />
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-indicator" role="status" aria-label="AI 正在回复">
      <span className="typing-dot" />
    </div>
  );
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

function ChatView({
  currentTheme,
  onToggleTheme
}: {
  currentTheme: ThemePreference;
  onToggleTheme: () => void;
}) {
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
          <div className="pane-actions">
            <button
              type="button"
              className="theme-toggle"
              onClick={onToggleTheme}
              aria-label={currentTheme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
              title={currentTheme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
            >
              {currentTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value={defaultModel}>{defaultModel}</option>
              <option value={complexModel}>{complexModel}</option>
            </select>
          </div>
        </header>
        <div className={isEmptyChat ? "messages empty-chat" : "messages"}>
          {isEmptyChat ? (
            <div className="empty-chat-content">
              <h1 className="empty-chat-greeting">{openingLine}</h1>
              {composer}
            </div>
          ) : (
            messages.map((message) => {
              const isAssistantThinking = message.role === "assistant" && busy && !message.content.trim();
              return (
                <div key={message.id} className={`message ${message.role}`}>
                  {message.role === "assistant" && <ChatGptAvatar />}
                  <div className="message-content">
                    {isAssistantThinking && <TypingIndicator />}
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
                    {message.content.trim() && (
                      <MessageMarkdown markdown={message.content} copyable={message.role === "assistant"} />
                    )}
                  </div>
                </div>
              );
            })
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
  const reportTypeLabel = type === "daily" ? "日报" : type === "weekly" ? "周报" : "月报";

  function exportReportPdf() {
    if (!active) return;
    window.print();
  }

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
        {active ? (
          <>
            <div className="report-toolbar">
              <div>
                <span>{active.period}</span>
                <strong>{reportTypeLabel}</strong>
              </div>
              <button className="secondary-button compact print-export-button" onClick={exportReportPdf}>
                <Download size={16} />
                导出 PDF
              </button>
            </div>
            <MarkdownPreview markdown={active.markdown} />
          </>
        ) : (
          <div className="empty-state">这个月份还没有报告。</div>
        )}
      </section>
    </div>
  );
}

function TranslationView() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<TranslationEntry | null>(null);
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.translationPrompt(), api.translationEntries()])
      .then(([prompt, history]) => {
        setPromptDraft(prompt.system_prompt);
        setEntries(history);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "翻译模块加载失败"));
  }, []);

  async function submitTranslation() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const translated = await api.translate(text);
      setResult(translated);
      setEntries((current) => [translated, ...current.filter((item) => item.id !== translated.id)].slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : "翻译失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePrompt() {
    setError("");
    setSaved("");
    try {
      const prompt = await api.updateTranslationPrompt(promptDraft);
      setPromptDraft(prompt.system_prompt);
      setSaved("Prompt 已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function resetPrompt() {
    setPromptDraft("");
    setError("");
    setSaved("");
    try {
      const prompt = await api.updateTranslationPrompt("");
      setPromptDraft(prompt.system_prompt);
      setSaved("已恢复预设 Prompt");
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复失败");
    }
  }

  const activeResult = result || entries[0] || null;

  return (
    <section className="translation-panel">
      <header className="pane-header translation-header">
        <div>
          <h2>翻译 / 讲解</h2>
          <p>围绕考研英语一，做中英互译、词根词缀和句子拆解。</p>
        </div>
        <button className="secondary-button compact" onClick={() => setPromptOpen((current) => !current)}>
          {promptOpen ? "收起 Prompt" : "修改 Prompt"}
        </button>
      </header>

      <div className="translation-body">
        <div className="translation-workbench">
          <section className="translation-card">
            <div className="translation-card-head">
              <span>输入</span>
              <strong>中文 / English</strong>
            </div>
            <textarea
              className="translation-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="输入中文、英文单词、短语或句子..."
            />
          </section>

          <div className="translation-submit-slot">
            <button
              className={busy ? "translation-submit loading" : "translation-submit"}
              onClick={submitTranslation}
              disabled={busy || !input.trim()}
              aria-label={busy ? "正在翻译" : "翻译"}
            >
              {busy ? <TranslationLoading /> : "翻译"}
            </button>
          </div>

          <section className="translation-card translation-result">
            <div className="translation-card-head">
              <span>结果</span>
              <strong>{activeResult ? sourceKindLabel(activeResult.source_kind) : "等待输入"}</strong>
            </div>
            {busy ? (
              <div className="translation-result-loading">
                <TranslationLoading />
                <span>正在整理译文</span>
              </div>
            ) : activeResult ? (
              <MarkdownRenderer markdown={activeResult.result_markdown} className="translation-markdown" />
            ) : (
              <div className="translation-empty">输入内容后，这里会显示简洁译文、重点拆解和例句。</div>
            )}
          </section>
        </div>

        {promptOpen && (
          <section className="translation-card prompt-editor">
            <div className="translation-card-head">
              <span>System Prompt</span>
              <strong>默认预设可随时恢复编辑</strong>
            </div>
            <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} />
            <div className="translation-actions">
              <span>建议保持“考研英语一、简洁、词根词缀、句子拆解”这些约束。</span>
              <div className="translation-action-buttons">
                <button className="secondary-button compact" onClick={resetPrompt}>
                  恢复预设
                </button>
                <button className="secondary-button compact" onClick={savePrompt}>
                  保存 Prompt
                </button>
              </div>
            </div>
          </section>
        )}

        {(error || saved) && <div className={error ? "form-error" : "form-success"}>{error || saved}</div>}

        <TranslationWordCloud entries={entries} activeId={activeResult?.id || null} onSelect={setResult} />
      </div>
    </section>
  );
}

function sourceKindLabel(kind: TranslationEntry["source_kind"]) {
  if (kind === "chinese") return "中文 -> English";
  if (kind === "word") return "Word";
  return "English -> 中文";
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
  const [systemTheme, setSystemTheme] = useState<ThemePreference>(currentSystemTheme);
  const [themePreference, setThemePreference] = useState<ThemePreference | null>(readThemePreference);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => setSystemTheme(query.matches ? "dark" : "light");
    updateSystemTheme();
    query.addEventListener("change", updateSystemTheme);
    return () => query.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  if (loading) return <div className="loading">加载中...</div>;
  if (!user) return <AuthScreen onAuthed={setUser} />;

  async function logout() {
    await api.logout();
    setUser(null);
  }

  function toggleThemePreference() {
    const nextTheme: ThemePreference = (themePreference || systemTheme) === "dark" ? "light" : "dark";
    setThemePreference(nextTheme);
    localStorage.setItem(themeStorageKey, nextTheme);
  }

  const currentTheme = themePreference || systemTheme;

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
          className={view === "translate" ? "active" : ""}
          onClick={() => setView("translate")}
          aria-label="翻译"
          title="翻译"
        >
          <Languages size={17} />
          <span className="nav-label">翻译</span>
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
        {view === "chat" && <ChatView currentTheme={currentTheme} onToggleTheme={toggleThemePreference} />}
        {view === "translate" && <TranslationView />}
        {view === "reports" && <ReportsView />}
        {view === "admin" && <AdminView />}
      </section>
    </main>
  );
}
