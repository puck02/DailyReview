import {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  Suspense,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState
} from "react";
import {
  CalendarDays,
  Camera,
  Check,
  Archive,
  ArchiveRestore,
  ChevronDown,
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
  RefreshCw,
  Send,
  FileText,
  Settings,
  Sun,
  Trash2,
  X
} from "lucide-react";
import {
  api,
  AiConfig,
  AiConfigPatch,
  AiProviderName,
  AppSettings,
  Attachment,
  ChatSession,
  Invite,
  Message,
  ReportContent,
  ReportGenerationStatus,
  ReportItem,
  TokenUsageSummary,
  TranslationEntry,
  regenerateChat,
  streamChat,
  User
} from "./api";
import { removeAttachmentPreview } from "./attachmentPreviews";
import { firstClipboardImage } from "./clipboard";
import { ScreenshotEditor } from "./ScreenshotEditor";
import appIconUrl from "./assets/app-icon.svg?url";
import { prepareImageForUpload } from "./imageCompression";
import "katex/dist/katex.min.css";

type View = "chat" | "translate" | "reports" | "admin" | "settings";
type AuthMode = "login" | "register";
type ThemePreference = "light" | "dark";
type PendingAttachment = Attachment & {
  previewUrl: string;
  dataUrl: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
};
type TranslationCloudItem = {
  key: string;
  label: string;
  count: number;
  weight: number;
  entry: TranslationEntry;
};
type TranslationCloudLane = {
  id: number;
  duration: number;
  delay: number;
  items: TranslationCloudItem[];
};
type PdfWritable = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};
type PdfFileHandle = {
  createWritable: () => Promise<PdfWritable>;
};
type PdfSavePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<PdfFileHandle>;
  };
type PdfSaveTarget = { kind: "handle"; handle: PdfFileHandle } | { kind: "download" } | { kind: "cancelled" };
type TokenFlushController = {
  push: (token: string) => void;
  flush: () => void;
  cancel: () => void;
};
const defaultModel = "gpt-5.4-mini";
const complexModel = "gpt-5.5";
const reportModels = [defaultModel, complexModel];
const providerNames: AiProviderName[] = ["gpt", "zhipu", "deepseek"];
const fallbackProviderModels: Record<AiProviderName, { text: string[]; vision: string[] }> = {
  gpt: { text: reportModels, vision: reportModels },
  zhipu: { text: ["glm-5"], vision: ["glm-4.6v"] },
  deepseek: { text: ["deepseek-chat", "deepseek-reasoner"], vision: [] }
};
const themeStorageKey = "dailyreview.theme";
const translationInputLimit = 2000;
const translationEntriesClearedEvent = "dailyreview:translation-entries-cleared";
const aiConfigChangedEvent = "dailyreview:ai-config-changed";
const wordCloudLaneCount = 4;
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));
const DAILY_QUOTES = [
  { text: "面朝大海，春暖花开。", source: "海子" },
  { text: "认识你自己。", source: "德尔斐箴言" },
  { text: "生如夏花。", source: "泰戈尔" },
  { text: "凡是过往，皆为序章。", source: "莎士比亚" },
  { text: "大胆假设，小心求证。", source: "胡适" },
  { text: "人只能自己救自己。", source: "《千与千寻》" },
  { text: "去生活。去犯错。", source: "《灵魂奇遇记》" }
];

function preloadMarkdownRenderer() {
  void import("./MarkdownRenderer");
}
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

function dailyQuoteIndex(date = new Date()): number {
  const dayKey = date.toISOString().slice(0, 10);
  let hash = 0;
  for (const char of dayKey) {
    hash = (hash * 31 + char.charCodeAt(0)) % DAILY_QUOTES.length;
  }
  return hash;
}

function createTokenFlushController(onFlush: (text: string) => void): TokenFlushController {
  let pending = "";
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    if (!pending) return;
    const text = pending;
    pending = "";
    onFlush(text);
  };
  return {
    push(token) {
      pending += token;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(flush);
    },
    flush,
    cancel() {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      pending = "";
    }
  };
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

function isScreenshotCancel(error: unknown) {
  return error instanceof DOMException && ["AbortError", "NotAllowedError", "SecurityError"].includes(error.name);
}

async function captureScreenCanvas(): Promise<HTMLCanvasElement> {
  const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
  if (!getDisplayMedia) {
    throw new Error("当前浏览器不支持网页截图，请使用 Chrome 或 Edge 桌面版");
  }

  const stream = await getDisplayMedia({
    video: { cursor: "always" } as MediaTrackConstraints,
    audio: false
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("截图读取失败，请重新截图"));
      video.srcObject = stream;
    });
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("截图读取失败，请重新截图");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理截图");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function MessageActions({
  text,
  onRegenerate,
  disabled
}: {
  text: string;
  onRegenerate: () => void;
  disabled: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!(await copyMarkdownText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="message-actions">
      <button
        type="button"
        className="message-action-button"
        onClick={onRegenerate}
        disabled={disabled}
        aria-label="重新生成回复"
        title="重新生成"
      >
        <RefreshCw size={14} />
      </button>
      <button
        type="button"
        className={copied ? "message-action-button message-copy-button copied" : "message-action-button message-copy-button"}
        onClick={handleCopy}
        aria-label={copied ? "已复制整条回复" : "复制整条回复"}
        title={copied ? "已复制" : "复制整条回复"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <Suspense fallback={<div className="empty-state">正在加载报告内容...</div>}>
      <MarkdownRenderer markdown={markdown} className="markdown-preview" />
    </Suspense>
  );
}

function reportGenerationTitle(status: ReportGenerationStatus, reportTypeLabel: string): string {
  if (status.status === "running") return reportTypeLabel === "日报" ? "日报正在生成" : `${reportTypeLabel}正在生成`;
  if (status.status === "failed") return reportTypeLabel === "日报" ? "日报生成失败" : `${reportTypeLabel}生成失败`;
  return `${reportTypeLabel}未生成`;
}

function reportGenerationMessage(status: ReportGenerationStatus): string {
  if (status.message) return status.message;
  if (status.status === "running") return "生成完成后会自动出现在报告列表中。";
  if (status.status === "failed") return "系统会在下一次定时任务重试。";
  return "当天没有足够的学习内容生成报告。";
}

function MessageMarkdown({ markdown, copyable }: { markdown: string; copyable: boolean }) {
  return (
    <Suspense fallback={<div className="message-markdown">{markdown}</div>}>
      <MarkdownRenderer markdown={markdown} className="message-markdown" copyable={copyable} />
    </Suspense>
  );
}

function isSavePickerGestureError(error: unknown): boolean {
  return error instanceof DOMException && /user gesture|handling a user gesture|activation/i.test(error.message);
}

function pickPdfSaveTarget(filename: string): Promise<PdfSaveTarget> {
  const pickerWindow = window as PdfSavePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return Promise.resolve({ kind: "download" });
  try {
    const handlePromise = pickerWindow.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "PDF 文件", accept: { "application/pdf": [".pdf"] } }]
    });
    return handlePromise
      .then((handle) => ({ kind: "handle", handle }) as PdfSaveTarget)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return { kind: "cancelled" };
        if (isSavePickerGestureError(error)) return { kind: "download" };
        throw error;
      });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return Promise.resolve({ kind: "cancelled" });
    if (isSavePickerGestureError(error)) return Promise.resolve({ kind: "download" });
    throw error;
  }
}

