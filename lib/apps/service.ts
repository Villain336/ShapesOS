// ShapesOS — Phase 9 (apps): the mini-app service (server only).
//
// One service behind the API routes, the runtime pages and the agent tools:
//
//   apps     listApps · createApp · loadApp · saveDraft · publishApp ·
//            unpublishApp · deleteApp
//   records  listRecords · getRecord (read role = entityReadRole)
//   actions  runAppAction — the ONLY write path for records. Every write is
//            an action declared in the spec, so the spec's minRole and tier
//            decide who may do what and how much ceremony it takes.
//
// Built on what exists (no parallel machinery):
//   - tenant isolation: withWorkspaceScope (FORCE RLS on the three tables)
//     plus an explicit workspaceId on every query;
//   - approvals: the ops gate (lib/ops/gate.ts) on top of Phase 14 — tier-2
//     actions are proposed to the Approvals inbox and execute only with an
//     approved, unexpired approval whose binding matches the exact mutation,
//     claimed approved → executed in the write's own transaction;
//   - audit: ops_audit_events (entity "app:<slug>"), the ops audit trail;
//   - workflows: a run_workflow action queues a WorkflowRun like the
//     run_workflow chat tool (the workflows cron executes it);
//   - agent tools: a call_tool action goes through executeTool
//     (lib/chat/tool-exec.ts): grant, role, confirmation, audit, run events.

import type { Prisma, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  OpsGateError,
  opsBindingFor,
  phase14GatePort,
  verifyAndConsumeOpsApproval,
  type OpsGatePort,
  type OpsGateProposal,
} from "@/lib/ops/gate";
import { TOOL_GROUP } from "@/lib/chat/tools";
import type { ToolContext } from "@/lib/chat/tools";
import {
  FILTER_OPS,
  actionMinRole,
  effectiveActionTier,
  entityReadRole,
  findAction,
  findEntity,
  findView,
  parseSpec,
  roleMeets,
  slugify,
  starterSpec,
  storedSpec,
  titleFieldOf,
  viewMinRole,
  type ActionSpec,
  type ActionTier,
  type AppRole,
  type EntitySpec,
  type FilterSpec,
  type MiniAppSpec,
} from "./spec";
import {
  applyViewQuery,
  formatValue,
  recordErrorText,
  validateRecordData,
  type RecordData,
  type RecordRow,
} from "./records";

type Tx = Prisma.TransactionClient;

/** The Phase 14 tool name tier-2 app actions are proposed under. */
export const APP_ACTION_GATE = "APP_ACTION_RUN";
/** Records scanned per list (newest first) before view filters / sort apply. */
export const APP_RECORD_SCAN_MAX = 2000;
export const APP_LIST_MAX = 500;

export class AppError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly errors?: string[];
  constructor(status: number, message: string, extra: { fields?: Record<string, string>; errors?: string[] } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.fields = extra.fields;
    this.errors = extra.errors;
  }
}

export interface AppActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

function requireRole(actor: AppActor, min: AppRole, what: string): void {
  if (!roleMeets(actor.role, min)) throw new AppError(403, `${what} needs the ${min} role (you have ${actor.role}).`);
}

async function audit(tx: Tx, actor: AppActor, slug: string, action: string, entityId: string | null, summary: string) {
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: `app:${slug}`,
      entityId,
      action,
      actor: actor.userId,
      summary: summary.slice(0, 2000),
    },
  });
}

type AppRowFull = NonNullable<Awaited<ReturnType<Tx["miniApp"]["findFirst"]>>>;

async function appRow(tx: Tx, actor: AppActor, slug: string): Promise<AppRowFull> {
  const row = await tx.miniApp.findFirst({ where: { workspaceId: actor.workspaceId, slug } });
  if (!row) throw new AppError(404, `App "${slug}" not found in this workspace.`);
  return row;
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  published: boolean;
  /** Draft differs from the live spec (or there is no live spec yet). */
  hasDraftChanges: boolean;
  entities: string[];
  recordCount: number;
  updatedAt: Date;
}

