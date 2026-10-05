// Marketr — content autopilot pure engine (milestone 18).
//
// Dependency-free: candidate selection, idempotency, run caps, auto-approve
// eligibility, kill-switch scope semantics, and rule-input validation.
// The DB-backed orchestration lives in ./autopilot-service.ts.

import { simpleBlocksToTiptap, type SimpleBlock } from "./programmatic";

export const AUTOPILOT_SOURCES = ["decay_refresh", "programmatic_template", "keyword_opportunity"] as const;
export type AutopilotSource = (typeof AUTOPILOT_SOURCES)[number];

export const AUTOPILOT_CADENCES = ["daily", "weekly", "manual"] as const;
export type AutopilotCadence = (typeof AUTOPILOT_CADENCES)[number];

export const AUTOPILOT_ITEM_KINDS = ["decay_refresh", "programmatic_page", "keyword_brief"] as const;
export type AutopilotItemKind = (typeof AUTOPILOT_ITEM_KINDS)[number];

export const AUTOPILOT_ITEM_STATUSES = ["pending", "approved", "rejected", "published", "killed"] as const;
export type AutopilotItemStatus = (typeof AUTOPILOT_ITEM_STATUSES)[number];

export const AUTOPILOT_RUN_STATUSES = ["running", "completed", "failed", "killed"] as const;
export type AutopilotRunStatus = (typeof AUTOPILOT_RUN_STATUSES)[number];

/** Hard server-side cap on items per run — a rule can never exceed this. */
export const MAX_ITEMS_PER_RUN_HARD_CAP = 50;

/** Statuses that mean an item is still "in flight" (counts toward idempotency). */
export const IN_FLIGHT_STATUSES: readonly AutopilotItemStatus[] = ["pending", "approved"];

/** Publish-target kinds autopilot may push to (same vocabulary as M17). */
export const AUTOPILOT_PUBLISH_TARGETS = ["none", "csv", "wordpress", "webflow", "marketr-site"] as const;
export type AutopilotPublishTargetKind = (typeof AUTOPILOT_PUBLISH_TARGETS)[number];

export function isAutopilotSource(v: unknown): v is AutopilotSource {
  return typeof v === "string" && (AUTOPILOT_SOURCES as readonly string[]).includes(v);
}

export function isAutopilotCadence(v: unknown): v is AutopilotCadence {
  return typeof v === "string" && (AUTOPILOT_CADENCES as readonly string[]).includes(v);
}

export function isAutopilotItemKind(v: unknown): v is AutopilotItemKind {
  return typeof v === "string" && (AUTOPILOT_ITEM_KINDS as readonly string[]).includes(v);
}

/** Clamp a rule's maxItemsPerRun to the valid range (1..hard cap). */
export function clampMaxItemsPerRun(n: unknown): number {
  const parsed = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 5;
  if (parsed < 1) return 1;
  if (parsed > MAX_ITEMS_PER_RUN_HARD_CAP) return MAX_ITEMS_PER_RUN_HARD_CAP;
  return parsed;
}

export interface RuleInput {
  name?: unknown;
  source?: unknown;
  programmaticTemplateId?: unknown;
  cadence?: unknown;
  maxItemsPerRun?: unknown;
  autoApprove?: unknown;
  publishTarget?: unknown;
  enabled?: unknown;
}

export interface PublishTargetInput {
  kind: AutopilotPublishTargetKind;
  siteId?: string | null;
  connectionId?: string | null;
  webflowCollectionId?: string | null;
}

/** Validate a publish-target blob; throws with a human-readable message. */
export function validatePublishTarget(input: unknown): PublishTargetInput | null {
  if (input == null) return null;
  if (typeof input !== "object") throw new Error("publishTarget must be an object");
  const t = input as Record<string, unknown>;
  const kind = t.kind;
  if (typeof kind !== "string" || !(AUTOPILOT_PUBLISH_TARGETS as readonly string[]).includes(kind)) {
    throw new Error(`publishTarget.kind must be one of: ${AUTOPILOT_PUBLISH_TARGETS.join(", ")}`);
  }
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    kind: kind as AutopilotPublishTargetKind,
    siteId: pick(t.siteId),
    connectionId: pick(t.connectionId),
    webflowCollectionId: pick(t.webflowCollectionId),
  };
}

export interface ValidatedRuleInput {
  name: string;
  source: AutopilotSource;
  programmaticTemplateId: string | null;
  cadence: AutopilotCadence;
  maxItemsPerRun: number;
  autoApprove: boolean;
  publishTarget: PublishTargetInput | null;
  enabled: boolean;
}

