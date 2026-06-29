import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Check, Eraser, Pencil, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import {
  HandwritingPoint,
  addHandwritingPoint,
  exportHandwritingImage,
  handwritingStrokeWidth,
  isActiveHandwritingPointer,
  isHandwritingInputAllowed
} from "./handwritingPad";

type HandwritingPadProps = {
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
};

type PadTool = "pen" | "eraser";

const fallbackPadWidth = 1180;
const fallbackPadHeight = 760;
const minStrokeWidth = 2;
const maxStrokeWidth = 16;

function pointFromEvent(event: ReactPointerEvent<HTMLCanvasElement>): HandwritingPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return addHandwritingPoint([], {
    x,
    y,
    pressure: event.pressure,
    pointerType: event.pointerType,
    time: event.timeStamp
  })[0];
}

export function HandwritingPad({ onCancel, onConfirm }: HandwritingPadProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<HandwritingPoint[][]>([]);
  const activeStrokeRef = useRef<HandwritingPoint[]>([]);
  const activePointerIdRef = useRef<number | null>(null);
  const [strokes, setStrokes] = useState<HandwritingPoint[][]>([]);
  const [tool, setTool] = useState<PadTool>("pen");
  const [penOnlyMode, setPenOnlyMode] = useState(false);
  const [strokeMax, setStrokeMax] = useState(4);
  const [canvasSize, setCanvasSize] = useState({ width: fallbackPadWidth, height: fallbackPadHeight });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const canvas = canvasRef.current;
    if (!backdrop || !canvas) return;
    const activeBackdrop = backdrop;

    function preventModalSelection(event: Event) {
      const target = event.target;
      if (target instanceof Node && activeBackdrop.contains(target)) event.preventDefault();
    }

    function clearActiveSelection() {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    }

    function preventCanvasTouch(event: TouchEvent) {
      event.preventDefault();
    }

    document.addEventListener("selectstart", preventModalSelection, { capture: true });
    document.addEventListener("contextmenu", preventModalSelection, { capture: true });
    document.addEventListener("selectionchange", clearActiveSelection);
    canvas.addEventListener("touchstart", preventCanvasTouch, { passive: false });
    canvas.addEventListener("touchmove", preventCanvasTouch, { passive: false });

    return () => {
      document.removeEventListener("selectstart", preventModalSelection, { capture: true });
      document.removeEventListener("contextmenu", preventModalSelection, { capture: true });
      document.removeEventListener("selectionchange", clearActiveSelection);
      canvas.removeEventListener("touchstart", preventCanvasTouch);
      canvas.removeEventListener("touchmove", preventCanvasTouch);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    paintCanvas(strokes, true);
  }, [strokes, strokeMax]);

  function paintCanvas(points: HandwritingPoint[][], syncSize = false) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth || fallbackPadWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight || fallbackPadHeight));
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fffffe";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(17, 17, 17, 0.08)";
    context.lineWidth = 1;
    for (let y = 40; y < height; y += 40) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    for (const stroke of points) drawStroke(context, stroke, strokeMax);
    if (syncSize) {
      setCanvasSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    }
    return context;
  }

  function setCommittedStrokes(nextStrokes: HandwritingPoint[][]) {
    strokesRef.current = nextStrokes;
    setStrokes(nextStrokes);
  }

  function eraseAtPoint(point: HandwritingPoint, syncState: boolean) {
    const nextStrokes = strokesRef.current.filter((stroke) => !stroke.some((item) => Math.hypot(item.x - point.x, item.y - point.y) < 28));
    if (nextStrokes.length === strokesRef.current.length) return;
    strokesRef.current = nextStrokes;
    paintCanvas(nextStrokes);
    if (syncState) setStrokes(nextStrokes);
  }

  function releasePointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser after cancel/lost capture.
    }
  }

  function endActiveStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const stroke = activeStrokeRef.current;
    activePointerIdRef.current = null;
    activeStrokeRef.current = [];
    releasePointer(event);
    if (tool === "eraser") {
      setStrokes(strokesRef.current);
      return;
    }
    if (stroke.length) setCommittedStrokes([...strokesRef.current, stroke]);
  }

  function drawStroke(context: CanvasRenderingContext2D, points: HandwritingPoint[], maxWidth: number) {
    if (!points.length) return;
    context.strokeStyle = "#111111";
    context.lineCap = "round";
    context.lineJoin = "round";
    if (points.length === 1) {
      const point = points[0];
      context.beginPath();
      context.lineWidth = handwritingStrokeWidth(point.pressure, minStrokeWidth, maxWidth);
      context.moveTo(point.x, point.y);
      context.lineTo(point.x + 0.1, point.y);
      context.stroke();
      return;
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const next = points[index + 1] || current;
      context.beginPath();
      context.lineWidth = handwritingStrokeWidth(current.pressure, minStrokeWidth, maxWidth);
      context.moveTo(previous.x, previous.y);
      context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
      context.stroke();
    }
  }

  function drawLiveSegment(context: CanvasRenderingContext2D, previous: HandwritingPoint, current: HandwritingPoint, maxWidth: number) {
    context.strokeStyle = "#111111";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.lineWidth = handwritingStrokeWidth(current.pressure, minStrokeWidth, maxWidth);
    context.moveTo(previous.x, previous.y);
    context.lineTo(current.x, current.y);
    context.stroke();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (exporting || activePointerIdRef.current !== null || !isHandwritingInputAllowed(event.pointerType, penOnlyMode)) return;
    activePointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and some browser edge cases can fail capture; drawing should still start.
    }
    setError("");
    const point = pointFromEvent(event);
    if (tool === "eraser") {
      eraseAtPoint(point, true);
      return;
    }
    activeStrokeRef.current = [point];
    const context = canvasRef.current?.getContext("2d");
    if (context) drawStroke(context, activeStrokeRef.current, strokeMax);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (exporting || !isActiveHandwritingPointer(activePointerIdRef.current, event.pointerId, event.pointerType, penOnlyMode)) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (tool === "eraser") {
      if (event.buttons !== 1) return;
      eraseAtPoint(point, false);
      return;
    }
    if (!activeStrokeRef.current.length) return;
    const previous = activeStrokeRef.current[activeStrokeRef.current.length - 1];
    activeStrokeRef.current.push(point);
    const context = canvasRef.current?.getContext("2d");
    if (context) drawLiveSegment(context, previous, point, strokeMax);
  }

  function finishStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!isActiveHandwritingPointer(activePointerIdRef.current, event.pointerId, event.pointerType, penOnlyMode)) return;
    event.preventDefault();
    endActiveStroke(event);
  }

  async function handleConfirm() {
    const committedStrokes = strokesRef.current;
    if (!committedStrokes.length || exporting) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setExporting(true);
    setError("");
    try {
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const file = await exportHandwritingImage(committedStrokes, {
        width: canvasSize.width,
        height: canvasSize.height,
        name: `handwriting-${Date.now()}.webp`,
        maxStrokeWidth: strokeMax,
        pixelRatio
      });
      await onConfirm(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "写字板导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div ref={backdropRef} className="handwriting-pad-backdrop" role="dialog" aria-modal="true" aria-label="写字板">
      <section className="handwriting-pad-panel">
        <header className="handwriting-pad-toolbar">
          <div className="handwriting-tool-group" aria-label="写字工具">
            <button
              type="button"
              className={tool === "pen" ? "handwriting-tool active" : "handwriting-tool"}
              onClick={() => setTool("pen")}
              aria-label="画笔"
              title="画笔"
            >
              <Pencil size={18} />
            </button>
            <button
              type="button"
              className={tool === "eraser" ? "handwriting-tool active" : "handwriting-tool"}
              onClick={() => setTool("eraser")}
              aria-label="橡皮"
              title="橡皮"
            >
              <Eraser size={18} />
            </button>
            <button
              type="button"
              className={penOnlyMode ? "handwriting-tool active" : "handwriting-tool"}
              onClick={() => {
                activePointerIdRef.current = null;
                activeStrokeRef.current = [];
                setPenOnlyMode((current) => !current);
              }}
              aria-label="仅笔模式"
              title="仅笔模式"
            >
              <ShieldCheck size={18} />
            </button>
          </div>
          <label className="handwriting-pressure-control" title="笔画上限">
            <SlidersHorizontal size={17} />
            <input
              type="range"
              min={minStrokeWidth}
              max={maxStrokeWidth}
              step={1}
              value={strokeMax}
              onChange={(event) => setStrokeMax(Number(event.currentTarget.value))}
              aria-label="笔画上限"
            />
            <span>{strokeMax}px</span>
          </label>
          <div className="handwriting-toolbar-actions">
            <button
              type="button"
              className="handwriting-action"
              onClick={() => setCommittedStrokes(strokesRef.current.slice(0, -1))}
              disabled={!strokes.length || exporting}
              aria-label="撤销"
              title="撤销"
            >
              <RotateCcw size={18} />
            </button>
            <button
              type="button"
              className="handwriting-action"
              onClick={() => setCommittedStrokes([])}
              disabled={!strokes.length || exporting}
              aria-label="清空"
              title="清空"
            >
              <Trash2 size={18} />
            </button>
            <button type="button" className="handwriting-action" onClick={onCancel} disabled={exporting} aria-label="取消" title="取消">
              <X size={18} />
            </button>
            <button
              type="button"
              className="handwriting-confirm"
              onClick={handleConfirm}
              disabled={!strokes.length || exporting}
              aria-label="使用手写"
              title="使用手写"
            >
              <Check size={18} />
              <span>{exporting ? "处理中" : "使用"}</span>
            </button>
          </div>
        </header>
        {error && <div className="handwriting-error">{error}</div>}
        <canvas
          ref={canvasRef}
          className="handwriting-canvas"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
        />
      </section>
    </div>
  );
}
