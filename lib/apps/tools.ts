// ShapesOS — Phase 9 (apps): mini-app tools on the agent surface.
//
// Registered at runtime (registerExtraTool, like the ship and browser tools)
// so they go through every gate executeTool applies: grant, role,
// confirmation, audit, run events. Groups follow the Phase 5 rules the ops
// tools set: reads are "workspace", writes are "ops".
//
//   app_create_spec    publish kind, draft_app_spec (Tier 0: an auto rule
//                      may cover it). Writes the DRAFT only — publishing is
//                      a person's job (admin, in the builder): that is the
//                      approval of an agent-built app.
//   app_list_records   safe. Without an app, lists the workspace's apps.
//   app_upsert_record  publish kind, write_app_record (Tier 2: always asks).
//                      Runs the entity's create / edit action, so the app's
//                      own tier and minRole apply on top.
//   app_delete_record  destructive (always asks), delete_app_record.
//
// A tier-2 action comes back as "approval required" with the approval id;
// once a person approves it in Approvals, the same call with approvalId
// executes exactly that mutation (the binding is verified fail-closed).

import { registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import {
  createApp,
  listApps,
  listRecords,
  loadApp,
  runAppAction,
  saveDraft,
  AppError,
  type AppActor,
  type RunActionDeps,
  type RunActionResult,
} from "./service";
import { parseSpec, recordWriteAction, titleFieldOf, type FilterSpec } from "./spec";
import { formatValue } from "./records";

function actorOf(ctx: ToolContext): AppActor {
  return { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function jsonArg(raw: unknown, name: string): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") throw new Error(`"${name}" must be JSON`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`"${name}" must be valid JSON`);
  }
}

/** Test seam: inject the gate port / tool runner the actions use. */
let testDeps: RunActionDeps | null = null;
export function __setAppToolsTestDeps(d: RunActionDeps | null): void {
  testDeps = d;
}

function actionResult(r: RunActionResult): ToolResult {
  if (r.outcome === "approval_required") {
    return {
      summary: `Approval required: ${r.summary} A person approves it in Approvals (/dashboard/approvals); then call again with approvalId="${r.approval.id}".`,
      details: { approvalRequired: true, approvalId: r.approval.id, riskTier: r.approval.riskTier, tier: r.tier },
    };
  }
  if (r.outcome === "confirm_required") {
    // Only reachable when the caller didn't pass confirmed (never from executeTool).
    return { summary: r.summary, details: { confirmRequired: true } };
  }
  return { summary: r.summary, details: r };
}

function wrapAppError(err: unknown): never {
  if (err instanceof AppError) {
    const more = err.errors?.length ? ` (${err.errors.slice(0, 5).join("; ")})` : "";
    throw new Error(`${err.message}${more}`);
  }
  throw err;
}

export const app_create_spec: ToolDef = {
  name: "app_create_spec",
  description:
    "Draft an internal mini-app (or replace the draft of an existing one) from a spec: entities with typed fields (text, number, money in cents, date, bool, select, relation, file), views (table, form, kanban, detail), actions (create_record, update_record, delete_record, run_workflow, call_tool) each with a tier (0 runs at once, 1 asks first, 2 needs approval) and minRole. Writes the DRAFT only: a workspace admin reviews and publishes it in the builder at /dashboard/apps/<slug>/build. Validation errors come back as path: message lines — fix them and call again.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      spec: {
        type: "string",
        description:
          'The spec as JSON: {"name","slug","description"?,"entities":[{"key","label","labelPlural"?,"titleField"?,"fields":[{"key","label","type","required"?,"options"? (select),"target"? (relation entity key),"min"?,"max"?,"maxLength"?,"format"? ("email"|"url"|"multiline")}]}],"views":[{"key","label","type","entity","fields"?,"filters"?:[{"field","op","value"}],"sort"?:{"field","dir"},"groupBy"? (kanban select field),"minRole"?}],"actions":[{"key","label","type","entity"?,"tier"?,"minRole"?,"set"? (update_record fixed values),"workflowId"?,"tool"?,"args"?}],"toolGroups"?:[...]}. Keys are lower_snake_case; slug is lower-case-with-dashes.',
      },
    },
    required: ["spec"],
  },
  async execute(ctx, args) {
    const spec = jsonArg(args.spec, "spec");
    const parsed = parseSpec(spec);
    if (!parsed.ok) throw new Error(`The spec is not valid: ${parsed.errors.slice(0, 8).join("; ")}`);
    const actor = actorOf(ctx);
    let existed = false;
    try {
      try {
        await loadApp(actor, parsed.spec.slug);
        existed = true;
      } catch (e) {
        if (!(e instanceof AppError) || e.status !== 404) throw e;
      }
      if (existed) await saveDraft(actor, parsed.spec.slug, parsed.spec);
      else await createApp(actor, { spec: parsed.spec });
    } catch (e) {
      wrapAppError(e);
    }
    const s = parsed.spec;
    return {
      summary: `${s.name}: draft ${existed ? "updated" : "created"} (${s.entities.length} entities, ${s.views.length} views, ${s.actions.length} actions). Not live yet: an admin reviews and publishes it at /dashboard/apps/${s.slug}/build.`,
      details: { slug: s.slug, draft: true, published: false, builder: `/dashboard/apps/${s.slug}/build` },
    };
  },
};

