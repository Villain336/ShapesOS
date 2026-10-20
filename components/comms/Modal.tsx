"use client";

// ShapesOS — Phase 18.2 (WS=comms): the comms apps' dialog — base-ui Dialog
// (focus trap, Escape, aria-modal) on the Agentic OS overlay recipe: night
// scrim, white radius-lg panel with shadow-overlay, a heading, a close pill.

import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { iconBtnCls } from "./ui";

export function Modal({
  open,
  onOpenChange,
  title,
  closeLabel,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed top-[8%] left-1/2 z-50 flex max-h-[84dvh] w-[calc(100%-2rem)] -translate-x-1/2 flex-col rounded-lg bg-paper shadow-overlay",
            wide ? "max-w-2xl" : "max-w-lg",
          )}
        >
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Dialog.Title className="aos-subheading min-w-0 flex-1 truncate text-ink">{title}</Dialog.Title>
            <Dialog.Close className={iconBtnCls} aria-label={closeLabel}>
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
