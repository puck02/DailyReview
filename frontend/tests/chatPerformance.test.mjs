import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const helperUrl = new URL("../src/chatPerformance.ts", import.meta.url);

async function loadHelper() {
  assert.ok(fs.existsSync(helperUrl), "chatPerformance.ts should exist");
  const source = fs.readFileSync(helperUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("chat follows only while the viewport is near the bottom", async () => {
  const { isNearScrollBottom } = await loadHelper();

  assert.equal(isNearScrollBottom(500, 400, 960), true);
  assert.equal(isNearScrollBottom(479, 400, 960), false);
  assert.equal(isNearScrollBottom(0, 400, 380), true);
});

test("chat bottom threshold can be configured", async () => {
  const { isNearScrollBottom } = await loadHelper();

  assert.equal(isNearScrollBottom(450, 400, 960, 120), true);
  assert.equal(isNearScrollBottom(439, 400, 960, 120), false);
});
