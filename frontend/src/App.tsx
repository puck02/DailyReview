import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ImagePlus,
  KeyRound,
  LogOut,
  MessageSquareText,
  Plus,
  Send,
  FileText,
  Sparkles
} from "lucide-react";
import { api, Attachment, ChatSession, Invite, Message, ReportContent, ReportItem, streamChat, User } from "./api";
import { firstClipboardImage } from "./clipboard";

type View = "chat" | "reports" | "admin";
type AuthMode = "login" | "register";

const defaultModel = "gpt-5.4-mini";
const complexModel = "5.5";

function monthValue() {
  return new Date().toISOString().slice(0, 7);
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const nodes = markdown.split("\n").map((line, index) => {
    if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
    if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
    if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
    if (line.startsWith("- ")) return <li key={index}>{line.slice(2)}</li>;
    if (!line.trim()) return <div key={index} className="md-gap" />;
    return <p key={index}>{line}</p>;
  });
  return <article className="markdown-preview">{nodes}</article>;
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
          <Sparkles size={22} />
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
  }

  async function uploadFile(file: File) {
    const uploaded = await api.upload(file);
    setAttachments((current) => [...current, uploaded]);
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || busy) return;
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
      created_at: new Date().toISOString()
    };
    const assistant: Message = {
      id: Date.now() + 1,
      role: "assistant",
      content: "",
      model,
      created_at: new Date().toISOString()
    };
    setInput("");
    setAttachments([]);
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

  return (
    <div className="workspace">
      <aside className="sessions-pane">
        <button className="new-session" onClick={newSession}>
          <Plus size={16} />
          新会话
        </button>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={active?.id === session.id ? "session-item active" : "session-item"}
              onClick={() => setActive(session)}
            >
              <MessageSquareText size={15} />
              <span>{session.title}</span>
            </button>
          ))}
        </div>
      </aside>
      <section className="chat-pane">
        <header className="pane-header">
          <div>
            <h2>{active?.title || "新会话"}</h2>
            <p>最近 7 天会话会保留，报告长期保存。</p>
          </div>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value={defaultModel}>{defaultModel}</option>
            <option value={complexModel}>{complexModel}</option>
          </select>
        </header>
        <div className="messages">
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <div className="message-role">{message.role === "user" ? "我" : "AI"}</div>
              <div className="message-content">{message.content}</div>
            </div>
          ))}
        </div>
        <footer className="composer">
          {attachments.length > 0 && (
            <div className="attachment-row">{attachments.length} 张图片已附加，7 天后自动清理。</div>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="composer-row">
            <label className="icon-button" title="上传图片">
              <ImagePlus size={18} />
              <input type="file" accept="image/*" hidden onChange={(event) => event.target.files?.[0] && uploadFile(event.target.files[0])} />
            </label>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="输入问题，或直接粘贴图片..."
              rows={2}
            />
            <button className="send-button" onClick={sendMessage} disabled={busy}>
              <Send size={18} />
            </button>
          </div>
        </footer>
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
  const [error, setError] = useState("");

  async function refresh() {
    setInvites(await api.invites());
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  async function createInvite() {
    await api.createInvite();
    await refresh();
  }

  return (
    <section className="admin-panel">
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
      {error && <div className="form-error">{error}</div>}
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
          <Sparkles size={20} />
          <span>DailyReview</span>
        </div>
        <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
          <MessageSquareText size={17} />
          问答
        </button>
        <button className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}>
          <CalendarDays size={17} />
          报告
        </button>
        {user.role === "admin" && (
          <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}>
            <KeyRound size={17} />
            邀请码
          </button>
        )}
        <div className="nav-spacer" />
        <div className="user-chip">{user.email}</div>
        <button onClick={logout}>
          <LogOut size={17} />
          退出
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
