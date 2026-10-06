"use client";

// ShapesOS — a "New task" button for server-rendered pages (Overview): opens
// the New task composer (NewTaskDialog, mounted once in the dashboard layout).

import { Plus } from "lucide-react";
import { aosButton, type AosButtonVariant } from "@/components/aos/button";
import { openNewTask } from "./NewTaskDialog";
// Phase 18.1 (integration): label in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

export function NewTaskButton({ variant = "primary", label }: { variant?: AosButtonVariant; label?: string }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => openNewTask()} aria-haspopup="dialog" title={t("kit.newTaskHint")} className={aosButton({ variant })}>
      <Plus className="size-4" aria-hidden />
      {label ?? t("kit.newTask")}
    </button>
  );
}
