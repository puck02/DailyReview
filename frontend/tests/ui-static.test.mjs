import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");

const appIcon = fs.readFileSync(new URL("../src/assets/app-icon.svg", import.meta.url), "utf8");

test("uses black and white surfaces with a pale purple global sidebar", () => {
  assert.match(styles, /--background:\s*#ffffff;/);
  assert.match(styles, /--headline:\s*#111111;/);
  assert.match(styles, /--paragraph:\s*#111111;/);
  assert.match(styles, /--sidebar-tint:\s*#f3f0ff;/);
  assert.match(styles, /\.app-nav\s*{[^}]*background:\s*var\(--sidebar-tint\);/s);
  assert.match(styles, /\.app-nav button\s*{[^}]*color:\s*var\(--headline\);/s);
  assert.match(styles, /\.send-button[^,{]*,[\s\S]*?\.new-session\s*{[^}]*background:\s*#111111;/s);
  assert.match(styles, /\.message-content\s*{[^}]*background:\s*#f4f4f4;/s);

  for (const color of ["#00473e", "#475d5b", "#faae2b", "#ffa8ba", "#fa5246", "0, 71, 62"]) {
    assert.ok(!styles.includes(color), `${color} should not remain in styles`);
    assert.ok(!appIcon.includes(color), `${color} should not remain in app icon`);
  }
});

test("desktop global sidebar is a narrow icon rail", () => {
  assert.match(styles, /\.app-shell\s*{[^}]*grid-template-columns:\s*56px minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.app-nav button\s*{[^}]*width:\s*40px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.nav-brand span,[\s\S]*?\.nav-label,[\s\S]*?\.user-chip\s*{[^}]*display:\s*none;/s);
  assert.ok(app.includes('aria-label="问答"'));
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

test("pending image previews are removable above the composer", () => {
  assert.ok(app.includes("attachment-grid"));
  assert.ok(app.includes("attachment-preview"));
  assert.ok(app.includes("attachment-remove"));
  assert.ok(app.includes("removeAttachment(attachment.id)"));
  assert.match(styles, /\.attachment-remove\s*{[^}]*position:\s*absolute;/s);
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
  assert.match(styles, /\.workspace\.sidebar-collapsed\s*{/);
  assert.match(styles, /\.workspace\.sidebar-collapsed \.sessions-pane\s*{[^}]*border-right:\s*0;/s);
});

test("sidebar and chat bubbles follow ChatGPT-style light surfaces", () => {
  assert.match(styles, /\.sessions-pane\s*{[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.new-session\s*{[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.message-content\s*{[^}]*background:\s*#f4f4f4;/s);
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

test("admin page can update AI config without echoing the key", () => {
  assert.match(app, /AI 设置/);
  assert.ok(!app.includes(">邀请码</button>"));
  assert.ok(app.includes("api.aiConfig()"));
  assert.ok(app.includes("api.updateAiConfig(baseUrl, apiKey)"));
  assert.ok(app.includes("api.testAiConfig(baseUrl, apiKey)"));
  assert.ok(app.includes("留空则保持当前密钥"));
  assert.ok(app.includes("密钥已配置"));
  assert.ok(app.includes("测试连接"));
  assert.ok(app.includes("setApiKey(\"\")"));
  assert.match(styles, /\.admin-form\s*{/);
  assert.match(styles, /\.admin-section\s*{/);
});

test("mobile chat uses a slide-over session drawer", () => {
  assert.ok(app.includes("isMobileViewport()"));
  assert.ok(app.includes("if (isMobileViewport()) setSidebarOpen(false);"));
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.sessions-pane\s*{[\s\S]*position:\s*fixed;[\s\S]*transform:\s*translateX\(0\);/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.workspace\.sidebar-collapsed \.sessions-pane\s*{[\s\S]*transform:\s*translateX\(-100%\);/);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*\.message-content\s*{[\s\S]*max-width:\s*calc\(100vw - 64px\);/);
});