export const app_list_records: ToolDef = {
  name: "app_list_records",
  description:
    "Read an internal mini-app's records (or, without an app, list the workspace's apps with their entities). Filters use the app's fields: ops eq, neq, contains, gt, gte, lt, lte, empty, not_empty.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app's slug. Omit to list the apps." },
      entity: { type: "string", description: "Entity key (or give a view)." },
      view: { type: "string", description: "A view key: its filters, sort and role apply." },
      filters: { type: "string", description: 'Optional JSON: [{"field":"status","op":"eq","value":"Open"}].' },
      q: { type: "string", description: "Optional free-text search." },
      limit: { type: "number", description: "Max rows (default 25, max 200)." },
    },
  },
  async execute(ctx, args) {
    const actor = actorOf(ctx);
    const slug = str(args.app);
    try {
      if (!slug) {
        const apps = await listApps(actor);
        return {
          summary: apps.length
            ? apps.map((a) => `${a.name} (${a.slug}, ${a.published ? `v${a.version}` : "draft"}): ${a.entities.join(", ")} — ${a.recordCount} records`).join("; ")
            : "No mini-apps in this workspace yet.",
          details: apps,
        };
      }
      const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 25), 200));
      const filters = jsonArg(args.filters, "filters") as FilterSpec[] | undefined;
      if (filters !== undefined && !Array.isArray(filters)) throw new Error('"filters" must be a JSON array');
      const res = await listRecords(actor, slug, { entity: str(args.entity), view: str(args.view), filters, q: str(args.q), limit });
      const tf = titleFieldOf(res.entity);
      const lines = res.rows.slice(0, 10).map((r) => `${formatValue(tf, r.data[tf.key]) || "(untitled)"} [${r.id}]`);
      return {
        summary: `${res.app.name} · ${res.entity.labelPlural ?? res.entity.label}: ${res.matched} match${res.matched === 1 ? "" : "es"}${res.rows.length < res.matched ? ` (showing ${res.rows.length})` : ""}${lines.length ? ` — ${lines.join("; ")}` : ""}${res.truncated ? " (only the newest records were scanned)" : ""}`,
        details: { app: res.app, entity: res.entity.key, current: res.current, matched: res.matched, rows: res.rows },
      };
    } catch (e) {
      wrapAppError(e);
    }
  },
};

export const app_upsert_record: ToolDef = {
  name: "app_upsert_record",
  description:
    "Create a record in a published mini-app, or update one (pass recordId). Runs the app's own create / edit action for that entity, so its tier and role apply: a tier-2 action returns an approval to wait for (call again with approvalId once approved). Values: money in cents, dates YYYY-MM-DD, relations and files by id.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app's slug." },
      entity: { type: "string", description: "Entity key." },
      recordId: { type: "string", description: "Record to update (omit to create)." },
      data: { type: "string", description: 'JSON object of field values, e.g. {"title":"Fix the sink","status":"Open"}.' },
      approvalId: { type: "string", description: "Only after a person approved this exact write." },
    },
    required: ["app", "entity", "data"],
  },
  async execute(ctx, args) {
    const actor = actorOf(ctx);
    const slug = str(args.app);
    const entity = str(args.entity);
    if (!slug || !entity) throw new Error("app and entity are required");
    const data = jsonArg(args.data, "data");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error('"data" must be a JSON object');
    const recordId = str(args.recordId);
    try {
      const app = await loadApp(actor, slug);
      if (!app.spec || !app.published) throw new AppError(409, `"${app.name}" isn't published yet.`);
      const action = recordWriteAction(app.spec, entity, recordId ? "update" : "create");
      if (!action) {
        throw new AppError(403, `${app.name} has no ${recordId ? "edit" : "create"} action for ${entity}, so records can't be ${recordId ? "changed" : "added"} that way.`);
      }
      const r = await runAppAction(
        actor,
        slug,
        { action: action.key, recordId, data: data as Record<string, unknown>, confirmed: ctx.confirmed, approvalId: str(args.approvalId), via: "agent", runId: ctx.runId },
        testDeps ?? {},
      );
      return actionResult(r);
    } catch (e) {
      wrapAppError(e);
    }
  },
};

export const app_delete_record: ToolDef = {
  name: "app_delete_record",
  description:
    "Delete a record from a published mini-app through the app's delete action. Destructive: it always asks you first, and the app's tier may also require an approval (call again with approvalId once approved).",
  kind: "destructive",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app's slug." },
      entity: { type: "string", description: "Entity key." },
      recordId: { type: "string", description: "Record to delete." },
      approvalId: { type: "string", description: "Only after a person approved this exact delete." },
    },
    required: ["app", "entity", "recordId"],
  },
  async execute(ctx, args) {
    const actor = actorOf(ctx);
    const slug = str(args.app);
    const entity = str(args.entity);
    const recordId = str(args.recordId);
    if (!slug || !entity || !recordId) throw new Error("app, entity and recordId are required");
    try {
      const app = await loadApp(actor, slug);
      if (!app.spec || !app.published) throw new AppError(409, `"${app.name}" isn't published yet.`);
      const action = recordWriteAction(app.spec, entity, "delete");
      if (!action) throw new AppError(403, `${app.name} has no delete action for ${entity}.`);
      const r = await runAppAction(
        actor,
        slug,
        { action: action.key, recordId, confirmed: ctx.confirmed, approvalId: str(args.approvalId), via: "agent", runId: ctx.runId },
        testDeps ?? {},
      );
      return actionResult(r);
    } catch (e) {
      wrapAppError(e);
    }
  },
};

export const APP_TOOLS: ToolDef[] = [app_create_spec, app_list_records, app_upsert_record, app_delete_record];

for (const t of APP_TOOLS) registerExtraTool(t);
