// Marketr — Phase 9 M5: Agent Playbooks versioning store (SPEC-PHASE9.md §P9D, §5).
//
// Versioning model (research §4: immutable versions, mutable label pointers):
//   - `playbook`          — the named procedure (learned | community | seed).
//   - `playbook_version`  — IMMUTABLE rows: version number, content, content
//     hash, eval results, outcome attribution. Application code NEVER updates
//     `content`, `contentHash`, or `version`, and NEVER deletes rows.
//     Lifecycle metadata (status, labels, evalResults, outcomeAttribution)
//     changes ONLY through the guarded transitions in this module:
//       transitionVersion  (DRAFT→EVAL→REVIEW→CANARY→PRODUCTION→DEPRECATED)
//       setLabel           (moves the production/staging/latest pointers)
//       recordEval         (appends an outcome evaluation)
//     There is deliberately no other update/delete path in this module —
//     immutability is enforced by omission. `updateVersion` / `deleteVersion`
//     exist only to fail loudly if called (mirrors the memory_episodes
//     pattern in lib/substrate/memory/write.ts).
//   - Every run records the RESOLVED version number (runPlaybook → command
//     audit via lib/orchestrator/audit.ts logCommand).
//   - Community sharing is OFF by default (locked decision): export requires
//     the workspace-level opt-in flag `playbook_sharing_opt_in` (stored in
//     workspace_settings.dataGovernance JSON); export runs the Phase 8
//     anonymization transform and quarantines when it cannot confidently
//     strip tenant signal. Import always starts at draft and must travel the
//     lifecycle before use.
//
// All reads/writes go through withWorkspaceScope (FORCE RLS, fail-closed).

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
// Phase 10 M9: Expert Constitution Pack v1 — the playbook generator's
// system-prompt layer. Playbook generation today is deterministic
// (proposeFromLearning); any future LLM generator MUST use
// PLAYBOOK_GENERATOR_SYSTEM_PROMPT as its system prompt, with M9
// retrieval grounding placed after it (see groundedPrompt()).
import { constitutionSystemPrompt } from "@/lib/expert/constitution";
// Phase 12: Agency-Agents persona seeds (MIT, original distillations) as
// selectable strategist personas for playbook generation.
import {
  assertPersonaForSurface,
  PERSONAS,
  personaSystemPrompt,
  type PersonaId,
} from "@/lib/expert/personas";

/**
 * The playbook generator's system-prompt layer (Expert Constitution Pack
 * v1: global hard rules + playbook-generator constitution). Any LLM
 * playbook generator must send this as the system prompt, with retrieval
 * grounding after it — never before.
 */
export const PLAYBOOK_GENERATOR_SYSTEM_PROMPT =
  constitutionSystemPrompt("playbook-generator");

/**
 * Phase 12: selectable strategist personas for playbook generation
 * (Agency-Agents seeds, MIT, original distillations). When a persona is
 * selected, its seed is appended behind the base playbook-generator
 * constitution — same layering contract: hard rules first, persona lens
 * second, retrieval grounding and task after. Omitting the persona keeps
 * the base v1 prompt unchanged.
 */
export const PLAYBOOK_STRATEGIST_PERSONAS: readonly PersonaId[] = [
  "multi-agent-systems-architect",
  "workflow-architect",
] as const;

export function playbookGeneratorPrompt(persona?: PersonaId): string {
  if (persona === undefined) return PLAYBOOK_GENERATOR_SYSTEM_PROMPT;
  assertPersonaForSurface(persona, "playbooks");
  return [
    PLAYBOOK_GENERATOR_SYSTEM_PROMPT,
    personaSystemPrompt(persona),
    `<!-- persona provenance: ${PERSONAS[persona].provenance.repo} (${PERSONAS[persona].provenance.license}), ${PERSONAS[persona].provenance.sourceFile} -->`,
  ].join("\n\n");
}
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { canonicalize, sha256Hex } from "@/lib/authority/approvals";
import { anonymizeForPlaybook } from "@/lib/substrate/memory/anonymize";
import { logCommand } from "@/lib/orchestrator/audit";

type TxClient = Prisma.TransactionClient;

