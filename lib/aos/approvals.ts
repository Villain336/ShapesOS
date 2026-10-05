// ShapesOS — approvals inbox as agent work (pure; no React, no prisma).
//
// The unified inbox (lib/approvals) lists every pending human approval. The
// Agentic OS inbox draws each one as an ApprovalCard and hangs the ones that
// came from a mission under the lead agent → the sub-agent waiting on it
// (DESIGN.md "Agents: one lead, many sub-agents"). This module decides:
//   - which agent asked (the card header),
//   - which buttons the card gets (each queue keeps its own decide rule),
//   - what the buttons say (DESIGN.md action table + "buttons say exactly
//     what happens"),
//   - how mission items group, and the needs-you banner copy.

import { INBOX_SOURCE_LABELS, type InboxItem, type InboxSourceKey } from "@/lib/approvals/types";
import { LEAD_AGENT, monogram, type AgentNode, type MissionView } from "./agents";
import { listJoin } from "./home";

/** Who a mission's approvals are waiting on, keyed by mission id. */
export interface MissionAgentInfo {
  missionId: string;
  missionName: string;
  /** The sub-agent that paused for the human, else the lead. */
  agent: string;
  href: string;
}

export type MissionAgentIndex = Record<string, MissionAgentInfo>;

/**
 * From the live tree's missions: the branch that is waiting on the human
 * (status "needs"), else the last one working, else the lead itself.
 */
export function missionAgentIndex(missions: readonly MissionView[]): MissionAgentIndex {
  const out: MissionAgentIndex = {};
  for (const m of missions) {
    const rev = [...m.branches].reverse();
    const who = rev.find((b) => b.status === "needs") ?? rev.find((b) => b.status === "running") ?? null;
    out[m.id] = { missionId: m.id, missionName: m.name, agent: who?.name ?? LEAD_AGENT.name, href: m.href };
  }
  return out;
}

/** "admin:jordan@x.co" → "jordan@x.co": never show an internal id prefix. */
export function displayRequester(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.replace(/^[a-z][a-z0-9_-]*:(?=\S+@)/i, "").trim();
  return t || null;
}

/** The card header's agent name: the sub-agent a mission is waiting on, the queue's agent, else who asked. */
export function approvalAgent(item: InboxItem, index: MissionAgentIndex = {}): string {
  if (item.source === "mission") return (item.missionId && index[item.missionId]?.agent) || LEAD_AGENT.name;
  return item.agent ?? displayRequester(item.requester) ?? INBOX_SOURCE_LABELS[item.source];
}

/** Mission and scheduled-run titles are verb-first actions: ask them as the question. */
export function approvalQuestion(item: Pick<InboxItem, "source" | "title">): string {
  if ((item.source === "mission" || item.source === "scheduler") && !/[?.!…]$/.test(item.title)) return `${item.title}?`;
  return item.title;
}

/** What approving does, in one line, when the queue gives no detail of its own. */
export function approvalBody(item: InboxItem, index: MissionAgentIndex = {}): string | null {
  if (item.source === "mission") {
    const agent = approvalAgent(item, index);
    const mission = (item.missionId && index[item.missionId]?.missionName) || item.missionName;
    return `${agent} paused ${mission ?? "this mission"} for your approval. Nothing goes out until you decide.`;
  }
  return item.detail;
}

export type ApprovalMode = "decide" | "review" | "blocked";

/**
 * Inline Deny/Approve only where the queue's API takes a plain POST and the
 * viewer's role may decide; otherwise Review on the queue's own screen; a
 * viewer who can't decide gets the reason and Open.
 */
export function approvalMode(item: Pick<InboxItem, "approve" | "deny" | "canDecide">): ApprovalMode {
  if (item.canDecide && item.approve && item.deny) return "decide";
  if (item.canDecide) return "review";
  return "blocked";
}

const SENDING_SOURCES: ReadonlySet<InboxSourceKey> = new Set(["messaging", "report", "mail", "intro", "boardy", "esign"]);
const SEND_RE = /\b(send|sends|sending|email|emails|broadcast|reply|replies|message|outreach|remind|mail)\b/i;
const PUBLISH_RE = /\b(publish|post|posts|launch|go live)\b/i;

