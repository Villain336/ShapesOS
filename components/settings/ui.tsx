// Marketr — shared settings UI primitives (milestone 21, part D1).
// Tailwind classes follow the members-page pattern; accent = scarab green,
// warm-paper surfaces come from the global theme.

export const inputCls =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none";

export const btnCls =
  "rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-200 disabled:opacity-50";

export const primaryBtnCls =
  "rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50";

export const dangerBtnCls =
  "rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-50";

export const cardCls = "rounded-xl border border-zinc-200 bg-white/60 p-5";

export const labelCls = "block text-xs font-medium text-zinc-600";

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
    notice.kind === "ok"
      ? "border-emerald-200 bg-emerald-50/70 text-emerald-800"
      : notice.kind === "error"
        ? "border-red-200 bg-red-50/70 text-red-700"
        : "border-zinc-200 bg-zinc-50 text-zinc-600";
  return (
    <p role="status" className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {notice.message}
    </p>
  );
}
