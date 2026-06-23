import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  clampCropRect,
  exportEditedScreenshot
} from "/tmp/dailyreview-frontend-tests/frontend/src/screenshotExport.js";

const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.document = originalDocument;
});

function createCanvasFactory(resolveSize) {
  const canvases = [];
  const toBlobCalls = [];

  globalThis.document = {
    createElement: (tagName) => {
      assert.equal(tagName, "canvas");
      const operations = [];
      const canvas = {
        width: 0,
        height: 0,
        operations,
        getContext: () => ({
          set fillStyle(value) {
            operations.push(["fillStyle", value]);
          },
          set strokeStyle(value) {
            operations.push(["strokeStyle", value]);
          },
          set lineWidth(value) {
            operations.push(["lineWidth", value]);
          },
          set lineCap(value) {
            operations.push(["lineCap", value]);
          },
          set lineJoin(value) {
            operations.push(["lineJoin", value]);
          },
          fillRect: (...args) => operations.push(["fillRect", ...args]),
          drawImage: (...args) => operations.push(["drawImage", ...args.slice(1)]),
          beginPath: () => operations.push(["beginPath"]),
          moveTo: (...args) => operations.push(["moveTo", ...args]),
          lineTo: (...args) => operations.push(["lineTo", ...args]),
          stroke: () => operations.push(["stroke"]),
          fill: () => operations.push(["fill"]),
          strokeRect: (...args) => operations.push(["strokeRect", ...args])
        }),
        toBlob: (callback, type, quality) => {
          toBlobCalls.push({ type, quality, width: canvas.width, height: canvas.height });
          callback(new Blob([new Uint8Array(resolveSize(canvas, type, quality))], { type }));
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };

  return { canvases, toBlobCalls };
}

test("clampCropRect keeps a dragged crop inside the screenshot bounds", () => {
  const crop = clampCropRect({ x: -20, y: 90, width: 260, height: 80 }, 200, 120);

  assert.deepEqual(crop, { x: 0, y: 90, width: 200, height: 30 });
});

test("exportEditedScreenshot lowers quality until the file is below the byte target", async () => {
  const { canvases, toBlobCalls } = createCanvasFactory((_canvas, _type, quality) =>
    quality && quality >= 0.8 ? 720_000 : 420_000
  );
  const source = { width: 3200, height: 1800 };

  const file = await exportEditedScreenshot(
    source,
    { x: 100, y: 50, width: 2400, height: 1200 },
    [
      { kind: "arrow", startX: 200, startY: 160, endX: 600, endY: 360 },
      { kind: "rect", startX: 700, startY: 260, endX: 1200, endY: 620 }
    ],
    {
      maxBytes: 600_000,
      maxDimension: 1280,
      qualities: [0.82, 0.62],
      name: "screen-shot.webp"
    }
  );

  assert.equal(file.name, "screen-shot.webp");
  assert.equal(file.type, "image/webp");
  assert.equal(file.size, 420_000);
  assert.deepEqual(
    toBlobCalls.map(({ type, quality }) => ({ type, quality })),
    [
      { type: "image/webp", quality: 0.82 },
      { type: "image/webp", quality: 0.62 }
    ]
  );
  assert.equal(canvases[0].width, 1280);
  assert.equal(canvases[0].height, 640);
  assert(canvases[0].operations.some((operation) => operation[0] === "drawImage"));
  assert(canvases[0].operations.some((operation) => operation[0] === "strokeRect"));
  assert(canvases[0].operations.filter((operation) => operation[0] === "lineTo").length >= 3);
});

test("exportEditedScreenshot refuses to return an image that still exceeds the byte target", async () => {
  createCanvasFactory(() => 900_000);
  const source = { width: 1600, height: 900 };

  await assert.rejects(
    () =>
      exportEditedScreenshot(source, { x: 0, y: 0, width: 1600, height: 900 }, [], {
        maxBytes: 100_000,
        maxDimension: 800,
        minDimension: 790,
        qualities: [0.7],
        name: "too-large.webp"
      }),
    /截图压缩后仍超过 98KB/
  );
});