// ── Types ────────────────────────────────────────────────────────────────────

export type PlaybookSource = "learned" | "community" | "seed";
export type PlaybookVersionStatus =
  | "draft"
  | "eval"
  | "review"
  | "canary"
  | "production"
  | "deprecated";
export type PlaybookLabel = "production" | "staging" | "latest";

export interface PlaybookStep {
  title: string;
  detail?: string;
  /** Executor that would perform the step (researcher|planner|drafter|analyst|scheduler). */
  executor?: string;
  // Phase 12, Worker 3: automation steps. Playbook versions are immutable JSON
  // snapshots, so this additive shape needs no Prisma migration.
  /** Step kind: "task" (default) runs like every step before; "automation" fires an Activepieces webhook flow. */
  stepType?: "task" | "automation";
  /** Automation configuration (present when stepType === "automation"). */
  automation?: {
    /** Activepieces flow id to trigger. */
    flowId?: string;
    /** Optional display name for the flow (cosmetic; flowId is authoritative). */
    flowName?: string;
    /** Optional default payload template merged into the trigger payload. */
    payloadTemplate?: Record<string, unknown>;
  };
}

export interface PlaybookContent {
  title: string;
  summary?: string;
  steps: PlaybookStep[];
  guardrails?: string[];
  provenance?: Record<string, unknown>;
}

/** Honest uncertainty: evals record what is/isn't proven, not just a lift. */
export interface EvalUncertainty {
  lowerBound: number;
  upperBound: number;
  /** Basis for the interval: e.g. "n=14 runs, bootstrap 95% CI". */
  basis: string;
  confidence?: number;
}

export interface EvalInput {
  /** Metric deltas attributable to this version, e.g. { bookedJobsLiftPct: 12 }. */
  metricDeltas: Record<string, number>;
  /** What is proven vs what is NOT proven. Required — honesty over vibes. */
  attributionNote: string;
  uncertainty: EvalUncertainty;
}

export interface StoredEval extends EvalInput {
  recordedBy: string;
  recordedAt: string;
}

export interface OutcomeLiftSummary {
  metric: string;
  liftPct: number;
  basis: string;
  recordedAt: string | null;
}

export interface PlaybookListItem {
  id: string;
  name: string;
  source: PlaybookSource;
  description: string | null;
  productionVersion: number | null;
  productionStatus: PlaybookVersionStatus | null;
  latestVersion: number;
  versionCount: number;
  outcomeLift: OutcomeLiftSummary | null;
  createdAt: string;
}

export interface VersionView {
  id: string;
  playbookId: string;
  version: number;
  status: PlaybookVersionStatus;
  labels: PlaybookLabel[];
  contentHash: string;
  content: unknown;
  eval: StoredEval | null;
  outcomeAttribution: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
}

// ── Pure guards (unit-testable without a database) ───────────────────────────

const LIFECYCLE_NEXT: Record<PlaybookVersionStatus, PlaybookVersionStatus[]> = {
  draft: ["eval"],
  eval: ["review"],
  review: ["canary", "deprecated"],
  canary: ["production", "deprecated"],
  production: ["deprecated"],
  deprecated: [],
};

const STATUSES: PlaybookVersionStatus[] = [
  "draft",
  "eval",
  "review",
  "canary",
  "production",
  "deprecated",
];

const LABELS: PlaybookLabel[] = ["production", "staging", "latest"];

/**
 * assertTransition — the lifecycle guard. Throws unless `to` is an allowed
 * next state from `from`. Direct DRAFT→PRODUCTION (any skip) is rejected.
 */
export function assertTransition(from: PlaybookVersionStatus, to: PlaybookVersionStatus): void {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) {
    throw new Error(`transition: unknown status (from=${from}, to=${to}).`);
  }
  if (!LIFECYCLE_NEXT[from].includes(to)) {
    throw new Error(
      `transition: ${from} → ${to} is not allowed. Lifecycle order is ` +
        `DRAFT → EVAL → REVIEW → CANARY → PRODUCTION → DEPRECATED; skips are rejected.`,
    );
  }
}

/** SHA-256 over canonical JSON — the content identity for a version. */
export function contentHashOf(content: unknown): string {
  return sha256Hex(canonicalize(content));
}

