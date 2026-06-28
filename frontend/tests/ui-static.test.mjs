import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const handwritingPad = fs.readFileSync(new URL("../src/HandwritingPad.tsx", import.meta.url), "utf8");
const markdownRenderer = fs.readFileSync(new URL("../src/MarkdownRenderer.tsx", import.meta.url), "utf8");
const markdownPlugins = fs.readFileSync(new URL("../src/markdownPlugins.ts", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const packageJson = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
const headersFile = fs.readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

const appIcon = fs.readFileSync(new URL("../src/assets/app-icon.svg", import.meta.url), "utf8");

test("uses black and white surfaces with a pale purple global sidebar", () => {
  assert.match(styles, /--background:\s*#ffffff;/);
  assert.match(styles, /--headline:\s*#111111;/);
  assert.match(styles, /--paragraph:\s*#111111;/);
  assert.match(styles, /--app-nav-hover:\s*rgba\(0,\s*0,\s*0,\s*0\.07\);/);
  assert.match(styles, /--message-surface:\s*#f4f4f4;/);
  assert.match(styles, /--primary-bg:\s*#111111;/);
  assert.match(styles, /--sidebar-tint:\s*#f3f0ff;/);
  assert.match(styles, /\.app-nav\s*{[^}]*background:\s*var\(--sidebar-tint\);/s);
  assert.match(styles, /\.app-nav button\s*{[^}]*color:\s*var\(--headline\);/s);
  assert.match(styles, /\.send-button[^,{]*,[\s\S]*?\.new-session\s*{[^}]*background:\s*var\(--primary-bg\);/s);
  assert.match(styles, /\.message\.user \.message-content\s*{[^}]*background:\s*var\(--message-surface\);/s);

  for (const color of ["#00473e", "#475d5b", "#faae2b", "#ffa8ba", "#fa5246", "0, 71, 62"]) {
    assert.ok(!styles.includes(color), `${color} should not remain in styles`);
    assert.ok(!appIcon.includes(color), `${color} should not remain in app icon`);
  }
});

test("theme follows system dark mode with readable chat surfaces", () => {
  assert.match(styles, /color-scheme:\s*light dark;/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)\s*{/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*--background:\s*#111111;/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*--headline:\s*#f5f5f5;/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*--sidebar-tint:\s*#292433;/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*--message-surface:\s*#242424;/);
  assert.match(styles, /\.sessions-pane\s*{[^}]*background:\s*var\(--panel-bg\);/s);
  assert.match(styles, /\.new-session\s*{[^}]*background:\s*var\(--button-surface\);/s);
  assert.match(styles, /\.composer-shell\s*{[^}]*background:\s*var\(--surface\);/s);
  assert.match(styles, /\.auth-panel\s*{[^}]*border:\s*1px solid var\(--stroke\);/s);
  assert.match(styles, /\.markdown-code\s*{[^}]*background:\s*var\(--code-bg\);/s);
  assert.match(styles, /\.markdown-table\s*{[^}]*background:\s*var\(--table-bg\);/s);
});

test("chat header can manually toggle light and dark theme before the model picker", () => {
  assert.ok(app.includes('type ThemePreference = "light" | "dark";'));
  assert.ok(app.includes("themeStorageKey"));
  assert.ok(app.includes("localStorage.setItem(themeStorageKey, nextTheme)"));
  assert.ok(app.includes("document.documentElement.dataset.theme = preference"));
  assert.ok(app.includes("function toggleThemePreference"));
  assert.ok(app.includes("Moon"));
  assert.ok(app.includes("Sun"));
  assert.match(app, /className="pane-actions"[\s\S]*className="theme-toggle"[\s\S]*<select value={model}/);
  assert.match(styles, /:root\[data-theme="light"\]\s*{[^}]*color-scheme:\s*light;/s);
  assert.match(styles, /:root\[data-theme="dark"\]\s*{[^}]*--background:\s*#111111;/s);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)\s*{[\s\S]*:root:not\(\[data-theme\]\)/);
  assert.match(styles, /\.pane-actions\s*{[^}]*display:\s*flex;/s);
  assert.match(styles, /\.theme-toggle\s*{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
});

test("chat model picker uses the full upstream model names", () => {
  assert.match(app, /const defaultModel = "gpt-5\.4-mini";/);
  assert.match(app, /const complexModel = "gpt-5\.5";/);
  assert.doesNotMatch(app, /const complexModel = "5\.5";/);
  assert.ok(apiSource.includes("aiModels: () => request<AiModels>"));
  assert.match(app, /api\s*\.\s*aiModels\(\)/);
  assert.ok(app.includes("setChatModelOptions"));
  assert.ok(app.includes("setChatDefaultModel"));
  assert.ok(app.includes("const options = config.text_models.length ? config.text_models : config.text_model ? [config.text_model] : [];"));
  assert.ok(app.includes("const nextDefault = config.text_model || nextOptions[0] || defaultModel;"));
  assert.ok(app.includes("setChatDefaultModel(nextDefault);"));
  assert.doesNotMatch(app, /if \(nextOptions\.includes\(defaultModel\)\) return defaultModel;/);
  assert.ok(app.includes("aiConfigChangedEvent"));
  assert.equal(app.match(/loadChatModels\(\)\.catch/g)?.length, 2);
  assert.doesNotMatch(app, /loadChatModels\(true\)\.catch/g);
  assert.ok(app.includes("window.addEventListener(aiConfigChangedEvent, handleAiConfigChanged);"));
  assert.ok(app.includes("window.removeEventListener(aiConfigChangedEvent, handleAiConfigChanged);"));
  assert.ok(app.includes("const preferredChatModel = chatDefaultModel || chatModelOptions[0] || defaultModel;"));
  assert.match(app, /chatModelOptions\.map\(\(option\) =>/);
});

test("desktop global sidebar is a narrow icon rail", () => {
  assert.match(styles, /\.app-shell\s*{[^}]*grid-template-columns:\s*56px minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.app-nav button\s*{[^}]*width:\s*40px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.nav-brand span,[\s\S]*?\.nav-label,[\s\S]*?\.user-chip\s*{[^}]*display:\s*none;/s);
  assert.ok(app.includes('aria-label="问答"'));
  assert.ok(app.includes('aria-label="翻译"'));
  assert.ok(app.includes('title="AI 设置"'));
  assert.ok(app.includes('className="nav-label"'));
});

test("desktop shell keeps the left sidebar fixed while admin content scrolls independently", () => {
  assert.match(styles, /\.app-shell\s*{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.app-content\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.admin-panel\s*{[^}]*height:\s*100vh;[^}]*overflow-y:\s*auto;/s);
});

test("chat messages render flat assistant replies and compact user messages", () => {
  assert.doesNotMatch(app, /function ChatGptAvatar/);
  assert.doesNotMatch(app, /<ChatGptAvatar \/>/);
  assert.doesNotMatch(styles, /\.message-avatar\s*{/);
  assert.doesNotMatch(styles, /\.ai-avatar\s*{/);
  assert.match(styles, /\.message\.assistant\s*{[^}]*justify-content:\s*start;/s);
  assert.match(styles, /\.message\.user\s*{[^}]*justify-content:\s*end;/s);
  assert.ok(app.includes("message ${message.role}"));
  assert.ok(!app.includes("user-avatar"));
  assert.match(styles, /\.messages\s*{[^}]*--chat-content-width:\s*860px;/s);
  assert.match(styles, /\.message\s*{[^}]*max-width:\s*var\(--chat-content-width\);/s);
  assert.match(styles, /\.message\.assistant \.message-content\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.message\.user \.message-content\s*{[^}]*max-width:\s*min\(680px,\s*100%\);/s);
});

test("assistant reply shows a pulsing black dot while waiting for the first token", () => {
  assert.ok(app.includes("const isAssistantThinking"));
  assert.ok(app.includes("typing-indicator"));
  assert.ok(app.includes('aria-label="AI 正在回复"'));
  assert.match(app, /message\.role === "assistant" && busy && !message\.content\.trim\(\)/);
  assert.match(styles, /\.typing-indicator\s*{[^}]*width:\s*28px;[^}]*height:\s*22px;/s);
  assert.match(styles, /\.typing-dot\s*{[^}]*background:\s*var\(--typing-dot\);/s);
  assert.match(styles, /@keyframes typing-dot-pulse\s*{[\s\S]*transform:\s*scale\(1\.42\);/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.typing-dot\s*{[\s\S]*animation:\s*none;/);
});

test("pending image previews are removable above the composer", () => {
  assert.ok(app.includes('status: "uploading"'));
  assert.ok(app.includes('status: "ready"'));
  assert.ok(app.includes('status: "failed"'));
  assert.ok(app.includes("attachment-grid"));
  assert.ok(app.includes("attachment-preview"));
  assert.ok(app.includes("attachment.status"));
  assert.ok(app.includes("attachment-upload-overlay"));
  assert.ok(app.includes("attachment-upload-spinner"));
  assert.ok(app.includes("attachment-upload-label"));
  assert.ok(app.includes("attachment-remove"));
  assert.ok(app.includes("removeAttachment(attachment.id)"));
  assert.match(styles, /\.attachment-remove\s*{[^}]*position:\s*absolute;/s);
  assert.match(styles, /\.attachment-preview\.is-uploading\s*{/);
  assert.match(styles, /\.attachment-upload-overlay\s*{[^}]*position:\s*absolute;/s);
  assert.match(styles, /\.attachment-upload-spinner\s*{[^}]*animation:\s*attachment-spin 820ms linear infinite;/s);
  assert.match(styles, /@keyframes attachment-spin\s*{/);
});

test("chat composer opens a pressure-sensitive handwriting pad", () => {
  assert.ok(app.includes('import { HandwritingPad } from "./HandwritingPad";'));
  assert.ok(app.includes("PencilLine"));
  assert.ok(app.includes("const [handwritingOpen, setHandwritingOpen] = useState(false);"));
  assert.ok(app.includes("handleHandwritingConfirm"));
  assert.match(app, /<HandwritingPad[\s\S]*onConfirm=\{handleHandwritingConfirm\}/);
  assert.match(app, /aria-label="写字板"/);
  assert.match(app, /title="写字板"/);
  assert.match(app, /disabled=\{handwritingDisabled\}/);
  assert.match(handwritingPad, /try\s*{\s*event\.currentTarget\.setPointerCapture\(event\.pointerId\);\s*}\s*catch/);
  assert.match(styles, /\.handwriting-pad-backdrop\s*{/);
  assert.match(styles, /\.handwriting-canvas\s*{[^}]*touch-action:\s*none;/s);
  assert.match(styles, /\.handwriting-tool\s*{/);
});

test("sent messages render image thumbnails and markdown content", () => {
  assert.ok(app.includes("MessageMarkdown"));
  assert.ok(app.includes("message-attachments"));
  assert.ok(app.includes("message-attachment-thumb"));
  assert.ok(app.includes("attachment.url"));
  assert.ok(markdownRenderer.includes("markdown-code"));
  assert.ok(markdownRenderer.includes("markdown-list"));
  assert.match(styles, /\.message-attachments\s*{/);
  assert.match(styles, /\.message-attachment-thumb\s*{/);
  assert.match(styles, /\.message-markdown\s*{/);
});

test("message markdown uses GFM and KaTeX for formulas", () => {
  assert.ok(packageJson.includes("react-markdown"));
  assert.ok(packageJson.includes("remark-gfm"));
  assert.ok(packageJson.includes("remark-math"));
  assert.ok(packageJson.includes("rehype-katex"));
  assert.ok(packageJson.includes("katex"));
  assert.ok(markdownRenderer.includes("ReactMarkdown"));
  assert.ok(markdownPlugins.includes("remarkGfm"));
  assert.ok(markdownPlugins.includes("remarkMath"));
  assert.ok(markdownPlugins.includes("rehypeKatex"));
  assert.ok(markdownRenderer.includes("normalizeMarkdownMath"));
  assert.ok(markdownRenderer.includes("key={normalizedMarkdown}"));
  assert.ok(fs.readFileSync(new URL("../../shared/src/markdown.ts", import.meta.url), "utf8").includes("normalizeInlineCodeMath"));
  assert.ok(app.includes('import "katex/dist/katex.min.css";'));
  assert.ok(markdownRenderer.includes("markdown-math-block"));
  assert.ok(markdownRenderer.includes("markdown-math-inline"));
  assert.match(styles, /\.message-markdown \.katex-display\s*{/);
  assert.match(styles, /\.message-markdown \.katex\s*{/);
  assert.match(styles, /\.markdown-code\s*{/);
  assert.match(styles, /\.markdown-table-wrap\s*{/);
});

test("visited app views stay mounted and heavy markdown renderer is prefetched from navigation", () => {
  assert.ok(app.includes("visitedViews"));
  assert.ok(app.includes("openView"));
  assert.ok(app.includes("preloadMarkdownRenderer"));
  assert.match(app, /onPointerEnter=\{\(\) => preloadMarkdownRenderer\(\)\}/);
  assert.match(app, /style=\{\{ display: view === "reports" \? "contents" : "none" \}\}/);
  assert.match(app, /visitedViews\.has\("reports"\) && <ReportsView \/>/);
  assert.match(app, /style=\{\{ display: view === "translate" \? "contents" : "none" \}\}/);
  assert.match(app, /visitedViews\.has\("translate"\) &&/);
  assert.match(styles, /\.app-content\s*{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
});

test("essay writing view renders a dedicated workspace and suggestion rail", () => {
  assert.ok(app.includes('type View = "chat" | "translate" | "essay" | "reports" | "admin" | "settings";'));
  assert.ok(app.includes('aria-label="作文"'));
  assert.ok(app.includes("NotebookPen"));
  assert.match(app, /visitedViews\.has\("essay"\) && <EssayView isActive=\{view === "essay"\} \/>/);
  assert.ok(app.includes("essay-editor"));
  assert.ok(app.includes("essay-suggestion-rail"));
  assert.ok(app.includes("essay-topic-card"));
  assert.ok(app.includes("handleTopicImagePaste"));
  assert.match(app, /document\.addEventListener\("paste", handleTopicImagePaste\)/);
  assert.doesNotMatch(app, /className="essay-title-field"/);
  assert.doesNotMatch(app, />标题<\/span>/);
  assert.doesNotMatch(app, /作文标题/);
  assert.doesNotMatch(app, /后台只保存 OCR 和客观描述/);
  assert.doesNotMatch(app, /不显示给练习者/);
  assert.doesNotMatch(app, /保存后会自动同步到后端/);
  assert.match(app, /const essayWordCount =/);
  assert.match(app, /countEssayWords\(/);
  assert.match(styles, /\.essay-editor\s*{[^}]*font-family:\s*"Comic Sans MS"/s);
  assert.match(styles, /\.essay-editor-shell\s*{[^}]*width:\s*min\(100%,\s*760px\);[^}]*justify-self:\s*center;/s);
  assert.doesNotMatch(styles, /\.essay-editor-shell\s*{[^}]*repeating-linear-gradient/s);
  assert.match(styles, /\.essay-editor\s*{[^}]*background:\s*[\s\S]*repeating-linear-gradient/s);
  assert.match(styles, /\.essay-editor\s*{[^}]*background-position-y:\s*1px;/s);
  assert.match(styles, /\.essay-editor\s*{[^}]*background-attachment:\s*local;/s);
  assert.match(styles, /\.essay-editor\s*{[^}]*padding:\s*9px 30px 20px 68px;/s);
  assert.match(styles, /\.essay-editor:focus\s*{[^}]*background-position-y:\s*1px;/s);
  assert.match(styles, /\.essay-editor:focus\s*{[^}]*background-attachment:\s*local;/s);
  assert.match(styles, /@media \(max-width:\s*620px\)\s*{[\s\S]*\.essay-editor\s*{[^}]*padding:\s*9px 16px 18px 56px;/s);
  assert.match(styles, /\.essay-pane\s*{/);
  assert.match(styles, /\.essay-editor\s*{/);
  assert.match(styles, /\.essay-suggestion-rail\s*{/);
});

test("essay api surface serializes session, image context, and suggestion requests", () => {
  assert.ok(apiSource.includes('essaySessions: () => request<EssaySession[]>("/api/essay/sessions")'));
  assert.ok(apiSource.includes('createEssaySession: (payload: { title?: string; model?: string })'));
  assert.ok(apiSource.includes('updateEssaySession: (sessionId: number, payload: { title?: string; draft_text?: string; model?: string; clear_topic_image?: boolean })'));
  assert.ok(apiSource.includes('deleteEssaySession: (sessionId: number)'));
  assert.ok(apiSource.includes("essayImageContext: (sessionId: number, attachmentId: number)"));
  assert.ok(apiSource.includes("essaySuggest: ("));
  assert.ok(apiSource.includes('request<{ suggestions: EssaySuggestion[] }>("/api/essay/suggest"'));
});

test("fingerprinted static assets use immutable browser cache headers", () => {
  assert.match(headersFile, /\/assets\/\*/);
  assert.match(headersFile, /Cache-Control:\s*public,\s*max-age=31556952,\s*immutable/);
});

test("message code blocks use syntax highlighting in light and dark themes", () => {
  assert.ok(packageJson.includes("rehype-highlight"));
  assert.ok(markdownPlugins.includes("import rehypeHighlight from \"rehype-highlight\";"));
  assert.ok(markdownPlugins.includes("rehypeHighlight"));
  assert.ok(markdownPlugins.includes("ignoreMissing: true"));
  assert.ok(markdownPlugins.includes("detect: true"));
  assert.match(styles, /--syntax-keyword:\s*#[0-9a-fA-F]{6};/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*--syntax-keyword:\s*#[0-9a-fA-F]{6};/);
  assert.match(styles, /\.markdown-code \.hljs-keyword[\s\S]*color:\s*var\(--syntax-keyword\);/);
  assert.match(styles, /\.markdown-code \.hljs-string[\s\S]*color:\s*var\(--syntax-string\);/);
  assert.match(styles, /\.markdown-code \.hljs-number[\s\S]*color:\s*var\(--syntax-number\);/);
});

test("assistant messages have one reply copy control while code blocks keep their own copy control", () => {
  assert.ok(markdownRenderer.includes("CopyableMarkdownBlock"));
  assert.ok(app.includes("MessageActions"));
  assert.ok(app.includes("copyMarkdownText"));
  assert.ok(app.includes("navigator.clipboard.writeText"));
  assert.ok(app.includes('copyable={message.role === "assistant"}'));
  assert.ok(app.includes("message-actions"));
  assert.ok(app.includes('message-copy-button'));
  assert.ok(app.includes('aria-label={copied ? "已复制整条回复" : "复制整条回复"}'));
  assert.ok(app.includes('aria-label="重新生成回复"'));
  assert.ok(app.includes("RefreshCw"));
  assert.ok(app.includes("regenerateAssistantMessage(message)"));
  assert.ok(app.includes('text={message.content}'));
  assert.ok(markdownRenderer.includes('aria-label={copied ? "已复制" : "复制此块"}'));
  assert.ok(app.includes("Copy size={14}"));
  assert.ok(app.includes("Check size={14}"));
  assert.doesNotMatch(markdownRenderer, /return <CopyableMarkdownBlock text=\{markdownTextFromNode\(children\)\}>\{heading\}<\/CopyableMarkdownBlock>;/);
  assert.doesNotMatch(markdownRenderer, /return <CopyableMarkdownBlock text=\{markdownTextFromNode\(children\)\}>\{paragraph\}<\/CopyableMarkdownBlock>;/);
  assert.doesNotMatch(markdownRenderer, /return <CopyableMarkdownBlock text=\{markdownTextFromNode\(children\)\}>\{list\}<\/CopyableMarkdownBlock>;/);
  assert.match(styles, /\.copyable-markdown-block\s*{[^}]*position:\s*relative;/s);
  assert.match(styles, /\.copy-block-button\s*{[^}]*position:\s*absolute;[^}]*top:\s*4px;[^}]*right:\s*4px;/s);
  assert.match(styles, /\.message-actions\s*{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-start;/s);
  assert.match(styles, /\.message-action-button\s*{[^}]*width:\s*30px;[^}]*height:\s*30px;/s);
  assert.match(styles, /\.copyable-markdown-block:not\(\.copyable-code-block\) > \.copy-block-button\s*{[^}]*display:\s*none;/s);
  assert.match(styles, /\.copyable-code-block:hover > \.copy-block-button/s);
  assert.match(styles, /\.copyable-code-block > \.copy-block-button:focus-visible/s);
  assert.doesNotMatch(styles, /\.copyable-markdown-block:hover \.copy-block-button/);
  assert.doesNotMatch(styles, /\.message\.assistant \.message-content:hover \.message-copy-button/s);
  assert.match(styles, /\.copyable-markdown-block \.markdown-code\s*{[^}]*padding-right:\s*42px;/s);
});

test("assistant regenerate uses the previous user message and replaces the assistant reply", () => {
  assert.ok(apiSource.includes("regenerateChat"));
  assert.ok(apiSource.includes('"/api/chat/regenerate"'));
  assert.ok(app.includes("async function regenerateAssistantMessage"));
  assert.ok(app.includes("lastUserMessage"));
  assert.ok(app.includes("setMessages((current) => current.filter((message) => message.id !== assistantMessage.id))"));
  assert.ok(app.includes("content: lastUserMessage.content"));
  assert.ok(app.includes("attachment_ids: lastUserMessage.attachments.map((attachment) => attachment.id)"));
  assert.ok(app.includes("regenerateAssistantMessage(message)"));
  assert.ok(app.includes("sendLockRef"));
  assert.ok(app.includes("regenerateLockRef"));
  assert.ok(app.includes("busy || sendLockRef.current"));
  assert.ok(app.includes("busy || regenerateLockRef.current"));
  assert.ok(app.includes("const refreshedMessages = await api.messages(active.id);"));
  assert.match(styles, /\.message-action-button:disabled\s*{/);
});

test("pending image previews share one visual surface with the composer", () => {
  assert.ok(app.includes("composer-shell"));
  assert.match(styles, /\.composer-shell\s*{[^}]*background:\s*var\(--surface\);[^}]*border:\s*1px solid var\(--stroke\);[^}]*border-radius:\s*32px;/s);
  assert.match(styles, /\.attachment-grid\s*{[^}]*background:\s*transparent;[^}]*border:\s*0;/s);
  assert.match(styles, /\.composer-row\s*{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(styles, /\.attachment-grid \+ \.form-error \+ \.composer-row/);
  assert.doesNotMatch(styles, /\.attachment-grid \+ \.composer-row/);
});

test("admin provider settings expand by clicking each provider row", () => {
  assert.ok(app.includes("const [expandedProvider, setExpandedProvider] = useState<AiProviderName | null>(null);"));
  assert.ok(app.includes("toggleProvider"));
  assert.ok(app.includes("providerNames.map((provider) =>"));
  assert.ok(app.includes("provider-row-button"));
  assert.ok(app.includes("provider-card-body"));
  assert.ok(app.includes("aria-expanded={expandedProvider === provider}"));
  assert.ok(app.includes("ChevronDown"));
  assert.match(styles, /\.provider-grid\s*{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(styles, /\.provider-row-button\s*{[^}]*display:\s*grid;/s);
  assert.match(styles, /\.provider-card-body\s*{[^}]*display:\s*grid;/s);
});

test("admin AI config save shows progress and refreshes model choices", () => {
  assert.ok(app.includes("const [savingAiConfig, setSavingAiConfig] = useState(false);"));
  assert.ok(app.includes("const [detectingProvider, setDetectingProvider]"));
  assert.ok(app.includes("setSavingAiConfig(true);"));
  assert.ok(app.includes('setSaved("AI 配置已保存");'));
  assert.ok(app.includes("savingAiConfig ? \"保存中...\" : \"保存 AI 配置\""));
  assert.ok(app.includes("disabled={savingAiConfig}"));
  assert.ok(app.includes("provider-switch-status"));
  assert.ok(app.includes("provider-status-dot"));
  assert.ok(app.includes("保存并刷新模型中"));
  assert.ok(app.includes("AI 配置已保存"));
  assert.ok(app.includes("window.dispatchEvent(new Event(aiConfigChangedEvent));"));
  assert.ok(app.includes("api.discoverAiModels"));
  assert.ok(app.includes("检测上游模型"));
  assert.match(styles, /\.provider-switch-status\s*{[^}]*display:\s*inline-flex;/s);
  assert.match(styles, /\.provider-status-dot\s*{[^}]*animation:\s*provider-status-pulse 900ms ease-in-out infinite;/s);
  assert.match(styles, /@keyframes provider-status-pulse\s*{/);
});

test("composer blocks sending while image upload is still running", () => {
  assert.ok(app.includes("uploadingCount"));
  assert.ok(app.includes("图片上传中，请稍等"));
  assert.ok(app.includes("请先删除上传失败的图片"));
  assert.ok(app.includes("上传中"));
  assert.ok(app.includes("hasFailedAttachments"));
  assert.ok(app.includes("disabled={!busy && (isUploading || hasFailedAttachments || (!input.trim() && !hasReadyAttachments))}"));
  assert.ok(app.includes("aria-disabled={isUploading || busy}"));
  assert.match(styles, /\.icon-button\.disabled\s*{/);
});

test("composer can send ready images without typed text", () => {
  assert.ok(app.includes("const hasReadyAttachments = attachments.some((attachment) => attachment.status === \"ready\");"));
  assert.ok(app.includes("if ((!content && !hasReadyAttachments) || busy || sendLockRef.current) return;"));
  assert.ok(app.includes("const sessionTitle = content ? content.slice(0, 24) : \"图片消息\";"));
  assert.ok(app.includes("content,"));
  assert.ok(app.includes("disabled={!busy && (isUploading || hasFailedAttachments || (!input.trim() && !hasReadyAttachments))}"));
});

test("app icon is used for favicon and brand", () => {
  assert.ok(main.includes("link[rel='icon']"));
  assert.ok(app.includes("AppIcon"));
  assert.match(appIcon, /id="knot"/);
  assert.match(appIcon, /<circle[^>]*cx="1203"[^>]*cy="1203"[^>]*r="1203"[^>]*fill="#ffffff"/);
  assert.doesNotMatch(appIcon, /<path d="M1 578\.4C1 259\.5/);
  assert.match(appIcon, /fill="#111111"/);
  assert.match(styles, /\.app-icon\s*{[^}]*border-radius:\s*50%;/s);
  assert.doesNotMatch(styles, /\.ai-avatar\s*{/);
  assert.ok(!appIcon.includes("#faae2b"));
});

test("auth screen centers the brand and shows a daily quote instead of the old hero copy", () => {
  assert.doesNotMatch(app, /AI 学习工作台/);
  assert.doesNotMatch(app, /用问答推进学习，用日报沉淀复盘。/);
  assert.ok(app.includes("DAILY_QUOTES"));
  assert.ok(app.includes("dailyQuote"));
  assert.ok(app.includes("面朝大海，春暖花开。"));
  assert.match(app, /<p className="auth-quote">[\s\S]*<span>\{dailyQuote\.text\}<\/span>[\s\S]*<cite>——\{dailyQuote\.source\}<\/cite>/);
  assert.match(styles, /\.auth-brand\s*{[^}]*justify-content:\s*center;/s);
  assert.match(styles, /\.auth-quote\s*{[^}]*text-align:\s*center;/s);
});

test("chat scrolls to the latest message after loading and streaming updates", () => {
  assert.ok(app.includes("const messagesEndRef = useRef<HTMLDivElement>(null);"));
  assert.ok(app.includes("messagesEndRef.current?.scrollIntoView"));
  assert.ok(app.includes("window.requestAnimationFrame"));
  assert.match(app, /useEffect\(\(\) => \{[\s\S]*messagesEndRef\.current\?\.scrollIntoView\(\{ block: "end" \}\);[\s\S]*\}, \[messages, messagesLoading\]\);/);
  assert.match(app, /<div[\s\S]*ref=\{messagesEndRef\}[\s\S]*className="messages-end"[\s\S]*aria-hidden="true"/);
  assert.match(styles, /\.messages-end\s*{[^}]*height:\s*1px;/s);
});

test("streaming chat batches token UI updates and aborts stale requests", () => {
  assert.ok(app.includes("type TokenFlushController"));
  assert.ok(app.includes("function createTokenFlushController"));
  assert.ok(app.includes("window.requestAnimationFrame(flush)"));
  assert.ok(app.includes("activeStreamAbortRef"));
  assert.ok(app.includes("activeStreamAbortRef.current?.abort();"));
  assert.ok(app.includes("function stopGenerating()"));
  assert.ok(app.includes('aria-label={busy ? "中断回复" : "发送"}'));
  assert.ok(app.includes('title={busy ? "中断回复" : "发送"}'));
  assert.ok(app.includes("onClick={busy ? stopGenerating : sendMessage}"));
  assert.ok(app.includes("disabled={!busy && (isUploading || hasFailedAttachments || (!input.trim() && !hasReadyAttachments))}"));
  assert.ok(app.includes("{busy ? <Square size={18} /> : <Send size={18} />}"));
  assert.ok(app.includes("tokenFlush.push"));
  assert.ok(app.includes("tokenFlush.flush();"));
  assert.ok(app.includes("{ signal: abortController.signal }"));
  assert.ok(apiSource.includes("options: { signal?: AbortSignal } = {}"));
  assert.ok(apiSource.includes("signal: options.signal"));
});

test("chat sidebar can collapse from the top-left control", () => {
  assert.ok(app.includes("sidebarOpen"));
  assert.ok(app.includes("sidebar-collapsed"));
  assert.ok(app.includes("sidebar-toggle"));
  assert.ok(app.includes('className="session-retention-note"'));
  assert.match(styles, /\.workspace\.sidebar-collapsed\s*{/);
  assert.match(styles, /\.workspace\.sidebar-collapsed \.sessions-pane\s*{[^}]*border-right:\s*0;/s);
  assert.match(styles, /\.session-retention-note\s*{/);
});

test("sidebar and user messages keep quiet light surfaces", () => {
  assert.match(styles, /\.sessions-pane\s*{[^}]*background:\s*var\(--panel-bg\);/s);
  assert.match(styles, /\.new-session\s*{[^}]*background:\s*var\(--button-surface\);/s);
  assert.match(styles, /\.message\.user \.message-content\s*{[^}]*background:\s*var\(--message-surface\);/s);
  assert.match(styles, /\.message\.assistant \.message-content\s*{[^}]*background:\s*transparent;/s);
});

test("composer textarea starts as one centered line and grows to four lines", () => {
  assert.ok(app.includes("const textareaRef = useRef<HTMLTextAreaElement>(null);"));
  assert.ok(app.includes("textareaRef.current.style.height = \"auto\";"));
  assert.ok(app.includes("textareaRef.current.scrollHeight"));
  assert.ok(app.includes("function handleComposerKeyDown"));
  assert.ok(app.includes("event.key !== \"Enter\" || event.shiftKey"));
  assert.ok(app.includes("event.nativeEvent.isComposing"));
  assert.ok(app.includes("event.preventDefault();"));
  assert.match(app, /<textarea[\s\S]*?ref={textareaRef}[\s\S]*?rows={1}/);
  assert.match(app, /<textarea[\s\S]*?onKeyDown={handleComposerKeyDown}/);
  assert.match(styles, /\.composer textarea\s*{[^}]*line-height:\s*22px;[^}]*min-height:\s*22px;[^}]*max-height:\s*88px;/s);
  assert.match(styles, /\.composer textarea\s*{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.composer textarea\s*{[^}]*padding:\s*0 2px;/s);
  assert.match(styles, /\.composer-row\s*{[^}]*align-items:\s*center;/s);
  assert.match(styles, /\.composer-row\s*{[^}]*border-radius:\s*30px;/s);
});

test("empty chat shows a centered greeting with the composer below it", () => {
  assert.ok(app.includes("openingLines"));
  assert.ok(app.includes("randomOpeningLine"));
  assert.ok(app.includes("setOpeningLine(randomOpeningLine())"));
  assert.ok(app.includes("const isEmptyChat = !messagesLoading && messages.length === 0;"));
  assert.ok(app.includes("准备好了，随时开始"));
  assert.ok(app.includes("有什么想学的，直接开始"));
  assert.ok(app.includes("{openingLine}"));
  assert.ok(app.includes("empty-chat"));
  assert.ok(app.includes("composer ${isEmptyChat ? \"composer-floating\" : \"\"}"));
  assert.match(styles, /\.empty-chat\s*{[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.empty-chat-content\s*{[^}]*transform:\s*translateY\(-2vh\);/s);
  assert.match(styles, /\.empty-chat-greeting\s*{[^}]*text-align:\s*center;/s);
  assert.match(styles, /\.composer-floating\s*{[^}]*padding:\s*0;/s);
});

test("new chat stays local until the first message is sent", () => {
  assert.ok(app.includes("const [draftSessionActive, setDraftSessionActive]"));
  assert.match(app, /async function newSession\(\)\s*{[\s\S]*setDraftSessionActive\(true\);[\s\S]*setActive\(null\);[\s\S]*setMessages\(\[\]\);/);
  assert.doesNotMatch(app, /async function newSession\(\)\s*{[\s\S]*api\.createSession\("新会话", model\)/);
  assert.ok(app.includes("if (isActive) newSession();"));
  assert.match(app, /useEffect\(\(\) => \{\s*if \(isActive\) newSession\(\);/);
});

test("draft chat first message skips the initial history reload while streaming", () => {
  assert.ok(app.includes("skipNextMessageLoadSessionIdRef"));
  assert.match(app, /const skipNextMessageLoadSessionIdRef = useRef<number \| null>\(null\);/);
  assert.match(app, /if \(skipNextMessageLoadSessionIdRef\.current === active\.id\)\s*{[\s\S]*skipNextMessageLoadSessionIdRef\.current = null;[\s\S]*return;/);
  assert.match(app, /if \(!session\)\s*{[\s\S]*skipNextMessageLoadSessionIdRef\.current = createdSession\.id;[\s\S]*setActive\(createdSession\);/);
});

test("chat data loading keeps previous UI stable and ignores stale requests", () => {
  assert.ok(app.includes("const [sessionsLoading, setSessionsLoading]"));
  assert.ok(app.includes("const [messagesLoading, setMessagesLoading]"));
  assert.ok(app.includes("const sessionLoadRequestRef = useRef(0);"));
  assert.ok(app.includes("const messageLoadRequestRef = useRef(0);"));
  assert.match(app, /const requestId = \+\+sessionLoadRequestRef\.current;[\s\S]*if \(requestId !== sessionLoadRequestRef\.current\) return;/);
  assert.match(app, /const requestId = \+\+messageLoadRequestRef\.current;[\s\S]*if \(requestId !== messageLoadRequestRef\.current\) return;/);
  assert.match(app, /setSessionsLoading\(true\);[\s\S]*setSessionsLoading\(false\);/);
  assert.match(app, /setMessagesLoading\(true\);[\s\S]*setMessagesLoading\(false\);/);
  assert.ok(app.includes("{sessionsLoading && !sessions.length ? <div className=\"session-empty\">正在加载会话...</div>"));
  assert.ok(app.includes("{messagesLoading && !messages.length ? ("));
  assert.ok(app.includes("empty-chat-loading"));
});

test("secondary pages show loading states instead of transient empty content", () => {
  assert.ok(app.includes("const [reportsLoading, setReportsLoading]"));
  assert.ok(app.includes("const [reportContentLoading, setReportContentLoading]"));
  assert.ok(app.includes("const reportListRequestRef = useRef(0);"));
  assert.ok(app.includes("const reportContentRequestRef = useRef(0);"));
  assert.ok(app.includes("正在加载报告..."));
  assert.ok(app.includes("正在加载报告内容..."));
  assert.ok(app.includes("const [historyLoading, setHistoryLoading]"));
  assert.ok(app.includes("正在加载翻译历史..."));
  assert.ok(app.includes("const [settingsLoading, setSettingsLoading]"));
  assert.ok(app.includes("正在加载设置..."));
  assert.ok(app.includes("const [loadingAdmin, setLoadingAdmin]"));
  assert.ok(app.includes("正在加载 AI 配置..."));
  assert.ok(app.includes("正在加载邀请码..."));
});

test("sessions can be deleted from the sidebar", () => {
  assert.ok(app.includes("Trash2"));
  assert.ok(app.includes("deleteSession(session)"));
  assert.ok(app.includes("window.confirm"));
  assert.ok(app.includes("api.deleteSession(session.id)"));
  assert.ok(app.includes("delete-session"));
  assert.ok(app.includes("setActive(nextSession);"));
  assert.match(styles, /\.session-row\s*{/);
  assert.match(styles, /\.delete-session\s*{/);
});

test("sessions can be archived from a split sidebar context menu", () => {
  assert.ok(apiSource.includes("is_archived: boolean;"));
  assert.ok(apiSource.includes("archiveSession"));
  assert.ok(apiSource.includes('body: JSON.stringify({ archived })'));
  assert.ok(app.includes("regularSessions"));
  assert.ok(app.includes("archivedSessions"));
  assert.ok(app.includes("session-context-menu"));
  assert.ok(app.includes("openSessionMenu"));
  assert.ok(app.includes("archiveSession(sessionMenu.session, true)"));
  assert.ok(app.includes("archiveSession(sessionMenu.session, false)"));
  assert.ok(app.includes("最近会话"));
  assert.ok(app.includes("已归档"));
  assert.ok(app.includes("归档"));
  assert.ok(app.includes("取消归档"));
  assert.match(app, /<div className="session-section session-section-main">[\s\S]*regularSessions\.map/);
  assert.match(app, /<div className="session-section session-section-archived">[\s\S]*archivedSessions\.map/);
  assert.match(styles, /\.session-sections\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) minmax\(120px,\s*38%\);/s);
  assert.match(styles, /\.session-section-list\s*{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.session-context-menu\s*{[^}]*position:\s*fixed;/s);
});

test("admin page can update AI config without echoing the key", () => {
  assert.match(app, /AI 设置/);
  assert.ok(!app.includes(">邀请码</button>"));
  assert.ok(app.includes("api.aiConfig()"));
  assert.ok(app.includes("api.updateAiConfig({"));
  assert.ok(app.includes("api.testAiConfig({"));
  assert.ok(app.includes("默认对话模型"));
  assert.ok(app.includes("图片消息视觉模型"));
  assert.ok(app.includes("value={defaultTextModel}"));
  assert.ok(app.includes("provider-grid"));
  assert.ok(app.includes("provider-card"));
  assert.ok(app.includes("GPT"));
  assert.ok(app.includes("ZHIPU"));
  assert.ok(app.includes("DeepSeek"));
  assert.ok(app.includes("api_key_preview"));
  assert.ok(apiSource.includes('export type AiProviderName = "gpt" | "zhipu" | "deepseek";'));
  assert.ok(apiSource.includes("providers: Record<AiProviderName, AiProviderConfig>;"));
  assert.ok(apiSource.includes("text_model: string;"));
  assert.ok(apiSource.includes("vision_model: string;"));
  assert.ok(apiSource.includes("translation_model: string;"));
  assert.ok(apiSource.includes("report_model: string;"));
  assert.ok(apiSource.includes("enabled_text_models: string[];"));
  assert.ok(apiSource.includes("enabled_vision_models: string[];"));
  assert.ok(app.includes("providerStateFromConfig(config, \"gpt\")"));
  assert.ok(app.includes("providerStateFromConfig(config, \"zhipu\")"));
  assert.ok(app.includes("providerStateFromConfig(config, \"deepseek\")"));
  assert.ok(app.includes("text_model"));
  assert.ok(app.includes("vision_model"));
  assert.ok(app.includes("translation_model"));
  assert.ok(app.includes("report_model"));
  assert.ok(app.includes("翻译模型"));
  assert.ok(app.includes("日报模型"));
  assert.ok(app.includes("glm-5"));
  assert.ok(app.includes("glm-4.6v"));
  assert.ok(app.includes("deepseek-chat"));
  assert.ok(app.includes("当前密钥"));
  assert.ok(app.includes("新密钥待保存"));
  assert.ok(app.includes("留空则保持当前密钥"));
  assert.ok(app.includes("测试连接"));
  assert.ok(app.includes("apiKey: \"\""));
  assert.match(styles, /\.admin-form\s*{/);
  assert.match(styles, /\.admin-section\s*{/);
  assert.match(styles, /\.provider-grid\s*{/);
  assert.match(styles, /\.provider-card\s*{/);
  assert.match(styles, /\.model-checkbox-grid\s*{/);
});

test("chat regeneration uses the currently selected model", () => {
  assert.ok(app.includes("assistant_message_id: assistantMessage.id"));
  assert.ok(app.includes("model,"));
  assert.ok(!app.includes("lastUserMessage.model || model"));
});

test("settings page exposes report schedule and word cloud visibility controls", () => {
  assert.ok(app.includes('type View = "chat" | "translate" | "essay" | "reports" | "admin" | "settings";'));
  assert.ok(app.includes("Settings"));
  assert.ok(app.includes('aria-label="设置"'));
  assert.ok(app.includes('title="设置"'));
  assert.ok(app.includes("SettingsView"));
  assert.match(app, /api\s*\.\s*settings\s*\(\s*\)/);
  assert.ok(app.includes("api.updateSettings"));
  assert.ok(app.includes("daily_report_enabled"));
  assert.ok(app.includes("daily_report_time"));
  assert.ok(app.includes("weekly_report_time"));
  assert.ok(app.includes("weekly_report_day"));
  assert.ok(!app.includes("monthly_report_time"));
  assert.ok(app.includes("word_cloud_enabled"));
  assert.ok(app.includes('type="time"'));
  assert.ok(app.includes("type=\"button\""));
  assert.ok(app.includes("settingsAutoSave"));
  assert.ok(app.includes("window.setTimeout"));
  assert.ok(app.includes("dailyReportEnabled"));
  assert.ok(app.includes("wordCloudEnabled"));
  assert.match(app, /wordCloudEnabled\s*\?\s*\(/);
  assert.ok(!app.includes("保存设置"));
  assert.ok(!app.includes("settings-header"));
  assert.doesNotMatch(app, /<h2>设置<\/h2>/);
  assert.doesNotMatch(app, /调整报告生成节奏和学习工具展示。/);
  assert.match(styles, /\.settings-panel\s*{/);
  assert.match(styles, /\.settings-toggle\s*{/);
  assert.ok(apiSource.includes("export type AppSettings"));
  assert.ok(apiSource.includes("daily_report_enabled: boolean;"));
  assert.ok(apiSource.includes("weekly_report_day:"));
  assert.ok(!apiSource.includes("monthly_report_time: string;"));
  assert.ok(apiSource.includes('settings: () => request<AppSettings>("/api/settings")'));
  assert.ok(apiSource.includes('updateSettings: (payload: Partial<AppSettings>)'));
});

test("translation panel is a designed first-stage tool with editable prompt", () => {
  assert.ok(app.includes('type View = "chat" | "translate" | "essay" | "reports" | "admin" | "settings";'));
  assert.ok(app.includes("TranslationView"));
  assert.ok(app.includes("Languages"));
  assert.ok(app.includes("api.translate("));
  assert.ok(app.includes("api.translationPrompt()"));
  assert.ok(app.includes("api.updateTranslationPrompt(promptDraft)"));
  assert.ok(app.includes("api.translationEntries()"));
  assert.ok(app.includes("api.translationDictionaryEntry(item.label)"));
  assert.ok(app.includes("onDictionaryEntry"));
  assert.ok(app.includes("词条详解生成失败"));
  assert.ok(app.includes("const translationInputLimit = 2000;"));
  assert.ok(app.includes("const isTranslationOverLimit = input.length > translationInputLimit;"));
  assert.ok(app.includes("输入超过 2000 字，已超限，不予翻译。"));
  assert.ok(app.includes("prompt-editor"));
  assert.ok(app.includes("TranslationWordCloud"));
  assert.ok(app.includes("translationCloudItems"));
  assert.ok(app.includes("shuffleTranslationCloudItems"));
  assert.ok(app.includes("buildTranslationCloudLanes"));
  assert.ok(app.includes('if (entry.source_kind === "chinese") return [];'));
  assert.ok(app.includes('if (entry.source_kind === "word") return [compactCloudLabel(source)];'));
  assert.ok(app.includes("const wordCloudLaneCount = 4;"));
  assert.ok(app.includes("const laneCount = wordCloudLaneCount;"));
  assert.ok(app.includes("duration: 72 + index * 12"));
  assert.ok(app.includes("function cloudTone"));
  assert.ok(app.includes("function cloudDetailEntryForItem"));
  assert.ok(apiSource.includes("phonetic: string | null;"));
  assert.ok(apiSource.includes("detail_status: \"queued\" | \"processing\" | \"ready\" | \"failed\";"));
  assert.ok(apiSource.includes("is_auto_detail: boolean;"));
  assert.ok(apiSource.includes("translationDictionaryEntry"));
  assert.ok(app.includes("function TranslationPhonetic"));
  assert.ok(app.includes("function isTranslationDetailPending"));
  assert.ok(app.includes("translation-phonetic"));
  assert.ok(app.includes("api.translationEntries()"));
  assert.ok(app.includes("dailyreview:translation-entries-cleared"));
  assert.ok(apiSource.includes("clearTranslationEntries"));
  assert.ok(app.includes("entry.detail_status === \"queued\" || entry.detail_status === \"processing\""));
  assert.ok(app.includes("const historyRequestId = useRef(0);"));
  assert.ok(app.includes("async function refreshTranslationEntries()"));
  assert.ok(app.includes("if (requestId !== historyRequestId.current) return;"));
  assert.ok(app.includes("void refreshTranslationEntries();"));
  assert.ok(app.includes("entries.some((entry) => isTranslationDetailPending(entry))"));
  assert.ok(app.includes("正在生成词条详解"));
  assert.ok(app.includes("const updatedResult = result ? entries.find((entry) => entry.id === result.id) || result : null;"));
  assert.ok(app.includes("正在查询词条并生成详解"));
  assert.ok(app.includes("正在按学习 Prompt 生成详解"));
  assert.doesNotMatch(app, /const translated = await api\.translate\(text\);[\s\S]*?api\s*\.translationEntries\(\)/);
  assert.ok(!app.includes("词条详解正在后台排队"));
  assert.ok(app.includes("词条详解生成失败，稍后刷新或重新收录。"));
  assert.ok(app.includes("setDetailState({ label: item.label, entry: existing, error: \"\" });"));
  assert.ok(!app.includes("const translated = await api.translate(item.label);"));
  assert.ok(app.includes("repeated.length < 32"));
  assert.ok(app.includes("data-size={item.weight}"));
  assert.ok(app.includes("data-tone={cloudTone(item.key)}"));
  assert.ok(app.includes("data-label={item.label}"));
  assert.doesNotMatch(app, /<small>\{item\.count\}<\/small>/);
  assert.ok(app.includes("word-cloud-stage"));
  assert.ok(app.includes("word-cloud-lane"));
  assert.ok(app.includes("word-cloud-run"));
  assert.ok(app.includes("word-cloud-chip"));
  assert.ok(app.includes("word-cloud-detail-backdrop"));
  assert.ok(app.includes("word-cloud-detail-card"));
  assert.ok(app.includes("word-cloud-detail-content"));
  assert.ok(app.includes("word-cloud-detail-close"));
  assert.ok(app.includes("aria-modal=\"true\""));
  assert.ok(app.includes("closeCloudDetail"));
  assert.ok(app.includes("TranslationLoading"));
  assert.ok(app.includes("translation-submit-label"));
  assert.ok(app.includes("translation-submit-loader"));
  assert.ok(app.includes("translation-result-content"));
  assert.ok(app.includes("translation-result-loading"));
  assert.ok(app.includes("translation-card translation-result is-loading"));
  assert.ok(app.includes("aria-label={busy ? \"正在翻译\" : \"翻译\"}"));
  assert.ok(!app.includes("最近记录"));
  assert.ok(!app.includes("单词会补充词根词缀、易混词、用法和例句"));
  assert.ok(app.includes("考研英语一"));
  assert.ok(app.includes("词根词缀"));
  assert.ok(app.includes("翻译 / 讲解"));
  assert.ok(app.includes("清空词条"));
  assert.ok(app.includes("api.clearTranslationEntries()"));
  assert.match(styles, /\.translation-panel\s*{[^}]*display:\s*grid;/s);
  assert.match(styles, /\.translation-workbench\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 64px minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.translation-card\s*{[^}]*background:\s*var\(--surface\);[^}]*border:\s*1px solid var\(--stroke\);/s);
  assert.match(styles, /\.translation-result\s*{[^}]*background:\s*var\(--message-surface\);/s);
  assert.match(styles, /\.translation-submit\s*{[^}]*width:\s*58px;[^}]*height:\s*58px;[^}]*display:\s*inline-grid;[^}]*border-radius:\s*50%;/s);
  assert.match(styles, /\.translation-submit-label,\s*\.translation-submit-loader\s*{[^}]*grid-area:\s*1 \/ 1;[^}]*display:\s*grid;/s);
  assert.match(styles, /\.translation-submit\.is-loading \.translation-submit-label\s*{[^}]*opacity:\s*0;/s);
  assert.match(styles, /\.translation-submit\.is-loading \.translation-submit-loader\s*{[^}]*opacity:\s*1;/s);
  assert.match(styles, /\.translation-loading\s*{[^}]*width:\s*22px;[^}]*height:\s*8px;/s);
  assert.match(styles, /\.translation-loading span\s*{[^}]*width:\s*4px;[^}]*height:\s*4px;[^}]*animation:\s*translation-pulse 840ms ease-in-out infinite;/s);
  assert.match(styles, /\.translation-result-loading\s*{[^}]*position:\s*absolute;[^}]*inset:\s*42px 12px 12px;[^}]*min-height:\s*0;/s);
  assert.match(styles, /\.translation-result-content\s*{[^}]*min-height:\s*168px;[^}]*max-height:\s*clamp\(168px,\s*32vh,\s*360px\);[^}]*overflow-y:\s*auto;[^}]*display:\s*grid;/s);
  assert.match(styles, /\.translation-result\.is-loading \.translation-result-content\s*{[^}]*opacity:\s*0\.42;/s);
  assert.match(styles, /\.translation-phonetic\s*{[^}]*font-family:\s*"SFMono-Regular",\s*Consolas,\s*"Liberation Mono",\s*monospace;/s);
  assert.match(styles, /\.translation-input-meta\.over-limit\s*{[^}]*color:\s*#b42318;/s);
  assert.match(app, /<section className="translation-cloud">\s*\{items\.length \? \(/);
  assert.doesNotMatch(app, /<section className="translation-cloud">[\s\S]*?个词 \/ 短语/);
  assert.match(styles, /\.translation-cloud\s*{[^}]*position:\s*relative;[^}]*background:\s*transparent;[^}]*height:\s*clamp\(184px,\s*24vh,\s*260px\);[^}]*min-height:\s*0;[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.match(styles, /\.word-cloud-stage\s*{[^}]*width:\s*calc\(100% \+ 44px\);[^}]*margin-inline:\s*-22px;[^}]*height:\s*100%;[^}]*align-content:\s*space-evenly;[^}]*grid-template-rows:\s*repeat\(4,\s*minmax\(30px,\s*auto\)\);[^}]*overflow-y:\s*visible;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.word-cloud-lane\s*{[^}]*min-width:\s*0;[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*visible;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.word-cloud-run\s*{[^}]*padding-left:\s*22px;[^}]*padding-right:\s*22px;[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.word-cloud-run\s*{[^}]*animation:\s*word-cloud-marquee var\(--lane-duration\) linear infinite;/s);
  for (const size of ["1", "2", "3", "4", "5"]) {
    assert.match(styles, new RegExp(`\\.word-cloud-chip\\[data-size="${size}"\\]`));
  }
  for (const tone of ["1", "2", "3", "4", "5", "6"]) {
    assert.match(styles, new RegExp(`\\.word-cloud-chip\\[data-tone="${tone}"\\]`));
  }
  assert.match(styles, /\.word-cloud-chip:hover,[\s\S]*?\.word-cloud-chip\.active\s*{[^}]*background:\s*color-mix\(in srgb,\s*var\(--word-chip-bg,\s*var\(--button-surface\)\) 78%,\s*var\(--surface-solid\)\);/s);
  assert.match(styles, /\.word-cloud-detail-backdrop\s*{[^}]*position:\s*fixed;[^}]*backdrop-filter:\s*blur\(18px\);/s);
  assert.match(styles, /\.word-cloud-detail-card\s*{[^}]*backdrop-filter:\s*blur\(28px\);[^}]*max-height:\s*min\(72vh,\s*620px\);/s);
  assert.match(styles, /\.word-cloud-detail-content\s*{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.word-cloud-detail-loading\s*{[^}]*min-height:\s*180px;/s);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.translation-workbench\s*{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.doesNotMatch(styles, /@media \(max-width:\s*980px\)[\s\S]*\.word-cloud-stage\s*{[^}]*min-height:\s*clamp\(190px,\s*30vh,\s*260px\);/);
  assert.doesNotMatch(styles, /@media \(max-width:\s*620px\)[\s\S]*\.translation-empty,\s*\.translation-result-loading\s*{/);
});

test("chat top bar is compact and keeps retention copy in the expanded sidebar", () => {
  assert.match(app, /<aside className="sessions-pane">[\s\S]*最近 7 天会话会保留，报告长期保存。[\s\S]*<div className="session-sections">/);
  assert.doesNotMatch(app, /<header className="pane-header">[\s\S]*<h2>\{active\?\.title \|\| "新会话"\}<\/h2>[\s\S]*最近 7 天会话会保留，报告长期保存。[\s\S]*<\/header>/);
  assert.match(styles, /\.pane-header\s*{[^}]*min-height:\s*58px;[^}]*padding:\s*8px 20px;/s);
});

test("auth confirms the session cookie before entering the app", () => {
  assert.match(apiSource, /credentials:\s*"include"/);
  assert.match(apiSource, /cache:\s*init\?\.cache \?\? "no-store"/);
  assert.match(app, /async function confirmAuthSession\(\): Promise<User> \{[\s\S]*return await api\.me\(\);[\s\S]*登录状态未保存，请确认手机浏览器允许 Cookie 后重试。/);
  assert.match(app, /mode === "login" \? await api\.login\(email, password\) : await api\.register\(email, password, inviteCode\);/);
  assert.match(app, /const confirmedUser = await confirmAuthSession\(\);[\s\S]*onAuthed\(confirmedUser\);/);
});

test("reports can be exported as downloaded PDF files without opening print", () => {
  assert.ok(app.includes("Download"));
  assert.ok(app.includes("function exportReportPdf"));
  assert.ok(apiSource.includes("reportPdf"));
  assert.ok(app.includes("api.reportPdf(reportId)"));
  assert.ok(!app.includes("reportPreviewRef"));
  assert.ok(!app.includes("exportReportElementToPdf"));
  assert.ok(!app.includes("html2canvas"));
  assert.ok(!app.includes("jsPDF"));
  assert.ok(!app.includes("addImage"));
  assert.ok(!app.includes("toDataURL"));
  assert.ok(app.includes("showSaveFilePicker"));
  assert.ok(app.includes("URL.createObjectURL(blob)"));
  assert.ok(!app.includes("window.print()"));
  assert.ok(!packageJson.includes('"html2canvas"'));
  assert.ok(!packageJson.includes('"jspdf"'));
  assert.ok(app.includes("report-toolbar"));
  assert.ok(app.includes("print-export-button"));
  assert.ok(app.includes("导出 PDF"));
  assert.match(styles, /@media print\s*{[\s\S]*@page\s*{[\s\S]*size:\s*A4;/);
  assert.match(styles, /@media print\s*{[\s\S]*\.app-nav,[\s\S]*\.report-sidebar,[\s\S]*\.report-toolbar\s*{[\s\S]*display:\s*none !important;/);
  assert.match(styles, /@media print\s*{[\s\S]*\.report-content\s*{[\s\S]*overflow:\s*visible;/);
  assert.match(styles, /@media print\s*{[\s\S]*\.markdown-preview\s*{[\s\S]*max-width:\s*none;[\s\S]*box-shadow:\s*none;/);
  assert.match(styles, /@media print\s*{[\s\S]*\.markdown-preview h2,[\s\S]*\.markdown-preview h3,[\s\S]*\.markdown-preview table,[\s\S]*\.markdown-preview pre,[\s\S]*\.markdown-preview blockquote\s*{[\s\S]*break-inside:\s*avoid;/);
});

test("markdown renderer dependencies are code split from the main app", () => {
  assert.doesNotMatch(app, /from "react-markdown"/);
  assert.doesNotMatch(app, /from "rehype-highlight"/);
  assert.doesNotMatch(app, /from "rehype-katex"/);
  assert.doesNotMatch(app, /from "remark-gfm"/);
  assert.doesNotMatch(app, /from "remark-math"/);
  assert.match(app, /lazy\(\(\) => import\("\.\/MarkdownRenderer"\)\)/);
  assert.match(markdownRenderer, /from "react-markdown"/);
  assert.ok(markdownRenderer.includes('import("./markdownPlugins")'));
});

test("reports list can render before the selected report markdown finishes loading", () => {
  assert.match(app, /setReportsLoading\(false\);[\s\S]*const content = await loadReportContent\(reports\[0\]\)/);
  assert.ok(app.includes('reportContentLoading ? "正在加载报告内容..."'));
  assert.ok(app.includes("reportContentCacheRef"));
  assert.ok(app.includes("reportContentCacheRef.current.get(item.id)"));
  assert.ok(app.includes("reportContentCacheRef.current.set(content.id, content)"));
});

test("reports page surfaces background generation status", () => {
  assert.ok(apiSource.includes("ReportGenerationStatus"));
  assert.ok(apiSource.includes("reportGenerationStatuses"));
  assert.ok(apiSource.includes("/api/reports/generation-status"));
  assert.ok(app.includes("const [generationStatuses, setGenerationStatuses]"));
  assert.ok(app.includes("latestGenerationStatus"));
  assert.ok(app.includes("report-generation-status"));
  assert.ok(app.includes("report-status-spinner"));
  assert.ok(app.includes("日报正在生成"));
  assert.ok(app.includes("日报生成失败"));
  assert.match(styles, /\.report-generation-status\s*{/);
  assert.match(styles, /\.report-status-spinner\s*{[^}]*animation:\s*report-status-spin/);
  assert.match(styles, /@keyframes report-status-spin\s*{/);
});

test("PDF export opens the save picker before downloading the backend-rendered PDF", () => {
  const exportFunction = app.slice(app.indexOf("function exportReportPdf()"), app.indexOf("async function selectReport"));
  assert.ok(exportFunction.includes("api.reportPdf(reportId)"));
  assert.ok(exportFunction.includes("pickPdfSaveTarget(filename)"));
  assert.ok(exportFunction.includes("const targetPromise = pickPdfSaveTarget(filename);"));
  assert.ok(exportFunction.indexOf("pickPdfSaveTarget(filename)") < exportFunction.indexOf("setExportingPdf(true)"));
  assert.ok(exportFunction.indexOf("pickPdfSaveTarget(filename)") < exportFunction.indexOf("api.reportPdf(reportId)"));
  assert.ok(exportFunction.includes("setExportError(error instanceof Error ? error.message : \"PDF 导出失败\")"));
  assert.ok(app.includes("isSavePickerGestureError"));
  assert.ok(app.includes('return { kind: "download" };'));
});

test("mobile chat uses a slide-over session drawer", () => {
  assert.ok(app.includes("isMobileViewport()"));
  assert.ok(app.includes("if (isMobileViewport()) setSidebarOpen(false);"));
  assert.ok(app.includes("session-drawer-backdrop"));
  assert.ok(app.includes("sessions-pane-head"));
  assert.ok(app.includes("session-drawer-close"));
  assert.ok(app.includes('aria-label="关闭会话历史"'));
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.app-shell\s*{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto;/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.app-nav\s*{[\s\S]*order:\s*2;[\s\S]*justify-content:\s*space-around;[\s\S]*padding:\s*8px max\(10px,\s*env\(safe-area-inset-left\)\) max\(8px,\s*env\(safe-area-inset-bottom\)\) max\(10px,\s*env\(safe-area-inset-right\)\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.app-content\s*{[\s\S]*order:\s*1;/);
  assert.match(styles, /\.session-drawer-backdrop\s*{[^}]*display:\s*none;/s);
  assert.match(styles, /\.sessions-pane-head\s*{[^}]*display:\s*none;/s);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.session-drawer-backdrop\s*{[\s\S]*position:\s*fixed;[\s\S]*backdrop-filter:\s*blur\(10px\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.sessions-pane\s*{[\s\S]*position:\s*fixed;[\s\S]*border-radius:\s*0 22px 22px 0;[\s\S]*transform:\s*translateX\(0\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.workspace\.sidebar-collapsed \.sessions-pane\s*{[\s\S]*transform:\s*translateX\(-100%\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.sessions-pane-head\s*{[\s\S]*display:\s*flex;/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.session-drawer-close\s*{[\s\S]*width:\s*36px;[\s\S]*height:\s*36px;/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.session-retention-note\s*{[\s\S]*display:\s*none;/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.pane-header\s*{[\s\S]*position:\s*sticky;[\s\S]*top:\s*0;[\s\S]*z-index:\s*10;/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.composer-shell\s*{[\s\S]*border-radius:\s*24px;/);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*\.message\.user \.message-content\s*{[\s\S]*max-width:\s*100%;/);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*\.message\.assistant \.message-content\s*{[\s\S]*padding:\s*2px 0;/);
});