async function savePdfBlob(blob: Blob, filename: string, target: PdfSaveTarget) {
  if (target.kind === "cancelled") return;
  if (target.kind === "handle") {
    const writable = await target.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  if (entry.source_kind === "chinese") return [];
  if (entry.source_kind === "word") return [compactCloudLabel(source)];

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

  const items = Array.from(cloud.values()).sort(
    (left, right) => right.count - left.count || right.entry.id - left.entry.id
  );
  const maxCount = Math.max(1, ...items.map((item) => item.count));
  const minCount = Math.min(maxCount, ...items.map((item) => item.count));
  return items
    .map((item) => {
      const spread = maxCount - minCount;
      const weight = spread ? 1 + Math.round(((item.count - minCount) / spread) * 4) : 3;
      return { ...item, weight: Math.max(1, Math.min(5, weight)) };
    })
    .slice(0, 40);
}

function shuffleTranslationCloudItems(items: TranslationCloudItem[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function buildTranslationCloudLanes(items: TranslationCloudItem[]): TranslationCloudLane[] {
  const shuffled = shuffleTranslationCloudItems(items);
  if (!shuffled.length) return [];
  const laneCount = wordCloudLaneCount;
  const lanes = Array.from({ length: laneCount }, (_, index) => {
    const laneItems = shuffled.filter((_, itemIndex) => itemIndex % laneCount === index);
    const rotated = [...shuffled.slice(index % shuffled.length), ...shuffled.slice(0, index % shuffled.length)];
    return {
      id: index,
      duration: 72 + index * 12,
      delay: -index * 3,
      items: laneItems.length >= 3 ? laneItems : rotated.slice(0, Math.min(8, rotated.length))
    };
  });
  return lanes;
}

function cloudTone(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 9973;
  }
  return String((hash % 6) + 1);
}

function repeatedLaneItems(items: TranslationCloudItem[]) {
  if (!items.length) return [];
  if (items.length >= 32) return items;
  const repeated: TranslationCloudItem[] = [];
  while (repeated.length < 32) repeated.push(...items);
  return repeated.slice(0, 32);
}

function cloudLookupKey(text: string) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function cloudDetailEntryForItem(item: TranslationCloudItem, entries: TranslationEntry[]) {
  const labelKey = cloudLookupKey(item.label);
  const sourceKey = cloudLookupKey(item.entry.source_text);
  if (item.entry.source_kind !== "english" || sourceKey === labelKey || item.label.endsWith("...")) return item.entry;
  return (
    entries.find((entry) => entry.source_kind === "word" && cloudLookupKey(entry.source_text) === labelKey) ||
    entries.find((entry) => cloudLookupKey(entry.source_text) === labelKey) ||
    null
  );
}

function TranslationPhonetic({ phonetic }: { phonetic: string | null }) {
  if (!phonetic) return null;
  return <div className="translation-phonetic">{phonetic}</div>;
}

function isTranslationDetailPending(entry: TranslationEntry) {
  return entry.detail_status === "queued" || entry.detail_status === "processing";
}

function TranslationWordCloud({
  entries,
  activeId,
  onSelect,
  onDictionaryEntry
}: {
  entries: TranslationEntry[];
  activeId: number | null;
  onSelect: (entry: TranslationEntry) => void;
  onDictionaryEntry: (entry: TranslationEntry) => void;
}) {
  const items = useMemo(() => translationCloudItems(entries), [entries]);
  const lanes = useMemo(() => buildTranslationCloudLanes(items), [items]);
  const [detailState, setDetailState] = useState<{
    label: string;
    entry: TranslationEntry | null;
    error: string;
  } | null>(null);
  const detailEntry = useMemo(() => {
    if (!detailState) return null;
    if (detailState.entry) {
      return entries.find((entry) => entry.id === detailState.entry?.id) || detailState.entry;
    }
    const labelKey = cloudLookupKey(detailState.label);
    return (
      entries.find((entry) => entry.source_kind === "word" && cloudLookupKey(entry.source_text) === labelKey) ||
      entries.find((entry) => cloudLookupKey(entry.source_text) === labelKey) ||
      null
    );
  }, [detailState, entries]);

  async function openCloudDetail(item: TranslationCloudItem) {
    const existing = cloudDetailEntryForItem(item, entries);
    setDetailState({ label: item.label, entry: existing, error: "" });
    if (existing) {
      if (existing.detail_status === "ready" || existing.result_markdown.trim()) onSelect(existing);
      if (existing.detail_status === "ready" || item.label.endsWith("...")) return;
    }
    if (item.label.endsWith("...")) return;
    try {
      const dictionaryEntry = await api.translationDictionaryEntry(item.label);
      onDictionaryEntry(dictionaryEntry);
      onSelect(dictionaryEntry);
      setDetailState({ label: item.label, entry: dictionaryEntry, error: "" });
    } catch (err) {
      if (existing) return;
      setDetailState({
        label: item.label,
        entry: null,
        error: err instanceof Error ? err.message : "词条详解生成失败"
      });
    }
  }

  function closeCloudDetail() {
    setDetailState(null);
  }

  return (
    <>
      <section className="translation-cloud">
        {items.length ? (
          <div className="word-cloud-stage">
            {lanes.map((lane) => {
              const laneItems = repeatedLaneItems(lane.items);
              return (
                <div key={lane.id} className="word-cloud-lane">
                  <div
                    className="word-cloud-run"
                    style={
                      {
                        "--lane-duration": `${lane.duration}s`,
                        "--lane-delay": `${lane.delay}s`
                      } as CSSProperties
                    }
                  >
                    {[...laneItems, ...laneItems].map((item, index) => (
                      <button
                        key={`${lane.id}-${item.key}-${index}`}
                        className={activeId === item.entry.id ? "word-cloud-chip active" : "word-cloud-chip"}
                        data-size={item.weight}
                        data-tone={cloudTone(item.key)}
                        data-label={item.label}
                        onClick={() => openCloudDetail(item)}
                      >
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="translation-cloud-empty">翻译几次后，这里会积累词和短语。</div>
        )}
      </section>
      {detailState && (
        <div
          className="word-cloud-detail-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${detailState.label} 详解`}
          onClick={closeCloudDetail}
        >
          <div className="word-cloud-detail-card" onClick={(event) => event.stopPropagation()}>
            <div className="word-cloud-detail-head">
              <div>
                <span>详解</span>
                <strong>{detailState.label}</strong>
              </div>
              <button
                type="button"
                className="word-cloud-detail-close"
                onClick={closeCloudDetail}
                aria-label="关闭详解"
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="word-cloud-detail-content">
              {detailState.error ? (
                <div className="form-error">{detailState.error}</div>
              ) : detailEntry ? (
                isTranslationDetailPending(detailEntry) && !detailEntry.result_markdown.trim() ? (
                  <div className="word-cloud-detail-loading">
                    <TranslationLoading />
                    <span>正在按学习 Prompt 生成详解</span>
                  </div>
                ) : detailEntry.detail_status === "failed" && !detailEntry.result_markdown.trim() ? (
                  <div className="form-error">词条详解生成失败，稍后刷新或重新收录。</div>
                ) : (
                  <>
                    <TranslationPhonetic phonetic={detailEntry.phonetic} />
                    <MarkdownRenderer markdown={detailEntry.result_markdown} className="translation-markdown" />
                  </>
                )
              ) : (
                <div className="word-cloud-detail-loading">
                  <TranslationLoading />
                  <span>正在查询词条并生成详解</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
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

async function confirmAuthSession(): Promise<User> {
  try {
    return await api.me();
  } catch {
    throw new Error("登录状态未保存，请确认手机浏览器允许 Cookie 后重试。");
  }
}

function AuthScreen({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dailyQuote = useMemo(() => DAILY_QUOTES[dailyQuoteIndex()], []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      mode === "login" ? await api.login(email, password) : await api.register(email, password, inviteCode);
      const confirmedUser = await confirmAuthSession();
      onAuthed(confirmedUser);
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
        <p className="auth-quote">
          <span>{dailyQuote.text}</span>
          <cite>——{dailyQuote.source}</cite>
        </p>
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
  onToggleTheme,
  isActive
}: {
  currentTheme: ThemePreference;
  onToggleTheme: () => void;
  isActive: boolean;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<ChatSession | null>(null);
  const [draftSessionActive, setDraftSessionActive] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [chatModelOptions, setChatModelOptions] = useState(reportModels);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [screenshotCanvas, setScreenshotCanvas] = useState<HTMLCanvasElement | null>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const activeRef = useRef<ChatSession | null>(null);
  const draftSessionActiveRef = useRef(false);
  const skipNextMessageLoadSessionIdRef = useRef<number | null>(null);
  const sessionLoadRequestRef = useRef(0);
  const messageLoadRequestRef = useRef(0);
  const nextPendingAttachmentIdRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendLockRef = useRef(false);
  const regenerateLockRef = useRef(false);
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState("");
  const [openingLine, setOpeningLine] = useState(randomOpeningLine);

  async function refreshSessions() {
    const requestId = ++sessionLoadRequestRef.current;
    setSessionsLoading(true);
    try {
      const items = await api.sessions();
      if (requestId !== sessionLoadRequestRef.current) return;
      setSessions(items);
      if (activeRef.current) {
        const updatedActive = items.find((item) => item.id === activeRef.current?.id);
        if (updatedActive) {
          activeRef.current = updatedActive;
          setActive(updatedActive);
        }
      }
      if (!activeRef.current && !draftSessionActiveRef.current && items[0]) {
        activeRef.current = items[0];
        setActive(items[0]);
      }
    } finally {
      if (requestId === sessionLoadRequestRef.current) setSessionsLoading(false);
    }
  }

  const regularSessions = useMemo(() => sessions.filter((session) => !session.is_archived), [sessions]);
  const archivedSessions = useMemo(() => sessions.filter((session) => session.is_archived), [sessions]);

  async function loadChatModels(preferConfiguredModel = false) {
    const config = await api.aiModels();
    const options = config.text_models.length ? config.text_models : config.text_model ? [config.text_model] : [];
    const nextOptions = options.length ? options : [config.text_model || defaultModel];
    setChatModelOptions(nextOptions);
    setModel((current) => {
      if (preferConfiguredModel && nextOptions.includes(config.text_model)) return config.text_model;
      if (nextOptions.includes(current)) return current;
      return nextOptions.includes(config.text_model) ? config.text_model : nextOptions[0] || defaultModel;
    });
  }

  useEffect(() => {
    refreshSessions().catch((err) => setError(err.message));
    loadChatModels(true).catch(() => {
      setChatModelOptions(reportModels);
      setModel(defaultModel);
    });
  }, []);

  useEffect(() => {
    function handleAiConfigChanged() {
      loadChatModels(true).catch(() => {
        setChatModelOptions(reportModels);
        setModel(defaultModel);
      });
    }

    window.addEventListener(aiConfigChangedEvent, handleAiConfigChanged);
    return () => window.removeEventListener(aiConfigChangedEvent, handleAiConfigChanged);
  }, []);

  useEffect(() => {
    function closeSessionMenu() {
      setSessionMenu(null);
    }

    window.addEventListener("click", closeSessionMenu);
    window.addEventListener("resize", closeSessionMenu);
    return () => {
      window.removeEventListener("click", closeSessionMenu);
      window.removeEventListener("resize", closeSessionMenu);
    };
  }, []);

  useEffect(() => {
    const requestId = ++messageLoadRequestRef.current;
    if (!active) {
      skipNextMessageLoadSessionIdRef.current = null;
      setMessagesLoading(false);
      setMessages([]);
      return;
    }
    if (skipNextMessageLoadSessionIdRef.current === active.id) {
      skipNextMessageLoadSessionIdRef.current = null;
      setMessagesLoading(false);
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    api
      .messages(active.id)
      .then((items) => {
        if (requestId !== messageLoadRequestRef.current) return;
        setMessages(items);
      })
      .catch((err) => {
        if (requestId !== messageLoadRequestRef.current) return;
        setError(err.message);
      })
      .finally(() => {
        if (requestId === messageLoadRequestRef.current) setMessagesLoading(false);
      });
  }, [active?.id]);

  useEffect(() => {
    setOpeningLine(randomOpeningLine());
  }, [active?.id]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    draftSessionActiveRef.current = draftSessionActive;
  }, [draftSessionActive]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 88)}px`;
  }, [input]);

  useEffect(() => {
    if (!messages.length || messagesLoading) return;
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, messagesLoading]);

  useEffect(() => {
    if (!isActive || !messages.length) return;
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isActive, messages.length]);

  useEffect(() => {
    return () => {
      activeStreamAbortRef.current?.abort();
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    function handleDocumentPaste(event: globalThis.ClipboardEvent) {
      const file = firstClipboardImage(event.clipboardData);
      if (!file) return;

      event.preventDefault();
      uploadFile(file).catch((err) => setError(err.message));
    }

    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, [isActive]);

  async function newSession() {
    setDraftSessionActive(true);
    draftSessionActiveRef.current = true;
    skipNextMessageLoadSessionIdRef.current = null;
    activeRef.current = null;
    setActive(null);
    setMessages([]);
    setInput("");
    clearAttachments();
    setError("");
    setOpeningLine(randomOpeningLine());
    if (isMobileViewport()) setSidebarOpen(false);
  }

  function selectSession(session: ChatSession) {
    setSessionMenu(null);
    setDraftSessionActive(false);
    draftSessionActiveRef.current = false;
    skipNextMessageLoadSessionIdRef.current = null;
    activeRef.current = session;
    setActive(session);
    if (isMobileViewport()) setSidebarOpen(false);
  }

  function openSessionMenu(event: ReactMouseEvent, session: ChatSession) {
    event.preventDefault();
    event.stopPropagation();
    setSessionMenu({ session, x: event.clientX, y: event.clientY });
  }

  async function archiveSession(session: ChatSession, archived: boolean) {
    try {
      setError("");
      setSessionMenu(null);
      const updated = await api.archiveSession(session.id, archived);
      setSessions((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)).sort((left, right) => {
          if (left.is_archived !== right.is_archived) return left.is_archived ? 1 : -1;
          return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
        })
      );
      if (active?.id === updated.id) setActive(updated);
      if (active?.id === updated.id) activeRef.current = updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : archived ? "归档失败" : "取消归档失败");
    }
  }

  async function deleteSession(session: ChatSession) {
    if (!window.confirm(`删除会话「${session.title}」？`)) return;
    try {
      setError("");
      setSessionMenu(null);
      await api.deleteSession(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (active?.id === session.id) {
        const nextSession = remaining[0] || null;
        setDraftSessionActive(false);
        draftSessionActiveRef.current = false;
        activeRef.current = nextSession;
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
    const previewUrl = URL.createObjectURL(file);
    const localId = nextPendingAttachmentIdRef.current;
    nextPendingAttachmentIdRef.current -= 1;
    const pending: PendingAttachment = {
      id: localId,
      mime_type: file.type || "image/*",
      size: file.size,
      expires_at: "",
      url: "",
      previewUrl,
      dataUrl: "",
      name: file.name || "图片",
      status: "uploading"
    };
    setAttachments((current) => [...current, pending]);
    setUploadingCount((current) => current + 1);
    try {
      const prepared = await prepareImageForUpload(file);
      const uploaded = await api.upload(prepared.file);
      setError("");
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === localId
            ? {
                ...uploaded,
                previewUrl,
                dataUrl: prepared.dataUrl,
                name: pending.name,
                status: "ready"
              }
            : attachment
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "图片上传失败";
      setError(message);
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.id === localId
            ? {
                ...attachment,
                status: "failed",
                error: message
              }
            : attachment
        )
      );
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

  async function handleScreenshotCapture() {
    if (busy || isUploading || capturingScreenshot) return;
    setCapturingScreenshot(true);
    setError("");
    try {
      setScreenshotCanvas(await captureScreenCanvas());
    } catch (err) {
      if (!isScreenshotCancel(err)) {
        setError(err instanceof Error ? err.message : "截图失败，请重试");
      }
    } finally {
      setCapturingScreenshot(false);
    }
  }

  function handleScreenshotConfirm(file: File) {
    setScreenshotCanvas(null);
    uploadFile(file).catch((err) => setError(err.message));
  }

  async function sendMessage() {
    const content = input.trim();
    if ((!content && !hasReadyAttachments) || busy || sendLockRef.current) return;
    if (uploadingCount > 0) {
      setError("图片上传中，请稍等");
      return;
    }
    if (attachments.some((attachment) => attachment.status === "failed")) {
      setError("请先删除上传失败的图片");
      return;
    }
    const readyAttachments = attachments.filter((attachment) => attachment.status === "ready");
    let session = active;
    if (!session) {
      const sessionTitle = content ? content.slice(0, 24) : "图片消息";
      const createdSession = await api.createSession(sessionTitle, model);
      session = createdSession;
      setDraftSessionActive(false);
      draftSessionActiveRef.current = false;
      activeRef.current = createdSession;
      skipNextMessageLoadSessionIdRef.current = createdSession.id;
      setActive(createdSession);
      setSessions((current) => [createdSession, ...current.filter((item) => item.id !== createdSession.id)]);
    }
    const pendingUser: Message = {
      id: Date.now(),
      role: "user",
      content,
      model,
      created_at: new Date().toISOString(),
      attachments: readyAttachments
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
    sendLockRef.current = true;
    setBusy(true);
    setError("");
    activeStreamAbortRef.current?.abort();
    const abortController = new AbortController();
    activeStreamAbortRef.current = abortController;
    const tokenFlush = createTokenFlushController((text) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistant.id ? { ...message, content: message.content + text } : message
        )
      );
    });
    try {
      await streamChat(
        {
          session_id: session.id,
          content,
          model,
          attachment_ids: readyAttachments.map((item) => item.id),
          image_data_urls: readyAttachments.map((item) => item.dataUrl).filter(Boolean)
        },
        tokenFlush.push,
        { signal: abortController.signal }
      );
      tokenFlush.flush();
      await refreshSessions();
    } catch (err) {
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : "发送失败");
      }
    } finally {
      tokenFlush.flush();
      if (activeStreamAbortRef.current === abortController) activeStreamAbortRef.current = null;
      sendLockRef.current = false;
      setBusy(false);
    }
  }

  async function regenerateAssistantMessage(assistantMessage: Message) {
    if (!active || busy || regenerateLockRef.current) return;
    const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
    const lastUserMessage = messages
      .slice(0, assistantIndex)
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUserMessage) {
      setError("没有可重新生成的用户消息");
      return;
    }
    const replacement: Message = {
      id: assistantMessage.id,
      role: "assistant",
      content: "",
      model,
      created_at: new Date().toISOString(),
      attachments: []
    };
    setMessages((current) => current.filter((message) => message.id !== assistantMessage.id));
    setMessages((current) => {
      const userIndex = current.findIndex((message) => message.id === lastUserMessage.id);
      if (userIndex < 0) return [...current, replacement];
      return [...current.slice(0, userIndex + 1), replacement, ...current.slice(userIndex + 1)];
    });
    regenerateLockRef.current = true;
    setBusy(true);
    setError("");
    activeStreamAbortRef.current?.abort();
    const abortController = new AbortController();
    activeStreamAbortRef.current = abortController;
    const tokenFlush = createTokenFlushController((text) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === replacement.id ? { ...message, content: message.content + text } : message
        )
      );
    });
    try {
      await regenerateChat(
        {
          session_id: active.id,
          assistant_message_id: assistantMessage.id,
          model,
          content: lastUserMessage.content,
          attachment_ids: lastUserMessage.attachments.map((attachment) => attachment.id)
        },
        tokenFlush.push,
        { signal: abortController.signal }
      );
      tokenFlush.flush();
      const refreshedMessages = await api.messages(active.id);
      setMessages(refreshedMessages);
      await refreshSessions();
    } catch (err) {
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : "重新生成失败");
      }
    } finally {
      tokenFlush.flush();
      if (activeStreamAbortRef.current === abortController) activeStreamAbortRef.current = null;
      regenerateLockRef.current = false;
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  const isEmptyChat = !messagesLoading && messages.length === 0;
  const isUploading = uploadingCount > 0;
  const screenshotDisabled = isUploading || busy || capturingScreenshot;
  const hasReadyAttachments = attachments.some((attachment) => attachment.status === "ready");
  const hasFailedAttachments = attachments.some((attachment) => attachment.status === "failed");
  const composer = (
    <footer className={`composer ${isEmptyChat ? "composer-floating" : ""}`}>
      {error && <div className="form-error">{error}</div>}
      <div className="composer-shell">
        {attachments.length > 0 && (
          <div className="attachment-grid" aria-label="已附加图片">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className={`attachment-preview ${
                  attachment.status === "uploading"
                    ? "is-uploading"
                    : attachment.status === "failed"
                      ? "is-failed"
                      : "is-ready"
                }`}
              >
                <img src={attachment.previewUrl} alt={attachment.name} />
                {attachment.status === "uploading" && (
                  <div className="attachment-upload-overlay" aria-label="图片上传中">
                    <span className="attachment-upload-spinner" />
                    <span className="attachment-upload-label">上传中</span>
                  </div>
                )}
                {attachment.status === "failed" && (
                  <div className="attachment-upload-overlay attachment-upload-error" aria-label={attachment.error || "图片上传失败"}>
                    <span className="attachment-upload-label">失败</span>
                  </div>
                )}
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
        <div className="composer-row">
          <label
            className={`icon-button ${isUploading || busy ? "disabled" : ""}`}
            title="上传图片"
            aria-disabled={isUploading || busy}
          >
            <ImagePlus size={18} />
            <input type="file" accept="image/*" hidden onChange={handleFileSelect} disabled={isUploading || busy} />
          </label>
          <button
            type="button"
            className={`icon-button ${screenshotDisabled ? "disabled" : ""}`}
            onClick={handleScreenshotCapture}
            disabled={screenshotDisabled}
            title="截图"
            aria-label="截图"
          >
            <Camera size={18} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入问题，或直接粘贴图片..."
            rows={1}
          />
          <button className="send-button" onClick={sendMessage} disabled={busy || isUploading || hasFailedAttachments || (!input.trim() && !hasReadyAttachments)}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </footer>
  );

  return (
    <div className={sidebarOpen ? "workspace" : "workspace sidebar-collapsed"}>
      {screenshotCanvas && (
        <ScreenshotEditor
          sourceCanvas={screenshotCanvas}
          onCancel={() => setScreenshotCanvas(null)}
          onConfirm={handleScreenshotConfirm}
        />
      )}
      {sidebarOpen && (
        <button
          type="button"
          className="session-drawer-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-label="关闭会话历史"
        />
      )}
      <aside className="sessions-pane">
        {sidebarOpen && (
          <>
            <div className="sessions-pane-head">
              <div>
                <span>会话</span>
                <strong>{regularSessions.length} 个最近会话</strong>
              </div>
              <button
                type="button"
                className="session-drawer-close"
                onClick={() => setSidebarOpen(false)}
                aria-label="关闭会话历史"
                title="关闭"
              >
                <X size={17} />
              </button>
            </div>
            <button className="new-session" onClick={newSession}>
              <Plus size={16} />
              新会话
            </button>
            <p className="session-retention-note">最近 7 天会话会保留，报告长期保存。</p>
            <div className="session-sections">
              <div className="session-section session-section-main">
                <div className="session-section-head">
                  <span>最近会话</span>
                  <small>{regularSessions.length}</small>
                </div>
                <div className="session-section-list">
                  {sessionsLoading && !sessions.length ? <div className="session-empty">正在加载会话...</div> : null}
                  {regularSessions.map((session) => (
                    <div
                      key={session.id}
                      className={active?.id === session.id ? "session-row active" : "session-row"}
                      onContextMenu={(event) => openSessionMenu(event, session)}
                    >
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
                  {!sessionsLoading && !regularSessions.length && <div className="session-empty">暂无最近会话</div>}
                </div>
              </div>
              <div className="session-section session-section-archived">
                <div className="session-section-head">
                  <span>已归档</span>
                  <small>{archivedSessions.length}</small>
                </div>
                <div className="session-section-list">
                  {archivedSessions.map((session) => (
                    <div
                      key={session.id}
                      className={active?.id === session.id ? "session-row active" : "session-row"}
                      onContextMenu={(event) => openSessionMenu(event, session)}
                    >
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
                  {!sessionsLoading && !archivedSessions.length && <div className="session-empty">暂无归档会话</div>}
                </div>
              </div>
            </div>
            {sessionMenu && (
              <div
                className="session-context-menu"
                style={{ left: sessionMenu.x, top: sessionMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                {sessionMenu.session.is_archived ? (
                  <button type="button" onClick={() => archiveSession(sessionMenu.session, false)}>
                    <ArchiveRestore size={15} />
                    取消归档
                  </button>
                ) : (
                  <button type="button" onClick={() => archiveSession(sessionMenu.session, true)}>
                    <Archive size={15} />
                    归档
                  </button>
                )}
                <button type="button" onClick={() => deleteSession(sessionMenu.session)}>
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            )}
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
              {chatModelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </header>
        <div className={isEmptyChat || (messagesLoading && !messages.length) ? "messages empty-chat" : "messages"}>
          {messagesLoading && !messages.length ? (
            <div className="empty-chat-content empty-chat-loading">
              <TranslationLoading />
              <span>正在加载消息...</span>
            </div>
          ) : isEmptyChat ? (
            <div className="empty-chat-content">
              <h1 className="empty-chat-greeting">{openingLine}</h1>
              {composer}
            </div>
          ) : (
            <>
              {messages.map((message) => {
                const isAssistantThinking = message.role === "assistant" && busy && !message.content.trim();
                return (
                  <div key={message.id} className={`message ${message.role}`}>
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
                        <>
                          <MessageMarkdown markdown={message.content} copyable={message.role === "assistant"} />
                          {message.role === "assistant" && (
                            <MessageActions
                              text={message.content}
                              onRegenerate={() => regenerateAssistantMessage(message)}
                              disabled={busy}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
            </>
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
  const [generationStatuses, setGenerationStatuses] = useState<ReportGenerationStatus[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportContentLoading, setReportContentLoading] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState("");
  const [reportError, setReportError] = useState("");
  const reportListRequestRef = useRef(0);
  const reportContentRequestRef = useRef(0);
  const reportContentCacheRef = useRef<Map<number, ReportContent>>(new Map());

  async function loadReportContent(item: ReportItem) {
    const cached = reportContentCacheRef.current.get(item.id);
    if (cached) return cached;
    const content = await api.report(item.id);
    reportContentCacheRef.current.set(content.id, content);
    return content;
  }

  useEffect(() => {
    const listRequestId = ++reportListRequestRef.current;
    const contentRequestId = ++reportContentRequestRef.current;
    setReportsLoading(true);
    setReportContentLoading(true);
    setReportError("");
    Promise.all([
      api.reports(type, month),
      api.reportGenerationStatuses(type, month).catch(() => [] as ReportGenerationStatus[])
    ])
      .then(async ([reports, statuses]) => {
        if (listRequestId !== reportListRequestRef.current) return;
        setItems(reports);
        setGenerationStatuses(statuses);
        if (!reports[0]) {
          setActive(null);
          setReportsLoading(false);
          return;
        }
        setReportsLoading(false);
        const content = await loadReportContent(reports[0]);
        if (listRequestId !== reportListRequestRef.current || contentRequestId !== reportContentRequestRef.current) return;
        setActive(content);
      })
      .catch((err) => {
        if (listRequestId !== reportListRequestRef.current) return;
        setItems([]);
        setGenerationStatuses([]);
        setActive(null);
        setReportError(err instanceof Error ? err.message : "报告加载失败");
      })
      .finally(() => {
        if (contentRequestId === reportContentRequestRef.current) setReportContentLoading(false);
      });
  }, [month, type]);

  const totalMessages = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.stats.message_count || 0), 0),
    [items]
  );
  const reportTypeLabel = type === "daily" ? "日报" : type === "weekly" ? "周报" : "月报";
  const latestGenerationStatus = useMemo(
    () => generationStatuses.find((status) => status.status === "running") || generationStatuses.find((status) => status.status !== "success") || null,
    [generationStatuses]
  );

  function exportReportPdf() {
    if (!active || exportingPdf) return;
    const reportId = active.id;
    const filename = `${active.period}-${reportTypeLabel}.pdf`;
    const targetPromise = pickPdfSaveTarget(filename);
    setExportingPdf(true);
    setExportError("");
    void (async () => {
      try {
        const target = await targetPromise;
        if (target.kind === "cancelled") return;
        const blob = await api.reportPdf(reportId);
        await savePdfBlob(blob, filename, target);
      } catch (error) {
        setExportError(error instanceof Error ? error.message : "PDF 导出失败");
      } finally {
        setExportingPdf(false);
      }
    })();
  }

  async function selectReport(item: ReportItem) {
    const requestId = ++reportContentRequestRef.current;
    setReportContentLoading(true);
    setReportError("");
    try {
      const cached = reportContentCacheRef.current.get(item.id);
      if (cached) {
        setActive(cached);
        setReportContentLoading(false);
        return;
      }
      const content = await api.report(item.id);
      if (requestId !== reportContentRequestRef.current) return;
      reportContentCacheRef.current.set(content.id, content);
      setActive(content);
    } catch (error) {
      if (requestId !== reportContentRequestRef.current) return;
      setReportError(error instanceof Error ? error.message : "报告加载失败");
    } finally {
      if (requestId === reportContentRequestRef.current) setReportContentLoading(false);
    }
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
        {reportsLoading && !items.length ? <div className="empty-state compact">正在加载报告...</div> : null}
        {items.map((item) => (
          <button key={item.id} className="report-item" onClick={() => selectReport(item)}>
            <FileText size={15} />
            <span>{item.period}</span>
          </button>
        ))}
      </section>
      <section className="report-content">
        {latestGenerationStatus ? (
          <div className={`report-generation-status is-${latestGenerationStatus.status}`}>
            {latestGenerationStatus.status === "running" ? <span className="report-status-spinner" aria-hidden="true" /> : null}
            <div>
              <strong>{reportGenerationTitle(latestGenerationStatus, reportTypeLabel)}</strong>
              <span>{reportGenerationMessage(latestGenerationStatus)}</span>
            </div>
          </div>
        ) : null}
        {reportError && <div className="form-error report-export-error">{reportError}</div>}
        {reportContentLoading && !active ? (
          <div className="empty-state">正在加载报告内容...</div>
        ) : active ? (
          <>
            <div className="report-toolbar">
              <div>
                <span>{active.period}</span>
                <strong>{reportTypeLabel}</strong>
              </div>
              <button
                className="secondary-button compact print-export-button"
                onClick={exportReportPdf}
                disabled={exportingPdf}
              >
                <Download size={16} />
                {exportingPdf ? "导出中..." : "导出 PDF"}
              </button>
            </div>
            {exportError && <div className="form-error report-export-error">{exportError}</div>}
            <MarkdownPreview markdown={active.markdown} />
          </>
        ) : reportContentLoading ? (
          <div className="empty-state">{reportContentLoading ? "正在加载报告内容..." : ""}</div>
        ) : (
          <div className="empty-state">{reportsLoading ? "正在加载报告..." : "这个月份还没有报告。"}</div>
        )}
      </section>
    </div>
  );
}

function TranslationView({ wordCloudEnabled }: { wordCloudEnabled: boolean }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<TranslationEntry | null>(null);
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const historyRequestId = useRef(0);

  async function refreshTranslationEntries() {
    const requestId = historyRequestId.current + 1;
    historyRequestId.current = requestId;
    const history = await api.translationEntries();
    if (requestId !== historyRequestId.current) return;
    setEntries(history);
  }

  useEffect(() => {
    Promise.all([api.translationPrompt(), refreshTranslationEntries()])
      .then(([prompt]) => {
        setPromptDraft(prompt.system_prompt);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "翻译模块加载失败"))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    function handleEntriesCleared() {
      setEntries([]);
      setResult(null);
    }

    window.addEventListener(translationEntriesClearedEvent, handleEntriesCleared);
    return () => window.removeEventListener(translationEntriesClearedEvent, handleEntriesCleared);
  }, []);

  useEffect(() => {
    if (!entries.some((entry) => isTranslationDetailPending(entry))) return;
    const timer = window.setInterval(() => {
      refreshTranslationEntries().catch(() => undefined);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [entries]);

  async function submitTranslation() {
    const text = input.trim();
    if (!text || busy) return;
    if (input.length > translationInputLimit) {
      setSaved("");
      setError("输入超过 2000 字，已超限，不予翻译。");
      return;
    }
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const translated = await api.translate(text);
      setResult(translated);
      setEntries((current) => [translated, ...current.filter((item) => item.id !== translated.id)].slice(0, 30));
      void refreshTranslationEntries();
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

  const updatedResult = result ? entries.find((entry) => entry.id === result.id) || result : null;
  const activeResult = updatedResult || entries.find((entry) => !entry.is_auto_detail) || entries[0] || null;
  const isTranslationOverLimit = input.length > translationInputLimit;
  const translationMetaText = `${input.length}/${translationInputLimit}`;

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
              onChange={(event) => {
                setInput(event.target.value);
                if (event.target.value.length <= translationInputLimit && error === "输入超过 2000 字，已超限，不予翻译。") {
                  setError("");
                }
              }}
              placeholder="输入中文、英文单词、短语或句子..."
            />
            <div className={isTranslationOverLimit ? "translation-input-meta over-limit" : "translation-input-meta"}>
              <span>{isTranslationOverLimit ? "输入超过 2000 字，已超限，不予翻译。" : "最多 2000 字"}</span>
              <strong>{translationMetaText}</strong>
            </div>
          </section>

          <div className="translation-submit-slot">
            <button
              className={busy ? "translation-submit is-loading" : "translation-submit"}
              onClick={submitTranslation}
              disabled={busy || !input.trim() || isTranslationOverLimit}
              aria-label={busy ? "正在翻译" : "翻译"}
            >
              <span className="translation-submit-label">翻译</span>
              <span className="translation-submit-loader">
                <TranslationLoading />
              </span>
            </button>
          </div>

          <section className={busy ? "translation-card translation-result is-loading" : "translation-card translation-result"}>
            <div className="translation-card-head">
              <span>结果</span>
              <strong>{activeResult ? sourceKindLabel(activeResult.source_kind) : "等待输入"}</strong>
            </div>
            <div className="translation-result-content">
              {activeResult ? (
                isTranslationDetailPending(activeResult) && !activeResult.result_markdown.trim() ? (
                  <div className="word-cloud-detail-loading">
                    <TranslationLoading />
                    <span>正在生成词条详解</span>
                  </div>
                ) : activeResult.detail_status === "failed" && !activeResult.result_markdown.trim() ? (
                  <div className="form-error">词条详解生成失败，稍后再试。</div>
                ) : (
                  <>
                    <TranslationPhonetic phonetic={activeResult.phonetic} />
                    <MarkdownRenderer markdown={activeResult.result_markdown} className="translation-markdown" />
                  </>
                )
              ) : historyLoading ? (
                <div className="translation-empty">正在加载翻译历史...</div>
              ) : (
                <div className="translation-empty">输入内容后，这里会显示简洁译文、重点拆解和例句。</div>
              )}
            </div>
            {busy && (
              <div className="translation-result-loading">
                <TranslationLoading />
                <span>正在整理译文</span>
              </div>
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

        {wordCloudEnabled ? (
          <TranslationWordCloud
            entries={entries}
            activeId={activeResult?.id || null}
            onSelect={setResult}
            onDictionaryEntry={(entry) =>
              setEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 30))
            }
          />
        ) : null}
      </div>
    </section>
  );
}

function sourceKindLabel(kind: TranslationEntry["source_kind"]) {
  if (kind === "chinese") return "中文 -> English";
  if (kind === "word") return "Word";
  return "English -> 中文";
}

const defaultAppSettings: AppSettings = {
  daily_report_enabled: true,
  daily_report_time: "23:00",
  weekly_report_time: "23:00",
  weekly_report_day: "sun",
  word_cloud_enabled: true
};

const weeklyReportDays = [
  { value: "mon", label: "周一" },
  { value: "tue", label: "周二" },
  { value: "wed", label: "周三" },
  { value: "thu", label: "周四" },
  { value: "fri", label: "周五" },
  { value: "sat", label: "周六" },
  { value: "sun", label: "周日" }
];

function SettingsView({
  settings,
  onSaved,
  isAdmin,
  loading
}: {
  settings: AppSettings | null;
  onSaved: (settings: AppSettings) => void;
  isAdmin: boolean;
  loading: boolean;
}) {
  const currentSettings = settings || defaultAppSettings;
  const [dailyReportEnabled, setDailyReportEnabled] = useState(currentSettings.daily_report_enabled);
  const [dailyTime, setDailyTime] = useState(currentSettings.daily_report_time);
  const [weeklyTime, setWeeklyTime] = useState(currentSettings.weekly_report_time);
  const [weeklyDay, setWeeklyDay] = useState(currentSettings.weekly_report_day);
  const [wordCloudEnabled, setWordCloudEnabled] = useState(currentSettings.word_cloud_enabled);
  const [busy, setBusy] = useState(false);
  const [clearingEntries, setClearingEntries] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const settingsAutoSave = useRef<number | null>(null);
  const settingsLoaded = useRef(false);
  const skipSettingsAutoSave = useRef(false);

  useEffect(() => {
    const nextSettings = settings || defaultAppSettings;
    skipSettingsAutoSave.current = true;
    setDailyReportEnabled(nextSettings.daily_report_enabled);
    setDailyTime(nextSettings.daily_report_time);
    setWeeklyTime(nextSettings.weekly_report_time);
    setWeeklyDay(nextSettings.weekly_report_day);
    setWordCloudEnabled(nextSettings.word_cloud_enabled);
    settingsLoaded.current = Boolean(settings);
  }, [settings]);

  useEffect(() => {
    if (!settingsLoaded.current) return;
    if (skipSettingsAutoSave.current) {
      skipSettingsAutoSave.current = false;
      return;
    }
    if (
      settings &&
      dailyReportEnabled === settings.daily_report_enabled &&
      dailyTime === settings.daily_report_time &&
      weeklyTime === settings.weekly_report_time &&
      weeklyDay === settings.weekly_report_day &&
      wordCloudEnabled === settings.word_cloud_enabled
    ) {
      return;
    }

    if (settingsAutoSave.current) window.clearTimeout(settingsAutoSave.current);
    settingsAutoSave.current = window.setTimeout(async () => {
      setBusy(true);
      setError("");
      setSaved("");
      try {
        const updated = await api.updateSettings({
          daily_report_enabled: dailyReportEnabled,
          daily_report_time: dailyTime,
          weekly_report_time: weeklyTime,
          weekly_report_day: weeklyDay,
          word_cloud_enabled: wordCloudEnabled
        });
        onSaved(updated);
        setSaved("设置已保存");
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
      } finally {
        setBusy(false);
      }
    }, 500);

    return () => {
      if (settingsAutoSave.current) window.clearTimeout(settingsAutoSave.current);
    };
  }, [dailyReportEnabled, dailyTime, weeklyTime, weeklyDay, wordCloudEnabled, settings, onSaved]);

  async function clearTranslationEntries() {
    if (clearingEntries || !window.confirm("确定清空当前账号的词条和词云记录吗？")) return;
    setClearingEntries(true);
    setError("");
    setSaved("");
    try {
      await api.clearTranslationEntries();
      window.dispatchEvent(new Event(translationEntriesClearedEvent));
      setSaved("词条记录已清空");
    } catch (err) {
      setError(err instanceof Error ? err.message : "清空失败");
    } finally {
      setClearingEntries(false);
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-content">
        {loading ? <div className="empty-state">正在加载设置...</div> : null}
        <section className="settings-card">
          <div className="settings-card-head">
            <span>报告生成时间</span>
            <strong>Asia/Shanghai</strong>
          </div>
          <div className="settings-row">
            <div>
              <span>日报</span>
              <p>关闭后当前账号不再自动生成日报，周报和月报继续生成。</p>
            </div>
            <button
              className={dailyReportEnabled ? "settings-toggle is-on" : "settings-toggle"}
              onClick={() => setDailyReportEnabled((current) => !current)}
              role="switch"
              aria-checked={dailyReportEnabled}
              type="button"
            >
              <span />
            </button>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span>日报时间</span>
              <input
                type="time"
                value={dailyTime}
                onChange={(event) => setDailyTime(event.target.value)}
                disabled={!dailyReportEnabled}
              />
            </label>
            <label className="settings-field">
              <span>周报日期</span>
              <select value={weeklyDay} onChange={(event) => setWeeklyDay(event.target.value)}>
                {weeklyReportDays.map((day) => (
                  <option key={day.value} value={day.value}>
                    {day.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>周报时间</span>
              <input type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} />
            </label>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-row">
            <div>
              <span>词云</span>
              <p>关闭后仅隐藏前端词云，翻译数据继续保留。</p>
            </div>
            <button
              className={wordCloudEnabled ? "settings-toggle is-on" : "settings-toggle"}
              onClick={() => setWordCloudEnabled((current) => !current)}
              disabled={!isAdmin}
              role="switch"
              aria-checked={wordCloudEnabled}
              type="button"
            >
              <span />
            </button>
          </div>
          <div className="settings-row">
            <div>
              <span>词条记录</span>
              <p>清空当前账号的翻译历史和词云内容。</p>
            </div>
            <button className="secondary-button compact danger" type="button" onClick={clearTranslationEntries} disabled={clearingEntries}>
              <Trash2 size={16} />
              {clearingEntries ? "清空中..." : "清空词条"}
            </button>
          </div>
        </section>

        {!isAdmin && <div className="form-success">报告生成时间仅作用于当前账号，词云开关需要管理员权限。</div>}
        {(error || saved || busy) && <div className={error ? "form-error" : "form-success"}>{error || saved || "正在保存..."}</div>}
      </div>
    </section>
  );
}

function AdminView() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageSummary[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  type ProviderFormState = {
    baseUrl: string;
    apiKey: string;
    textModel: string;
    visionModel: string;
    translationModel: string;
    reportModel: string;
    enabledTextModels: string[];
    enabledVisionModels: string[];
    availableTextModels: string[];
    availableVisionModels: string[];
  };
  const emptyProviderState = (provider: AiProviderName): ProviderFormState => ({
    baseUrl: provider === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4" : provider === "deepseek" ? "https://api.deepseek.com" : "",
    apiKey: "",
    textModel: fallbackProviderModels[provider].text[0] || "",
    visionModel: fallbackProviderModels[provider].vision[0] || "",
    translationModel: fallbackProviderModels[provider].text[0] || "",
    reportModel: fallbackProviderModels[provider].text[0] || "",
    enabledTextModels: fallbackProviderModels[provider].text,
    enabledVisionModels: fallbackProviderModels[provider].vision,
    availableTextModels: fallbackProviderModels[provider].text,
    availableVisionModels: fallbackProviderModels[provider].vision
  });
  const [providerStates, setProviderStates] = useState<Record<AiProviderName, ProviderFormState>>(() => ({
    gpt: emptyProviderState("gpt"),
    zhipu: emptyProviderState("zhipu"),
    deepseek: emptyProviderState("deepseek")
  }));
  const [expandedProvider, setExpandedProvider] = useState<AiProviderName | null>(null);
  const [defaultTextModel, setDefaultTextModel] = useState(complexModel);
  const [defaultVisionModel, setDefaultVisionModel] = useState(complexModel);
  const [translationModel, setTranslationModel] = useState(defaultModel);
  const [reportModel, setReportModel] = useState(complexModel);
  const [detectingProvider, setDetectingProvider] = useState<AiProviderName | null>(null);
  const [loadingAdmin, setLoadingAdmin] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [savingAiConfig, setSavingAiConfig] = useState(false);

  function uniqueModelOptions(models: string[]) {
    return Array.from(new Set(models.map((item) => item.trim()).filter(Boolean)));
  }

  function providerDisplayName(provider: AiProviderName) {
    if (provider === "zhipu") return "ZHIPU";
    if (provider === "deepseek") return "DeepSeek";
    return "GPT";
  }

  function providerStateFromConfig(config: AiConfig, provider: AiProviderName): ProviderFormState {
    const providerConfig = config.providers[provider];
    const fallback = fallbackProviderModels[provider];
    return {
      baseUrl: providerConfig.base_url,
      apiKey: "",
      textModel: providerConfig.text_model,
      visionModel: providerConfig.vision_model,
      translationModel: providerConfig.translation_model,
      reportModel: providerConfig.report_model,
      enabledTextModels: providerConfig.enabled_text_models,
      enabledVisionModels: providerConfig.enabled_vision_models,
      availableTextModels: uniqueModelOptions([
        ...config.available_models[provider].text,
        ...providerConfig.enabled_text_models,
        ...fallback.text
      ]),
      availableVisionModels: uniqueModelOptions([
        ...config.available_models[provider].vision,
        ...providerConfig.enabled_vision_models,
        ...fallback.vision
      ])
    };
  }

  function applyAiConfig(config: AiConfig) {
    setAiConfig(config);
    setDefaultTextModel(config.text_model);
    setDefaultVisionModel(config.vision_model);
    setTranslationModel(config.translation_model);
    setReportModel(config.report_model);
    setProviderStates({
      gpt: providerStateFromConfig(config, "gpt"),
      zhipu: providerStateFromConfig(config, "zhipu"),
      deepseek: providerStateFromConfig(config, "deepseek")
    });
  }

  function updateProviderState(provider: AiProviderName, patch: Partial<ProviderFormState>) {
    setProviderStates((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...patch
      }
    }));
  }

  function toggleModel(provider: AiProviderName, kind: "text" | "vision", model: string) {
    setProviderStates((current) => {
      const state = current[provider];
      const key = kind === "text" ? "enabledTextModels" : "enabledVisionModels";
      const enabled = state[key];
      const nextEnabled = enabled.includes(model) ? enabled.filter((item) => item !== model) : [...enabled, model];
      const nextState = { ...state, [key]: nextEnabled };
      if (kind === "text" && !nextEnabled.includes(nextState.textModel)) {
        nextState.textModel = nextEnabled[0] || "";
        nextState.translationModel = nextEnabled.includes(nextState.translationModel) ? nextState.translationModel : nextState.textModel;
        nextState.reportModel = nextEnabled.includes(nextState.reportModel) ? nextState.reportModel : nextState.textModel;
      }
      if (kind === "vision" && !nextEnabled.includes(nextState.visionModel)) {
        nextState.visionModel = nextEnabled[0] || "";
      }
      return { ...current, [provider]: nextState };
    });
  }

  const allTextModels = useMemo(
    () => uniqueModelOptions(providerNames.flatMap((provider) => providerStates[provider].enabledTextModels)),
    [providerStates]
  );
  const allVisionModels = useMemo(
    () => uniqueModelOptions(providerNames.flatMap((provider) => providerStates[provider].enabledVisionModels)),
    [providerStates]
  );

  useEffect(() => {
    if (!allTextModels.length) return;
    setDefaultTextModel((current) => (allTextModels.includes(current) ? current : allTextModels[0] || current));
    setTranslationModel((current) => (allTextModels.includes(current) ? current : allTextModels[0] || current));
    setReportModel((current) => (allTextModels.includes(current) ? current : allTextModels[0] || current));
  }, [allTextModels]);

  useEffect(() => {
    setDefaultVisionModel((current) => (allVisionModels.includes(current) ? current : allVisionModels[0] || ""));
  }, [allVisionModels]);

  async function refresh() {
    const [inviteItems, config, usage] = await Promise.all([api.invites(), api.aiConfig(), api.tokenUsage()]);
    setInvites(inviteItems);
    setTokenUsage(usage);
    applyAiConfig(config);
  }

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoadingAdmin(false));
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
      setSavingAiConfig(true);
      const providers: AiConfigPatch["providers"] = {};
      for (const provider of providerNames) {
        const state = providerStates[provider];
        providers[provider] = {
          base_url: state.baseUrl,
          api_key: state.apiKey || undefined,
          text_model: state.textModel,
          vision_model: state.visionModel,
          translation_model: state.translationModel,
          report_model: state.reportModel,
          enabled_text_models: state.enabledTextModels,
          enabled_vision_models: state.enabledVisionModels
        };
      }
      const config = await api.updateAiConfig({
        default_text_model: defaultTextModel,
        default_vision_model: defaultVisionModel,
        translation_model: translationModel,
        report_model: reportModel,
        providers
      });
      applyAiConfig(config);
      setSaved("AI 配置已保存");
      window.dispatchEvent(new Event(aiConfigChangedEvent));
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingAiConfig(false);
    }
  }

  async function testAiConfig() {
    try {
      setError("");
      setSaved("");
      setTestResult("");
      setTesting(true);
      const providers: AiConfigPatch["providers"] = {};
      for (const provider of providerNames) {
        const state = providerStates[provider];
        providers[provider] = {
          base_url: state.baseUrl,
          api_key: state.apiKey || undefined,
          text_model: state.textModel,
          vision_model: state.visionModel,
          translation_model: state.translationModel,
          report_model: state.reportModel,
          enabled_text_models: state.enabledTextModels,
          enabled_vision_models: state.enabledVisionModels
        };
      }
      const result = await api.testAiConfig({
        default_text_model: defaultTextModel,
        default_vision_model: defaultVisionModel,
        translation_model: translationModel,
        report_model: reportModel,
        providers
      });
      setTestResult(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function discoverModels(provider: AiProviderName) {
    const state = providerStates[provider];
    try {
      setError("");
      setSaved("");
      setTestResult("");
      setDetectingProvider(provider);
      const result = await api.discoverAiModels({
        provider,
        base_url: state.baseUrl,
        api_key: state.apiKey || undefined
      });
      if (!result.ok) {
        setTestResult(result.message);
        return;
      }
      updateProviderState(provider, {
        availableTextModels: uniqueModelOptions([...state.availableTextModels, ...result.models]),
        availableVisionModels: uniqueModelOptions([...state.availableVisionModels, ...result.models])
      });
      setTestResult(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "检测失败");
    } finally {
      setDetectingProvider(null);
    }
  }

  function toggleProvider(provider: AiProviderName) {
    setExpandedProvider((current) => (current === provider ? null : provider));
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
        {loadingAdmin ? (
          <div className="empty-state">正在加载 AI 配置...</div>
        ) : (
        <form className="admin-form" onSubmit={saveAiConfig}>
          <div className="admin-model-grid">
            <label>
              默认对话模型
              <select value={defaultTextModel} onChange={(event) => setDefaultTextModel(event.target.value)} disabled={!allTextModels.length}>
                {allTextModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              图片消息视觉模型
              <select
                value={defaultVisionModel}
                onChange={(event) => setDefaultVisionModel(event.target.value)}
                disabled={!allVisionModels.length}
              >
                {!allVisionModels.length && <option value="">未开放视觉模型</option>}
                {allVisionModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              翻译模型
              <select value={translationModel} onChange={(event) => setTranslationModel(event.target.value)} disabled={!allTextModels.length}>
                {allTextModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              日报模型
              <select value={reportModel} onChange={(event) => setReportModel(event.target.value)} disabled={!allTextModels.length}>
                {allTextModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="provider-grid">
            {providerNames.map((provider) => {
              const state = providerStates[provider];
              const currentProviderConfig = aiConfig?.providers[provider];
              const isActive = aiConfig?.active_provider === provider;
              return (
                <section className="provider-card" key={provider}>
                  <button
                    type="button"
                    className="provider-row-button"
                    onClick={() => toggleProvider(provider)}
                    aria-expanded={expandedProvider === provider}
                  >
                    <span className="provider-row-title">
                      <strong>{providerDisplayName(provider)}</strong>
                      {isActive && <span className="provider-active-badge">默认通道</span>}
                    </span>
                    <span className="provider-row-meta">
                      {state.apiKey
                        ? "新密钥待保存"
                        : currentProviderConfig?.api_key_preview
                          ? `当前密钥 ${currentProviderConfig.api_key_preview}`
                          : "密钥未配置"}
                      {" · "}
                      {state.enabledTextModels.length} 个语言模型
                    </span>
                    <ChevronDown size={16} />
                  </button>
                  {expandedProvider === provider && (
                    <div className="provider-card-body">
                      <label>
                        Base URL
                        <input value={state.baseUrl} onChange={(event) => updateProviderState(provider, { baseUrl: event.target.value })} required />
                      </label>
                      <label>
                        API Key
                        <input
                          value={state.apiKey}
                          onChange={(event) => updateProviderState(provider, { apiKey: event.target.value })}
                          type="password"
                          placeholder={currentProviderConfig?.has_api_key ? "留空则保持当前密钥" : "请输入 API Key"}
                        />
                      </label>
                      <button
                        className="secondary-button compact provider-detect-button"
                        type="button"
                        onClick={() => discoverModels(provider)}
                        disabled={detectingProvider === provider}
                      >
                        <RefreshCw size={16} />
                        {detectingProvider === provider ? "检测中..." : "检测上游模型"}
                      </button>
                      <div className="model-group">
                        <div className="model-group-head">
                          <span>开放语言模型</span>
                          <strong>{state.enabledTextModels.length}</strong>
                        </div>
                        <div className="model-checkbox-grid">
                          {state.availableTextModels.map((modelName) => (
                            <label className="model-checkbox" key={`${provider}-text-${modelName}`}>
                              <input
                                type="checkbox"
                                checked={state.enabledTextModels.includes(modelName)}
                                onChange={() => toggleModel(provider, "text", modelName)}
                              />
                              <span>{modelName}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="model-group">
                        <div className="model-group-head">
                          <span>开放视觉模型</span>
                          <strong>{state.enabledVisionModels.length}</strong>
                        </div>
                        <div className="model-checkbox-grid">
                          {state.availableVisionModels.length ? (
                            state.availableVisionModels.map((modelName) => (
                              <label className="model-checkbox" key={`${provider}-vision-${modelName}`}>
                                <input
                                  type="checkbox"
                                  checked={state.enabledVisionModels.includes(modelName)}
                                  onChange={() => toggleModel(provider, "vision", modelName)}
                                />
                                <span>{modelName}</span>
                              </label>
                            ))
                          ) : (
                            <div className="empty-state compact">暂无视觉模型候选。</div>
                          )}
                        </div>
                      </div>
                      <div className="admin-model-grid compact-grid">
                        <label>
                          提供商默认语言模型
                          <select
                            value={state.textModel}
                            onChange={(event) => updateProviderState(provider, { textModel: event.target.value })}
                            disabled={!state.enabledTextModels.length}
                          >
                            {state.enabledTextModels.map((modelName) => (
                              <option key={modelName} value={modelName}>
                                {modelName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          提供商默认视觉模型
                          <select
                            value={state.visionModel}
                            onChange={(event) => updateProviderState(provider, { visionModel: event.target.value })}
                            disabled={!state.enabledVisionModels.length}
                          >
                            {!state.enabledVisionModels.length && <option value="">未开放视觉模型</option>}
                            {state.enabledVisionModels.map((modelName) => (
                              <option key={modelName} value={modelName}>
                                {modelName}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <div className="admin-actions">
            <span className={savingAiConfig ? "provider-switch-status is-switching" : "provider-switch-status"}>
              {savingAiConfig && <span className="provider-status-dot" />}
              {savingAiConfig
                ? "保存并刷新模型中"
                : allTextModels.length
                  ? `已开放 ${allTextModels.length} 个语言模型`
                  : "未开放语言模型"}
            </span>
            <div className="admin-action-buttons">
              <button className="secondary-button compact" type="button" onClick={testAiConfig} disabled={testing || savingAiConfig}>
                {testing ? "测试中..." : "测试连接"}
              </button>
              <button className="primary-button compact" type="submit" disabled={savingAiConfig}>
                {savingAiConfig ? "保存中..." : "保存 AI 配置"}
              </button>
            </div>
          </div>
        </form>
        )}
        {testResult && <div className="form-success">{testResult}</div>}
        {saved && <div className="form-success">{saved}</div>}
      </section>
      <section className="admin-section">
        <header className="pane-header">
          <div>
            <h2>邀请码</h2>
            <p>只显示最新 3 个邀请码，旧邀请码仍保留在数据库中。</p>
          </div>
          <button className="primary-button compact" onClick={createInvite}>
            <KeyRound size={16} />
            生成邀请码
          </button>
        </header>
      <div className="invite-table">
        {loadingAdmin && !invites.length ? <div className="empty-state compact">正在加载邀请码...</div> : null}
        {invites.slice(0, 3).map((invite) => (
          <div key={invite.code} className="invite-row">
            <code>{invite.code}</code>
            <span>{invite.is_used ? "已使用" : "未使用"}</span>
            <span>{invite.expires_at ? invite.expires_at.slice(0, 10) : "不过期"}</span>
          </div>
        ))}
      </div>
      </section>
      <section className="admin-section">
        <header className="pane-header">
          <div>
            <h2>Token 用量</h2>
            <p>按账号展示今日与过去 7 天的总 token。</p>
          </div>
        </header>
        <div className="token-usage-table">
          {loadingAdmin && !tokenUsage.length ? <div className="empty-state compact">正在加载 token 用量...</div> : null}
          {!loadingAdmin && !tokenUsage.length ? <div className="empty-state compact">暂无 token 用量。</div> : null}
          {tokenUsage.map((item) => (
            <div key={item.user_id} className="token-usage-row">
              <div className="token-usage-user">
                <strong>{item.email}</strong>
                <span>{item.role === "admin" ? "管理员" : "用户"}</span>
              </div>
              <span>今日 {item.today_total_tokens.toLocaleString()} token</span>
              <span>7 天 {item.last_7d_total_tokens.toLocaleString()} token</span>
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
  const [visitedViews, setVisitedViews] = useState<Set<View>>(() => new Set(["chat"]));
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
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
    if (!user) {
      setAppSettings(null);
      setSettingsLoading(false);
      return;
    }
    setSettingsLoading(true);
    api
      .settings()
      .then(setAppSettings)
      .catch(() => setAppSettings(defaultAppSettings))
      .finally(() => setSettingsLoading(false));
  }, [user]);

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
    setView("chat");
    setVisitedViews(new Set(["chat"]));
  }

  function openView(nextView: View) {
    setView(nextView);
    setVisitedViews((current) => {
      if (current.has(nextView)) return current;
      const next = new Set(current);
      next.add(nextView);
      return next;
    });
    if (nextView === "reports" || nextView === "translate") preloadMarkdownRenderer();
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
          onClick={() => openView("chat")}
          aria-label="问答"
          title="问答"
        >
          <MessageSquareText size={17} />
          <span className="nav-label">问答</span>
        </button>
        <button
          className={view === "translate" ? "active" : ""}
          onClick={() => openView("translate")}
          onPointerEnter={() => preloadMarkdownRenderer()}
          aria-label="翻译"
          title="翻译"
        >
          <Languages size={17} />
          <span className="nav-label">翻译</span>
        </button>
        <button
          className={view === "reports" ? "active" : ""}
          onClick={() => openView("reports")}
          onPointerEnter={() => preloadMarkdownRenderer()}
          aria-label="报告"
          title="报告"
        >
          <CalendarDays size={17} />
          <span className="nav-label">报告</span>
        </button>
        {user.role === "admin" && (
          <button
            className={view === "admin" ? "active" : ""}
            onClick={() => openView("admin")}
            aria-label="AI 设置"
            title="AI 设置"
          >
            <KeyRound size={17} />
            <span className="nav-label">AI 设置</span>
          </button>
        )}
        <div className="nav-spacer" />
        <div className="user-chip">{user.email}</div>
        <button
          className={view === "settings" ? "active" : ""}
          onClick={() => openView("settings")}
          aria-label="设置"
          title="设置"
        >
          <Settings size={17} />
          <span className="nav-label">设置</span>
        </button>
        <button onClick={logout} aria-label="退出" title="退出">
          <LogOut size={17} />
          <span className="nav-label">退出</span>
        </button>
      </nav>
      <section className="app-content">
        <div style={{ display: view === "chat" ? "contents" : "none" }}>
          <ChatView currentTheme={currentTheme} onToggleTheme={toggleThemePreference} isActive={view === "chat"} />
        </div>
        <div style={{ display: view === "translate" ? "contents" : "none" }}>
          {visitedViews.has("translate") && <TranslationView wordCloudEnabled={appSettings?.word_cloud_enabled ?? true} />}
        </div>
        <div style={{ display: view === "reports" ? "contents" : "none" }}>
          {visitedViews.has("reports") && <ReportsView />}
        </div>
        <div style={{ display: view === "admin" ? "contents" : "none" }}>
          {visitedViews.has("admin") && <AdminView />}
        </div>
        <div style={{ display: view === "settings" ? "contents" : "none" }}>
          {visitedViews.has("settings") && (
            <SettingsView
              settings={appSettings}
              onSaved={setAppSettings}
              isAdmin={user.role === "admin"}
              loading={settingsLoading}
            />
          )}
        </div>
      </section>
    </main>
  );
}
