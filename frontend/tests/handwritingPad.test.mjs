import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  addHandwritingPoint,
  exportHandwritingImage,
  isActiveHandwritingPointer,
  isHandwritingInputAllowed,
  handwritingStrokeWidth,
  isHandwritingPenInput
} from "/tmp/dailyreview-frontend-tests/frontend/src/handwritingPad.js";

const originalDocument = globalThis.document;
const originalDevicePixelRatio = globalThis.devicePixelRatio;

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.devicePixelRatio = originalDevicePixelRatio;
});

function createCanvasFactory(resolveSize = 80_000) {
  const canvases = [];

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
          beginPath: () => operations.push(["beginPath"]),
          moveTo: (...args) => operations.push(["moveTo", ...args]),
          lineTo: (...args) => operations.push(["lineTo", ...args]),
          quadraticCurveTo: (...args) => operations.push(["quadraticCurveTo", ...args]),
          stroke: () => operations.push(["stroke"])
        }),
        toBlob: (callback, type, quality) => {
          operations.push(["toBlob", type, quality]);
          callback(new Blob([new Uint8Array(resolveSize)], { type }));
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };

  return { canvases };
}

test("handwritingStrokeWidth maps Apple Pencil pressure into a usable width range", () => {
  assert.equal(handwritingStrokeWidth(0, 2, 10), 2);
  assert.equal(handwritingStrokeWidth(1, 2, 10), 10);
  assert(handwritingStrokeWidth(0.5, 2, 10) > 7);
  assert.equal(handwritingStrokeWidth(Number.NaN, 2, 10), 6);
});

test("addHandwritingPoint smooths short noisy Apple Pencil movement and pressure spikes", () => {
  const stroke = addHandwritingPoint([{ x: 10, y: 10, pressure: 0.2, time: 1 }], {
    x: 13,
    y: 12,
    pressure: 1,
    pointerType: "pen",
    time: 2
  });

  assert.equal(stroke.length, 2);
  assert(stroke[1].x > 10 && stroke[1].x < 13);
  assert(stroke[1].y > 10 && stroke[1].y < 12);
  assert(stroke[1].pressure > 0.2 && stroke[1].pressure < 1);
});

test("addHandwritingPoint falls back when non-pen input has no pressure", () => {
  const stroke = addHandwritingPoint([], { x: 12, y: 18, pressure: 0, pointerType: "touch", time: 7 });

  assert.deepEqual(stroke, [{ x: 12, y: 18, pressure: 0.5, time: 7 }]);
});

test("isHandwritingPenInput only accepts Apple Pencil style pen input", () => {
  assert.equal(isHandwritingPenInput("pen"), true);
  assert.equal(isHandwritingPenInput("touch"), false);
  assert.equal(isHandwritingPenInput("mouse"), false);
  assert.equal(isHandwritingPenInput(""), false);
});

test("isHandwritingInputAllowed only filters touch input in pen-only mode", () => {
  assert.equal(isHandwritingInputAllowed("pen", false), true);
  assert.equal(isHandwritingInputAllowed("touch", false), true);
  assert.equal(isHandwritingInputAllowed("mouse", false), true);
  assert.equal(isHandwritingInputAllowed("pen", true), true);
  assert.equal(isHandwritingInputAllowed("touch", true), false);
  assert.equal(isHandwritingInputAllowed("mouse", true), false);
});

test("isActiveHandwritingPointer keeps palm touches from affecting active Pencil strokes only in pen-only mode", () => {
  assert.equal(isActiveHandwritingPointer(7, 7, "pen", true), true);
  assert.equal(isActiveHandwritingPointer(7, 8, "pen", true), false);
  assert.equal(isActiveHandwritingPointer(7, 8, "touch", true), false);
  assert.equal(isActiveHandwritingPointer(null, 7, "pen", true), false);
  assert.equal(isActiveHandwritingPointer(7, 7, "touch", false), true);
});

test("exportHandwritingImage renders pressure-sensitive strokes to a webp attachment file", async () => {
  const { canvases } = createCanvasFactory();
  globalThis.devicePixelRatio = 2;

  const file = await exportHandwritingImage(
    [
      [
        { x: 10, y: 10, pressure: 0.2, time: 1 },
        { x: 60, y: 20, pressure: 0.6, time: 2 },
        { x: 120, y: 40, pressure: 1, time: 3 }
      ]
    ],
    { width: 300, height: 180, name: "handwriting-note.webp" }
  );

  assert.equal(file.name, "handwriting-note.webp");
  assert.equal(file.type, "image/webp");
  assert.equal(file.size, 80_000);
  assert.equal(canvases[0].width, 600);
  assert.equal(canvases[0].height, 360);
  assert(canvases[0].operations.some((operation) => operation[0] === "fillRect"));
  assert(canvases[0].operations.some((operation) => operation[0] === "quadraticCurveTo"));
  assert.deepEqual(
    canvases[0].operations.filter((operation) => operation[0] === "lineWidth").map((operation) => operation[1]),
    [19.101259946155565, 24]
  );
});
