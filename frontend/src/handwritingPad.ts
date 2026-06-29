export type HandwritingPoint = {
  x: number;
  y: number;
  pressure: number;
  time: number;
};

export type HandwritingInputPoint = {
  x: number;
  y: number;
  pressure: number;
  pointerType: string;
  time: number;
};

export type HandwritingExportOptions = {
  width: number;
  height: number;
  name?: string;
  minStrokeWidth?: number;
  maxStrokeWidth?: number;
  pixelRatio?: number;
};

const webpType = "image/webp";
const defaultMinStrokeWidth = 2;
const defaultMaxStrokeWidth = 12;
const fallbackPressure = 0.5;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function safePressure(value: number, pointerType = "") {
  if (!Number.isFinite(value)) return fallbackPressure;
  if (value > 0) return clamp(value, 0, 1);
  return pointerType === "pen" ? 0 : fallbackPressure;
}

export function isHandwritingPenInput(pointerType: string) {
  return pointerType === "pen";
}

export function isHandwritingInputAllowed(pointerType: string, penOnlyMode: boolean) {
  return !penOnlyMode || isHandwritingPenInput(pointerType);
}

export function isActiveHandwritingPointer(
  activePointerId: number | null,
  pointerId: number,
  pointerType: string,
  penOnlyMode: boolean
) {
  return isHandwritingInputAllowed(pointerType, penOnlyMode) && activePointerId === pointerId;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export function handwritingStrokeWidth(
  pressure: number,
  minWidth = defaultMinStrokeWidth,
  maxWidth = defaultMaxStrokeWidth
) {
  const safeMin = Math.max(0.5, minWidth);
  const safeMax = Math.max(safeMin, maxWidth);
  if (!Number.isFinite(pressure)) return (safeMin + safeMax) / 2;
  const normalized = clamp(pressure, 0, 1);
  const amplified = clamp((normalized - 0.05) / 0.8, 0, 1);
  return safeMin + Math.pow(amplified, 0.7) * (safeMax - safeMin);
}

export function addHandwritingPoint(points: HandwritingPoint[], input: HandwritingInputPoint): HandwritingPoint[] {
  const previous = points[points.length - 1];
  const pressure = safePressure(input.pressure, input.pointerType);
  if (!previous) return [...points, { x: input.x, y: input.y, pressure, time: input.time }];

  const distance = Math.hypot(input.x - previous.x, input.y - previous.y);
  const positionWeight = distance < 4 ? 0.46 : distance < 12 ? 0.62 : 0.78;
  const pressureWeight = 0.9;
  return [
    ...points,
    {
      x: previous.x + (input.x - previous.x) * positionWeight,
      y: previous.y + (input.y - previous.y) * positionWeight,
      pressure: previous.pressure + (pressure - previous.pressure) * pressureWeight,
      time: input.time
    }
  ];
}

function drawStroke(
  context: CanvasRenderingContext2D,
  points: HandwritingPoint[],
  scale: number,
  minStrokeWidth: number,
  maxStrokeWidth: number
) {
  if (!points.length) return;
  if (points.length === 1) {
    const point = points[0];
    context.beginPath();
    context.lineWidth = handwritingStrokeWidth(point.pressure, minStrokeWidth, maxStrokeWidth) * scale;
    context.moveTo(point.x * scale, point.y * scale);
    context.lineTo((point.x + 0.1) * scale, point.y * scale);
    context.stroke();
    return;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1] || current;
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;

    context.beginPath();
    context.lineWidth = handwritingStrokeWidth(current.pressure, minStrokeWidth, maxStrokeWidth) * scale;
    context.moveTo(previous.x * scale, previous.y * scale);
    context.quadraticCurveTo(current.x * scale, current.y * scale, midX * scale, midY * scale);
    context.stroke();
  }
}

export async function exportHandwritingImage(
  strokes: HandwritingPoint[][],
  options: HandwritingExportOptions
): Promise<File> {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const pixelRatio = Math.max(1, Math.min(3, options.pixelRatio ?? globalThis.devicePixelRatio ?? 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法打开写字板");

  context.fillStyle = "#fffffe";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#111111";
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const stroke of strokes) {
    drawStroke(
      context,
      stroke,
      pixelRatio,
      options.minStrokeWidth ?? defaultMinStrokeWidth,
      options.maxStrokeWidth ?? defaultMaxStrokeWidth
    );
  }

  const blob = await canvasBlob(canvas, webpType, 0.86);
  if (!blob) throw new Error("写字板导出失败，请重试");
  return new File([blob], options.name || `handwriting-${Date.now()}.webp`, { type: blob.type || webpType });
}