/** Immutability guard: versions are never edited in place. */
export function updateVersion(): never {
  throw new Error(
    "playbook_versions are immutable: new content is a new version row; lifecycle moves use transitionVersion/setLabel.",
  );
}

/** Immutability guard: versions are never deleted. */
export function deleteVersion(): never {
  throw new Error(
    "playbook_versions are immutable: rows are never deleted; retire with transitionVersion(..., 'deprecated').",
  );
}

// ── Creates (immutable by construction) ──────────────────────────────────────

export async function createPlaybook(
  workspaceId: string,
  input: { name: string; source: PlaybookSource; description?: string | null },
  createdBy: string,
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 3) throw new Error("createPlaybook: name must be at least 3 characters.");
  if (!["learned", "community", "seed"].includes(input.source)) {
    throw new Error(`createPlaybook: unknown source "${input.source}".`);
  }
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.playbook.create({
      data: {
        workspaceId,
        name: name.slice(0, 240),
        source: input.source,
        description: input.description?.slice(0, 4000) ?? null,
        createdBy,
      },
      select: { id: true },
    });
    return { id: row.id };
  });
}

/**
 * createVersion — appends a NEW immutable version row with version = max+1.
 * status is always `draft` at creation (promotion travels the lifecycle).
 */
export async function createVersion(
  workspaceId: string,
  playbookId: string,
  content: PlaybookContent,
  createdBy: string,
): Promise<{ id: string; version: number; contentHash: string }> {
  if (!content || typeof content !== "object" || !Array.isArray((content as PlaybookContent).steps)) {
    throw new Error("createVersion: content must be an object with a steps array.");
  }
  return withWorkspaceScope(workspaceId, async (tx) => {
    const playbook = await tx.playbook.findUnique({ where: { id: playbookId } });
    if (!playbook || playbook.workspaceId !== workspaceId) {
      throw new Error("Playbook not found in this workspace.");
    }
    const maxRow = await tx.playbookVersion.findFirst({
      where: { playbookId, workspaceId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (maxRow?.version ?? 0) + 1;
    const contentHash = contentHashOf(content);
    const row = await tx.playbookVersion.create({
      data: {
        playbookId,
        workspaceId,
        version,
        content: content as unknown as Prisma.InputJsonObject,
        contentHash,
        status: "draft",
        createdBy,
      },
      select: { id: true },
    });
    return { id: row.id, version, contentHash };
  });
}

// ── Label pointers (rollback = pointer flip, never rewrite) ──────────────────

export async function setLabel(
  workspaceId: string,
  playbookId: string,
  label: PlaybookLabel,
  version: number,
): Promise<{ version: number; label: PlaybookLabel }> {
  if (!LABELS.includes(label)) throw new Error(`setLabel: unknown label "${label}".`);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const playbook = await tx.playbook.findUnique({ where: { id: playbookId } });
    if (!playbook || playbook.workspaceId !== workspaceId) {
      throw new Error("Playbook not found in this workspace.");
    }
    const target = await tx.playbookVersion.findUnique({
      where: { playbookId_version: { playbookId, version } },
      select: { id: true, workspaceId: true, labels: true },
    });
    if (!target || target.workspaceId !== workspaceId) {
      throw new Error(`setLabel: version ${version} not found in this workspace.`);
    }
    // Remove the label from any other version of this playbook (pointer is
    // unique per playbook), then set it on the target. History is untouched —
    // only the mutable pointer moves.
    const holders = await tx.playbookVersion.findMany({
      where: { playbookId, workspaceId, labels: { has: label } },
      select: { id: true, labels: true },
    });
    for (const h of holders) {
      if (h.id === target.id) continue;
      await tx.playbookVersion.update({
        where: { id: h.id },
        data: { labels: { set: (h.labels as string[]).filter((l) => l !== label) } },
      });
    }
    if (!(target.labels as string[]).includes(label)) {
      await tx.playbookVersion.update({
        where: { id: target.id },
        data: { labels: { set: [...((target.labels as string[]) ?? []), label] } },
      });
    }
    return { version, label };
  });
}

/** resolveLabel — the pointer lookup every run goes through. */
export async function resolveLabel(
  workspaceId: string,
  playbookId: string,
  label: PlaybookLabel,
): Promise<VersionView | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.playbookVersion.findFirst({
      where: { playbookId, workspaceId, labels: { has: label } },
    });
    return row ? toVersionView(row) : null;
  });
}

