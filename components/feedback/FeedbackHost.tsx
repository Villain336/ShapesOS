"use client";

// ShapesOS — renders the shared confirm dialog and toast stack from
// lib/ui/feedback.ts. Mounted once in the dashboard layout.
//
// Confirm: Base UI AlertDialog (focus trap, Esc = cancel, focus returns to
// the trigger, role="alertdialog" + labelled/described). Destructive
// confirmations focus Cancel first so Enter never deletes by accident.
// Toasts: components/aos/Toast (night surface, status shape first, at most
// one action, Undo variant), polite live region (failed toasts are
// role="alert"), pause on hover/focus.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { feedback, type FeedbackState, type ToastRecord } from "@/lib/ui/feedback";
import { ToastView } from "@/components/aos/Toast";
// Phase 18.1 (integration): the toast region's name in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

const EMPTY: FeedbackState = { toasts: [], confirm: null };

const pill =
  "aos-press inline-flex h-control items-center justify-center rounded-full px-[22px] text-base font-semibold";

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
        <AlertDialog.Backdrop className="fixed inset-0 z-[90] bg-night/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
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
  const action = t.action
    ? {
        label: actionState === "done" ? (t.action.doneLabel ?? t.action.label) : t.action.label,
        disabled: actionState !== "idle",
        onClick: async () => {
          setActionState("busy");
          try {
            await t.action!.onClick();
            setActionState("done");
            setTimeout(() => feedback.dismiss(t.id), 1200);
          } catch {
            setActionState("idle");
          }
        },
      }
    : null;
  return (
    <ToastView
      role={t.status === "failed" ? "alert" : "status"}
      status={t.status}
      title={t.title}
      description={t.description}
      progress={t.progress ?? null}
      variant={t.variant}
      action={action}
      onDismiss={() => feedback.dismiss(t.id)}
      onMouseEnter={() => feedback.pause(t.id)}
      onMouseLeave={() => feedback.resume(t.id)}
      onFocus={() => feedback.pause(t.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) feedback.resume(t.id);
      }}
    />
  );
}

export function FeedbackHost() {
  const { t: tr } = useI18n();
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
        aria-label={tr("kit.toasts")}
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
