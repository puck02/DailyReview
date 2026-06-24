import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Crop, Minus, RotateCcw, SlidersHorizontal, Square, X } from "lucide-react";
import {
  ScreenshotCropRect,
  ScreenshotMark,
  clampCropRect,
  exportEditedScreenshot
} from "./screenshotExport";

type ScreenshotTool = "crop" | "arrow" | "rect" | "line";
type ScreenshotPoint = { x: number; y: number };
type ScreenshotDraft = {
  tool: ScreenshotTool;
  start: ScreenshotPoint;
  current: ScreenshotPoint;
};

type ScreenshotEditorProps = {
  sourceCanvas: HTMLCanvasElement;
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
};

const minimumDragDistance = 8;
const defaultStrokeWidth = 3;
const minimumStrokeWidth = 1;
const maximumStrokeWidth = 8;

function rectFromPoints(start: ScreenshotPoint, end: ScreenshotPoint): ScreenshotCropRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function cropOverlayRects(crop: ScreenshotCropRect, width: number, height: number) {
  return [
    { x: 0, y: 0, width, height: crop.y },
    { x: 0, y: crop.y + crop.height, width, height: Math.max(0, height - crop.y - crop.height) },
    { x: 0, y: crop.y, width: crop.x, height: crop.height },
    { x: crop.x + crop.width, y: crop.y, width: Math.max(0, width - crop.x - crop.width), height: crop.height }
  ];
}

function dragDistance(draft: ScreenshotDraft) {
  return Math.hypot(draft.current.x - draft.start.x, draft.current.y - draft.start.y);
}

function markFromDraft(draft: ScreenshotDraft, strokeWidth: number): ScreenshotMark | null {
  if (draft.tool === "crop") return null;
  return {
    kind: draft.tool === "arrow" ? "arrow" : draft.tool === "line" ? "line" : "rect",
    startX: draft.start.x,
    startY: draft.start.y,
    endX: draft.current.x,
    endY: draft.current.y,
    strokeWidth
  };
}

