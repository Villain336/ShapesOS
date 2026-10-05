// ShapesOS — Phase 10 (portal): class atoms + formatters for the client
// portal (docs/design/DESIGN.md). Server-safe (no "use client"), so the
// portal's server pages can use them directly. Tokens only; invoice, quote,
// project and ticket states are NEUTRAL chips — they are never agent states,
// so the four status colours never appear here.

export const pageTitleCls = "aos-heading";
export const pageHintCls = "mt-1 text-sm text-muted";
export const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";
export const tableWrapCls = "overflow-x-auto rounded-lg bg-paper shadow-hairline";
export const tableCls = "w-full text-left text-md";
export const thCls = "whitespace-nowrap border-b border-line px-4 py-2.5 text-xs font-semibold text-muted";
export const tdCls = "border-b border-line px-4 py-3 align-middle text-ink";
export const rowCls = "hover:bg-hover-paper";
export const chipCls = "inline-flex h-badge items-center whitespace-nowrap rounded-full bg-canvas px-2.5 text-xs font-semibold text-ink";
export const linkCls = "font-semibold text-ink underline-offset-2 hover:underline";
export const btnPrimarySm =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-fg";
export const btnSecondarySm =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none";
export const btnQuietSm =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-semibold text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-disabled-fg";
export const inputCls =
  "h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus";
export const textareaCls =
  "min-h-28 w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-md text-ink outline-none focus:border-focus";
export const emptyCls = "rounded-lg bg-paper px-5 py-10 text-center text-sm text-muted shadow-hairline";
export const noteCls = "rounded-lg border border-line bg-canvas px-4 py-3 text-sm text-muted";

const LABELS: Record<string, string> = {
  sent: "Open",
  overdue: "Overdue",
  paid: "Paid",
  cancelled: "Void",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  planning: "Planning",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  new: "New",
  open: "Open",
  pending: "Waiting on you",
  solved: "Solved",
  closed: "Closed",
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "In review",
  done: "Done",
  ready: "Ready",
  "partially-signed": "Partly signed",
  voided: "Voided",
};

/** Sentence-case label for a record state. */
export function stateLabel(s: string, opts: { quote?: boolean } = {}): string {
  if (opts.quote && s === "sent") return "Awaiting your decision";
  return LABELS[s] ?? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/[_-]/g, " ");
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
