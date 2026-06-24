import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../src/ScreenshotEditor.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("screenshot editor exposes a thickness slider for annotation width", () => {
  assert.match(source, /type="range"/);
  assert.match(source, /screenshot-thickness-control/);
  assert.match(source, /strokeWidth/);
});

test("screenshot editor exports screenshots under the 200KB upload target", () => {
  assert.match(source, /maxBytes:\s*200 \* 1024/);
});

test("screenshot editor exposes a straight line tool", () => {
  assert.match(source, /type ScreenshotTool = "crop" \| "arrow" \| "rect" \| "line"/);
  assert.match(source, /title="画直线"/);
  assert.match(source, /draft\.tool === "line" \? "line"/);
});

test("screenshot editor uses almost the full viewport for editing", () => {
  assert.match(styles, /\.screenshot-editor-panel\s*{[^}]*width:\s*calc\(100dvw - 24px\);[^}]*height:\s*calc\(100dvh - 24px\);/s);
  assert.match(styles, /\.screenshot-stage\s*{[^}]*width:\s*min\(100%,\s*calc\(\(100dvh - 112px\) \* var\(--screenshot-ratio\)\)\);/s);
  assert.doesNotMatch(styles, /width:\s*min\(1120px,\s*100%\);/);
  assert.doesNotMatch(styles, /68dvh/);
});