// ── Lifecycle transitions ────────────────────────────────────────────────────

export async function transitionVersion(
  workspaceId: string,
  versionId: string,
  to: PlaybookVersionStatus,
  opts: { approver: string },
): Promise<{ id: string; status: PlaybookVersionStatus }> {
  if (!STATUSES.includes(to)) {
    throw new Error(`transition: unknown target status "${to}".`);
  }
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.playbookVersion.findUnique({ where: { id: versionId } });
    if (!row || row.workspaceId !== workspaceId) {
      throw new Error("Playbook version not found in this workspace.");
    }
    const from = row.status as PlaybookVersionStatus;
    assertTransition(from, to);
    if (to === "production" && !opts.approver) {
      throw new Error("transition: PRODUCTION requires a human approver.");
    }
    const data: Prisma.PlaybookVersionUpdateInput = { status: to };
    if (to === "production") {
      // Human approver is recorded on the version (there is no approver
      // column by design — approval evidence lives in outcomeAttribution).
      const existing = (row.outcomeAttribution as Record<string, unknown> | null) ?? {};
      data.outcomeAttribution = {
        ...existing,
        productionApproval: { approvedBy: opts.approver, approvedAt: new Date().toISOString() },
      };
    }
    await tx.playbookVersion.update({ where: { id: versionId }, data });
    // Promotion to production moves the production pointer (research §4:
    // "promoted with an environment pointer"). Rollback is still a separate
    // setLabel call — nothing is rewritten.
    if (to === "production") {
      const holders = await tx.playbookVersion.findMany({
        where: { playbookId: row.playbookId, workspaceId, labels: { has: "production" } },
        select: { id: true, labels: true },
      });
      for (const h of holders) {
        if (h.id === versionId) continue;
        await tx.playbookVersion.update({
          where: { id: h.id },
          data: { labels: { set: (h.labels as string[]).filter((l) => l !== "production") } },
        });
      }
      await tx.playbookVersion.update({
        where: { id: versionId },
        data: { labels: { set: [...new Set([...((row.labels as string[]) ?? []), "production"])] } },
      });
    }
    return { id: versionId, status: to };
  });
}

// ── Learned promotion (Growth Memory → playbook; human review required) ──────

/**
 * proposeFromLearning — drafts a playbook from a `memory_learnings` row.
 * The new playbook's first version starts at status `review`: a human must
 * move it through the lifecycle (and production needs a named approver).
 * NEVER auto-promotes.
 */
export async function proposeFromLearning(
  workspaceId: string,
  learningId: string,
  createdBy: string,
): Promise<{ playbookId: string; versionId: string; version: number }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const learning = await tx.memoryLearning.findUnique({ where: { id: learningId } });
    if (!learning || learning.workspaceId !== workspaceId) {
      throw new Error("Learning not found in this workspace.");
    }
    if (learning.invalidatedAt) {
      throw new Error("proposeFromLearning: learning was invalidated and cannot be promoted.");
    }
    const playbook = await tx.playbook.create({
      data: {
        workspaceId,
        name: `Learned: ${learning.hypothesis.slice(0, 120)}`,
        source: "learned",
        description:
          `Promoted from Growth Memory learning ${learning.id.slice(-8)} ` +
          `(result: ${learning.result}; observed ${learning.observedAt.toISOString().slice(0, 10)}). ` +
          `Drafted by agent — human review required before use.`,
        createdBy,
      },
      select: { id: true },
    });
    const content: PlaybookContent = {
      title: learning.hypothesis.slice(0, 240),
      summary: learning.hypothesis,
      steps: [
        { title: "Hypothesis (from Growth Memory)", detail: learning.hypothesis },
        { title: "Proven action", detail: learning.action },
        {
          title: "Human review",
          detail:
            "Review the procedure for tenant-specific assumptions, then advance through eval → canary. " +
            "Production requires a named human approver.",
        },
      ],
      provenance: {
        type: "growth_memory_learning",
        learningId: learning.id,
        result: learning.result,
        observedAt: learning.observedAt.toISOString(),
        sourceEpisodeId: learning.sourceEpisodeId,
      },
    };
    const version = await tx.playbookVersion.create({
      data: {
        playbookId: playbook.id,
        workspaceId,
        version: 1,
        content: content as unknown as Prisma.InputJsonObject,
        contentHash: contentHashOf(content),
        status: "review",
        createdBy,
      },
      select: { id: true },
    });
    return { playbookId: playbook.id, versionId: version.id, version: 1 };
  });
}

