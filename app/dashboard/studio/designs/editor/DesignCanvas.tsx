// Marketr — Phase 11 "Canvas": the konva canvas. Renders the active page at
// `zoom`, with per-type element renderers, drag + transform committing back
// to the store, shift-click multi-select, and center-snap guides.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Path,
  Rect,
  Stage,
  Text,
  TextPath,
  Transformer,
} from "react-konva";
import Konva from "konva";
import { useCanvasStore } from "@/lib/design/store";
import type { DesignElement, ImageElement, SvgElement, TextElement } from "@/lib/design/types";
import { iconDataUrl } from "@/lib/design/iconify";
/* TEXTURES (integration #10) */
import { textureFillProps, useTextureTile } from "@/lib/design/textures";
/* END */
import { chartSize } from "@/lib/design/chart-math";
import {
  hasRichFragments,
  layoutRichText,
  type MeasureFn,
} from "@/lib/design/rich-text";
import { ChartNode } from "./ChartNode";
import { QrNode } from "./QrNode";

export type StageRef = { current: Konva.Stage | null };

/** Minimal useImage hook — loads an <img> for Konva Image nodes. */
function useImage(src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let live = true;
    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (live) setImg(image);
    };
    image.src = src;
    return () => {
      live = false;
      setImg(null);
    };
  }, [src]);
  return img;
}

function konvaFontStyle(s: DesignElement & { type: "text" }): string {
  return s.fontStyle === "bold-italic" ? "bold italic" : s.fontStyle;
}

interface NodeProps {
  el: DesignElement;
  registerRef: (id: string, node: Konva.Node | null) => void;
  onSelect: (id: string, additive: boolean) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onSnapMove: (id: string, node: Konva.Node) => void;
  onSnapEnd: () => void;
  onTransformEnd: (el: DesignElement, e: Konva.KonvaEventObject<Event>) => void;
}

function ElementNode({ el, registerRef, onSelect, onDragEnd, onSnapMove, onSnapEnd, onTransformEnd }: NodeProps) {
  const ref = (node: Konva.Node | null) => registerRef(el.id, node);
  const common = {
    id: el.id,
    name: el.id,
    ref,
    x: el.x,
    y: el.y,
    rotation: el.rotation,
    opacity: el.opacity,
    visible: el.visible,
    draggable: !el.locked,
    onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      if (el.locked) return;
      onSelect(el.id, e.evt.shiftKey);
    },
    onTap: (e: Konva.KonvaEventObject<TouchEvent>) => {
      e.cancelBubble = true;
      if (el.locked) return;
      onSelect(el.id, e.evt.shiftKey ?? false);
    },
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      onSnapEnd();
      onDragEnd(el.id, e.target.x(), e.target.y());
    },
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => {
      onSnapMove(el.id, e.target);
    },
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
      onTransformEnd(el, e);
    },
  };

  /* TEXTURES (integration #10) — pattern fill from custom.texture provenance. */
  const textureImg = useTextureTile(el.custom);

  switch (el.type) {
    case "text":
      return <TextNode el={el} common={common} />;
    case "image":
      return <ImageNode el={el} common={common} />;
    case "rect": {
      const gradient = el.gradient
        ? {
            fillLinearGradientStartPoint: { x: 0, y: 0 },
            fillLinearGradientEndPoint: { x: el.width, y: 0 },
            fillLinearGradientColorStops: [0, el.gradient[0], 1, el.gradient[1]],
          }
        : {};
      return (
        <Rect
          {...common}
          {...gradient}
          width={el.width}
          height={el.height}
          fill={el.gradient ? undefined : el.fill}
          /* TEXTURES (integration #10) — pattern tile; skipped when a gradient owns the fill. */
          {...(el.gradient ? {} : textureFillProps(textureImg))}
          cornerRadius={el.cornerRadius}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
        />
      );
    }
    case "ellipse":
      return (
        <Ellipse
          {...common}
          radiusX={el.radiusX}
          radiusY={el.radiusY}
          fill={el.fill}
          /* TEXTURES (integration #10) */
          {...textureFillProps(textureImg)}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
        />
      );
    case "line":
      return (
        <Line
          {...common}
          points={el.points}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
          dash={el.dash}
          lineCap="round"
        />
      );
    case "svg":
      if (el.body) return <IconifySvgNode el={el} common={common} />;
      return (
        <Path
          {...common}
          data={el.path}
          fill={el.fill}
          /* TEXTURES (integration #10) */
          {...textureFillProps(textureImg)}
          scaleX={el.width / 24}
          scaleY={el.height / 24}
        />
      );
    case "chart":
      return <ChartNode el={el} common={common} />;
    case "qr":
      return <QrNode el={el} common={common} />;
  }
}