/** Published apps for everyone; drafts too for editors and up. */
export async function listApps(actor: AppActor): Promise<AppSummary[]> {
  const editor = roleMeets(actor.role, "editor");
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const rows = await tx.miniApp.findMany({
      where: { workspaceId: actor.workspaceId, ...(editor ? {} : { published: true }) },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const counts = rows.length
      ? await tx.miniAppRecord.groupBy({
          by: ["appId"],
          where: { workspaceId: actor.workspaceId, appId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        })
      : [];
    const countBy = new Map(counts.map((c) => [c.appId, c._count._all]));
    return rows.map((r) => {
      const live = r.spec as MiniAppSpec | null;
      const shown = (editor ? r.draftSpec : r.spec) as MiniAppSpec | null;
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        version: r.version,
        published: r.published,
        hasDraftChanges: !live || JSON.stringify(live) !== JSON.stringify(r.draftSpec),
        entities: (shown?.entities ?? []).map((e) => e.labelPlural ?? e.label),
        recordCount: countBy.get(r.id) ?? 0,
        updatedAt: r.updatedAt,
      };
    });
  });
}

function parseOrThrow(input: unknown): MiniAppSpec {
  const r = parseSpec(input);
  if (!r.ok) throw new AppError(400, `The app spec is not valid: ${r.errors[0]}`, { errors: r.errors });
  return r.spec;
}

/** Create an app with a draft spec (the starter spec when none is given). Editors and up. Never publishes. */
export async function createApp(
  actor: AppActor,
  input: { name?: string; slug?: string; description?: string; spec?: unknown },
): Promise<{ slug: string; id: string }> {
  requireRole(actor, "editor", "Creating an app");
  let spec: MiniAppSpec;
  if (input.spec !== undefined) {
    spec = parseOrThrow(input.spec);
  } else {
    const name = (input.name ?? "").trim();
    if (!name) throw new AppError(400, "Give the app a name.");
    const slug = input.slug?.trim() || slugify(name);
    spec = parseOrThrow(starterSpec(name.slice(0, 80), slug, input.description?.trim() || undefined));
  }
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const clash = await tx.miniApp.findFirst({ where: { workspaceId: actor.workspaceId, slug: spec.slug }, select: { id: true } });
    if (clash) throw new AppError(409, `An app with the address "${spec.slug}" already exists. Pick another name or slug.`);
    const row = await tx.miniApp.create({
      data: {
        workspaceId: actor.workspaceId,
        slug: spec.slug,
        name: spec.name,
        description: spec.description ?? null,
        draftSpec: toJson(spec),
        draftUpdatedBy: actor.userId,
        createdBy: actor.userId,
      },
      select: { id: true, slug: true },
    });
    await audit(tx, actor, row.slug, "app_create", row.id, `created app "${spec.name}" (draft)`);
    return row;
  });
}

export interface LoadedApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  published: boolean;
  /** The live spec (null until first published). */
  spec: MiniAppSpec | null;
  /** The working draft — editors and up only (null for viewers). */
  draftSpec: MiniAppSpec | null;
  hasDraftChanges: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

/** One app. Viewers only see published apps (404 otherwise). */
export async function loadApp(actor: AppActor, slug: string): Promise<LoadedApp> {
  const editor = roleMeets(actor.role, "editor");
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => appRow(tx, actor, slug));
  if (!row.published && !editor) throw new AppError(404, `App "${slug}" not found in this workspace.`);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    published: row.published,
    spec: row.spec ? storedSpec(row.spec) : null,
    draftSpec: editor ? storedSpec(row.draftSpec) : null,
    hasDraftChanges: !row.spec || JSON.stringify(row.spec) !== JSON.stringify(row.draftSpec),
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

/** Replace the draft spec (editors and up). The slug is fixed: a different one is refused. */
export async function saveDraft(actor: AppActor, slug: string, input: unknown): Promise<MiniAppSpec> {
  requireRole(actor, "editor", "Editing an app");
  const spec = parseOrThrow(input);
  if (spec.slug !== slug) throw new AppError(400, `The app's address is fixed: slug must stay "${slug}".`);
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const row = await appRow(tx, actor, slug);
    await tx.miniApp.update({
      where: { id: row.id, workspaceId: actor.workspaceId },
      data: { draftSpec: toJson(spec), draftUpdatedBy: actor.userId, ...(row.published ? {} : { name: spec.name, description: spec.description ?? null }) },
    });
    await audit(tx, actor, slug, "app_draft_saved", row.id, `saved the draft of "${spec.name}"`);
    return spec;
  });
}

/**
 * Checks that need the server: call_tool tools exist, sit inside the app's
 * tool groups and aren't app tools themselves; run_workflow workflows belong
 * to this workspace; tool groups never include hand-offs.
 */
