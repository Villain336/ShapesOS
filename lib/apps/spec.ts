// ShapesOS — Phase 9 (apps): the mini-app spec (PURE: safe in the browser).
//
// An internal mini-app is ONE JSON document, validated here with zod:
//
//   name, slug, description
//   entities  — what the app stores; each a list of typed fields
//               (text, number, money, date, bool, select, relation, file)
//               with required + per-type validation
//   views     — how people see an entity: table (columns, filters, sort),
//               form, kanban (grouped by a select field) or detail
//   actions   — what people (and agents) can do: create / update / delete a
//               record, run a workflow, call a granted agent tool — each
//               with a TIER and a minimum role
//   toolGroups — the agent tool groups call_tool actions may use (granted
//               when an admin publishes the app)
//
// Permissions are inline: every view and action carries `minRole`
// (defaults: views viewer, actions editor). Writes never go below editor —
// viewers stay read-only workspace-wide (lib/authz.ts).
//
// Tiers (what happens when an action runs; the server enforces them):
//   0  runs at once (logged)
//   1  asks first: the person confirms in the UI, or a person said "yes" to
//      the agent's call (lib/chat/tool-exec.ts). An agent call that ran on
//      an auto-approve rule had no person in the loop, so it is escalated
//      to an approval (tier 2) instead.
//   2  needs an approval: proposed to the Approvals inbox through the ops
//      gate (lib/ops/gate.ts → Phase 14), executed only with the approved,
//      unexpired, binding-matching approval
// A spec can raise a tier, never lower it below the action's floor
// (ACTION_TIER_FLOOR; call_tool also floors on the tool's kind), and any
// action whose wording reads as money / signing / deletion to the DoA
// evaluator (lib/orchestrator/authority.ts, Tier 3) is lifted to 2.
//
// The database never holds a spec this module would reject: drafts are
// parsed before they're saved, and publish re-parses (lib/apps/service.ts).

import { z } from "zod";
import { TOOL_GROUPS, type ToolGroup } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { validateFieldValue } from "./records";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const APP_ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const ROLE_RANK: Record<AppRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Same lattice as lib/authz.ts roleAtLeast (kept here so this module stays pure). */
export function roleMeets(role: string | null | undefined, min: AppRole): boolean {
  if (!role || !(role in ROLE_RANK)) return false;
  return ROLE_RANK[role as AppRole] >= ROLE_RANK[min];
}

