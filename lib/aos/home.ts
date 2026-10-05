// ShapesOS — Overview banners (pure).
//
// Banners sit at the top of the agent home only when something needs the
// user: approvals waiting (yellow, "Review all") and work that stopped on an
// error (red, "Reconnect" when the error is an expired connection, else
// "Open"). Exactly one action each (DESIGN.md "Banners").

import type { AgentTree } from "./agents";
import type { AosStatus } from "./status";

export interface BannerSpec {
  key: string;
  status: AosStatus;
  title: string;
  description: string;
  action: { label: string; href: string } | null;
}

export interface ApprovalsSummary {
  /** Approvals this member can decide. */
  actionable: number;
  /** User-facing queue names the approvals come from (deduped by the caller or here). */
  sources: string[];
}

export interface FailedWork {
  key: string;
  name: string;
  detail: string;
  href: string;
}

/** End a fragment with exactly one full stop. */
function sentence(s: string): string {
  return `${s.trim().replace(/[.!?…]+$/, "")}.`;
}

const RECONNECT_RE = /\b(reconnect|expired|unauthori[sz]ed|revoked|token|access denied|credentials?)\b/i;

export function needsReconnect(detail: string): boolean {
  return RECONNECT_RE.test(detail);
}

export function listJoin(items: readonly string[], max = 3): string {
  const uniq = [...new Set(items.filter(Boolean))];
  if (uniq.length === 0) return "";
  const shown = uniq.slice(0, max);
  const rest = uniq.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Failed missions, sub-agents and standalone runs from the tree, newest first. */
export function failedWorkFromTree(tree: AgentTree | null): FailedWork[] {
  if (!tree) return [];
  const out: FailedWork[] = [];
  const seen = new Set<string>();
  for (const m of tree.missions) {
    if (m.status !== "failed") continue;
    const who = m.branches.find((b) => b.status === "failed");
    out.push({
      key: `mission:${m.id}`,
      name: who ? `${who.name} on ${m.name}` : m.name,
      detail: m.line,
      href: m.runId ? `/dashboard/runs/${m.runId}` : m.href,
    });
    seen.add(m.id);
  }
  for (const b of tree.branches) {
    if (b.status !== "failed") continue;
    if (b.missionId && seen.has(b.missionId)) continue;
    out.push({ key: b.key, name: b.name, detail: b.line, href: b.href ?? "/dashboard/runs" });
  }
  return out;
}

/**
 * Banner list, in the order they stack: needs-you first, then failures. More
 * than `maxFailures` failures collapse into one "N runs stopped" banner.
 */
export function deriveBanners(input: {
  approvals: ApprovalsSummary;
  failed: readonly FailedWork[];
  maxFailures?: number;
}): BannerSpec[] {
  const out: BannerSpec[] = [];
  const n = input.approvals.actionable;
  if (n > 0) {
    const from = listJoin(input.approvals.sources);
    out.push({
      key: "approvals",
      status: "needs",
      title: `${n} ${n === 1 ? "approval is" : "approvals are"} waiting on you`,
      description: from ? `${from} paused for your approval. Nothing goes out until you decide.` : "Nothing goes out until you decide.",
      action: { label: "Review all", href: "/dashboard/approvals" },
    });
  }
  const max = input.maxFailures ?? 2;
  if (input.failed.length > max) {
    out.push({
      key: "failed",
      status: "failed",
      title: `${input.failed.length} runs stopped on errors`,
      description: `${sentence(listJoin(input.failed.map((f) => f.name)))} Open each run to see what failed and fix it.`,
      action: { label: "Open runs", href: "/dashboard/runs" },
    });
  } else {
    for (const f of input.failed) {
      const reconnect = needsReconnect(f.detail);
      out.push({
        key: `failed:${f.key}`,
        status: "failed",
        title: `${f.name} stopped`,
        description: reconnect ? `${sentence(f.detail)} Reconnect to resume.` : sentence(f.detail),
        action: reconnect
          ? { label: "Reconnect", href: "/dashboard/settings/connectors" }
          : { label: "Open", href: f.href },
      });
    }
  }
  return out;
}
