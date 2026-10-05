// Marketr — shared settings UI primitives (milestone 21, part D1).
// Agentic OS (docs/design/DESIGN.md): black primary pills, white secondary
// pills with a hairline-ink ring, failed-ring destructive pills, white cards.

export const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

export const btnCls =
  "inline-flex h-control-sm items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40";

export const primaryBtnCls =
  "inline-flex h-control-sm items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40";

// Kept under its old name for existing imports: the primary action is black
// (Agentic OS), not violet.
export const primaryBtnVioletCls =
  "flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-[13px] font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40";

export const dangerBtnCls =
  "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full bg-paper px-3 text-[13px] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:cursor-not-allowed disabled:opacity-40";

export const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";

export const labelCls = "block text-xs font-semibold text-muted";

export type NoticeKind = "ok" | "error" | "info";

export interface NoticeState {
  kind: NoticeKind;
  message: string;
}

// The repo's existing toast/notice pattern: a small inline banner.
// Used for success + error feedback after every mutation.
export function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  const cls =
    notice.kind === "error"
      ? "bg-failed-tint text-failed-text"
      : notice.kind === "ok"
        ? "bg-paper text-ink shadow-hairline"
        : "bg-canvas text-muted";
  return (
    <p role="status" className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${cls}`}>
      {notice.kind === "error" && <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />}
      {notice.message}
    </p>
  );
}
