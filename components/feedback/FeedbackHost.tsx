"use client";

// ShapesOS — renders the shared confirm dialog and toast stack from
// lib/ui/feedback.ts. Mounted once in the dashboard layout.
//
// Confirm: Base UI AlertDialog (focus trap, Esc = cancel, focus returns to
// the trigger, role="alertdialog" + labelled/described). Destructive
// confirmations focus Cancel first so Enter never deletes by accident.
// Toasts: Agentic OS night surface, status shape first, exactly one action,
// polite live region (failed toasts are role="alert"), pause on hover/focus.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { feedback, type FeedbackState, type ToastRecord, type ToastStatus } from "@/lib/ui/feedback";

const EMPTY: FeedbackState = { toasts: [], confirm: null };

const pill =
  "aos-press inline-flex h-control items-center justify-center rounded-full px-[22px] text-base font-semibold";

const SHAPE_NIGHT_COLOR: Record<ToastStatus, string> = {
  running: "var(--aos-running-on-night)",
  needs: "var(--aos-needs)",
  done: "var(--aos-done-on-night)",
  failed: "var(--aos-failed-on-night)",
};

const STATUS_LABEL: Record<ToastStatus, string> = {
  running: "Running",
  needs: "Needs you",
  done: "Done",
  failed: "Failed",
};

function ConfirmDialog({ state }: { state: FeedbackState }) {
  const req = state.confirm;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Keep the last request rendered through the close animation.
  const [shown, setShown] = useState(req);
  useEffect(() => {
    if (req) setShown(req);
  }, [req]);
  const view = req ?? shown;

  return (
    <AlertDialog.Root
      open={req !== null}
      onOpenChange={(open) => {
        if (!open && req) feedback.settle(req.id, false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[90] bg-ink/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup
          initialFocus={view?.destructive ? cancelRef : confirmRef}
          className="fixed top-1/2 left-1/2 z-[91] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-lg bg-paper p-6 text-ink shadow-overlay transition-[scale,opacity] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
        >
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="aos-subheading text-ink">
              {view?.title}
            </AlertDialog.Title>
            {view?.description ? (
              <AlertDialog.Description className="text-sm text-muted">{view.description}</AlertDialog.Description>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} className={cn(pill, "bg-paper text-ink shadow-outline")}>
              {view?.cancelLabel ?? "Cancel"}
            </AlertDialog.Close>
            <button
              ref={confirmRef}
              type="button"
              onClick={() => req && feedback.settle(req.id, true)}
              className={cn(
                pill,
                view?.destructive
                  ? "bg-paper text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint"
                  : "bg-ink text-paper",
              )}
            >
              {view?.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function ToastItem({ t }: { t: ToastRecord }) {
  const [actionState, setActionState] = useState<"idle" | "busy" | "done">("idle");
  return (
    <div
      role={t.status === "failed" ? "alert" : "status"}
      onMouseEnter={() => feedback.pause(t.id)}
      onMouseLeave={() => feedback.resume(t.id)}
      onFocus={() => feedback.pause(t.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) feedback.resume(t.id);
      }}
      className="aos-night pointer-events-auto flex w-full items-start gap-3 rounded-lg p-3 pl-4 shadow-toast animate-toast-in"
    >
      <span
        className={`aos-shape aos-shape--${t.status} mt-1.5`}
        style={{ color: SHAPE_NIGHT_COLOR[t.status] }}
        role="img"
        aria-label={STATUS_LABEL[t.status]}
      />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-night">{t.title}</p>
        {t.description ? <p className="mt-0.5 text-sm text-night-soft">{t.description}</p> : null}
      </div>
      {t.action ? (
        <button
          type="button"
          disabled={actionState !== "idle"}
          onClick={async () => {
            setActionState("busy");
            try {
              await t.action!.onClick();
              setActionState("done");
              setTimeout(() => feedback.dismiss(t.id), 1200);
            } catch {
              setActionState("idle");
            }
          }}
          className="h-control-sm shrink-0 rounded-full bg-paper px-4 text-sm font-semibold text-ink disabled:bg-night-raised disabled:text-night-soft"
        >
          {actionState === "done" ? (t.action.doneLabel ?? t.action.label) : t.action.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => feedback.dismiss(t.id)}
        aria-label="Dismiss notification"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-night-soft hover:bg-night-hover hover:text-night"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function FeedbackHost() {
  const state = useSyncExternalStore(
    (fn) => feedback.subscribe(fn),
    () => feedback.getState(),
    () => EMPTY,
  );
  useEffect(() => feedback.registerHost(), []);

  return (
    <>
      <ConfirmDialog state={state} />
      <section
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[95] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {state.toasts.map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </section>
    </>
  );
}
