import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const packageJson = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");

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
  assert.match(styles, /\.message-content\s*{[^}]*background:\s*var\(--message-surface\);/s);

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
  assert.match(styles, /\.composer-row\s*{[^}]*background:\s*var\(--surface\);/s);
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

test("desktop global sidebar is a narrow icon rail", () => {
  assert.match(styles, /\.app-shell\s*{[^}]*grid-template-columns:\s*56px minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.app-nav button\s*{[^}]*width:\s*40px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.nav-brand span,[\s\S]*?\.nav-label,[\s\S]*?\.user-chip\s*{[^}]*display:\s*none;/s);
  assert.ok(app.includes('aria-label="问答"'));
  assert.ok(app.includes('aria-label="翻译"'));
  assert.ok(app.includes('title="AI 设置"'));
  assert.ok(app.includes('className="nav-label"'));
});

test("chat messages keep assistant left and user right", () => {
  assert.match(styles, /\.message\.assistant\s*{[^}]*justify-content:\s*start;/s);
  assert.match(styles, /\.message\.user\s*{[^}]*justify-content:\s*end;/s);
  assert.ok(app.includes("ChatGptAvatar"));
  assert.ok(app.includes('<img src={appIconUrl} alt="" />'));
  assert.ok(app.includes("message ${message.role}"));
  assert.ok(!app.includes("user-avatar"));
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
  assert.ok(app.includes("attachment-grid"));
  assert.ok(app.includes("attachment-preview"));
  assert.ok(app.includes("attachment-remove"));
  assert.ok(app.includes("removeAttachment(attachment.id)"));
  assert.match(styles, /\.attachment-remove\s*{[^}]*position:\s*absolute;/s);
});