// ── Outcome evals (honest uncertainty) ────────────────────────────────────────

export async function recordEval(
  workspaceId: string,
  versionId: string,
  input: EvalInput,
  recordedBy: string,
): Promise<{ id: string; eval: StoredEval }> {
  if (!input.attributionNote || input.attributionNote.trim().length < 12) {
    throw new Error(
      "recordEval: attributionNote is required — say what is proven AND what is not proven.",
    );
  }
  const u = input.uncertainty;
  if (!u || typeof u.lowerBound !== "number" || typeof u.upperBound !== "number" || !u.basis) {
    throw new Error(
      "recordEval: uncertainty must carry numeric lowerBound/upperBound and a basis string.",
    );
  }
  if (u.lowerBound > u.upperBound) {
    throw new Error("recordEval: uncertainty.lowerBound cannot exceed upperBound.");
  }
  const evalDoc: StoredEval = {
    metricDeltas: { ...(input.metricDeltas ?? {}) },
    attributionNote: input.attributionNote.trim(),
    uncertainty: {
      lowerBound: u.lowerBound,
      upperBound: u.upperBound,
      basis: u.basis,
      ...(typeof u.confidence === "number" ? { confidence: u.confidence } : {}),
    },
    recordedBy,
    recordedAt: new Date().toISOString(),
  };
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.playbookVersion.findUnique({ where: { id: versionId } });
    if (!row || row.workspaceId !== workspaceId) {
      throw new Error("Playbook version not found in this workspace.");
    }
    await tx.playbookVersion.update({
      where: { id: versionId },
      data: { evalResults: evalDoc as unknown as Prisma.InputJsonObject },
    });
    return { id: versionId, eval: evalDoc };
  });
}

// ── Runs (M3 command-bar contract) ───────────────────────────────────────────

export interface DraftedStep {
  order: number;
  title: string;
  detail: string | null;
  executor: string | null;
  mode: "proposed";
}

export interface PlaybookRunResult {
  playbookId: string;
  playbookName: string;
  /** The RESOLVED version number — every run records it (spec §P9D). */
  version: number;
  contentHash: string;
  resolvedAt: string;
  /** v1 STUB: the procedure's steps returned as a drafted plan. Propose-only. */
  plan: DraftedStep[];
  runLogId: string;
  note: string;
}

/**
 * runPlaybook — resolves the `production` label, records the resolved
 * version in the run log (command_audit via logCommand), and returns the
 * version's steps as a DRAFTED plan. v1 executes nothing: propose-only,
 * zero side effects (P9 safety invariants hold — no executor, no approvals,
 * no external sends).
 */
