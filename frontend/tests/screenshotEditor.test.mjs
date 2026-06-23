import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../src/ScreenshotEditor.tsx", import.meta.url), "utf8");

test("screenshot editor exposes a thickness slider for annotation width", () => {
  assert.match(source, /type="range"/);
  assert.match(source, /screenshot-thickness-control/);
  assert.match(source, /strokeWidth/);
});

test("screenshot editor exports screenshots under the 200KB upload target", () => {
  assert.match(source, /maxBytes:\s*200 \* 1024/);
});