async function serverChecks(tx: Tx, actor: AppActor, spec: MiniAppSpec): Promise<string[]> {
  const errors: string[] = [];
  const groups = new Set<string>(["workspace", ...(spec.toolGroups ?? [])]);
  if (spec.toolGroups?.includes("delegate")) errors.push("toolGroups: an app can't hand work to sub-agents (delegate)");
  for (const a of spec.actions) {
    if (a.type === "call_tool" && a.tool) {
      const group = TOOL_GROUP[a.tool];
      if (!group) errors.push(`actions.${a.key}.tool: unknown tool "${a.tool}"`);
      else if (a.tool.startsWith("app_")) errors.push(`actions.${a.key}.tool: an app can't call the app tools`);
      else if (!groups.has(group)) errors.push(`actions.${a.key}.tool: "${a.tool}" is in the ${group} group — add it to toolGroups`);
      if (a.projectId) {
        const p = await tx.project.findFirst({ where: { id: a.projectId, workspaceId: actor.workspaceId }, select: { id: true } });
        if (!p) errors.push(`actions.${a.key}.projectId: no such project in this workspace`);
      }
    }
    if (a.type === "run_workflow" && a.workflowId) {
      const w = await tx.workflow.findFirst({
        where: { id: a.workflowId, project: { workspaceId: actor.workspaceId } },
        select: { id: true },
      });
      if (!w) errors.push(`actions.${a.key}.workflowId: no such workflow in this workspace`);
    }
  }
  return errors;
}

/**
 * Publish the draft (admins and up): it becomes the live spec at version+1,
 * snapshotted in mini_app_versions. Publishing is the approval of an
 * agent-drafted app: agents can only ever write drafts.
 */
export async function publishApp(actor: AppActor, slug: string): Promise<{ version: number }> {
  requireRole(actor, "admin", "Publishing an app");
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const row = await appRow(tx, actor, slug);
    const spec = parseOrThrow(row.draftSpec);
    const errors = await serverChecks(tx, actor, spec);
    if (errors.length) throw new AppError(400, `The app can't be published: ${errors[0]}`, { errors });
    const version = row.version + 1;
    await tx.miniAppVersion.create({
      data: { workspaceId: actor.workspaceId, appId: row.id, version, spec: toJson(spec), publishedBy: actor.userId },
    });
    // Version-guarded: two racing publishes can't both claim version+1
    // (the unique (app_id, version) above also refuses the loser).
    const claimed = await tx.miniApp.updateMany({
      where: { id: row.id, workspaceId: actor.workspaceId, version: row.version },
      data: {
        spec: toJson(spec),
        version,
        published: true,
        publishedBy: actor.userId,
        publishedAt: new Date(),
        name: spec.name,
        description: spec.description ?? null,
      },
    });
    if (claimed.count !== 1) throw new AppError(409, "The app was published by someone else just now. Reload and try again.");
    await audit(tx, actor, slug, "app_publish", row.id, `published "${spec.name}" version ${version}`);
    return { version };
  });
}

/** Take an app off the runtime (admins and up). Records are kept. */
export async function unpublishApp(actor: AppActor, slug: string): Promise<void> {
  requireRole(actor, "admin", "Unpublishing an app");
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const row = await appRow(tx, actor, slug);
    await tx.miniApp.update({ where: { id: row.id, workspaceId: actor.workspaceId }, data: { published: false } });
    await audit(tx, actor, slug, "app_unpublish", row.id, `unpublished "${row.name}"`);
  });
}

/** Delete an app and every record in it (admins and up). */
export async function deleteApp(actor: AppActor, slug: string): Promise<void> {
  requireRole(actor, "admin", "Deleting an app");
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const row = await appRow(tx, actor, slug);
    await tx.miniApp.delete({ where: { id: row.id, workspaceId: actor.workspaceId } });
    await audit(tx, actor, slug, "app_delete", row.id, `deleted app "${row.name}" and its records`);
  });
}

// ---------------------------------------------------------------------------
// Records (read)
// ---------------------------------------------------------------------------