export async function runPlaybook(
  workspaceId: string,
  userId: string,
  playbookId: string,
  input: Record<string, unknown>,
): Promise<PlaybookRunResult> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const playbook = await tx.playbook.findUnique({ where: { id: playbookId } });
    if (!playbook || playbook.workspaceId !== workspaceId) {
      throw new Error("Playbook not found in this workspace.");
    }
    const prod = await tx.playbookVersion.findFirst({
      where: { playbookId, workspaceId, labels: { has: "production" } },
    });
    if (!prod) {
      throw new Error("runPlaybook: no production version — promote a version first.");
    }
    const content = prod.content as unknown as PlaybookContent;
    const steps = Array.isArray(content?.steps) ? content.steps : [];
    const plan: DraftedStep[] = steps.map((s, i) => ({
      order: i + 1,
      title: typeof s.title === "string" ? s.title : `Step ${i + 1}`,
      detail: typeof s.detail === "string" ? s.detail : null,
      executor: typeof s.executor === "string" ? s.executor : null,
      mode: "proposed" as const,
    }));
    const resolvedAt = new Date().toISOString();
    // The run log: command_audit (kind "do") records the resolved version —
    // the same audit trail the command bar writes to (spec §P9B).
    const { id: runLogId } = await logCommand({
      workspaceId,
      userId,
      kind: "do",
      templateId: `playbook_run:${playbookId}`,
      prompt: JSON.stringify({ playbookId, version: prod.version, input }),
      resultSummary:
        `resolved v${prod.version} (${(prod.contentHash as string).slice(0, 8)}); ` +
        `drafted ${plan.length} steps; propose-only, no side effects`,
    });
    return {
      playbookId,
      playbookName: playbook.name,
      version: prod.version,
      contentHash: prod.contentHash as string,
      resolvedAt,
      plan,
      runLogId,
      note: "Propose-only stub: the plan above is drafted from the production playbook version. Nothing was executed, approved, or sent.",
    };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

function outcomeLiftOf(evalResults: unknown): OutcomeLiftSummary | null {
  const e = evalResults as StoredEval | null;
  if (!e || typeof e !== "object" || !e.metricDeltas) return null;
  const entries = Object.entries(e.metricDeltas);
  if (entries.length === 0) return null;
  // Pick the largest absolute lift as the headline metric.
  const [metric, liftPct] = entries.reduce((best, cur) =>
    Math.abs(cur[1]) > Math.abs(best[1]) ? cur : best,
  );
  return {
    metric,
    liftPct,
    basis: e.uncertainty?.basis ?? "no uncertainty basis recorded",
    recordedAt: e.recordedAt ?? null,
  };
}

export async function listPlaybooks(workspaceId: string): Promise<PlaybookListItem[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = await tx.playbook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    return rows.map((p) => {
      const prod = p.versions.find((v) => (v.labels as string[]).includes("production"));
      return {
        id: p.id,
        name: p.name,
        source: p.source as PlaybookSource,
        description: p.description,
        productionVersion: prod?.version ?? null,
        productionStatus: (prod?.status as PlaybookVersionStatus) ?? null,
        latestVersion: p.versions[0]?.version ?? 0,
        versionCount: p.versions.length,
        outcomeLift: prod ? outcomeLiftOf(prod.evalResults) : null,
        createdAt: p.createdAt.toISOString(),
      };
    });
  });
}

function toVersionView(row: {
  id: string;
  playbookId: string;
  version: number;
  status: string;
  labels: unknown;
  contentHash: string;
  content: unknown;
  evalResults: unknown;
  outcomeAttribution: unknown;
  createdBy: string;
  createdAt: Date;
}): VersionView {
  return {
    id: row.id,
    playbookId: row.playbookId,
    version: row.version,
    status: row.status as PlaybookVersionStatus,
    labels: (row.labels as string[]).filter((l): l is PlaybookLabel =>
      (LABELS as string[]).includes(l),
    ),
    contentHash: row.contentHash,
    content: row.content,
    eval: (row.evalResults as StoredEval | null) ?? null,
    outcomeAttribution: (row.outcomeAttribution as Record<string, unknown> | null) ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getPlaybook(
  workspaceId: string,
  playbookId: string,
): Promise<{ playbook: { id: string; name: string; source: PlaybookSource; description: string | null; createdAt: string }; versions: VersionView[] } | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const p = await tx.playbook.findUnique({ where: { id: playbookId } });
    if (!p || p.workspaceId !== workspaceId) return null;
    const versions = await tx.playbookVersion.findMany({
      where: { playbookId, workspaceId },
      orderBy: { version: "desc" },
    });
    return {
      playbook: {
        id: p.id,
        name: p.name,
        source: p.source as PlaybookSource,
        description: p.description,
        createdAt: p.createdAt.toISOString(),
      },
      versions: versions.map(toVersionView),
    };
  });
}

// ── Community sharing (OFF by default; anonymized on export) ─────────────────

const OPT_IN_KEY = "playbook_sharing_opt_in";

