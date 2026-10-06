// Marketr — Phase 11 "Canvas": Elements panel. Shapes plus a curated set of
// hand-written geometric SVG icons (24x24 viewBox convention, filled). No emoji.

"use client";

import { BarChart3, LineChart, PieChart, QrCode } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { makeChart, makeEllipse, makeLine, makeQr, makeRect, makeSvg } from "../factory";
import { panelSectionLabel, panelTitle } from "../ui";

interface IconDef {
  name: string;
  path: string;
}

// All icons are simple filled geometric shapes on a 24x24 grid.
const ICONS: IconDef[] = [
  { name: "Circle", path: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" },
  { name: "Square", path: "M4 4h16v16H4z" },
  { name: "Triangle", path: "M12 4l10 16H2z" },
  { name: "Diamond", path: "M12 2l7 10-7 10-7-10z" },
  { name: "Hexagon", path: "M12 2l8.66 5v10L12 22l-8.66-5V7z" },
  { name: "Star", path: "M12 2l2.9 6.26 6.6.72-4.9 4.55 1.35 6.47L12 16.9 6.05 20l1.35-6.47-4.9-4.55 6.6-.72z" },
  { name: "Heart", path: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" },
  { name: "Bolt", path: "M13 2L4 14h6l-1 8 9-12h-6z" },
  { name: "Sparkle", path: "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" },
  { name: "Plus", path: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" },
  { name: "Minus", path: "M5 11h14v2H5z" },
  { name: "Check", path: "M9 16.2l-3.5-3.5L4 14.2 9 19.2 20 8.2l-1.4-1.4z" },
  { name: "Close", path: "M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z" },
  { name: "Chevron", path: "M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6z" },
  { name: "Arrow right", path: "M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z" },
  { name: "Arrow up", path: "M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z" },
  { name: "Play", path: "M8 5v14l11-7z" },
  { name: "Pause", path: "M6 5h4v14H6zM14 5h4v14h-4z" },
  { name: "Quote", path: "M6 17h3l2-4V7H5v6h3zM16 17h3l2-4V7h-6v6h3z" },
  { name: "Asterisk", path: "M11 2h2v7.4l6-3.5 1 1.7-6 3.4 6 3.4-1 1.7-6-3.5V20h-2v-7.4l-6 3.5-1-1.7 6-3.4-6-3.4 1-1.7 6 3.5z" },
  { name: "Bookmark", path: "M6 3h12v18l-6-4.5L6 21z" },
  { name: "Flag", path: "M5 3h2v18H5zM9 4h11l-3 4 3 4H9z" },
  { name: "Home", path: "M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z" },
  { name: "Search", path: "M10 2a8 8 0 1 0 4.94 14.06l4.83 4.83 1.41-1.41-4.83-4.83A8 8 0 0 0 10 2zm0 2a6 6 0 1 1-.001 12.001A6 6 0 0 1 10 4z" },
];

export function ElementsPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  const dims = { pageW: page.width, pageH: page.height };

  return (
    <div>
      <div className={panelTitle}>Elements</div>
      <div className="space-y-4 px-3 pb-4">
        <div>
          <div className={panelSectionLabel}>Shapes</div>
          {/* Legit literal hex below: default fills written into the user's design
              document (Konva canvas, exported to PNG/PDF), not UI chrome. */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => addElement(makeRect({ width: 320, height: 200, fill: "#1c1917", cornerRadius: 8, ...dims, name: "Rectangle" }))}
              className="flex h-14 items-center justify-center rounded-md border border-line bg-paper hover:border-line-strong"
              title="Rectangle"
            >
              <span className="h-6 w-9 rounded-[3px] bg-ink" />
            </button>
            <button
              onClick={() => addElement(makeEllipse({ radiusX: 120, radiusY: 90, fill: "#1c1917", ...dims, name: "Ellipse" }))}
              className="flex h-14 items-center justify-center rounded-md border border-line bg-paper hover:border-line-strong"
              title="Ellipse"
            >
              <span className="h-6 w-9 rounded-full bg-ink" />
            </button>
            <button
              onClick={() => addElement(makeLine({ length: 320, ...dims, name: "Line" }))}
              className="flex h-14 items-center justify-center rounded-md border border-line bg-paper hover:border-line-strong"
              title="Line"
            >
              <span className="h-[3px] w-9 bg-ink" />
            </button>
          </div>
        </div>
        <div>
          <div className={panelSectionLabel}>Charts & QR</div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { key: "bar", label: "Bar chart", icon: <BarChart3 className="h-6 w-6" /> },
                { key: "line", label: "Line chart", icon: <LineChart className="h-6 w-6" /> },
                { key: "pie", label: "Pie chart", icon: <PieChart className="h-6 w-6" /> },
              ] as const
            ).map((c) => (
              <button
                key={c.key}
                onClick={() => addElement(makeChart({ chartType: c.key, ...dims, name: c.label }))}
                title={`Insert ${c.label}`}
                className="flex h-14 flex-col items-center justify-center gap-1 rounded-md border border-line bg-paper text-ink hover:border-line-strong hover:bg-hover-paper"
              >
                {c.icon}
                <span className="text-[0.625rem] font-medium text-muted">{c.label}</span>
              </button>
            ))}
            <button
              onClick={() => addElement(makeQr({ ...dims, name: "QR code" }))}
              title="Insert QR code"
              className="flex h-14 flex-col items-center justify-center gap-1 rounded-md border border-line bg-paper text-ink hover:border-line-strong hover:bg-hover-paper"
            >
              <QrCode className="h-6 w-6" />
              <span className="text-[0.625rem] font-medium text-muted">QR code</span>
            </button>
          </div>
          <p className="pt-2 text-[0.6875rem] leading-snug text-muted">
            Charts and QR codes drop in with starter content — edit data, colors, and links from the toolbar once selected.
          </p>
        </div>
        <div>
          <div className={panelSectionLabel}>Icons</div>
          <div className="grid grid-cols-4 gap-2">
            {ICONS.map((icon) => (
              <button
                key={icon.name}
                onClick={() => addElement(makeSvg({ path: icon.path, ...dims, name: icon.name }))}
                title={icon.name}
                className="flex h-14 items-center justify-center rounded-md border border-line bg-paper text-ink hover:border-line-strong hover:bg-hover-paper"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
                  <path d={icon.path} />
                </svg>
              </button>
            ))}
          </div>
          <p className="pt-2 text-[0.6875rem] leading-snug text-muted">
            Icons drop in ink — recolor them from the toolbar.
          </p>
        </div>
      </div>
    </div>
  );
}
