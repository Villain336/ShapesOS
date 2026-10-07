// ShapesOS — Phase 18.3 (WS=flow): the share sheet ("Send to…") and
// "Open with", generated from the registries that already exist (client-safe,
// PURE — the ShareMenu component renders it, lib/share/__tests__ checks it).
//
// Send-to targets:
//   - the apps that can RECEIVE a record — SHARE_RECEIVERS, keyed by the
//     app's nav href (lib/nav/config.ts), so a target only shows while its
//     app is in the nav and a new app joins by adding its receiver next to
//     its nav entry. Each receiver names the EXISTING route it uses; every
//     send goes through that route's own checks and tiers (a mail draft is a
//     draft — sending stays the Mail app's own send rules).
//   - the agents — one target per agent in the agent registry
//     (lib/aos/agents.ts via lib/agents/grants.ts AGENT_KEYS): "Ask the
//     Researcher about this" queues a task for that agent with the record
//     attached (the ⌘K Ask path); its tools keep their tiers.
//   - links: a file share link (files only, POST /api/files/[id]/shares),
//     copy link, and the device's own share sheet (navigator.share).
//
// Open with: the apps that can open a record kind — the kind's own page
// (its search source's href) plus OPEN_WITH apps, all of them nav entries.

import { allNavItems, navItemVisible, type NavItem } from "@/lib/nav/config";
import { RECORD_KINDS, type RecordKind } from "@/lib/search/kinds";
import { AGENT_KEYS, type AgentKey } from "@/lib/agents/grants";
import { isUnlinkableKind } from "@/lib/notes/linkable";

export interface ShareRecord {
  kind: RecordKind;
  id: string;
  title: string;
  /** Same-origin path of the record's page. */
  href: string;
  snippet?: string | null;
}

export type ShareRole = "viewer" | "editor" | "admin" | "owner";
const RANK: Record<ShareRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export interface ShareReceiver {
  /** The app's nav href (must exist in lib/nav/config.ts). */
  app: string;
  /** Target id ("notes", "mail" …). */
  id: string;
  /** The existing route / tool the send uses (documentation + tests). */
  via: string;
  minRole: ShareRole;
  /** Kinds it refuses (with the reason key in i18n share.unavailable.*). */
  refuses?: (kind: RecordKind) => string | null;
}

/** The apps that can receive a record (keyed by nav href; new apps add a line here next to their nav entry). */
export const SHARE_RECEIVERS: readonly ShareReceiver[] = [
  { app: "/dashboard/assistant", id: "assistant", via: "the Assistant (queueTask → POST /api/agents/chat)", minRole: "viewer" },
  { app: "/dashboard/mail", id: "mail", via: "Mail compose (new draft; sending follows the Mail app's send rules)", minRole: "editor" },
  { app: "/dashboard/messages", id: "messages", via: "POST /api/comms/messages/channels/[id]/messages", minRole: "viewer" },
  { app: "/dashboard/notes", id: "notes", via: "POST /api/notes (createNote, linked to the record)", minRole: "viewer", refuses: (k) => (isUnlinkableKind(k) ? "personal" : null) },
  { app: "/dashboard/reminders", id: "reminders", via: "POST /api/comms/reminders (createReminder)", minRole: "viewer" },
];

export type ShareTargetGroup = "apps" | "agents" | "links";

export interface ShareTarget {
  id: string;
  group: ShareTargetGroup;
  /** For app targets: the app's nav item (label, icon). */
  app?: NavItem;
  /** For agent targets. */
  agentKey?: AgentKey;
  via: string;
  minRole: ShareRole;
  /** null = available; otherwise why not (i18n key suffix). */
  unavailable: string | null;
}

export interface ShareEnv {
  role: ShareRole | null;
  /** navigator.share exists on this device. */
  canNativeShare: boolean;
}