/** "Approve and send" when approving sends something; "Approve and publish" for posts; else "Approve". */
export function approveLabelFor(item: Pick<InboxItem, "source" | "title" | "typeLabel">): string {
  const text = `${item.title} ${item.typeLabel}`;
  if (item.source === "social" || PUBLISH_RE.test(text)) return "Approve and publish";
  if (SENDING_SOURCES.has(item.source) || SEND_RE.test(text)) return "Approve and send";
  return "Approve";
}

const DRAFT_SOURCES: ReadonlySet<InboxSourceKey> = new Set(["messaging", "social", "intro", "boardy", "report"]);

/** The quiet link to the queue's own screen: edit the draft where the queue holds one, else open it. */
export function editLabelFor(item: Pick<InboxItem, "source">): string {
  return DRAFT_SOURCES.has(item.source) ? "Edit draft" : "Open";
}

/** Toast copy after a decision: the result keeps the button's verb. */
export function decisionToast(item: Pick<InboxItem, "source" | "title" | "typeLabel">, which: "approve" | "deny"): { title: string; description: string } {
  if (which === "deny") return { title: "Denied", description: `${item.title}. Nothing goes out.` };
  const label = approveLabelFor(item);
  const title = label === "Approve and send" ? "Approved and sent" : label === "Approve and publish" ? "Approved and published" : "Approved";
  return { title, description: item.title };
}

// ---------------------------------------------------------------------------
// Grouping: mission items under lead → sub-agent; the rest stand alone.
// ---------------------------------------------------------------------------

export interface ApprovalGroup {
  /** Branch row under the lead: the sub-agent waiting, on this mission. */
  node: AgentNode;
  items: InboxItem[];
}

export interface GroupedApprovals {
  /** The lead row (present when any item came from a mission). */
  lead: AgentNode | null;
  groups: ApprovalGroup[];
  other: InboxItem[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function node(p: Pick<AgentNode, "key" | "name" | "line" | "href"> & Partial<AgentNode>): AgentNode {
  return {
    monogram: monogram(p.name),
    isLead: false,
    status: "needs",
    updatedAt: "",
    missionId: null,
    missionName: null,
    progress: null,
    description: "",
    tools: [],
    ...p,
  };
}

export function groupApprovals(items: readonly InboxItem[], index: MissionAgentIndex = {}): GroupedApprovals {
  const byMission = new Map<string, InboxItem[]>();
  const other: InboxItem[] = [];
  for (const it of items) {
    if (it.source === "mission" && it.missionId) {
      const list = byMission.get(it.missionId) ?? [];
      list.push(it);
      byMission.set(it.missionId, list);
    } else {
      other.push(it);
    }
  }
  if (byMission.size === 0) return { lead: null, groups: [], other };

  const groups: ApprovalGroup[] = [...byMission.entries()].map(([missionId, list]) => {
    const info = index[missionId];
    const missionName = info?.missionName ?? list[0]!.missionName ?? "Mission";
    const agent = info?.agent ?? LEAD_AGENT.name;
    return {
      node: node({
        key: `mission:${missionId}`,
        name: agent,
        line: `${missionName} · ${plural(list.length, "approval", "approvals")} waiting`,
        href: info?.href ?? `/dashboard/missions/${encodeURIComponent(missionId)}`,
        missionId,
        missionName,
      }),
      items: list,
    };
  });
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const lead = node({
    key: "lead",
    name: LEAD_AGENT.name,
    isLead: true,
    line: `${plural(total, "approval", "approvals")} waiting on you across ${plural(groups.length, "mission", "missions")}`,
    href: null,
  });
  return { lead, groups, other };
}

/** The needs-you banner over the inbox; null when nothing waits on this viewer. */
export function approvalsBanner(
  items: readonly InboxItem[],
  index: MissionAgentIndex = {},
): { title: string; description: string } | null {
  const mine = items.filter((i) => i.canDecide);
  const n = mine.length;
  if (n === 0) return null;
  const who = listJoin(mine.map((i) => approvalAgent(i, index)));
  return {
    title: `${n} ${n === 1 ? "approval is" : "approvals are"} waiting on you`,
    description: who ? `${who} paused for your approval. Nothing goes out until you decide.` : "Nothing goes out until you decide.",
  };
}
