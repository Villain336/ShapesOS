// ShapesOS — Phase 13 (twinui): camera + view controls — zoom in/out, rotate
// 90°, reset, home, and the 3D / 2D / table view switch. Pill icon buttons
// (DESIGN.md: round things you press); the selected view is solid ink.

"use client";

import { Box, House, Map as MapIcon, RefreshCcw, RotateCw, Table2, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TwinCameraApi } from "./camera-api";

export type TwinView = "3d" | "2d" | "table";

function IconBtn({ icon: Icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="aos-press inline-flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-hover-paper disabled:pointer-events-none disabled:text-disabled-fg"
    >
      <Icon size={17} aria-hidden />
    </button>
  );
}

export function TwinControls({
  api,
  view,
  onView,
  webgl,
  className,
}: {
  api: TwinCameraApi | null;
  view: TwinView;
  onView: (v: TwinView) => void;
  /** false when WebGL is unavailable: 3D is disabled */
  webgl: boolean;
  className?: string;
}) {
  const cam = view === "3d" && !!api;
  const views: { v: TwinView; label: string; icon: LucideIcon; disabled?: boolean }[] = [
    { v: "3d", label: "3D", icon: Box, disabled: !webgl },
    { v: "2d", label: "2D", icon: MapIcon },
    { v: "table", label: "Table", icon: Table2 },
  ];
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div role="group" aria-label="View" className="inline-flex items-center gap-0.5 rounded-full bg-paper p-1 shadow-hairline">
        {views.map(({ v, label, icon: Icon, disabled }) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            disabled={disabled}
            onClick={() => onView(v)}
            title={disabled ? "3D needs WebGL, which this browser doesn't offer" : `${label} view`}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold disabled:pointer-events-none disabled:text-disabled-fg",
              view === v ? "bg-ink text-paper" : "text-ink hover:bg-hover-paper",
            )}
          >
            <Icon size={15} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Camera" className="inline-flex items-center gap-0.5 rounded-full bg-paper p-1 shadow-hairline">
        <IconBtn icon={ZoomIn} label="Zoom in" disabled={!cam} onClick={() => api?.zoomBy(1.3)} />
        <IconBtn icon={ZoomOut} label="Zoom out" disabled={!cam} onClick={() => api?.zoomBy(1 / 1.3)} />
        <IconBtn icon={RotateCw} label="Rotate 90°" disabled={!cam} onClick={() => api?.rotate90()} />
        <IconBtn icon={RefreshCcw} label="Reset view" disabled={!cam} onClick={() => api?.reset()} />
        <IconBtn icon={House} label="Whole site" disabled={!cam} onClick={() => api?.home()} />
      </div>
    </div>
  );
}
