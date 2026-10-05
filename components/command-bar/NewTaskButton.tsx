"use client";

// ShapesOS — a "New task" button for server-rendered pages (Overview): opens
// the New task composer (NewTaskDialog, mounted once in the dashboard layout).

import { Plus } from "lucide-react";
import { aosButton, type AosButtonVariant } from "@/components/aos/button";
import { openNewTask } from "./NewTaskDialog";

export function NewTaskButton({ variant = "primary", label = "New task" }: { variant?: AosButtonVariant; label?: string }) {
  return (
    <button type="button" onClick={() => openNewTask()} aria-haspopup="dialog" title="New task (⌘N)" className={aosButton({ variant })}>
      <Plus className="size-4" aria-hidden />
      {label}
    </button>
  );
}