/** Published spec, or a 404 / a clear refusal when the app isn't live. */
async function liveSpec(tx: Tx, actor: AppActor, slug: string): Promise<{ row: AppRowFull; spec: MiniAppSpec }> {
  const row = await appRow(tx, actor, slug);
  if (!row.published || !row.spec) {
    if (!roleMeets(actor.role, "editor")) throw new AppError(404, `App "${slug}" not found in this workspace.`);
    throw new AppError(409, `"${row.name}" isn't published yet. An admin publishes it from the builder.`);
  }
  return { row, spec: storedSpec(row.spec) };
}

/**
 * The entity as the record was written: current spec first, else the newest
 * published version that still had it (entities dropped later stay readable).
 */
async function entityForRead(tx: Tx, row: AppRowFull, spec: MiniAppSpec, entityKey: string): Promise<{ entity: EntitySpec; current: boolean } | null> {
  const cur = findEntity(spec, entityKey);
  if (cur) return { entity: cur, current: true };
  const versions = await tx.miniAppVersion.findMany({
    where: { appId: row.id, workspaceId: row.workspaceId },
    orderBy: { version: "desc" },
    select: { spec: true },
    take: 50,
  });
  for (const v of versions) {
    const e = findEntity(storedSpec(v.spec), entityKey);
    if (e) return { entity: e, current: false };
  }
  return null;
}

export interface RecordOut extends RecordRow {
  id: string;
  entity: string;
  data: Record<string, unknown>;
  specVersion: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string | null;
}

const RECORD_SELECT = {
  id: true,
  entity: true,
  data: true,
  specVersion: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
} as const;

function asRecord(r: {
  id: string;
  entity: string;
  data: unknown;
  specVersion: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string | null;
}): RecordOut {
  const data = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : {};
  return { ...r, data };
}

export interface ListRecordsInput {
  entity?: string;
  /** A view key: its filters + sort apply and its minRole is checked. */
  view?: string;
  /** Extra filters (validated against the entity). */
  filters?: FilterSpec[];
  sort?: { field: string; dir: "asc" | "desc" };
  q?: string;
  limit?: number;
}

export interface ListRecordsResult {
  app: { slug: string; name: string; version: number };
  entity: EntitySpec;
  /** False when the entity only exists in an older version (read-only). */
  current: boolean;
  rows: RecordOut[];
  /** Rows matching before the limit. */
  matched: number;
  /** True when more than APP_RECORD_SCAN_MAX records exist (only the newest were scanned). */
  truncated: boolean;
}

function checkFilters(entity: EntitySpec, filters: FilterSpec[] | undefined): FilterSpec[] {
  const out: FilterSpec[] = [];
  for (const f of filters ?? []) {
    if (!f || typeof f !== "object") throw new AppError(400, "Each filter needs field, op and value.");
    if (!(FILTER_OPS as readonly string[]).includes(f.op)) throw new AppError(400, `Unknown filter op "${String(f.op)}".`);
    if (f.field !== "createdAt" && f.field !== "updatedAt" && !entity.fields.some((x) => x.key === f.field)) {
      throw new AppError(400, `"${String(f.field)}" is not a field of ${entity.label}.`);
    }
    out.push({ field: f.field, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) });
  }
  return out.slice(0, 10);
}

export async function listRecords(actor: AppActor, slug: string, input: ListRecordsInput): Promise<ListRecordsResult> {
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const { row, spec } = await liveSpec(tx, actor, slug);
    const view = input.view ? findView(spec, input.view) : undefined;
    if (input.view && !view) throw new AppError(404, `View "${input.view}" not found in ${row.name}.`);
    const entityKey = view?.entity ?? input.entity;
    if (!entityKey) throw new AppError(400, "Say which entity (or view) to list.");
    if (view && input.entity && input.entity !== view.entity) throw new AppError(400, `View "${view.key}" shows ${view.entity}, not ${input.entity}.`);
    const found = await entityForRead(tx, row, spec, entityKey);
    if (!found) throw new AppError(404, `${row.name} has no entity "${entityKey}".`);
    const min = view ? viewMinRole(view) : found.current ? entityReadRole(spec, entityKey) : "editor";
    requireRole(actor, min, `Reading ${found.entity.labelPlural ?? found.entity.label}`);

    const scanned = await tx.miniAppRecord.findMany({
      where: { workspaceId: actor.workspaceId, appId: row.id, entity: entityKey },
      orderBy: { createdAt: "desc" },
      take: APP_RECORD_SCAN_MAX + 1,
      select: RECORD_SELECT,
    });
    const truncated = scanned.length > APP_RECORD_SCAN_MAX;
    const rows = scanned.slice(0, APP_RECORD_SCAN_MAX).map(asRecord);
    const filtered = applyViewQuery(rows, found.entity, {
      filters: [...(view?.filters ?? []), ...checkFilters(found.entity, input.filters)],
      sort: input.sort ?? view?.sort,
      q: input.q,
    });
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), APP_LIST_MAX));
    return {
      app: { slug: row.slug, name: row.name, version: row.version },
      entity: found.entity,
      current: found.current,
      rows: filtered.slice(0, limit),
      matched: filtered.length,
      truncated,
    };
  });
}

