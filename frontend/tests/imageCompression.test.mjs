import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prepareImageForUpload } from "/tmp/dailyreview-frontend-tests/frontend/src/imageCompression.js";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalFileReader = globalThis.FileReader;
const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalImage = globalThis.Image;
const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.FileReader = originalFileReader;
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.Image = originalImage;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
});

class ImmediateFileReader {
  result = "";
  onload = null;
  onerror = null;

  readAsDataURL(file) {
    this.result = `data:${file.type};base64,prepared-${file.size}`;
    this.onload?.();
  }
}

test("small images keep the original file and still expose a data url", async () => {
  globalThis.FileReader = ImmediateFileReader;
  globalThis.window = {};
  const file = new File([new Uint8Array(128)], "small.png", { type: "image/png" });

  const prepared = await prepareImageForUpload(file);

  assert.equal(prepared.file, file);
  assert.equal(prepared.dataUrl, "data:image/png;base64,prepared-128");
});

test("large non-gif images are resized through canvas before upload", async () => {
  globalThis.FileReader = ImmediateFileReader;
  globalThis.window = { createImageBitmap: true };
  globalThis.createImageBitmap = async () => ({ width: 3200, height: 1600, close() {} });
  const drawCalls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: () => {},
      drawImage: (_image, x, y, width, height) => drawCalls.push({ x, y, width, height })
    }),
    toBlob: (callback, type, quality) => callback(new Blob([new Uint8Array(200)], { type }))
  };
  globalThis.document = { createElement: () => canvas };
  const file = new File([new Uint8Array(1200 * 1024)], "large.png", { type: "image/png" });

  const prepared = await prepareImageForUpload(file);

  assert.notEqual(prepared.file, file);
  assert.equal(prepared.file.size, 200);
  assert.equal(prepared.file.type, "image/jpeg");
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 800);
  assert.deepEqual(drawCalls, [{ x: 0, y: 0, width: 1600, height: 800 }]);
  assert.equal(prepared.dataUrl, "data:image/jpeg;base64,prepared-200");
});

test("large images still compress when createImageBitmap is unavailable", async () => {
  globalThis.FileReader = ImmediateFileReader;
  globalThis.window = {};
  globalThis.Image = class {
    onload = null;
    onerror = null;
    width = 3200;
    height = 1600;
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.URL.createObjectURL = () => "blob:mock";
  globalThis.URL.revokeObjectURL = () => {};
  const drawCalls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: () => {},
      drawImage: (_image, x, y, width, height) => drawCalls.push({ x, y, width, height })
    }),
    toBlob: (callback, type, quality) => callback(new Blob([new Uint8Array(180)], { type }))
  };
  globalThis.document = { createElement: () => canvas };
  const file = new File([new Uint8Array(1200 * 1024)], "large.png", { type: "image/png" });

  const prepared = await prepareImageForUpload(file);

  assert.notEqual(prepared.file, file);
  assert.equal(prepared.file.size, 180);
  assert.equal(prepared.file.type, "image/jpeg");
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 800);
  assert.deepEqual(drawCalls, [{ x: 0, y: 0, width: 1600, height: 800 }]);
});

test("large clipboard screenshots with generic mime are converted to jpeg before upload", async () => {
  globalThis.FileReader = ImmediateFileReader;
  globalThis.window = { createImageBitmap: true };
  globalThis.createImageBitmap = async () => ({ width: 2400, height: 1800, close() {} });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect: () => {}, drawImage: () => {} }),
    toBlob: (callback, type, quality) => callback(new Blob([new Uint8Array(160)], { type }))
  };
  globalThis.document = { createElement: () => canvas };
  const file = new File([new Uint8Array(2 * 1024 * 1024)], "clipboard", { type: "application/octet-stream" });

  const prepared = await prepareImageForUpload(file);

  assert.notEqual(prepared.file, file);
  assert.equal(prepared.file.size, 160);
  assert.equal(prepared.file.type, "image/jpeg");
  assert.equal(prepared.file.name, "clipboard.jpg");
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 1200);
});