function ToolButton({
  active,
  title,
  children,
  onClick
}: {
  active: boolean;
  title: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "screenshot-tool active" : "screenshot-tool"}
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ScreenshotEditor({ sourceCanvas, onCancel, onConfirm }: ScreenshotEditorProps) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const previewUrl = useMemo(() => sourceCanvas.toDataURL("image/jpeg", 0.9), [sourceCanvas]);
  const [tool, setTool] = useState<ScreenshotTool>("crop");
  const [crop, setCrop] = useState<ScreenshotCropRect>(() => ({ x: 0, y: 0, width: sourceWidth, height: sourceHeight }));
  const [marks, setMarks] = useState<ScreenshotMark[]>([]);
  const [draft, setDraft] = useState<ScreenshotDraft | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(defaultStrokeWidth);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const activeCrop =
    draft?.tool === "crop"
      ? clampCropRect(rectFromPoints(draft.start, draft.current), sourceWidth, sourceHeight)
      : crop;
  const previewMark = draft && draft.tool !== "crop" && dragDistance(draft) >= minimumDragDistance ? markFromDraft(draft, strokeWidth) : null;
  const shownMarks = previewMark ? [...marks, previewMark] : marks;
  const overlayRects = cropOverlayRects(activeCrop, sourceWidth, sourceHeight);
  const stageStyle = {
    "--screenshot-ratio": `${sourceWidth} / ${sourceHeight}`
  } as CSSProperties;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function pointFromEvent(event: ReactPointerEvent<SVGSVGElement>): ScreenshotPoint {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.round(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * sourceWidth),
      y: Math.round(Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1) * sourceHeight)
    };
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    event.preventDefault();
    const point = pointFromEvent(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setError("");
    setDraft({ tool, start: point, current: point });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draft) return;
    setDraft({ ...draft, current: pointFromEvent(event) });
  }

  function finishDraft(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draft) return;
    const nextDraft = { ...draft, current: pointFromEvent(event) };
    setDraft(null);
    if (dragDistance(nextDraft) < minimumDragDistance) return;
    if (nextDraft.tool === "crop") {
      setCrop(clampCropRect(rectFromPoints(nextDraft.start, nextDraft.current), sourceWidth, sourceHeight));
      return;
    }
    const mark = markFromDraft(nextDraft, strokeWidth);
    if (mark) setMarks((current) => [...current, mark]);
  }

  async function handleConfirm() {
    setExporting(true);
    setError("");
    try {
      const file = await exportEditedScreenshot(sourceCanvas, crop, marks, {
        maxBytes: 200 * 1024,
        maxDimension: 1280,
        name: `screenshot-${Date.now()}.webp`
      });
      await onConfirm(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "截图导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="screenshot-editor-backdrop" role="dialog" aria-modal="true" aria-label="截图编辑器">
      <div className="screenshot-editor-panel">
        <div className="screenshot-editor-toolbar">
          <div className="screenshot-tool-group" aria-label="截图编辑工具">
            <ToolButton active={tool === "crop"} title="裁剪区域" onClick={() => setTool("crop")}>
              <Crop size={18} />
            </ToolButton>
            <ToolButton active={tool === "arrow"} title="画箭头" onClick={() => setTool("arrow")}>
              <ArrowUpRight size={18} />
            </ToolButton>
            <ToolButton active={tool === "rect"} title="画方框" onClick={() => setTool("rect")}>
              <Square size={18} />
            </ToolButton>
            <ToolButton active={tool === "line"} title="画直线" onClick={() => setTool("line")}>
              <Minus size={18} />
            </ToolButton>
          </div>
          <div className="screenshot-thickness-control" title="线条粗细">
            <SlidersHorizontal size={17} />
            <input
              type="range"
              min={minimumStrokeWidth}
              max={maximumStrokeWidth}
              step={1}
              value={strokeWidth}
              onChange={(event) => setStrokeWidth(Number(event.currentTarget.value))}
              aria-label="线条粗细"
            />
            <span className="screenshot-thickness-value">{strokeWidth}px</span>
          </div>
          <div className="screenshot-toolbar-actions">
            <button
              type="button"
              className="screenshot-action-button"
              onClick={() => setMarks((current) => current.slice(0, -1))}
              disabled={exporting || marks.length === 0}
              title="撤销"
              aria-label="撤销"
            >
              <RotateCcw size={18} />
            </button>
            <button type="button" className="screenshot-action-button" onClick={onCancel} disabled={exporting} title="取消" aria-label="取消">
              <X size={18} />
            </button>
            <button type="button" className="screenshot-confirm-button" onClick={handleConfirm} disabled={exporting} title="使用截图" aria-label="使用截图">
              <Check size={18} />
              <span>{exporting ? "处理中" : "使用截图"}</span>
            </button>
          </div>
        </div>
        {error && <div className="screenshot-editor-error">{error}</div>}
        <div className="screenshot-stage" style={stageStyle}>
          <img className="screenshot-preview" src={previewUrl} alt="截图预览" draggable={false} />
          <svg
            ref={overlayRef}
            className="screenshot-overlay"
            viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDraft}
            onPointerCancel={() => setDraft(null)}
          >
            <defs>
              <marker id="screenshot-arrow-head" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {overlayRects.map((rect, index) => (
              <rect key={index} className="screenshot-crop-shade" x={rect.x} y={rect.y} width={rect.width} height={rect.height} />
            ))}
            <rect className="screenshot-crop-rect" x={activeCrop.x} y={activeCrop.y} width={activeCrop.width} height={activeCrop.height} />
            {shownMarks.map((mark, index) => {
              if (mark.kind === "arrow") {
                return (
                  <line
                    key={index}
                    className="screenshot-mark screenshot-mark-arrow"
                    x1={mark.startX}
                    y1={mark.startY}
                    x2={mark.endX}
                    y2={mark.endY}
                    strokeWidth={mark.strokeWidth ?? defaultStrokeWidth}
                    markerEnd="url(#screenshot-arrow-head)"
                  />
                );
              }
              if (mark.kind === "line") {
                return (
                  <line
                    key={index}
                    className="screenshot-mark screenshot-mark-line"
                    x1={mark.startX}
                    y1={mark.startY}
                    x2={mark.endX}
                    y2={mark.endY}
                    strokeWidth={mark.strokeWidth ?? defaultStrokeWidth}
                  />
                );
              }
              return (
                <rect
                  key={index}
                  className="screenshot-mark"
                  x={Math.min(mark.startX, mark.endX)}
                  y={Math.min(mark.startY, mark.endY)}
                  width={Math.abs(mark.endX - mark.startX)}
                  height={Math.abs(mark.endY - mark.startY)}
                  strokeWidth={mark.strokeWidth ?? defaultStrokeWidth}
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