export interface RecordDetail {
  record: RecordOut;
  /** The entity as the CURRENT spec declares it (null when it was dropped). */
  entity: EntitySpec | null;
  /** The spec version the record was last written under (for older-version fields). */
  writtenWith: MiniAppSpec | null;
}

export async function getRecord(actor: AppActor, slug: string, recordId: string): Promise<RecordDetail> {
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const { row, spec } = await liveSpec(tx, actor, slug);
    const rec = await tx.miniAppRecord.findFirst({
      where: { id: recordId, workspaceId: actor.workspaceId, appId: row.id },
      select: RECORD_SELECT,
    });
    if (!rec) throw new AppError(404, `Record "${recordId}" not found in ${row.name}.`);
    const entity = findEntity(spec, rec.entity) ?? null;
    requireRole(actor, entity ? entityReadRole(spec, rec.entity) : "editor", "Reading this record");
    let writtenWith: MiniAppSpec | null = null;
    if (rec.specVersion !== row.version) {
      const v = await tx.miniAppVersion.findFirst({ where: { appId: row.id, workspaceId: actor.workspaceId, version: rec.specVersion }, select: { spec: true } });
      writtenWith = v ? storedSpec(v.spec) : null;
    } else writtenWith = spec;
    return { record: asRecord(rec), entity, writtenWith };
  });
}

/** id → title for records of one entity (relation pickers and cells). */
export async function recordTitles(actor: AppActor, slug: string, entityKey: string, limit = 200): Promise<Array<{ id: string; title: string }>> {
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const { row, spec } = await liveSpec(tx, actor, slug);
    const entity = findEntity(spec, entityKey);
    if (!entity || !roleMeets(actor.role, entityReadRole(spec, entityKey))) return [];
    const tf = titleFieldOf(entity);
    const rows = await tx.miniAppRecord.findMany({
      where: { workspaceId: actor.workspaceId, appId: row.id, entity: entityKey },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 500),
      select: { id: true, data: true },
    });
    return rows.map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return { id: r.id, title: formatValue(tf, d[tf.key]) || r.id.slice(-8) };
    });
  });
}

// ---------------------------------------------------------------------------
// Actions (the only write path)
// ---------------------------------------------------------------------------

export interface RunActionInput {
  action: string;
  recordId?: string | null;
  /** create_record / update_record (edit form): field values. */
  data?: Record<string, unknown> | null;
  /** The person confirmed (UI dialog, or "yes" to the agent's call). */
  confirmed?: boolean;
  /** Tier 2: the approved approval to execute with. */
  approvalId?: string | null;
  /** "agent": an unconfirmed call (auto-approve rule) is escalated to tier 2. */
  via?: "ui" | "agent";
  /** Agent calls: the run the call belongs to (passed to call_tool). */
  runId?: string;
}

export type RunActionResult =
  | {
      outcome: "done";
      action: string;
      type: ActionSpec["type"];
      tier: ActionTier;
      record?: RecordOut;
      deletedId?: string;
      workflowRunId?: string;
      toolStatus?: string;
      summary: string;
    }
  | { outcome: "confirm_required"; action: string; tier: 1; summary: string }
  | { outcome: "approval_required"; action: string; tier: 2; approval: OpsGateProposal; summary: string };

export interface ToolRunOutcome {
  status: string;
  summary: string;
}

export type ToolRunner = (ctx: ToolContext, tool: string, args: Record<string, unknown>) => Promise<ToolRunOutcome>;

export interface RunActionDeps {
  gatePort?: OpsGatePort;
  toolRunner?: ToolRunner;
  /** call_tool: the tool's safety kind (default: the tool registry). */
  toolKind?: (tool: string) => Promise<string | null>;
}

