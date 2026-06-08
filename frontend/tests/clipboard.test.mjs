import assert from "node:assert/strict";
import { test } from "node:test";
import { firstClipboardImage } from "/tmp/dailyreview-frontend-tests/clipboard.js";

test("prefers image files exposed through clipboard items", () => {
  const image = new File(["image"], "screenshot.png", { type: "image/png" });
  const text = new File(["hello"], "note.txt", { type: "text/plain" });

  const result = firstClipboardImage({
    items: [
      {
        kind: "string",
        type: "text/plain",
        getAsFile: () => text
      },
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => image
      }
    ],
    files: [text]
  });

  assert.equal(result, image);
});

test("falls back to clipboard files when items are unavailable", () => {
  const image = new File(["image"], "photo.jpg", { type: "image/jpeg" });
  const text = new File(["hello"], "note.txt", { type: "text/plain" });

  const result = firstClipboardImage({
    files: [text, image]
  });

  assert.equal(result, image);
});

test("accepts screenshot files with generic or missing mime from clipboard", () => {
  const generic = new File(["image"], "screenshot.png", { type: "application/octet-stream" });
  const missing = new File(["image"], "pasted.png", { type: "" });

  const genericResult = firstClipboardImage({
    items: [
      {
        kind: "file",
        type: "application/octet-stream",
        getAsFile: () => generic
      }
    ]
  });
  const missingResult = firstClipboardImage({
    files: [missing]
  });

  assert.equal(genericResult, generic);
  assert.equal(missingResult, missing);
});
