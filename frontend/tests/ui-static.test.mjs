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

test("chat messages keep assistant left and user right", () => {
  assert.match(styles, /\.message\.assistant\s*{[^}]*justify-content:\s*start;/s);
  assert.match(styles, /\.message\.user\s*{[^}]*justify-content:\s*end;/s);
  assert.ok(app.includes("ChatGptAvatar"));
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

test("app icon is used for favicon and brand", () => {
  assert.ok(main.includes("link[rel='icon']"));
  assert.ok(app.includes("AppIcon"));
});

test("chat sidebar can collapse from the top-left control", () => {
  assert.ok(app.includes("sidebarOpen"));
  assert.ok(app.includes("sidebar-collapsed"));
  assert.ok(app.includes("sidebar-toggle"));
  assert.match(styles, /\.workspace\.sidebar-collapsed\s*{/);
});

test("sidebar and chat bubbles follow ChatGPT-style light surfaces", () => {
  assert.match(styles, /\.sessions-pane\s*{[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.new-session\s*{[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.message-content\s*{[^}]*background:\s*#f4f4f4;/s);
});