// FEATURE 1 — richer text: text-on-a-path when textPath holds usable SVG path
// data (fragments are ignored in path mode, per the schema contract),
// per-fragment runs when fragments are present, plain Konva Text otherwise.
// Degenerate path data falls back to styled text — content is never dropped.
function hasUsablePathData(d: string | undefined): d is string {
  if (!d || !d.trim()) return false;
  try {
    return (Konva.Path.parsePathData(d) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

/**
 * Width measurer backed by a scratch Konva.Text. Konva cannot construct
 * nodes without DOM ("Konva.js unsupported environment"), so the SSR
 * prerender gets a font-metric estimate; the client re-measures on first
 * render (document exists by then) and the estimate is never committed.
 */
function useTextMeasure(): MeasureFn {
  const scratchRef = useRef<Konva.Text | null>(null);
  return useCallback<MeasureFn>((text, style) => {
    if (typeof document === "undefined") {
      return text.length * style.fontSize * 0.55;
    }
    let n = scratchRef.current;
    if (!n) {
      n = new Konva.Text({});
      scratchRef.current = n;
    }
    n.text(text);
    n.fontFamily(style.fontFamily);
    n.fontSize(style.fontSize);
    n.fontStyle(style.fontStyle);
    n.letterSpacing(style.letterSpacing);
    return n.getTextWidth();
  }, []);
}

/** Per-fragment runs inside the element's Group (see TextNode). */
function RichTextRuns({ el, measure }: { el: TextElement; measure: MeasureFn }) {
  const runs = useMemo(
    () =>
      layoutRichText({
        fragments: el.fragments ?? [],
        base: {
          fontFamily: el.fontFamily,
          fontSize: el.fontSize,
          fontStyle: el.fontStyle,
          fill: el.fill,
          lineHeight: el.lineHeight,
          letterSpacing: el.letterSpacing,
          width: el.width,
          align: el.align,
        },
        measure,
      }),
    [
      el.fragments,
      el.fontFamily,
      el.fontSize,
      el.fontStyle,
      el.fill,
      el.lineHeight,
      el.letterSpacing,
      el.width,
      el.align,
      measure,
    ],
  );
  return (
    <>
      {runs.map((r, i) => (
        <Text
          key={i}
          x={r.x}
          y={r.y}
          text={r.text}
          fontFamily={r.fontFamily}
          fontSize={r.fontSize}
          fontStyle={r.fontStyle}
          fill={r.fill}
          letterSpacing={el.letterSpacing}
        />
      ))}
    </>
  );
}

function TextNode({
  el,
  common,
}: {
  el: TextElement;
  common: Record<string, unknown>;
}) {
  const measure = useTextMeasure();

  if (hasUsablePathData(el.textPath)) {
    return (
      <TextPath
        {...(common as object)}
        data={el.textPath}
        text={el.text}
        fontFamily={el.fontFamily}
        fontSize={el.fontSize}
        fontStyle={konvaFontStyle(el)}
        fill={el.fill}
        letterSpacing={el.letterSpacing}
      />
    );
  }

  if (hasRichFragments(el)) {
    // The Group carries the element's id/handlers so selection, drag,
    // snapping and the transformer treat the runs as one element.
    return (
      <Group {...(common as object)}>
        <RichTextRuns el={el} measure={measure} />
      </Group>
    );
  }

  return (
    <Text
      {...(common as object)}
      text={el.text}
      fontFamily={el.fontFamily}
      fontSize={el.fontSize}
      fontStyle={konvaFontStyle(el)}
      fill={el.fill}
      align={el.align}
      lineHeight={el.lineHeight}
      letterSpacing={el.letterSpacing}
      width={el.width}
      wrap={el.width !== undefined ? "word" : "none"}
    />
  );
}

function ImageNode({
  el,
  common,
}: {
  el: ImageElement;
  common: Record<string, unknown>;
}) {
  const img = useImage(el.src);
  if (!img) return null;
  return (
    <KonvaImage
      {...(common as object)}
      image={img}
      width={el.width}
      height={el.height}
      cornerRadius={el.cornerRadius}
    />
  );
}

/**
 * Iconify icon node — renders the sanitized SVG body stored in the document
 * as a data URL (built once per fill). No network at render or export time.
 */
function IconifySvgNode({
  el,
  common,
}: {
  el: SvgElement;
  common: Record<string, unknown>;
}) {
  const img = useImage(iconDataUrl(el.body ?? "", el.viewBox ?? "0 0 24 24", el.fill));
  if (!img) return null;
  return (
    <KonvaImage
      {...(common as object)}
      image={img}
      width={el.width}
      height={el.height}
    />
  );
}

export function DesignCanvas({ stageRef }: { stageRef: StageRef }) {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const zoom = useCanvasStore((s) => s.zoom);
  const select = useCanvasStore((s) => s.select);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const updateElement = useCanvasStore((s) => s.updateElement);

  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({
    v: null,
    h: null,
  });

  const page = document?.pages.find((p) => p.id === activePageId) ?? null;

  /* TEXTURES (integration #10) — page-background pattern from page.custom.texture. */
  const pageTextureImg = useTextureTile(page?.custom);

  const registerRef = (id: string, node: Konva.Node | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  };

  // Bind the single Transformer to the current selection after every render.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr || !page) return;
    const nodes = selectedIds
      .map((id) => nodeRefs.current.get(id))
      .filter((n): n is Konva.Node => {
        if (!n) return false;
        const el = page.elements.find((e) => e.id === n.id());
        return !!el && !el.locked;
      });
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  });

  if (!page) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-stone-500">
        No page to show.
      </div>
    );
  }

  const onSelect = (id: string, additive: boolean) => {
    if (additive) {
      if (selectedIds.includes(id)) select(selectedIds.filter((x) => x !== id));
      else select([id], true);
    } else {
      select([id]);
    }
  };

  const onDragEnd = (id: string, x: number, y: number) => {
    updateElement(id, { x, y });
  };

  /** Cheap center-snap: pull the dragged node to the page center axes. */
  const onSnapMove = (_id: string, node: Konva.Node) => {
    const threshold = 6 / zoom;
    const box = node.getClientRect({ skipTransform: false });
    // getClientRect is in absolute (scaled) coords; convert to design coords.
    const cx = (box.x + box.width / 2 - node.getStage()!.x()) / zoom;
    const cy = (box.y + box.height / 2 - node.getStage()!.y()) / zoom;
    const pcx = page.width / 2;
    const pcy = page.height / 2;
    let v: number | null = null;
    let h: number | null = null;
    let nx = node.x();
    let ny = node.y();
    if (Math.abs(cx - pcx) < threshold) {
      nx = node.x() + (pcx - cx);
      v = pcx;
    }
    if (Math.abs(cy - pcy) < threshold) {
      ny = node.y() + (pcy - cy);
      h = pcy;
    }
    node.x(nx);
    node.y(ny);
    setGuides((g) => (g.v === v && g.h === h ? g : { v, h }));
  };

  const onSnapEnd = () => setGuides({ v: null, h: null });

  const onTransformEnd = (el: DesignElement, e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const patch: Record<string, unknown> = {
      x: node.x(),
      y: node.y(),
      rotation: node.rotation(),
    };
    if (el.type === "text") {
      patch.fontSize = Math.max(8, Math.round(el.fontSize * sy));
      if (el.width !== undefined) patch.width = Math.max(40, el.width * sx);
      if (el.fragments && el.fragments.length > 0) {
        // FEATURE 1: keep per-fragment sizes proportional to the transform.
        patch.fragments = el.fragments.map((f) =>
          f.fontSize === undefined
            ? f
            : {
                ...f,
                fontSize: Math.max(1, Math.round(f.fontSize * sy * 10) / 10),
              },
        );
      }
    } else if (el.type === "rect" || el.type === "image") {
      patch.width = Math.max(4, el.width * sx);
      patch.height = Math.max(4, el.height * sy);
    } else if (el.type === "ellipse") {
      patch.radiusX = Math.max(2, el.radiusX * sx);
      patch.radiusY = Math.max(2, el.radiusY * sy);
    } else if (el.type === "svg") {
      patch.width = Math.max(4, el.width * sx);
      patch.height = Math.max(4, el.height * sy);
    } else if (el.type === "line") {
      patch.points = el.points.map((p, i) => (i % 2 === 0 ? p * sx : p * sy));
    } else if (el.type === "chart") {
      // FEATURE 3 — charts stay crisp by re-rendering at a new stored size.
      const cur = chartSize(el);
      const w = Math.max(60, Math.round(cur.w * sx));
      const h = Math.max(40, Math.round(cur.h * sy));
      patch.custom = { ...(el.custom ?? {}), w, h };
    } else if (el.type === "qr") {
      patch.size = Math.max(48, Math.round(el.size * Math.max(sx, sy)));
    }
    updateElement(el.id, patch as Partial<DesignElement>);
  };

  const onStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const empty = e.target === e.target.getStage() || e.target.name() === "page-bg";
    if (empty) clearSelection();
  };

  return (
    <div className="mx-auto w-fit p-10">
      <Stage
        ref={stageRef as React.Ref<Konva.Stage>}
        width={Math.round(page.width * zoom)}
        height={Math.round(page.height * zoom)}
        scaleX={zoom}
        scaleY={zoom}
        onMouseDown={onStageMouseDown}
        onTouchStart={(e) => {
          const empty = e.target === e.target.getStage() || e.target.name() === "page-bg";
          if (empty) clearSelection();
        }}
        className="overflow-hidden rounded-[2px] bg-white shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
      >
        <Layer>
          <Rect
            name="page-bg"
            x={0}
            y={0}
            width={page.width}
            height={page.height}
            fill={page.background}
            /* TEXTURES (integration #10) */
            {...textureFillProps(pageTextureImg)}
          />
          {page.elements
            .filter((el) => el.visible)
            .map((el) => (
              <ElementNode
                key={el.id}
                el={el}
                registerRef={registerRef}
                onSelect={onSelect}
                onDragEnd={onDragEnd}
                onSnapMove={onSnapMove}
                onSnapEnd={onSnapEnd}
                onTransformEnd={onTransformEnd}
              />
            ))}
          {guides.v !== null && (
            <Line
              points={[guides.v, 0, guides.v, page.height]}
              stroke="#7c3aed"
              strokeWidth={1 / zoom}
              dash={[6 / zoom, 4 / zoom]}
              listening={false}
            />
          )}
          {guides.h !== null && (
            <Line
              points={[0, guides.h, page.width, guides.h]}
              stroke="#7c3aed"
              strokeWidth={1 / zoom}
              dash={[6 / zoom, 4 / zoom]}
              listening={false}
            />
          )}
          <Transformer
            ref={trRef}
            rotateEnabled
            enabledAnchors={[
              "top-left",
              "top-center",
              "top-right",
              "middle-left",
              "middle-right",
              "bottom-left",
              "bottom-center",
              "bottom-right",
            ]}
            anchorStroke="#7c3aed"
            anchorFill="#ffffff"
            borderStroke="#7c3aed"
          />
        </Layer>
      </Stage>
    </div>
  );
}