test("sent messages render image thumbnails and markdown content", () => {
  assert.ok(app.includes("MessageMarkdown"));
  assert.ok(app.includes("message-attachments"));
  assert.ok(app.includes("message-attachment-thumb"));
  assert.ok(app.includes("attachment.url"));
  assert.ok(app.includes("markdown-code"));
  assert.ok(app.includes("markdown-list"));
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
  assert.ok(app.includes("ReactMarkdown"));
  assert.ok(app.includes("remarkGfm"));
  assert.ok(app.includes("remarkMath"));
  assert.ok(app.includes("rehypeKatex"));
  assert.ok(app.includes("normalizeMarkdownMath"));
  assert.ok(app.includes("key={normalizedMarkdown}"));
  assert.ok(app.includes('import "katex/dist/katex.min.css";'));
  assert.ok(app.includes("markdown-math-block"));
  assert.ok(app.includes("markdown-math-inline"));
  assert.match(styles, /\.message-markdown \.katex-display\s*{/);
  assert.match(styles, /\.message-markdown \.katex\s*{/);
  assert.match(styles, /\.markdown-code\s*{/);
  assert.match(styles, /\.markdown-table-wrap\s*{/);
});

test("message code blocks use syntax highlighting in light and dark themes", () => {
  assert.ok(packageJson.includes("rehype-highlight"));
  assert.ok(app.includes("import rehypeHighlight from \"rehype-highlight\";"));
  assert.ok(app.includes("rehypeHighlight"));
  assert.ok(app.includes("ignoreMissing: true"));
  assert.ok(app.includes("detect: true"));
  assert.match(styles, /--syntax-keyword:\s*#[0-9a-fA-F]{6};/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*--syntax-keyword:\s*#[0-9a-fA-F]{6};/);
  assert.match(styles, /\.markdown-code \.hljs-keyword[\s\S]*color:\s*var\(--syntax-keyword\);/);
  assert.match(styles, /\.markdown-code \.hljs-string[\s\S]*color:\s*var\(--syntax-string\);/);
  assert.match(styles, /\.markdown-code \.hljs-number[\s\S]*color:\s*var\(--syntax-number\);/);
});

test("assistant markdown text and code blocks have copy controls", () => {
  assert.ok(app.includes("CopyableMarkdownBlock"));
  assert.ok(app.includes("copyMarkdownText"));
  assert.ok(app.includes("navigator.clipboard.writeText"));
  assert.ok(app.includes('copyable={message.role === "assistant"}'));
  assert.ok(app.includes('aria-label={copied ? "已复制" : "复制此块"}'));
  assert.ok(app.includes("Copy size={14}"));
  assert.ok(app.includes("Check size={14}"));
  assert.match(styles, /\.copyable-markdown-block\s*{[^}]*position:\s*relative;/s);
  assert.match(styles, /\.copy-block-button\s*{[^}]*position:\s*absolute;[^}]*top:\s*4px;[^}]*right:\s*4px;/s);
  assert.match(styles, /\.copyable-markdown-block \.markdown-code\s*{[^}]*padding-right:\s*42px;/s);
});

test("composer blocks sending while image upload is still running", () => {
  assert.ok(app.includes("uploadingCount"));
  assert.ok(app.includes("图片上传中，请稍等"));
  assert.ok(app.includes("图片上传中..."));
  assert.ok(app.includes("disabled={busy || isUploading}"));
  assert.ok(app.includes("aria-disabled={isUploading}"));
  assert.match(styles, /\.upload-status\s*{/);
  assert.match(styles, /\.icon-button\.disabled\s*{/);
});

test("app icon is used for favicon and brand", () => {
  assert.ok(main.includes("link[rel='icon']"));
  assert.ok(app.includes("AppIcon"));
  assert.match(appIcon, /id="knot"/);
  assert.match(appIcon, /fill="#111111"/);
  assert.ok(!appIcon.includes("#faae2b"));
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

test("sidebar and chat bubbles follow ChatGPT-style light surfaces", () => {
  assert.match(styles, /\.sessions-pane\s*{[^}]*background:\s*var\(--panel-bg\);/s);
  assert.match(styles, /\.new-session\s*{[^}]*background:\s*var\(--button-surface\);/s);
  assert.match(styles, /\.message-content\s*{[^}]*background:\s*var\(--message-surface\);/s);
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
});

test("empty chat shows a centered greeting with the composer below it", () => {
  assert.ok(app.includes("openingLines"));
  assert.ok(app.includes("randomOpeningLine"));
  assert.ok(app.includes("setOpeningLine(randomOpeningLine())"));
  assert.ok(app.includes("const isEmptyChat = messages.length === 0;"));
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
  assert.match(app, /if \(!session\)\s*{[\s\S]*api\.createSession\(content\.slice\(0,\s*24\),\s*model\)/);
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
  assert.ok(app.includes("api.updateAiConfig(baseUrl, apiKey)"));
  assert.ok(app.includes("api.testAiConfig(baseUrl, apiKey)"));
  assert.ok(app.includes("api_key_preview"));
  assert.ok(app.includes("当前密钥"));
  assert.ok(app.includes("留空则保持当前密钥"));
  assert.ok(app.includes("测试连接"));
  assert.ok(app.includes("setApiKey(\"\")"));
  assert.match(styles, /\.admin-form\s*{/);
  assert.match(styles, /\.admin-section\s*{/);
});

test("settings page exposes report schedule and word cloud visibility controls", () => {
  assert.ok(app.includes('type View = "chat" | "translate" | "reports" | "admin" | "settings";'));
  assert.ok(app.includes("Settings"));
  assert.ok(app.includes('aria-label="设置"'));
  assert.ok(app.includes('title="设置"'));
  assert.ok(app.includes("SettingsView"));
  assert.match(app, /api\s*\.\s*settings\s*\(\s*\)/);
  assert.ok(app.includes("api.updateSettings"));
  assert.ok(app.includes("daily_report_time"));
  assert.ok(app.includes("weekly_report_time"));
  assert.ok(app.includes("weekly_report_day"));
  assert.ok(!app.includes("monthly_report_time"));
  assert.ok(app.includes("word_cloud_enabled"));
  assert.ok(app.includes('type="time"'));
  assert.ok(app.includes("type=\"button\""));
  assert.ok(app.includes("settingsAutoSave"));
  assert.ok(app.includes("window.setTimeout"));
  assert.ok(app.includes("wordCloudEnabled"));
  assert.match(app, /wordCloudEnabled\s*\?\s*\(/);
  assert.ok(!app.includes("保存设置"));
  assert.ok(!app.includes("settings-header"));
  assert.doesNotMatch(app, /<h2>设置<\/h2>/);
  assert.doesNotMatch(app, /调整报告生成节奏和学习工具展示。/);
  assert.match(styles, /\.settings-panel\s*{/);
  assert.match(styles, /\.settings-toggle\s*{/);
  assert.ok(apiSource.includes("export type AppSettings"));
  assert.ok(apiSource.includes("weekly_report_day:"));
  assert.ok(!apiSource.includes("monthly_report_time: string;"));
  assert.ok(apiSource.includes('settings: () => request<AppSettings>("/api/settings")'));
  assert.ok(apiSource.includes('updateSettings: (payload: Partial<AppSettings>)'));
});

test("translation panel is a designed first-stage tool with editable prompt", () => {
  assert.ok(app.includes('type View = "chat" | "translate" | "reports" | "admin" | "settings";'));
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
  assert.ok(app.includes("entry.detail_status === \"queued\" || entry.detail_status === \"processing\""));
  assert.ok(app.includes("正在查询词条并生成详解"));
  assert.ok(app.includes("正在按学习 Prompt 生成详解"));
  assert.ok(!app.includes("词条详解正在后台排队"));
  assert.ok(app.includes("词条详解生成失败，稍后刷新或重新收录。"));
  assert.ok(app.includes("setDetailState({ label: item.label, entry: existing, error: \"\" });"));
  assert.ok(!app.includes("const translated = await api.translate(item.label);"));
  assert.ok(app.includes("repeated.length < 32"));
  assert.ok(app.includes("data-size={item.weight}"));
  assert.ok(app.includes("data-tone={cloudTone(item.key)}"));
  assert.ok(app.includes("data-label={item.label}"));
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

test("reports can be exported as downloaded PDF files without opening print", () => {
  assert.ok(app.includes("Download"));
  assert.ok(app.includes("function exportReportPdf"));
  assert.ok(apiSource.includes("reportPdf"));
  assert.ok(app.includes("api.reportPdf(active.id)"));
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

test("mobile chat uses a slide-over session drawer", () => {
  assert.ok(app.includes("isMobileViewport()"));
  assert.ok(app.includes("if (isMobileViewport()) setSidebarOpen(false);"));
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.sessions-pane\s*{[\s\S]*position:\s*fixed;[\s\S]*transform:\s*translateX\(0\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.workspace\.sidebar-collapsed \.sessions-pane\s*{[\s\S]*transform:\s*translateX\(-100%\);/);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*\.message-content\s*{[\s\S]*max-width:\s*calc\(100vw - 64px\);/);
});