// Phase 8's COMPANY pattern strips only "<one token> <suffix>" (e.g. it
// turns "Acme Dental LLC" into "Acme [CLIENT]" — the first word leaks). This
// pre-pass strips multi-token company names before the Phase 8 transform.
const COMPANY_MULTI =
  /\b([A-Z][A-Za-z0-9&'.-]{1,30}(?:\s+[A-Z][A-Za-z0-9&'.-]{1,30}){1,2}\s+(?:Inc|Corp|LLC|Co|Ltd|GmbH|Pty|LLP|PA|PLLC)\.?)\b/g;

function stripCompanyNames(text: string): { text: string; stripped: boolean } {
  COMPANY_MULTI.lastIndex = 0;
  if (!COMPANY_MULTI.test(text)) return { text, stripped: false };
  COMPANY_MULTI.lastIndex = 0;
  return { text: text.replace(COMPANY_MULTI, "[CLIENT]"), stripped: true };
}

// Tenant-shaped keys stripped at every depth before anonymization.
const TENANT_KEY_RE = /workspace|tenant|business|brand|client|customer|company|owner|email|phone|address|account/i;

function stripTenantKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTenantKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TENANT_KEY_RE.test(k)) continue;
      out[k] = stripTenantKeys(v);
    }
    return out;
  }
  return value;
}

export interface PlaybookExport {
  format: "marketr.playbook/v1";
  exportId: string;
  name: string;
  description: string | null;
  /** The anonymized procedure. Prefer contentJson; fall back to contentText. */
  contentJson: Record<string, unknown> | null;
  contentText: string | null;
  originalVersion: number;
  originalContentHash: string;
  anonymizedContentHash: string;
  removedKinds: string[];
  exportedAt: string;
}

export async function getSharingOptIn(workspaceId: string): Promise<boolean> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const settings = await tx.workspaceSettings.findUnique({ where: { workspaceId } });
    const dg = (settings?.dataGovernance as Record<string, unknown> | null) ?? {};
    return dg[OPT_IN_KEY] === true;
  });
}

export async function setSharingOptIn(
  workspaceId: string,
  enabled: boolean,
  updatedBy: string,
): Promise<{ enabled: boolean }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.workspaceSettings.findUnique({ where: { workspaceId } });
    const dg: Prisma.InputJsonObject = {
      ...(((existing?.dataGovernance as Prisma.InputJsonObject | null) ?? {})),
      [OPT_IN_KEY]: enabled,
    };
    await tx.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, dataGovernance: dg, updatedBy, agentAllowList: [] },
      update: { dataGovernance: dg, updatedBy },
    });
    return { enabled };
  });
}

/**
 * exportPlaybook — anonymized export of the PRODUCTION version (falling back
 * to the latest version). Requires the workspace opt-in (default OFF).
 * Strips ALL tenant signal: no workspace id, no business names, no metric
 * absolutes — the Phase 8 `playbook_learnings` anonymization pattern
 * (anonymizeForPlaybook). Quarantines (throws) when the transform cannot
 * confidently strip the input.
 */