export const FIELD_TYPES = ["text", "number", "money", "date", "bool", "select", "relation", "file"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const VIEW_TYPES = ["table", "form", "kanban", "detail"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const ACTION_TYPES = ["create_record", "update_record", "delete_record", "run_workflow", "call_tool"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const FILTER_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const ACTION_TIERS = [0, 1, 2] as const;
export type ActionTier = (typeof ACTION_TIERS)[number];

export const TIER_LABELS: Readonly<Record<ActionTier, string>> = {
  0: "Runs at once",
  1: "Asks first",
  2: "Needs approval",
};

/** The lowest tier each action type may run at. */
export const ACTION_TIER_FLOOR: Readonly<Record<ActionType, ActionTier>> = {
  create_record: 0,
  update_record: 0,
  delete_record: 1,
  run_workflow: 1,
  call_tool: 0, // raised by the tool's kind: see toolKindTierFloor
};

/** Sortable / filterable system columns every record has. */
export const SYSTEM_FIELDS = ["createdAt", "updatedAt"] as const;

export const SPEC_LIMITS = {
  entities: 20,
  fieldsPerEntity: 60,
  views: 40,
  actions: 60,
  selectOptions: 50,
  textMax: 10_000,
} as const;

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_.]{0,79}$/;

const keySchema = z.string().regex(KEY_RE, "must be lower_snake_case: a letter, then letters, digits or _ (max 40)");
const labelSchema = z.string().trim().min(1, "is required").max(80);
const roleSchema = z.enum(APP_ROLES);
const scalarSchema = z.union([z.string().max(SPEC_LIMITS.textMax), z.number().finite(), z.boolean()]);

const fieldSchema = z
  .object({
    key: keySchema,
    label: labelSchema,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    help: z.string().trim().max(200).optional(),
    // text
    minLength: z.number().int().min(0).max(SPEC_LIMITS.textMax).optional(),
    maxLength: z.number().int().min(1).max(SPEC_LIMITS.textMax).optional(),
    format: z.enum(["email", "url", "multiline"]).optional(),
    // number / money (money bounds are in cents)
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code").optional(),
    // select
    options: z.array(z.string().trim().min(1).max(60)).max(SPEC_LIMITS.selectOptions).optional(),
    // relation
    target: keySchema.optional(),
  })
  .strict();

const entitySchema = z
  .object({
    key: keySchema,
    label: labelSchema,
    labelPlural: labelSchema.optional(),
    /** The field that names a record (kanban cards, relation pickers). */
    titleField: keySchema.optional(),
    fields: z.array(fieldSchema).min(1, "needs at least one field").max(SPEC_LIMITS.fieldsPerEntity),
  })
  .strict();

const filterSchema = z
  .object({
    field: z.string().min(1).max(40),
    op: z.enum(FILTER_OPS),
    value: scalarSchema.optional(),
  })
  .strict();

const viewSchema = z
  .object({
    key: keySchema,
    label: labelSchema,
    type: z.enum(VIEW_TYPES),
    entity: keySchema,
    /** Columns (table), inputs (form), card lines (kanban), rows (detail). Default: every field. */
    fields: z.array(keySchema).max(SPEC_LIMITS.fieldsPerEntity).optional(),
    filters: z.array(filterSchema).max(10).optional(),
    sort: z.object({ field: z.string().min(1).max(40), dir: z.enum(["asc", "desc"]) }).strict().optional(),
    /** Kanban: the select field whose options are the columns. */
    groupBy: keySchema.optional(),
    minRole: roleSchema.optional(),
  })
  .strict();

const actionSchema = z
  .object({
    key: keySchema,
    label: labelSchema,
    type: z.enum(ACTION_TYPES),
    description: z.string().trim().max(300).optional(),
    /** Record actions: the entity they act on. */
    entity: keySchema.optional(),
    tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    minRole: roleSchema.optional(),
    /** update_record: fixed values to set ("Mark done" → { status: "done" }). Absent = an edit form. */
    set: z.record(z.string(), scalarSchema).optional(),
    /** run_workflow: the workflow (lib/workflow) to queue. */
    workflowId: z.string().trim().min(1).max(64).optional(),
    /** call_tool: the agent tool to call (lib/chat/tools.ts) and its arguments. */
    tool: z.string().regex(TOOL_NAME_RE, "must be a tool name").optional(),
    /** String values may use {{record.id}} / {{record.<field>}}. */
    args: z.record(z.string(), scalarSchema).optional(),
    /** call_tool: the project the tool runs in (default: the workspace's first project). */
    projectId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const specObjectSchema = z
  .object({
    name: labelSchema,
    slug: z.string().regex(SLUG_RE, "must be lower-case letters, digits and dashes (max 48)"),
    description: z.string().trim().max(500).optional(),
    entities: z.array(entitySchema).min(1, "needs at least one entity").max(SPEC_LIMITS.entities),
    views: z.array(viewSchema).min(1, "needs at least one view").max(SPEC_LIMITS.views),
    actions: z.array(actionSchema).max(SPEC_LIMITS.actions).default([]),
    toolGroups: z.array(z.enum(TOOL_GROUPS)).max(TOOL_GROUPS.length).optional(),
  })
  .strict();

export type FieldSpec = z.infer<typeof fieldSchema>;
export type EntitySpec = z.infer<typeof entitySchema>;
export type FilterSpec = z.infer<typeof filterSchema>;
export type ViewSpec = z.infer<typeof viewSchema>;
export type ActionSpec = z.infer<typeof actionSchema>;
export type MiniAppSpec = z.output<typeof specObjectSchema>;

// ---------------------------------------------------------------------------
// Cross-reference checks (keys resolve, types fit, tiers respect floors)
// ---------------------------------------------------------------------------

type Issue = { path: Array<string | number>; message: string };

function dupes(values: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) (seen.has(v) ? out : seen).add(v);
  return [...out];
}

const ORDERED_TYPES: ReadonlySet<FieldType> = new Set(["number", "money", "date"]);

function crossCheck(spec: MiniAppSpec): Issue[] {
  const issues: Issue[] = [];
  const add = (path: Issue["path"], message: string) => issues.push({ path, message });

  for (const d of dupes(spec.entities.map((e) => e.key))) add(["entities"], `duplicate entity key "${d}"`);
  for (const d of dupes(spec.views.map((v) => v.key))) add(["views"], `duplicate view key "${d}"`);
  for (const d of dupes(spec.actions.map((a) => a.key))) add(["actions"], `duplicate action key "${d}"`);

  const entities = new Map(spec.entities.map((e) => [e.key, e]));

  spec.entities.forEach((e, ei) => {
    for (const d of dupes(e.fields.map((f) => f.key))) add(["entities", ei, "fields"], `duplicate field key "${d}"`);
    if (e.titleField && !e.fields.some((f) => f.key === e.titleField)) {
      add(["entities", ei, "titleField"], `"${e.titleField}" is not a field of ${e.key}`);
    }
    e.fields.forEach((f, fi) => {
      const at = ["entities", ei, "fields", fi];
      if ((SYSTEM_FIELDS as readonly string[]).includes(f.key)) add([...at, "key"], `"${f.key}" is reserved`);
      if (f.type === "select") {
        if (!f.options?.length) add([...at, "options"], "a select field needs at least one option");
        for (const d of dupes(f.options ?? [])) add([...at, "options"], `duplicate option "${d}"`);
      } else if (f.options) add([...at, "options"], "only select fields have options");
      if (f.type === "relation") {
        if (!f.target) add([...at, "target"], "a relation field needs a target entity");
        else if (!entities.has(f.target)) add([...at, "target"], `unknown entity "${f.target}"`);
      } else if (f.target) add([...at, "target"], "only relation fields have a target");
      if (f.type !== "text" && (f.minLength !== undefined || f.maxLength !== undefined || f.format)) {
        add(at, "minLength, maxLength and format apply to text fields only");
      }
      if (f.type !== "number" && f.type !== "money" && (f.min !== undefined || f.max !== undefined)) {
        add(at, "min and max apply to number and money fields only");
      }
      if (f.type === "money") {
        if ((f.min !== undefined && !Number.isInteger(f.min)) || (f.max !== undefined && !Number.isInteger(f.max))) {
          add(at, "money bounds are whole cents");
        }
      } else if (f.currency) add([...at, "currency"], "only money fields have a currency");
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) add(at, "min is greater than max");
      if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) {
        add(at, "minLength is greater than maxLength");
      }
    });
  });

  const fieldOf = (entityKey: string, key: string) => entities.get(entityKey)?.fields.find((f) => f.key === key);
  const isSystem = (k: string) => (SYSTEM_FIELDS as readonly string[]).includes(k);

  spec.views.forEach((v, vi) => {
    const at = ["views", vi];
    const entity = entities.get(v.entity);
    if (!entity) {
      add([...at, "entity"], `unknown entity "${v.entity}"`);
      return;
    }
    (v.fields ?? []).forEach((k, i) => {
      if (!fieldOf(v.entity, k)) add([...at, "fields", i], `"${k}" is not a field of ${v.entity}`);
    });
    (v.filters ?? []).forEach((flt, i) => {
      const f = fieldOf(v.entity, flt.field);
      if (!f && !isSystem(flt.field)) {
        add([...at, "filters", i, "field"], `"${flt.field}" is not a field of ${v.entity}`);
        return;
      }
      const type: FieldType = f ? f.type : "date";
      if (flt.op === "contains" && type !== "text") add([...at, "filters", i, "op"], "contains works on text fields only");
      if (["gt", "gte", "lt", "lte"].includes(flt.op) && !ORDERED_TYPES.has(type)) {
        add([...at, "filters", i, "op"], `${flt.op} works on number, money and date fields only`);
      }
      if (flt.op !== "empty" && flt.op !== "not_empty" && flt.value === undefined) {
        add([...at, "filters", i, "value"], `${flt.op} needs a value`);
      }
    });
    if (v.sort && !fieldOf(v.entity, v.sort.field) && !isSystem(v.sort.field)) {
      add([...at, "sort", "field"], `"${v.sort.field}" is not a field of ${v.entity}`);
    }
    if (v.type === "kanban") {
      const g = v.groupBy ? fieldOf(v.entity, v.groupBy) : undefined;
      if (!v.groupBy) add([...at, "groupBy"], "a kanban view needs groupBy (a select field)");
      else if (!g || g.type !== "select") add([...at, "groupBy"], `"${v.groupBy}" must be a select field of ${v.entity}`);
    } else if (v.groupBy) add([...at, "groupBy"], "only kanban views group by a field");
  });

  spec.actions.forEach((a, ai) => {
    const at = ["actions", ai];
    const recordAction = a.type === "create_record" || a.type === "update_record" || a.type === "delete_record";
    if (recordAction) {
      if (!a.entity) add([...at, "entity"], `${a.type} needs an entity`);
      else if (!entities.has(a.entity)) add([...at, "entity"], `unknown entity "${a.entity}"`);
    } else if (a.entity && !entities.has(a.entity)) add([...at, "entity"], `unknown entity "${a.entity}"`);
    if (a.set && a.type !== "update_record") add([...at, "set"], "only update_record actions set values");
    if (a.set && a.entity && entities.has(a.entity)) {
      for (const [k, val] of Object.entries(a.set)) {
        const f = fieldOf(a.entity, k);
        if (!f) {
          add([...at, "set", k], `"${k}" is not a field of ${a.entity}`);
          continue;
        }
        const r = validateFieldValue(f, val);
        if (!r.ok) add([...at, "set", k], r.error);
      }
    }
    if (a.type === "run_workflow" && !a.workflowId) add([...at, "workflowId"], "run_workflow needs a workflowId");
    if (a.type !== "run_workflow" && a.workflowId) add([...at, "workflowId"], "only run_workflow actions have a workflowId");
    if (a.type === "call_tool" && !a.tool) add([...at, "tool"], "call_tool needs a tool");
    if (a.type !== "call_tool" && (a.tool || a.args || a.projectId)) add(at, "tool, args and projectId belong to call_tool actions");
    if (a.minRole && !roleMeets(a.minRole, "editor")) {
      add([...at, "minRole"], "actions need at least the editor role (viewers are read-only)");
    }
    const floor = staticTierFloor(a);
    if (a.tier !== undefined && a.tier < floor) {
      add([...at, "tier"], `${a.type} "${a.key}" can't run below tier ${floor} (${TIER_LABELS[floor].toLowerCase()})`);
    }
  });

  return issues;
}

/** Tier floor known without the tool registry: the type's floor, raised by DoA Tier-3 wording. */
function staticTierFloor(a: Pick<ActionSpec, "type" | "label" | "description">): ActionTier {
  let floor = ACTION_TIER_FLOOR[a.type];
  // delete_record is exempt from the wording lift: it is never automatic
  // anyway (floor 1 = a person confirms every delete; the agent's
  // app_delete_record is a destructive tool, which always asks).
  if (a.type === "delete_record") return floor;
  const doa = evaluateTier(
    { kind: "app_action", description: `${a.label} ${a.description ?? ""}` },
    { smallActionThresholdCents: 0, automationAllows: false },
  );
  // Money / signing / deletion wording → it needs an approval, whatever the spec says.
  if (doa === 3) floor = 2;
  return floor;
}

/** The floor a tool's safety kind puts on a call_tool action. */
export function toolKindTierFloor(kind: string | null | undefined): ActionTier {
  if (kind === "safe") return 0;
  if (kind === "destructive") return 2;
  return 1; // spend / publish / unknown
}

/**
 * The tier an action actually runs at: the declared tier, never below the
 * type's floor, the DoA Tier-3 lift, or (call_tool) the tool kind's floor.
 */
export function effectiveActionTier(a: ActionSpec, opts: { toolKind?: string | null } = {}): ActionTier {
  let t: number = Math.max(a.tier ?? 0, staticTierFloor(a));
  if (a.type === "call_tool") t = Math.max(t, toolKindTierFloor(opts.toolKind));
  return t as ActionTier;
}

export function actionMinRole(a: Pick<ActionSpec, "minRole">): AppRole {
  return a.minRole && roleMeets(a.minRole, "editor") ? a.minRole : "editor";
}

export function viewMinRole(v: Pick<ViewSpec, "minRole">): AppRole {
  return v.minRole ?? "viewer";
}

/**
 * Who may read an entity's records: the lowest minRole among the views that
 * show it (no view → editors and up). The record API and the agent tools
 * use this, so a view's role can't be sidestepped by asking the API directly.
 */
export function entityReadRole(spec: MiniAppSpec, entityKey: string): AppRole {
  const roles = spec.views.filter((v) => v.entity === entityKey).map(viewMinRole);
  if (!roles.length) return "editor";
  return roles.reduce((lo, r) => (ROLE_RANK[r] < ROLE_RANK[lo] ? r : lo));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export type SpecParseResult = { ok: true; spec: MiniAppSpec } | { ok: false; errors: string[] };

function fmtPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
}

/** Parse + cross-check a spec. Errors are "path: message" lines (agent- and UI-readable). */
export function parseSpec(input: unknown): SpecParseResult {
  const parsed = specObjectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => `${fmtPath(i.path) || "spec"}: ${i.message}`),
    };
  }
  const issues = crossCheck(parsed.data);
  if (issues.length) return { ok: false, errors: issues.slice(0, 20).map((i) => `${fmtPath(i.path) || "spec"}: ${i.message}`) };
  return { ok: true, spec: parsed.data };
}

