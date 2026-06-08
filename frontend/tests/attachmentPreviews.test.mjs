import assert from "node:assert/strict";
import { test } from "node:test";
import { removeAttachmentPreview } from "/tmp/dailyreview-frontend-tests/attachmentPreviews.js";

test("removes one preview by attachment id", () => {
  const first = { id: 1, previewUrl: "blob:first" };
  const second = { id: 2, previewUrl: "blob:second" };

  const result = removeAttachmentPreview([first, second], 1);

  assert.deepEqual(result.remaining, [second]);
  assert.deepEqual(result.removed, first);
});

test("keeps previews unchanged when id is missing", () => {
  const previews = [{ id: 1, previewUrl: "blob:first" }];

  const result = removeAttachmentPreview(previews, 2);

  assert.deepEqual(result.remaining, previews);
  assert.equal(result.removed, null);
});