async function registryToolKind(tool: string): Promise<string | null> {
  // The runtime extras (ship, browser, code tools) register when the chat
  // agent module loads; load it so call_tool sees the same catalog as chat.
  await import("@/lib/chat/agent");
  const { getTool } = await import("@/lib/chat/tools");
  return getTool(tool)?.kind ?? null;
}

const defaultToolRunner: ToolRunner = async (ctx, tool, args) => {
  await import("@/lib/chat/agent");
  const { executeTool } = await import("@/lib/chat/tool-exec");
  const call: import("@/lib/chat/tool-exec").ChatToolCall = { tool, args, status: "pending_confirmation" };
  await executeTool(ctx, tool, args, call);
  return { status: call.status, summary: call.resultSummary ?? "" };
};

const PLACEHOLDER = /\{\{\s*record\.([a-zA-Z0-9_]+)\s*\}\}/g;

/** call_tool args: substitute {{record.id}} / {{record.<field>}}. */
export function fillToolArgs(args: Record<string, unknown> | undefined, record: RecordOut | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    const whole = /^\{\{\s*record\.([a-zA-Z0-9_]+)\s*\}\}$/.exec(v);
    if (whole) {
      const key = whole[1]!;
      out[k] = key === "id" ? (record?.id ?? "") : (record?.data[key] ?? "");
      continue;
    }
    out[k] = v.replace(PLACEHOLDER, (_m, key: string) => String(key === "id" ? (record?.id ?? "") : (record?.data[key] ?? "")));
  }
  return out;
}

function recordLabel(entity: EntitySpec | undefined, rec: { data: Record<string, unknown>; id: string } | null): string {
  if (!rec) return "";
  if (!entity) return rec.id;
  const tf = titleFieldOf(entity);
  const t = formatValue(tf, rec.data[tf.key]);
  return t ? `"${t.slice(0, 80)}"` : rec.id;
}

/** Relation targets and files a write references must exist (same app / this workspace). */
async function checkRefs(tx: Tx, actor: AppActor, appId: string, entity: EntitySpec, refs: { relations: Array<{ field: string; target: string; id: string }>; files: Array<{ field: string; id: string }> }) {
  const fields: Record<string, string> = {};
  for (const r of refs.relations) {
    const hit = await tx.miniAppRecord.findFirst({ where: { id: r.id, workspaceId: actor.workspaceId, appId, entity: r.target }, select: { id: true } });
    if (!hit) fields[r.field] = `${entity.fields.find((f) => f.key === r.field)?.label ?? r.field}: no such ${r.target} record`;
  }
  for (const f of refs.files) {
    const hit = await tx.workspaceFile.findFirst({ where: { id: f.id, workspaceId: actor.workspaceId, trashedAt: null }, select: { id: true } });
    if (!hit) fields[f.field] = `${entity.fields.find((x) => x.key === f.field)?.label ?? f.field}: no such file in this workspace`;
  }
  if (Object.keys(fields).length) throw new AppError(400, recordErrorText(fields), { fields });
}

/**
 * Run one spec action. Tier 0 runs; tier 1 needs `confirmed`; tier 2 needs
 * an approved approval (`approvalId`) — without one, the exact mutation is
 * proposed to the Approvals inbox and nothing is written.
 */
