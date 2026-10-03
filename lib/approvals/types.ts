// ShapesOS — Phase 3 (J): unified "needs you" inbox types.
//
// Pure types + helpers shared by the server aggregator (lib/approvals/inbox.ts),
// the API routes and the client UI. No prisma, no DOM.

import type { Prisma, WorkspaceRole } from "@prisma/client";

/** Every human-approval queue the inbox rolls up. */
export const INBOX_SOURCES = [
  "mission",
  "spend",
  "authority",
  "messaging",
  "insurance",
  "scheduler",
  "report",
  "cad",
  "intro",
  "boardy",
  "esign",
  "integration",
  "media",
  "mail",
  "social",
] as const;

export type InboxSourceKey = (typeof INBOX_SOURCES)[number];

/** User-facing names for each queue (sentence case). */
export const INBOX_SOURCE_LABELS: Record<InboxSourceKey, string> = {
  mission: "Mission",
  spend: "Ad spend",
  authority: "Outreach and authority",
  messaging: "Messaging and nurture",
  insurance: "Insurance",
  scheduler: "Scheduled run",
  report: "Report send",
  cad: "CAD change",
  intro: "Introduction",
  boardy: "Boardy request",
  esign: "E-sign",
  integration: "Tool action",
  media: "Media buy",
  mail: "Direct mail",
  social: "Social post",
};

export function isInboxSource(value: unknown): value is InboxSourceKey {
  return typeof value === "string" && (INBOX_SOURCES as readonly string[]).includes(value);
}

export type InboxRisk = "low" | "medium" | "high";

/** An inline decision the UI may fire directly (an existing, editor-gated API). */
export interface InboxAction {
  method: "POST";
  url: string;
  body: Record<string, unknown>;
}

export interface InboxItem {
  /** Unique across sources: `${source}:${id}`. */
  key: string;
  id: string;
  source: InboxSourceKey;
  /** Specific type within the queue, e.g. "Outreach send", "Nurture send". */
  typeLabel: string;
  title: string;
  detail: string | null;
  /** Raw requester identity (user id, "agent:…", email) — never shown raw. */
  requestedBy: string | null;
  /** Display name for the requester (resolved from workspace members). */
  requester: string | null;
  createdAt: string;
  expiresAt: string | null;
  risk: InboxRisk;
  /** Deep link to the queue's existing approve/deny UI. */
  href: string;
  /** Whether this viewer may decide it under the queue's own role rules. */
  canDecide: boolean;
  /** Why the viewer can't decide (shown as helper text). */
  blockedReason: string | null;
  /** Inline actions, only when canDecide and the queue's API supports it cleanly. */
  approve: InboxAction | null;
  deny: InboxAction | null;
}

/** Who is looking: the role rules of every queue are evaluated against this. */
export interface InboxViewer {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  /** Granted permissions (e.g. "skills.install" for scheduler approvals). */
  permissions: ReadonlySet<string>;
  /**
   * Separation of duties (integration actions): is there an editor+ member
   * other than this viewer? A solo workspace may self-approve.
   */
  hasOtherApprover: boolean;
}

export interface InboxSourceSummary {
  source: InboxSourceKey;
  label: string;
  total: number;
  actionable: number;
}

export interface InboxResult {
  items: InboxItem[];
  sources: InboxSourceSummary[];
  /** Queues that failed to load (the rest of the inbox still renders). */
  errors: Array<{ source: InboxSourceKey; message: string }>;
  total: number;
  actionable: number;
}

/** Prisma client or a transaction client — sources only use delegates. */
export type InboxDb = Prisma.TransactionClient;

/** "3m", "5h", "2d" — compact age for dense tables. */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