/** Validate rule input server-side; throws with a human-readable message. */
export function validateRuleInput(input: RuleInput): ValidatedRuleInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Rule name is required");
  if (!isAutopilotSource(input.source)) {
    throw new Error(`source must be one of: ${AUTOPILOT_SOURCES.join(", ")}`);
  }
  const source = input.source;
  const programmaticTemplateId =
    typeof input.programmaticTemplateId === "string" && input.programmaticTemplateId.trim()
      ? input.programmaticTemplateId.trim()
      : null;
  if (source === "programmatic_template" && !programmaticTemplateId) {
    throw new Error("programmaticTemplateId is required for the programmatic_template source");
  }
  return {
    name: name.slice(0, 120),
    source,
    programmaticTemplateId,
    cadence: isAutopilotCadence(input.cadence) ? input.cadence : "manual",
    maxItemsPerRun: clampMaxItemsPerRun(input.maxItemsPerRun),
    autoApprove: input.autoApprove === true,
    publishTarget: validatePublishTarget(input.publishTarget),
    enabled: input.enabled !== false,
  };
}

/** A raw candidate pulled from a source, before dedupe/cap. */
export interface AutopilotCandidate {
  kind: AutopilotItemKind;
  sourceRef: string;
  title: string;
  /** Lower = higher priority. Sources order candidates before passing them in. */
  priority: number;
  /** Brief text fed to the draft generator. */
  brief: string;
}

export interface InFlightKey {
  kind: AutopilotItemKind;
  sourceRef: string;
  status: AutopilotItemStatus;
}

/**
 * Idempotency: drop candidates that already have an in-flight item
 * (pending or approved) for the same rule. Rejected/published/killed items
 * do not block a fresh run — a human decision already resolved them.
 */
export function dedupeCandidates(candidates: AutopilotCandidate[], inFlight: InFlightKey[]): AutopilotCandidate[] {
  const blocked = new Set(
    inFlight
      .filter((i) => IN_FLIGHT_STATUSES.includes(i.status))
      .map((i) => `${i.kind}::${i.sourceRef}`),
  );
  return candidates.filter((c) => !blocked.has(`${c.kind}::${c.sourceRef}`));
}

/** Enforce the per-run item cap after sorting by priority (ascending). */
export function capCandidates(candidates: AutopilotCandidate[], maxItems: number): AutopilotCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);
  return sorted.slice(0, clampMaxItemsPerRun(maxItems));
}

/**
 * Auto-approve is only ever eligible for decay_refresh items on rules with
 * autoApprove enabled. Everything else always needs a human.
 */
export function isAutoApproveEligible(kind: AutopilotItemKind, ruleAutoApprove: boolean): boolean {
  return ruleAutoApprove === true && kind === "decay_refresh";
}

/** Phase 14 (approvals): the automation action each item kind stands for (lib/automation/actions.ts). */
export { AUTOPILOT_KIND_ACTION } from "@/lib/automation/actions";

// Kill-switch scope semantics
// ---------------------------------------------------------------------------

export interface KillScope {
  workspaceId?: string | null;
  projectId?: string | null;
}

/** Unique scope key for a kill-switch row. Exactly one of the two ids must be set. */
export function scopeKeyFor(scope: KillScope): string {
  const ws = scope.workspaceId?.trim() ?? "";
  const pr = scope.projectId?.trim() ?? "";
  if (ws && pr) throw new Error("Kill scope must be workspace-level OR project-level, not both");
  if (ws) return `workspace:${ws}`;
  if (pr) return `project:${pr}`;
  throw new Error("Kill scope requires a workspaceId or projectId");
}

/**
 * Decide whether autopilot is killed for a project: killed if the workspace
 * row OR the project's own row is killed. Rows default to not-killed.
 */
export function isKilledForProject(
  rows: { scopeKey: string; killed: boolean }[],
  workspaceId: string,
  projectId: string,
): boolean {
  const wsKey = `workspace:${workspaceId}`;
  const prKey = `project:${projectId}`;
  return rows.some((r) => r.killed && (r.scopeKey === wsKey || r.scopeKey === prKey));
}

// Draft conversion
// ---------------------------------------------------------------------------

/**
 * Convert draft markdown (from the M4 content engine) into simple blocks and
 * then into Tiptap JSON — the editable source of truth.
 */
export function markdownToSimpleBlocks(markdown: string): SimpleBlock[] {
  const blocks: SimpleBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      for (const b of bullets) blocks.push({ type: "bullet", text: b });
      bullets = [];
    }
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const h1 = t.match(/^#\s+(.*)$/);
    const h2 = t.match(/^##\s+(.*)$/);
    const h3 = t.match(/^###\s+(.*)$/);
    const bullet = t.match(/^[-*]\s+(.*)$/);
    if (h1 || h2 || h3) {
      flush();
      blocks.push({ type: h1 ? "h1" : h2 ? "h2" : "h3", text: (h1 ?? h2 ?? h3)![1].trim() });
    } else if (bullet) {
      if (paragraph.length) flush();
      bullets.push(bullet[1].trim());
    } else {
      if (bullets.length) flush();
      paragraph.push(t);
    }
  }
  flush();
  return blocks.filter((b) => b.text.length > 0);
}

/** Draft markdown → Tiptap JSON doc. */
export function markdownToTiptap(markdown: string): object {
  return simpleBlocksToTiptap(markdownToSimpleBlocks(markdown));
}

/** Title for an autopilot item when the source has no better title. */
export function fallbackTitle(kind: AutopilotItemKind, sourceRef: string): string {
  return `${kind.replace(/_/g, " ")} — ${sourceRef.slice(0, 24)}`;
}