export async function runAppAction(
  actor: AppActor,
  slug: string,
  input: RunActionInput,
  deps: RunActionDeps = {},
): Promise<RunActionResult> {
  const port = deps.gatePort ?? phase14GatePort;

  // 1. Resolve the action, the record and the data — and refuse early.
  const pre = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const { row, spec } = await liveSpec(tx, actor, slug);
    const action = findAction(spec, input.action);
    if (!action) throw new AppError(404, `${row.name} has no action "${input.action}".`);
    requireRole(actor, actionMinRole(action), `"${action.label}"`);
    const entity = action.entity ? findEntity(spec, action.entity) : undefined;
    let record: RecordOut | null = null;
    if (input.recordId) {
      const rec = await tx.miniAppRecord.findFirst({
        where: { id: input.recordId, workspaceId: actor.workspaceId, appId: row.id },
        select: RECORD_SELECT,
      });
      if (!rec) throw new AppError(404, `Record "${input.recordId}" not found in ${row.name}.`);
      record = asRecord(rec);
      if (action.entity && record.entity !== action.entity) {
        throw new AppError(400, `"${action.label}" acts on ${action.entity} records, not ${record.entity}.`);
      }
    }
    if (action.type === "create_record" && input.recordId) throw new AppError(400, `"${action.label}" creates a new record; don't pass a record id.`);
    if ((action.type === "update_record" || action.type === "delete_record") && !record) {
      throw new AppError(400, `"${action.label}" needs the record it acts on.`);
    }
    let data: Record<string, unknown> | null = null;
    if (action.type === "create_record" || action.type === "update_record") {
      data = action.set ? { ...action.set } : (input.data ?? {});
      const check = validateRecordData(entity!, data, { existing: action.type === "update_record" ? record!.data : null });
      if (!check.ok) throw new AppError(400, recordErrorText(check.errors), { fields: check.errors });
    }
    return { row: { id: row.id, name: row.name, version: row.version }, spec, action, entity, record, data };
  });

  const { action, entity, record, data, spec } = pre;
  const toolKind = action.type === "call_tool" ? await (deps.toolKind ?? registryToolKind)(action.tool!) : null;
  let tier: ActionTier = effectiveActionTier(action, { toolKind });
  // No person in the loop (an auto-approve rule ran the agent's call):
  // "asks first" becomes an approval.
  if (tier === 1 && input.via === "agent" && !input.confirmed) tier = 2;
  const label = `${pre.row.name}: ${action.label}${record ? ` ${recordLabel(entity, record)}` : ""}`;

  if (tier === 1 && !input.confirmed) {
    return { outcome: "confirm_required", action: action.key, tier: 1, summary: `${label} asks first: confirm to run it.` };
  }

  const gateEntity = `app:${slug}`;
  const mutation = { action: action.key, recordId: record?.id ?? null, data: data ?? null, version: pre.row.version };
  if (tier === 2 && !input.approvalId) {
    const approval = await port.propose({
      workspaceId: actor.workspaceId,
      appKey: "apps",
      toolName: APP_ACTION_GATE,
      args: opsBindingFor({ entity: gateEntity, entityId: record?.id, slug: APP_ACTION_GATE, mutation }),
      proposedBy: actor.userId,
      plainSummary: label.slice(0, 500),
    });
    await withWorkspaceScope(actor.workspaceId, (tx) =>
      audit(tx, actor, slug, "gate_proposed", record?.id ?? null, `${action.label} proposed (approval ${approval.id})`),
    );
    return {
      outcome: "approval_required",
      action: action.key,
      tier: 2,
      approval,
      summary: `${label} needs an approval — sent to Approvals as ${approval.id}. Run it again with that approval once it's approved.`,
    };
  }

  // 2. Execute (tier 2: the approval is verified and claimed in this same
  // transaction, before anything is written).
  const done = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    if (tier === 2) {
      await verifyAndConsumeOpsApproval(port, tx, {
        workspaceId: actor.workspaceId,
        slug: APP_ACTION_GATE,
        entity: gateEntity,
        entityId: record?.id,
        mutation,
        approvalId: input.approvalId!,
        actor: actor.userId,
      });
    }
    const how = tier === 2 ? ` (approval ${input.approvalId})` : "";
    switch (action.type) {
      case "create_record": {
        const check = validateRecordData(entity!, data);
        if (!check.ok) throw new AppError(400, recordErrorText(check.errors), { fields: check.errors });
        await checkRefs(tx, actor, pre.row.id, entity!, check.refs);
        const rec = await tx.miniAppRecord.create({
          data: {
            workspaceId: actor.workspaceId,
            appId: pre.row.id,
            entity: entity!.key,
            data: toJson(check.data),
            specVersion: pre.row.version,
            createdBy: actor.userId,
          },
          select: RECORD_SELECT,
        });
        const out = asRecord(rec);
        await audit(tx, actor, slug, "record_create", rec.id, `${action.label}: created ${entity!.label} ${recordLabel(entity, out)}${how}`);
        return { record: out, summary: `Created ${entity!.label.toLowerCase()} ${recordLabel(entity, out)}.` };
      }
      case "update_record": {
        // Re-read inside the write's transaction: validate against the
        // current stored data and land only if nobody changed it meanwhile.
        const cur = await tx.miniAppRecord.findFirst({ where: { id: record!.id, workspaceId: actor.workspaceId, appId: pre.row.id }, select: RECORD_SELECT });
        if (!cur) throw new AppError(404, "That record was deleted.");
        const existing = asRecord(cur);
        const check = validateRecordData(entity!, data, { existing: existing.data });
        if (!check.ok) throw new AppError(400, recordErrorText(check.errors), { fields: check.errors });
        await checkRefs(tx, actor, pre.row.id, entity!, check.refs);
        const claimed = await tx.miniAppRecord.updateMany({
          where: { id: existing.id, workspaceId: actor.workspaceId, appId: pre.row.id, updatedAt: existing.updatedAt },
          data: { data: toJson(check.data as RecordData), specVersion: pre.row.version, updatedBy: actor.userId },
        });
        if (claimed.count !== 1) throw new AppError(409, "Someone changed this record just now. Reload and try again.");
        const rec = await tx.miniAppRecord.findFirst({ where: { id: existing.id, workspaceId: actor.workspaceId }, select: RECORD_SELECT });
        const out = asRecord(rec!);
        await audit(tx, actor, slug, "record_update", out.id, `${action.label}: updated ${entity!.label} ${recordLabel(entity, out)}${how}`);
        return { record: out, summary: `${action.label}: updated ${recordLabel(entity, out)}.` };
      }
      case "delete_record": {
        const gone = await tx.miniAppRecord.deleteMany({ where: { id: record!.id, workspaceId: actor.workspaceId, appId: pre.row.id } });
        if (gone.count !== 1) throw new AppError(404, "That record was already deleted.");
        await audit(tx, actor, slug, "record_delete", record!.id, `${action.label}: deleted ${entity?.label ?? record!.entity} ${recordLabel(entity, record)}${how}`);
        return { deletedId: record!.id, summary: `Deleted ${recordLabel(entity, record)}.` };
      }
      case "run_workflow": {
        const wf = await tx.workflow.findFirst({
          where: { id: action.workflowId!, project: { workspaceId: actor.workspaceId } },
          select: { id: true, name: true, projectId: true, enabled: true, status: true },
        });
        if (!wf) throw new AppError(404, "The workflow this action runs no longer exists.");
        if (!wf.enabled || wf.status !== "active") throw new AppError(409, `Workflow "${wf.name}" isn't active. Turn it on in Automations first.`);
        const run = await tx.workflowRun.create({
          data: { workflowId: wf.id, projectId: wf.projectId, status: "queued", triggerKind: "manual", createdBy: actor.userId },
          select: { id: true },
        });
        await audit(tx, actor, slug, "workflow_queued", record?.id ?? null, `${action.label}: queued workflow "${wf.name}" run ${run.id}${how}`);
        return { workflowRunId: run.id, summary: `Workflow "${wf.name}" queued (run ${run.id}).` };
      }
      case "call_tool": {
        // The tool runs after this transaction (it opens its own); the
        // approval claim (tier 2) commits first.
        const projectId =
          action.projectId ??
          (await tx.project.findFirst({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
        if (!projectId) throw new AppError(409, "This workspace has no project for the tool to run in. Add a project first.");
        return { projectId, summary: "" };
      }
    }
  });

  if (action.type === "call_tool") {
    const ctx: ToolContext = {
      projectId: (done as { projectId: string }).projectId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      role: actor.role,
      // Reaching here means tier 0 (a safe tool), a person confirmed
      // (tier 1) or an approval was claimed (tier 2).
      confirmed: tier >= 1,
      agentKey: "lead",
      grant: ["workspace", ...(spec.toolGroups ?? [])],
      ...(input.runId ? { runId: input.runId } : {}),
    };
    const args = fillToolArgs(action.args, record);
    const out = await (deps.toolRunner ?? defaultToolRunner)(ctx, action.tool!, args);
    await withWorkspaceScope(actor.workspaceId, (tx) =>
      audit(tx, actor, slug, "tool_called", record?.id ?? null, `${action.label}: ${action.tool} → ${out.status}: ${out.summary}`),
    );
    if (out.status !== "executed") {
      throw new AppError(out.status === "denied" || out.status === "skipped_role" ? 403 : 502, out.summary || `${action.tool} did not run (${out.status}).`);
    }
    return { outcome: "done", action: action.key, type: action.type, tier, toolStatus: out.status, summary: out.summary };
  }

  return { outcome: "done", action: action.key, type: action.type, tier, ...(done as object), summary: (done as { summary: string }).summary } as RunActionResult;
}

export { OpsGateError };
