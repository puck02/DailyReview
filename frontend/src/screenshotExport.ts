export type ScreenshotCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenshotMark = {
  kind: "arrow" | "rect";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type ScreenshotExportOptions = {
  maxBytes?: number;
  maxDimension?: number;
  minDimension?: number;
  qualities?: number[];
  name?: string;
};

const defaultMaxBytes = 600 * 1024;
const defaultMaxDimension = 1280;
const defaultMinDimension = 640;
const defaultQualities = [0.74, 0.66, 0.58, 0.5, 0.44];
const webpType = "image/webp";
const jpegType = "image/jpeg";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function safeNumber(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const webp = await canvasBlob(canvas, webpType, quality);
  if (webp && webp.type === webpType) return webp;
  const jpeg = await canvasBlob(canvas, jpegType, quality);
  if (jpeg) return jpeg;
  throw new Error("截图导出失败，请重新截图");
}

function drawArrow(context: CanvasRenderingContext2D, mark: ScreenshotMark, crop: ScreenshotCropRect, scale: number) {
  const startX = (mark.startX - crop.x) * scale;
  const startY = (mark.startY - crop.y) * scale;
  const endX = (mark.endX - crop.x) * scale;
  const endY = (mark.endY - crop.y) * scale;
  const angle = Math.atan2(endY - startY, endX - startX);
  const length = Math.hypot(endX - startX, endY - startY);
  const headLength = clamp(length * 0.22, 12, 28);

  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - headLength * Math.cos(angle - Math.PI / 6), endY - headLength * Math.sin(angle - Math.PI / 6));
  context.lineTo(endX - headLength * Math.cos(angle + Math.PI / 6), endY - headLength * Math.sin(angle + Math.PI / 6));
  context.lineTo(endX, endY);
  context.fill();
}

function drawRect(context: CanvasRenderingContext2D, mark: ScreenshotMark, crop: ScreenshotCropRect, scale: number) {
  const left = (Math.min(mark.startX, mark.endX) - crop.x) * scale;
  const top = (Math.min(mark.startY, mark.endY) - crop.y) * scale;
  const width = Math.abs(mark.endX - mark.startX) * scale;
  const height = Math.abs(mark.endY - mark.startY) * scale;
  context.strokeRect(left, top, width, height);
}

function renderScreenshotCanvas(
  source: CanvasImageSource & { width: number; height: number },
  crop: ScreenshotCropRect,
  marks: ScreenshotMark[],
  scale: number
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法编辑截图");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);

  context.strokeStyle = "#ff3b30";
  context.fillStyle = "#ff3b30";
  context.lineWidth = clamp(3 * scale, 2, 5);
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const mark of marks) {
    if (mark.kind === "arrow") drawArrow(context, mark, crop, scale);
    else drawRect(context, mark, crop, scale);
  }

  return canvas;
}

function fileNameForType(name: string, type: string) {
  const extension = type === webpType ? ".webp" : ".jpg";
  return (name || "screenshot").replace(/\.[^.]+$/, "") + extension;
}

export function clampCropRect(crop: ScreenshotCropRect, sourceWidth: number, sourceHeight: number): ScreenshotCropRect {
  const safeSourceWidth = Math.max(1, Math.round(safeNumber(sourceWidth, 1)));
  const safeSourceHeight = Math.max(1, Math.round(safeNumber(sourceHeight, 1)));
  const left = clamp(Math.min(safeNumber(crop.x, 0), safeNumber(crop.x, 0) + safeNumber(crop.width, safeSourceWidth)), 0, safeSourceWidth);
  const top = clamp(Math.min(safeNumber(crop.y, 0), safeNumber(crop.y, 0) + safeNumber(crop.height, safeSourceHeight)), 0, safeSourceHeight);
  const right = clamp(Math.max(safeNumber(crop.x, 0), safeNumber(crop.x, 0) + safeNumber(crop.width, safeSourceWidth)), 0, safeSourceWidth);
  const bottom = clamp(Math.max(safeNumber(crop.y, 0), safeNumber(crop.y, 0) + safeNumber(crop.height, safeSourceHeight)), 0, safeSourceHeight);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  };
}

export async function exportEditedScreenshot(
  source: CanvasImageSource & { width: number; height: number },
  crop: ScreenshotCropRect,
  marks: ScreenshotMark[],
  options: ScreenshotExportOptions = {}
): Promise<File> {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const maxDimension = options.maxDimension ?? defaultMaxDimension;
  const minDimension = options.minDimension ?? defaultMinDimension;
  const qualities = options.qualities?.length ? options.qualities : defaultQualities;
  const safeCrop = clampCropRect(crop, source.width, source.height);
  const initialScale = Math.min(1, maxDimension / Math.max(safeCrop.width, safeCrop.height));
  const minScale = Math.min(initialScale, minDimension / Math.max(safeCrop.width, safeCrop.height));
  let scale = initialScale;
  let bestBlob: Blob | null = null;

  while (scale >= minScale) {
    for (const quality of qualities) {
      const canvas = renderScreenshotCanvas(source, safeCrop, marks, scale);
      const blob = await encodeCanvas(canvas, quality);
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= maxBytes) {
        return new File([blob], fileNameForType(options.name || "screenshot.webp", blob.type), { type: blob.type });
      }
    }
    if (scale === minScale) break;
    scale = Math.max(minScale, scale * 0.82);
  }

  throw new Error(`截图压缩后仍超过 ${formatBytes(maxBytes)}，请缩小截图区域后重试`);
}