/** Every send-to target for this record, in menu order (PURE). */
export function shareTargets(record: Pick<ShareRecord, "kind">, env: ShareEnv, nav: NavItem[] = allNavItems()): ShareTarget[] {
  const out: ShareTarget[] = [];
  const role = env.role;
  const roleOk = (min: ShareRole) => !!role && RANK[role] >= RANK[min];
  for (const r of SHARE_RECEIVERS) {
    const app = nav.find((n) => n.href === r.app);
    if (!app || !navItemVisible(app, role)) continue; // the app isn't in this person's nav: no target
    out.push({ id: r.id, group: "apps", app, via: r.via, minRole: r.minRole, unavailable: r.refuses?.(record.kind) ?? (roleOk(r.minRole) ? null : "role") });
  }
  for (const key of AGENT_KEYS) {
    if (key === "lead") continue; // the Assistant is the lead
    out.push({ id: `agent:${key}`, group: "agents", agentKey: key, via: "a task for this agent with the record attached (queueTask)", minRole: "viewer", unavailable: null });
  }
  if (record.kind === "file") {
    out.push({ id: "file_link", group: "links", via: "POST /api/files/[fileId]/shares (view only, 7 days)", minRole: "editor", unavailable: roleOk("editor") ? null : "role" });
  }
  out.push({ id: "copy_link", group: "links", via: "the clipboard", minRole: "viewer", unavailable: null });
  if (env.canNativeShare) out.push({ id: "device", group: "links", via: "navigator.share", minRole: "viewer", unavailable: null });
  return out;
}

/** Apps that can open a kind, besides the record's own page (nav hrefs). */
export const OPEN_WITH: Readonly<Partial<Record<RecordKind, readonly string[]>>> = {
  lead: ["/dashboard/crm", "/dashboard/contacts", "/dashboard/mail"],
  contact: ["/dashboard/contacts", "/dashboard/crm", "/dashboard/mail"],
  person: ["/dashboard/contacts", "/dashboard/connector"],
  company: ["/dashboard/contacts", "/dashboard/crm"],
  deal: ["/dashboard/crm", "/dashboard/ops"],
  ticket: ["/dashboard/ops"],
  invoice: ["/dashboard/ops"],
  ops_project: ["/dashboard/ops"],
  doc: ["/dashboard/office", "/dashboard/files"],
  file: ["/dashboard/files", "/dashboard/office"],
  file_content: ["/dashboard/files", "/dashboard/office"],
  note: ["/dashboard/notes"],
  mail: ["/dashboard/mail"],
  inbox_message: ["/dashboard/crm/inbox", "/dashboard/mail"],
  chat_message: ["/dashboard/assistant"],
  project: ["/dashboard/projects"],
  mission: ["/dashboard/missions"],
  cad_project: ["/dashboard/cad"],
  bom_line: ["/dashboard/cad"],
  envelope: ["/dashboard/esign"],
  legal_document: ["/dashboard/legal"],
  dataset: ["/dashboard/datasets"],
  social_post: ["/dashboard/social"],
  app: ["/dashboard/apps"],
};

export interface OpenWithEntry {
  href: string;
  /** The nav item when it is an app (null = the record's own page). */
  app: NavItem | null;
}

/** The record's own page first, then each app that opens its kind (deduped, visible to the role). PURE. */
export function openWith(record: Pick<ShareRecord, "kind" | "href">, role: ShareRole | null, nav: NavItem[] = allNavItems()): OpenWithEntry[] {
  const out: OpenWithEntry[] = [{ href: record.href, app: null }];
  const seen = new Set<string>([record.href.split("?")[0]!]);
  for (const href of OPEN_WITH[record.kind] ?? []) {
    const app = nav.find((n) => n.href === href);
    if (!app || !navItemVisible(app, role) || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, app });
  }
  return out;
}

/** Kinds Open with covers (for the test: every record kind is covered). */
export const OPEN_WITH_KINDS: readonly RecordKind[] = RECORD_KINDS.filter((k) => OPEN_WITH[k]);

/** The message a chat / agent target hands over (the ⌘K Ask format; the agent reads it with search_workspace). */
export function recordMessage(lead: string, r: Pick<ShareRecord, "kind" | "id" | "title" | "href" | "snippet">): string {
  const lines = [lead.trim(), "", `Record: ${r.kind}:${r.id} — ${r.title} (${r.href})`];
  if (r.snippet) lines.push(`Context: ${r.snippet.slice(0, 500)}`);
  lines.push("Read it with search_workspace before answering.");
  return lines.join("\n");
}

/** Absolute link for copy / mail / device share (same-origin paths only). */
export function absoluteLink(origin: string, href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return origin;
  return `${origin.replace(/\/$/, "")}${href}`;
}
