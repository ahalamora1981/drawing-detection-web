"use client";

import { useEffect, useRef, useState } from "react";
import { DIMENSION_COLORS } from "@/lib/constants";
import { useI18n } from "@/lib/i18n";
import type { DetectedDimension, RunBox } from "@/lib/types";

interface BoxCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  boxes: RunBox[];
  dimensions: DetectedDimension[];
  mode: "locate" | "result";
  zoom: number;
  editable: boolean;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onAdd: (box: { x: number; y: number; w: number; h: number }) => void;
  onDelete: (id: string) => void;
}

interface DragState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Drawing canvas with the boxes drawn as an interactive overlay.
 *
 * The boxes are DOM elements, not baked into a PNG: hovering, selecting,
 * deleting and adding are instant, and switching between the "located" and
 * "read" views costs nothing. A static annotated PNG is still produced by the
 * engine for export.
 */
export default function BoxCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  boxes,
  dimensions,
  mode,
  zoom,
  editable,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  onAdd,
  onDelete,
}: BoxCanvasProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);

  const imgW = imageWidth || natural.w;
  const imgH = imageHeight || natural.h;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const baseScale =
    imgW > 0 && imgH > 0 && viewport.w > 0
      ? Math.min(viewport.w / imgW, viewport.h / imgH)
      : 0;
  const scale = baseScale * zoom;
  const dispW = Math.max(1, Math.round(imgW * scale));
  const dispH = Math.max(1, Math.round(imgH * scale));

  // After a zoom change, keep the middle of the drawing in view instead of
  // jumping to the top-left corner.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [zoom, dispW, dispH]);

  const dimById = new Map(dimensions.map((d) => [d.item_id, d]));

  const toImageCoords = (clientX: number, clientY: number) => {
    const rect = fitRef.current?.getBoundingClientRect();
    if (!rect || imgW <= 0) return { x: 0, y: 0 };
    const x = ((clientX - rect.left) / rect.width) * imgW;
    const y = ((clientY - rect.top) / rect.height) * imgH;
    return {
      x: Math.max(0, Math.min(imgW, x)),
      y: Math.max(0, Math.min(imgH, y)),
    };
  };

  // Drag-to-add: only starts on empty canvas, so clicking a box never draws.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editable || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-box]")) return;
    e.preventDefault();
    const p = toImageCoords(e.clientX, e.clientY);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    onSelect(null);
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const p = toImageCoords(e.clientX, e.clientY);
      setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
    };
    const up = () => {
      setDrag((d) => {
        if (d) {
          const x = Math.min(d.x0, d.x1);
          const y = Math.min(d.y0, d.y1);
          const w = Math.abs(d.x1 - d.x0);
          const h = Math.abs(d.y1 - d.y0);
          if (w >= 8 && h >= 8) onAdd({ x, y, w, h });
        }
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, imgW, imgH, onAdd]);

  const pct = (v: number, total: number) => `${(v / (total || 1)) * 100}%`;

  return (
    <div className="canvas-scroll" ref={scrollRef}>
      <div
        className="canvas-fit"
        ref={fitRef}
        style={{ width: dispW, height: dispH }}
      >
        <img
          src={imageUrl}
          alt={t("ws.canvas.alt")}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />

        <div
          className="canvas-overlay"
          onPointerDown={handlePointerDown}
          style={{ cursor: editable ? "crosshair" : "default" }}
        >
          {boxes.map((box, index) => {
            const dim = dimById.get(box.id);
            const isSelected = selectedId === box.id;
            const isHovered = hoveredId === box.id;
            const review = !!dim?.needs_review;
            // In the locate view a box the engine could not tie to printed text
            // is amber and dashed: it is a guess, not a result.
            const unsure = mode === "locate" && box.source === "unsure";
            const color =
              mode === "result" && dim
                ? review
                  ? "var(--dim-review)"
                  : DIMENSION_COLORS[dim.dimension_type] ?? DIMENSION_COLORS.unknown
                : unsure
                  ? "var(--dim-review)"
                  : "var(--dim-locate)";

            return (
              <div
                key={box.id}
                data-box="1"
                className={[
                  "dbox",
                  mode === "locate" ? "dbox--locate" : "",
                  unsure ? "dbox--unsure" : "",
                  isSelected ? "dbox--selected" : "",
                  review ? "dbox--review" : "",
                  isHovered ? "dbox--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  left: pct(box.x, imgW),
                  top: pct(box.y, imgH),
                  width: pct(box.w, imgW),
                  height: pct(box.h, imgH),
                  borderColor: color,
                  borderWidth:
                    mode === "locate" ? (isSelected || isHovered ? 3 : 2) : isSelected || isHovered ? 2.5 : 1.5,
                }}
                title={
                  dim
                    ? dim.read_failed || dim.raw_text === "READ_FAILED"
                      ? t("table.failed")
                      : dim.raw_text
                    : unsure
                      ? t("ws.canvas.unsureTitle", { n: index + 1 })
                      : t("ws.canvas.boxTitle", { n: index + 1 })
                }
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(box.id);
                }}
                onMouseEnter={() => onHover(box.id)}
                onMouseLeave={() => onHover(null)}
              >
                <span className="dbox__num" style={{ backgroundColor: color }}>
                  {index + 1}
                </span>
                {isSelected && editable && (
                  <button
                    className="dbox__delete"
                    title={t("ws.canvas.deleteBox")}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onDelete(box.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {drag && (
            <div
              className="dbox dbox--ghost"
              style={{
                left: pct(Math.min(drag.x0, drag.x1), imgW),
                top: pct(Math.min(drag.y0, drag.y1), imgH),
                width: pct(Math.abs(drag.x1 - drag.x0), imgW),
                height: pct(Math.abs(drag.y1 - drag.y0), imgH),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