/** Parse a spec already stored (published or a version snapshot); throws when it's not one. */
export function storedSpec(value: unknown): MiniAppSpec {
  const r = parseSpec(value);
  if (!r.ok) throw new Error(`Stored mini-app spec is invalid: ${r.errors[0]}`);
  return r.spec;
}

// ---------------------------------------------------------------------------
// Lookups used by the runtime, the builder and the tools
// ---------------------------------------------------------------------------

export function findEntity(spec: MiniAppSpec, key: string): EntitySpec | undefined {
  return spec.entities.find((e) => e.key === key);
}

export function findView(spec: MiniAppSpec, key: string): ViewSpec | undefined {
  return spec.views.find((v) => v.key === key);
}

export function findAction(spec: MiniAppSpec, key: string): ActionSpec | undefined {
  return spec.actions.find((a) => a.key === key);
}

/** The fields a view shows, in order (default: every field of its entity). */
export function viewFields(spec: MiniAppSpec, view: ViewSpec): FieldSpec[] {
  const entity = findEntity(spec, view.entity);
  if (!entity) return [];
  if (!view.fields?.length) return entity.fields;
  return view.fields.map((k) => entity.fields.find((f) => f.key === k)).filter((f): f is FieldSpec => !!f);
}

/** The field that names a record: titleField, else the first text field, else the first field. */
export function titleFieldOf(entity: EntitySpec): FieldSpec {
  return (
    (entity.titleField ? entity.fields.find((f) => f.key === entity.titleField) : undefined) ??
    entity.fields.find((f) => f.type === "text") ??
    entity.fields[0]!
  );
}