export async function exportPlaybook(
  workspaceId: string,
  playbookId: string,
): Promise<PlaybookExport> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    if (!(await getSharingOptIn(workspaceId))) {
      throw new Error(
        "exportPlaybook: community sharing is OFF for this workspace (opt-in required).",
      );
    }
    const playbook = await tx.playbook.findUnique({ where: { id: playbookId } });
    if (!playbook || playbook.workspaceId !== workspaceId) {
      throw new Error("Playbook not found in this workspace.");
    }
    const source =
      (await tx.playbookVersion.findFirst({
        where: { playbookId, workspaceId, labels: { has: "production" } },
      })) ??
      (await tx.playbookVersion.findFirst({
        where: { playbookId, workspaceId },
        orderBy: { version: "desc" },
      }));
    if (!source) throw new Error("exportPlaybook: playbook has no versions to export.");

    const stripped = stripTenantKeys(source.content);
    const payloadText = canonicalize(stripped);
    // Multi-token company names leak past the Phase 8 pattern's single-token
    // COMPANY regex ("Acme Dental LLC" → "Acme [CLIENT]") — strip first.
    const pre = stripCompanyNames(payloadText);
    const anon = anonymizeForPlaybook(playbook.name, pre.text);
    const removedKinds = [...new Set([...(pre.stripped ? ["company_multi"] : []), ...anon.removedKinds])];
    if (anon.needsManualReview) {
      throw new Error(
        "exportPlaybook: quarantined — the anonymization transform could not confidently " +
          `strip tenant signal (removed: ${removedKinds.join(", ") || "none"}). A human must review the source version.`,
      );
    }
    const namePre = stripCompanyNames(playbook.name).text;
    const descPre = playbook.description ? stripCompanyNames(playbook.description).text : null;
    const nameAnon = anonymizeForPlaybook(namePre, namePre);
    const descAnon = descPre ? anonymizeForPlaybook(descPre, descPre) : null;
    if (nameAnon.needsManualReview || (descAnon && descAnon.needsManualReview)) {
      throw new Error("exportPlaybook: quarantined — name/description needs manual review.");
    }
    const exportedAt = new Date().toISOString();
    const envelope: Record<string, unknown> = {
      name: nameAnon.title,
      description: descAnon?.title ?? null,
      content: anon.body,
      originalVersion: source.version,
      exportedAt,
    };
    const anonymizedContentHash = contentHashOf(envelope);
    let contentJson: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(anon.body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        contentJson = parsed as Record<string, unknown>;
      }
    } catch {
      // The anonymized payload is no longer parseable JSON — ship it as text.
    }
    return {
      format: "marketr.playbook/v1",
      exportId: randomUUID(),
      name: nameAnon.title,
      description: descAnon?.title ?? null,
      contentJson,
      contentText: contentJson ? null : anon.body,
      originalVersion: source.version,
      originalContentHash: source.contentHash,
      anonymizedContentHash,
      removedKinds,
      exportedAt,
    };
  });
}

/**
 * importPlaybook — explicit import of an exported playbook envelope. Always
 * starts at version 1, status `draft`; it must travel EVAL→… before use
 * (enforced by the lifecycle guard, which has no skip path).
 */
export async function importPlaybook(
  workspaceId: string,
  envelope: Record<string, unknown>,
  createdBy: string,
): Promise<{ playbookId: string; versionId: string; version: number }> {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("importPlaybook: envelope must be an object.");
  }
  if (envelope.format !== "marketr.playbook/v1") {
    throw new Error(
      `importPlaybook: unsupported format "${String(envelope.format ?? "missing")}" — expected marketr.playbook/v1.`,
    );
  }
  const name =
    typeof envelope.name === "string" && envelope.name.trim().length >= 3
      ? envelope.name.slice(0, 240)
      : "Imported playbook";
  const rawContent =
    (envelope.contentJson as Record<string, unknown> | null) ??
    (typeof envelope.contentText === "string" ? { contentText: envelope.contentText } : null);
  if (!rawContent) throw new Error("importPlaybook: envelope carries no content.");
  const content = {
    ...(rawContent as Record<string, unknown>),
    importProvenance: {
      exportId: typeof envelope.exportId === "string" ? envelope.exportId : null,
      originalVersion: typeof envelope.originalVersion === "number" ? envelope.originalVersion : null,
      originalContentHash: typeof envelope.originalContentHash === "string" ? envelope.originalContentHash : null,
      importedAt: new Date().toISOString(),
    },
  };
  const { id: playbookId } = await createPlaybook(
    workspaceId,
    {
      name,
      source: "community",
      description:
        typeof envelope.description === "string" ? envelope.description.slice(0, 4000) : null,
    },
    createdBy,
  );
  const { id: versionId, version } = await createVersion(
    workspaceId,
    playbookId,
    {
      title: name,
      steps: Array.isArray((rawContent as { steps?: unknown }).steps)
        ? ((rawContent as { steps: PlaybookStep[] }).steps as PlaybookStep[])
        : [{ title: "Imported procedure", detail: "Review and restructure these steps before eval." }],
      provenance: content.importProvenance as Record<string, unknown>,
    },
    createdBy,
  );
  return { playbookId, versionId, version };
}

// Re-export prisma for callers that need a scoped transaction client.
export { prisma };
