"use client";

// ShapesOS — Phase 18.2 (WS=content): "Quick note" (opens quick capture).
// Used where a server component needs the button (the Home Notes widget).

import { NotebookPen } from "lucide-react";
import { aosButton } from "@/components/aos";
import { openQuickCapture } from "./events";

export function QuickNoteButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => openQuickCapture()} className={aosButton({ variant: "secondary", size: "xs" })}>
      <NotebookPen className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

export default QuickNoteButton;
