// ShapesOS — confirmations and toasts, framework-free.
//
// One store for the whole app: call sites use `confirmAction()` (replaces
// window.confirm) and `toast()`; components/feedback/FeedbackHost.tsx
// subscribes and renders the accessible dialog + toast stack. Keeping the
// logic here (no React, no DOM) makes it unit-testable with node:test.
//
// If no host is mounted (a page outside the dashboard shell), confirmAction
// falls back to the native dialog so nothing silently auto-confirms.

export type ToastStatus = "running" | "needs" | "done" | "failed";

export interface ToastAction {
  /** Verb the user presses, e.g. "Undo". */
  label: string;
  /** Label once it ran; same verb, result form ("Undone"). */
  doneLabel?: string;
  onClick: () => void | Promise<void>;
}

export interface ToastInput {
  title: string;
  description?: string;
  /** Leads the toast with the matching status shape. Default "done". */
  status?: ToastStatus;
  /** Exactly one action per toast (Agentic OS). */
  action?: ToastAction;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  durationMs?: number;
}

export interface ToastRecord extends Required<Pick<ToastInput, "title" | "status">> {
  id: string;
  description?: string;
  action?: ToastAction;
  durationMs: number;
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Verb on the confirm button ("Delete", "Revoke"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as Delete/Deny (failed ring). */
  destructive?: boolean;
}

export interface ConfirmRequest extends Required<Pick<ConfirmOptions, "title" | "confirmLabel" | "cancelLabel" | "destructive">> {
  id: string;
  description?: string;
}

export interface FeedbackState {
  toasts: ToastRecord[];
  /** Head of the confirm queue (one dialog at a time); null when idle. */
  confirm: ConfirmRequest | null;
}

export const MAX_TOASTS = 3;
export const DEFAULT_TOAST_MS = 5000;
/** Toasts with an action (e.g. Undo) stay long enough to reach it. */
export const ACTION_TOAST_MS = 8000;

// ---------------------------------------------------------------------------
// Turning a native confirm() message into dialog copy
// ---------------------------------------------------------------------------

const DESTRUCTIVE_VERBS = new Set([
  "delete",
  "remove",
  "revoke",
  "disconnect",
  "release",
  "cancel",
  "archive",
  "unlink",
  "discard",
  "retire",
  "revert",
  "purge",
  "roll back",
  "permanently delete",
]);

/**
 * parseConfirmMessage — split a legacy `confirm("Delete X? It can't be
 * undone.")` string into a title (first question / sentence), description
 * (the rest) and a confirm verb taken from the leading word. Destructive
 * verbs get the destructive style; "Cancel this booking?" gets a "Keep"
 * cancel label so the two buttons never both say "Cancel".
 */
export function parseConfirmMessage(message: string): ConfirmRequest & { id: "" } {
  const text = message.trim().replace(/\s+\n/g, "\n");
  // Title = up to and including the first "?" (or first sentence end).
  const m = /^([\s\S]*?[?.!])(\s+[\s\S]*)?$/.exec(text);
  const title = (m ? m[1] : text).replace(/\s+/g, " ").trim();
  const rest = m?.[2]?.replace(/\s+/g, " ").trim() || undefined;

  const lower = title.toLowerCase();
  const twoWord = lower.split(/\s+/).slice(0, 2).join(" ");
  const firstWord = lower.split(/[\s,?.!]+/)[0] ?? "";
  const verb = DESTRUCTIVE_VERBS.has(twoWord) ? twoWord : firstWord;
  const destructive = DESTRUCTIVE_VERBS.has(verb);
  const looksLikeVerb = /^[a-z][a-z-]+$/.test(firstWord) && !["are", "is", "do", "this", "you", "the"].includes(firstWord);
  const confirmLabel = looksLikeVerb ? verb.charAt(0).toUpperCase() + verb.slice(1) : "Confirm";

  return {
    id: "",
    title,
    description: rest,
    confirmLabel,
    cancelLabel: verb === "cancel" ? "Keep" : "Cancel",
    destructive,
  };
}

function normalizeConfirm(input: string | ConfirmOptions): Omit<ConfirmRequest, "id"> {
  if (typeof input === "string") {
    const { id: _id, ...parsed } = parseConfirmMessage(input);
    return parsed;
  }
  const destructive = input.destructive ?? false;
  return {
    title: input.title,
    description: input.description,
    confirmLabel: input.confirmLabel ?? (destructive ? "Delete" : "Confirm"),
    cancelLabel: input.cancelLabel ?? "Cancel",
    destructive,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = (state: FeedbackState) => void;

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class FeedbackStore {
  private toasts: ToastRecord[] = [];
  private confirms: { req: ConfirmRequest; resolve: (ok: boolean) => void }[] = [];
  private listeners = new Set<Listener>();
  private timers = new Map<string, unknown>();
  private hosts = 0;
  private seq = 0;
  private state: FeedbackState = { toasts: [], confirm: null };

  constructor(
    private readonly clock: Clock = realClock,
    /** Used only when no host is mounted. */
    private readonly nativeConfirm: ((message: string) => boolean) | null = null,
  ) {}

  getState(): FeedbackState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** FeedbackHost calls this on mount; the returned fn on unmount. */
  registerHost(): () => void {
    this.hosts++;
    return () => {
      this.hosts = Math.max(0, this.hosts - 1);
    };
  }

  get hasHost(): boolean {
    return this.hosts > 0;
  }

  private emit() {
    this.state = { toasts: this.toasts, confirm: this.confirms[0]?.req ?? null };
    for (const l of this.listeners) l(this.state);
  }

  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  // ---- toasts ------------------------------------------------------------

  toast(input: ToastInput): string {
    const id = this.nextId("toast");
    const durationMs =
      input.durationMs ?? (input.action ? ACTION_TOAST_MS : DEFAULT_TOAST_MS);
    const record: ToastRecord = {
      id,
      title: input.title,
      description: input.description,
      status: input.status ?? "done",
      action: input.action,
      durationMs,
    };
    // Newest last; drop the oldest beyond the cap.
    this.toasts = [...this.toasts, record];
    while (this.toasts.length > MAX_TOASTS) {
      const dropped = this.toasts[0]!;
      this.clearTimer(dropped.id);
      this.toasts = this.toasts.slice(1);
    }
    this.startTimer(id, durationMs);
    this.emit();
    return id;
  }

  dismiss(id: string): void {
    this.clearTimer(id);
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) this.emit();
  }

  /** Hover/focus pauses auto-dismiss so the action stays reachable. */
  pause(id: string): void {
    this.clearTimer(id);
  }

  resume(id: string): void {
    const t = this.toasts.find((x) => x.id === id);
    if (t) this.startTimer(id, t.durationMs);
  }

  private startTimer(id: string, ms: number) {
    this.clearTimer(id);
    if (ms > 0) this.timers.set(id, this.clock.setTimeout(() => this.dismiss(id), ms));
  }

  private clearTimer(id: string) {
    const h = this.timers.get(id);
    if (h !== undefined) {
      this.clock.clearTimeout(h);
      this.timers.delete(id);
    }
  }

  // ---- confirmations ---------------------------------------------------

  confirm(input: string | ConfirmOptions): Promise<boolean> {
    const normalized = normalizeConfirm(input);
    if (!this.hasHost) {
      if (this.nativeConfirm) {
        const msg = normalized.description
          ? `${normalized.title}\n\n${normalized.description}`
          : normalized.title;
        return Promise.resolve(this.nativeConfirm(msg));
      }
      // No UI at all (server, tests without a host): never auto-confirm.
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.confirms.push({ req: { id: this.nextId("confirm"), ...normalized }, resolve });
      this.emit();
    });
  }

  /** The host resolves the visible request (true = confirmed). */
  settle(id: string, ok: boolean): void {
    const idx = this.confirms.findIndex((c) => c.req.id === id);
    if (idx === -1) return;
    const [entry] = this.confirms.splice(idx, 1);
    entry!.resolve(ok);
    this.emit();
  }
}

const browserConfirm =
  typeof window !== "undefined" && typeof window.confirm === "function"
    ? (m: string) => window.confirm(m)
    : null;

/** The app-wide store. */
export const feedback = new FeedbackStore(realClock, browserConfirm);

/** Ask before a consequential action. Resolves true only if confirmed. */
export function confirmAction(input: string | ConfirmOptions): Promise<boolean> {
  return feedback.confirm(input);
}

/** Show a toast; returns its id. */
export function toast(input: ToastInput | string): string {
  return feedback.toast(typeof input === "string" ? { title: input } : input);
}

/** A failed-state toast (red square), for errors that used to be alert(). */
export function toastError(title: string, description?: string): string {
  return feedback.toast({ title, description, status: "failed" });
}

// ---------------------------------------------------------------------------
// Undo for soft actions
// ---------------------------------------------------------------------------

export interface UndoableOptions {
  /** Toast title once applied, e.g. "Alert dismissed". */
  title: string;
  description?: string;
  /** Apply the change (usually an API call). */
  run: () => Promise<void> | void;
  /** Reverse it (the inverse API call). */
  undo: () => Promise<void> | void;
  /** Called after undo succeeds (refresh lists, etc.). */
  onUndone?: () => void;
}

/**
 * Run a reversible action and offer Undo in the toast. Use only where the
 * inverse is a real, cheap API call (archive/unarchive, pause/resume,
 * mark read/unread) — never to fake-undo a hard delete.
 */
export async function runUndoable(opts: UndoableOptions, store: FeedbackStore = feedback): Promise<void> {
  await opts.run();
  store.toast({
    title: opts.title,
    description: opts.description,
    status: "done",
    action: {
      label: "Undo",
      doneLabel: "Undone",
      onClick: async () => {
        try {
          await opts.undo();
          opts.onUndone?.();
        } catch {
          store.toast({ title: "Couldn't undo", description: "Try again from the item itself.", status: "failed" });
        }
      },
    },
  });
}
