// ShapesOS Desktop: what the tray / menu-bar icon shows, and which bell
// items become native notifications. Pure.

import type { ActivityNode, AgentActivityResponse, ApprovalCounts, NotificationItem } from "./contract";

export interface TrayAgent {
  key: string;
  name: string;
  line: string;
  href: string | null;
}

export interface BackgroundRun {
  runId: string;
  goal: string;
  maxUsd: number;
  line: string;
  status: "running" | "needs" | "done" | "failed";
}

export interface TrayState {
  needsYou: number;
  running: TrayAgent[];
  background: BackgroundRun[];
  signedIn: boolean;
  /** Short label next to the icon (macOS menu bar). Empty when nothing needs you. */
  title: string;
  tooltip: string;
}

function walk(node: ActivityNode, out: TrayAgent[]): void {
  if (node.status === "running") out.push({ key: node.key, name: node.name, line: node.line, href: node.href });
  for (const c of node.children ?? []) walk(c, out);
}

export function runningAgents(activity: AgentActivityResponse | null): TrayAgent[] {
  const out: TrayAgent[] = [];
  if (!activity?.tree) return out;
  walk(activity.tree.lead, out);
  for (const b of activity.tree.branches) walk(b, out);
  return out;
}

export function trayState(input: {
  counts: ApprovalCounts | null;
  activity: AgentActivityResponse | null;
  background: BackgroundRun[];
  signedIn: boolean;
}): TrayState {
  const needsYou = input.counts?.actionable ?? 0;
  const running = runningAgents(input.activity);
  const liveBg = input.background.filter((b) => b.status === "running" || b.status === "needs");
  const parts: string[] = [];
  if (!input.signedIn) parts.push("Sign in to ShapesOS");
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
  if (running.length > 0) parts.push(`${running.length} running`);
  if (liveBg.length > 0) parts.push(`${liveBg.length} in the background`);
  return {
    needsYou,
    running,
    background: input.background,
    signedIn: input.signedIn,
    title: needsYou > 0 ? String(needsYou > 99 ? "99+" : needsYou) : "",
    tooltip: parts.length ? `ShapesOS: ${parts.join(", ")}` : "ShapesOS",
  };
}

/**
 * Which notifications to show natively. The first poll only seeds what was
 * already there (no flood at launch); after that each unseen unread item
 * notifies once.
 */
export class NotificationDiffer {
  private seen = new Set<string>();
  private seeded = false;

  next(items: readonly NotificationItem[]): NotificationItem[] {
    const fresh: NotificationItem[] = [];
    for (const n of items) {
      if (this.seen.has(n.id)) continue;
      this.seen.add(n.id);
      if (this.seeded && !n.readAt) fresh.push(n);
    }
    this.seeded = true;
    // Cap the memory of seen ids.
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    return fresh.slice(0, 5);
  }
}
