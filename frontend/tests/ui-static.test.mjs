import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");

test("uses Happy Hues palette 5 tokens", () => {
  for (const color of ["#f2f7f5", "#00473e", "#475d5b", "#faae2b", "#ffa8ba", "#fa5246"]) {
    assert.ok(styles.includes(color), `${color} missing`);
  }
});

test("chat messages keep assistant left and user right", () => {
  assert.match(styles, /\.message\.assistant\s*{[^}]*justify-content:\s*start;/s);
  assert.match(styles, /\.message\.user\s*{[^}]*justify-content:\s*end;/s);
  assert.ok(app.includes("ChatGptAvatar"));
  assert.ok(app.includes("message.role === \"user\""));
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