/** The action an agent's upsert maps to: create, or the entity's edit action (update without fixed values). */
export function recordWriteAction(spec: MiniAppSpec, entityKey: string, op: "create" | "update" | "delete"): ActionSpec | undefined {
  const type: ActionType = op === "create" ? "create_record" : op === "update" ? "update_record" : "delete_record";
  return spec.actions.find((a) => a.type === type && a.entity === entityKey && (op !== "update" || !a.set));
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return SLUG_RE.test(s) ? s : "app";
}

/**
 * The starter spec a new app gets: one entity with a title and a status,
 * a table, a form, a board, a detail view, and the four everyday actions.
 */
export function starterSpec(name: string, slug: string, description?: string): MiniAppSpec {
  const spec: MiniAppSpec = {
    name,
    slug,
    ...(description ? { description } : {}),
    entities: [
      {
        key: "items",
        label: "Item",
        labelPlural: "Items",
        titleField: "title",
        fields: [
          { key: "title", label: "Title", type: "text", required: true, maxLength: 200 },
          { key: "status", label: "Status", type: "select", options: ["To do", "Doing", "Done"] },
          { key: "notes", label: "Notes", type: "text", format: "multiline" },
        ],
      },
    ],
    views: [
      { key: "all", label: "All items", type: "table", entity: "items", fields: ["title", "status"], sort: { field: "createdAt", dir: "desc" } },
      { key: "board", label: "Board", type: "kanban", entity: "items", groupBy: "status", fields: ["notes"] },
      { key: "new_item", label: "New item", type: "form", entity: "items", minRole: "editor" },
      { key: "item", label: "Item", type: "detail", entity: "items" },
    ],
    actions: [
      { key: "create_item", label: "Add item", type: "create_record", entity: "items", tier: 0 },
      { key: "edit_item", label: "Edit", type: "update_record", entity: "items", tier: 0 },
      { key: "mark_done", label: "Mark done", type: "update_record", entity: "items", set: { status: "Done" }, tier: 0 },
      { key: "delete_item", label: "Delete", type: "delete_record", entity: "items", tier: 1 },
    ],
  };
  return spec;
}

export type { ToolGroup };
