// ShapesOS — Phase 18.3 (WS=flow): "Describe it". A person types what they
// want ("every Monday, summarise new tickets and post to #support"); the
// lead model drafts it IN AN EXISTING FORMAT — a scheduled skill (the
// scheduler) or a workflow canvas graph — explains the choice, and the
// Automations app shows it for review. Nothing runs or is saved here: on
// "Create" the app sends the draft to those systems' OWN routes
// (POST /api/schedules · POST /api/workflows + PUT …/nodes + PATCH schedule),
// with their own checks. A created workflow starts as a draft (off).
//
// validateDraft() is the safety net for whatever the model returns:
//   - only known formats, node kinds/types (lib/workflow/catalog.ts),
//     required fields, a trigger, edges between real nodes, no cycles, valid
//     cron + time zone, real skills / projects of THIS workspace;
//   - a scheduled skill is always "supervised" (each run waits in Needs you
//     before it acts) — a draft can never set autopilot;
//   - a canvas "run an agent tool" step may only name a known tool that is
//     NOT "always asks" (Tier 3 money/deleting, destructive, never-auto):
//     a draft can never include a step that would auto-run a Tier 3 action.
//
// Model: the workspace's "lead" workload through getLlmProviderForWorkspace
// (metered like every model call). Without a live model the drafter is a
// small rule-based MOCK, labelled mock in the result and the UI.

import { isEventSource, EVENT_SOURCES } from "@/lib/scheduler/events";
import { parseCron } from "@/lib/scheduler/cron";
import { CONDITION_LABELS, NODE_CATALOG, nodeTypeDef } from "@/lib/workflow/catalog";
import { allTools, type ToolDef } from "@/lib/chat/tools";
import { actionEntryForTool } from "./catalog";
export { workflowGraphBody } from "./model";

import { DRAFT_TEXT_MAX } from "./limits";
export { DRAFT_TEXT_MAX };
const MAX_DRAFT_NODES = 12;

export interface DraftContext {
  workspaceId: string;
  projects: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string; description?: string | null }>;
  timezone: string;
}

export interface ScheduleDraft {
  skillId: string;
  projectId: string | null;
  triggerType: "cron" | "event";
  cronExpr: string | null;
  timezone: string;
  eventSource: string | null;
  approvalMode: "supervised";
}

export interface DraftNode {
  key: string;
  kind: "trigger" | "action" | "approval" | "logic";
  type: string;
  label: string;
  config: Record<string, unknown>;
}

export interface DraftEdge {
  from: string;
  to: string;
  label?: "true" | "false" | null;
}

export interface WorkflowDraft {
  projectId: string;
  name: string;
  schedule: string | null;
  timezone: string;
  nodes: DraftNode[];
  edges: DraftEdge[];
}

export type AutomationDraft =
  | { format: "schedule"; name: string; why: string; schedule: ScheduleDraft }
  | { format: "workflow"; name: string; why: string; workflow: WorkflowDraft };

export interface DraftResult {
  draft: AutomationDraft | null;
  problems: string[];
  /** True when no live model drafted it (the rule-based mock did). */
  mock: boolean;
}

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function hasCycle(nodes: DraftNode[], edges: DraftEdge[]): boolean {
  const out = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const n of out.get(k) ?? []) if (visit(n)) return true;
    state.set(k, 2);
    return false;
  };
  return nodes.some((n) => visit(n.key));
}

/** Validate (and normalise) a draft against the scheduler / canvas schemas and the tier rule. PURE given the context and tools. */
export function validateDraft(raw: unknown, ctx: DraftContext, tools: readonly Pick<ToolDef, "name" | "description" | "kind">[] = allTools()): { ok: true; draft: AutomationDraft } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const format = r.format;
  const name = str(r.name, 120) || "New automation";
  const why = str(r.why, 600);
  if (format === "schedule") {
    const s = (r.schedule ?? {}) as Record<string, unknown>;
    const skillId = str(s.skillId, 120);
    if (!ctx.skills.some((k) => k.id === skillId)) problems.push("The draft names a skill this workspace doesn't have.");
    const projectId = s.projectId ? str(s.projectId, 120) : null;
    if (projectId && !ctx.projects.some((p) => p.id === projectId)) problems.push("The draft names a project this workspace doesn't have.");
    const triggerType = s.triggerType === "event" ? "event" : s.triggerType === "cron" ? "cron" : null;
    if (!triggerType) problems.push('A schedule triggers on "cron" or "event".');
    const timezone = str(s.timezone, 64) || ctx.timezone || "UTC";
    if (!validTimeZone(timezone)) problems.push(`"${timezone}" is not a time zone.`);
    let cronExpr: string | null = null;
    let eventSource: string | null = null;
    if (triggerType === "cron") {
      cronExpr = str(s.cronExpr, 100);
      try {
        parseCron(cronExpr);
      } catch (err) {
        problems.push(`Cron "${cronExpr}": ${err instanceof Error ? err.message : "invalid"}.`);
      }
    } else if (triggerType === "event") {
      eventSource = str(s.eventSource, 60);
      if (!isEventSource(eventSource)) problems.push(`"${eventSource}" is not a scheduler event (${EVENT_SOURCES.join(", ")}).`);
    }
    if (s.approvalMode !== undefined && s.approvalMode !== "supervised") {
      problems.push("A drafted schedule is always supervised: each run waits for a person before it acts.");
    }
    if (problems.length) return { ok: false, problems };
    return { ok: true, draft: { format: "schedule", name, why, schedule: { skillId, projectId, triggerType: triggerType!, cronExpr, timezone, eventSource, approvalMode: "supervised" } } };
  }
  if (format === "workflow") {
    const w = (r.workflow ?? {}) as Record<string, unknown>;
    const projectId = str(w.projectId, 120);
    if (!ctx.projects.some((p) => p.id === projectId)) problems.push("A workflow lives in a project; the draft names none of this workspace's projects.");
    const timezone = str(w.timezone, 64) || ctx.timezone || "UTC";
    if (!validTimeZone(timezone)) problems.push(`"${timezone}" is not a time zone.`);
    const rawNodes = Array.isArray(w.nodes) ? (w.nodes as Record<string, unknown>[]) : [];
    const rawEdges = Array.isArray(w.edges) ? (w.edges as Record<string, unknown>[]) : [];
    if (rawNodes.length === 0) problems.push("The workflow has no steps.");
    if (rawNodes.length > MAX_DRAFT_NODES) problems.push(`At most ${MAX_DRAFT_NODES} steps in a draft.`);
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const nodes: DraftNode[] = [];
    const keys = new Set<string>();
    let schedule: string | null = null;
    for (const [i, n] of rawNodes.slice(0, MAX_DRAFT_NODES).entries()) {
      const key = str(n.key, 40) || `n${i + 1}`;
      const kind = str(n.kind, 20) as DraftNode["kind"];
      const type = str(n.type, 40);
      const def = nodeTypeDef(kind, type);
      if (!def) {
        problems.push(`Step ${i + 1}: "${kind}/${type}" is not a canvas step.`);
        continue;
      }
      if (keys.has(key)) problems.push(`Two steps share the key "${key}".`);
      keys.add(key);
      const config = n.config && typeof n.config === "object" && !Array.isArray(n.config) ? { ...(n.config as Record<string, unknown>) } : {};
      for (const f of def.fields) {
        if (f.required && (config[f.key] === undefined || config[f.key] === null || String(config[f.key]).trim() === "")) problems.push(`Step "${def.label}" needs ${f.label}.`);
      }
      if (kind === "trigger" && type === "schedule") {
        try {
          parseCron(String(config.cron ?? ""));
          schedule = String(config.cron);
        } catch (err) {
          problems.push(`Schedule step: ${err instanceof Error ? err.message : "invalid cron"}.`);
        }
      }
      if (type === "run_agent_tool") {
        const tool = toolByName.get(String(config.tool ?? ""));
        if (!tool) problems.push(`Step "${str(n.label) || def.label}" names an agent tool that doesn't exist.`);
        else {
          const entry = actionEntryForTool(tool);
          if (entry.alwaysAsks || entry.tier === 3) {
            problems.push(`"${tool.name}" always asks a person (Tier ${entry.tier}${tool.kind === "destructive" ? ", destructive" : ""}); a draft can't include a step that would run it on its own.`);
          }
        }
        if (typeof config.args === "object" && config.args !== null) config.args = JSON.stringify(config.args);
      }
      nodes.push({ key, kind, type, label: str(n.label, 120) || def.defaultLabel, config });
    }
    if (!nodes.some((n) => n.kind === "trigger")) problems.push("A workflow needs a trigger step.");
    const edges: DraftEdge[] = [];
    for (const e of rawEdges) {
      const from = str(e.from, 40);
      const to = str(e.to, 40);
      const label = e.label === "true" || e.label === "false" ? e.label : null;
      if (!keys.has(from) || !keys.has(to) || from === to) {
        problems.push("A connection points at a step that doesn't exist.");
        continue;
      }
      if (e.label != null && !(CONDITION_LABELS as readonly string[]).includes(String(e.label))) problems.push('Connection labels are "true", "false" or empty.');
      edges.push({ from, to, label });
    }
    if (hasCycle(nodes, edges)) problems.push("The steps loop back on themselves.");
    if (problems.length) return { ok: false, problems: [...new Set(problems)] };
    return { ok: true, draft: { format: "workflow", name, why, workflow: { projectId, name, schedule, timezone, nodes, edges } } };
  }
  return { ok: false, problems: ['A draft is a "schedule" or a "workflow".'] };
}

// ── The mock drafter (no live model; labelled) ──────────────────────────────

const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };

/** "every Monday at 9" → "0 9 * * 1"; "daily" → "0 9 * * *"; "hourly" → "0 * * * *". PURE. */
export function cronFromText(text: string): string | null {
  const t = text.toLowerCase();
  const time = /\b(?:at|a las)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(t);
  let hour = 9;
  let minute = 0;
  if (time) {
    hour = Math.min(23, Number(time[1]));
    minute = Math.min(59, Number(time[2] ?? 0));
    if (time[3] === "pm" && hour < 12) hour += 12;
    if (time[3] === "am" && hour === 12) hour = 0;
  }
  if (/\b(hourly|every hour|cada hora)\b/.test(t)) return "0 * * * *";
  for (const [day, n] of Object.entries(DAYS)) if (t.includes(day)) return `${minute} ${hour} * * ${n}`;
  if (/\b(weekly|every week|cada semana|semanal)\b/.test(t)) return `${minute} ${hour} * * 1`;
  if (/\b(daily|every day|each day|every morning|cada d[ií]a|diario)\b/.test(t)) return `${minute} ${hour} * * *`;
  if (/\b(monthly|every month|cada mes)\b/.test(t)) return `${minute} ${hour} 1 * *`;
  return null;
}

/** A rule-based draft (MOCK — only when no live model is configured). */
export function mockDraft(text: string, ctx: DraftContext): AutomationDraft {
  const cron = cronFromText(text) ?? "0 9 * * 1";
  const words = new Set(text.toLowerCase().split(/[^a-záéíóúñ0-9]+/).filter((w) => w.length > 3));
  const skill = ctx.skills.map((s) => ({ s, score: s.name.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length })).sort((a, b) => b.score - a.score)[0]?.s;
  const name = text.trim().replace(/\s+/g, " ").slice(0, 80) || "New automation";
  if (skill) {
    return {
      format: "schedule",
      name,
      why: `Mock draft (no model is configured): a scheduled skill fits a recurring task an agent does. It runs "${skill.name}" on cron ${cron} (${ctx.timezone}), supervised — each run waits for you before it acts.`,
      schedule: { skillId: skill.id, projectId: null, triggerType: "cron", cronExpr: cron, timezone: ctx.timezone, eventSource: null, approvalMode: "supervised" },
    };
  }
  const project = ctx.projects[0];
  return {
    format: "workflow",
    name,
    why: "Mock draft (no model is configured): there is no skill to schedule yet, so this is a workflow: on the schedule it searches the workspace (read-only) and sends you an alert. It starts off; turn it on after you check it.",
    workflow: {
      projectId: project?.id ?? "",
      name,
      schedule: cron,
      timezone: ctx.timezone,
      nodes: [
        { key: "t1", kind: "trigger", type: "schedule", label: "Schedule", config: { cron, timezone: ctx.timezone } },
        { key: "a1", kind: "action", type: "run_agent_tool", label: "Search the workspace", config: { tool: "search_workspace", args: JSON.stringify({ query: name.slice(0, 80) }) } },
        { key: "a2", kind: "action", type: "send_alert", label: "Tell me", config: { title: name.slice(0, 120), body: "The run's steps show what the search found.", severity: "info", trigger: "workflow" } },
      ],
      edges: [
        { from: "t1", to: "a1" },
        { from: "a1", to: "a2" },
      ],
    },
  };
}

/** {"format": …} from a model's text (tolerates fences / prose). PURE. */
export function parseDraftJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as unknown;
  } catch {
    return null;
  }
}

export function draftPrompt(text: string, ctx: DraftContext, tools: readonly Pick<ToolDef, "name" | "description" | "kind">[] = allTools()): string {
  const safeTools = tools
    .map((t) => ({ t, e: actionEntryForTool(t) }))
    .filter(({ e }) => !e.alwaysAsks && e.tier !== 3)
    .slice(0, 80)
    .map(({ t, e }) => `- ${t.name} (Tier ${e.tier}): ${t.description.slice(0, 140)}`);
  const nodeTypes = (Object.keys(NODE_CATALOG) as Array<keyof typeof NODE_CATALOG>)
    .flatMap((kind) => NODE_CATALOG[kind].map((n) => `- ${kind}/${n.type}: ${n.description.slice(0, 120)} fields: ${n.fields.map((f) => `${f.key}${f.required ? "*" : ""}`).join(", ") || "none"}`));
  return [
    "You draft ONE automation for a business workspace in an existing format. Reply with ONLY a JSON object, no prose.",
    'Pick "schedule" (a scheduled skill: an agent skill run on a cron or an event; runs are supervised) when an existing skill does the work; otherwise "workflow" (a canvas graph).',
    'Schedule shape: {"format":"schedule","name":"…","why":"one or two sentences: why this format","schedule":{"skillId":"<id>","projectId":null,"triggerType":"cron"|"event","cronExpr":"m h dom mon dow"|null,"timezone":"<IANA>","eventSource":null|"<event>","approvalMode":"supervised"}}',
    'Workflow shape: {"format":"workflow","name":"…","why":"…","workflow":{"projectId":"<id>","timezone":"<IANA>","nodes":[{"key":"t1","kind":"trigger","type":"schedule","label":"…","config":{"cron":"0 9 * * 1"}}],"edges":[{"from":"t1","to":"a1"}]}}',
    "Never include a step that spends money, deletes, or uses a tool not listed below. Write labels in the person's language.",
    `Time zone: ${ctx.timezone}.`,
    `Skills: ${ctx.skills.map((s) => `${s.id} = ${s.name}${s.description ? ` (${s.description.slice(0, 100)})` : ""}`).join("; ") || "none"}.`,
    `Projects: ${ctx.projects.map((p) => `${p.id} = ${p.name}`).join("; ") || "none"}.`,
    `Scheduler events: ${EVENT_SOURCES.join(", ")}.`,
    "Canvas steps:",
    ...nodeTypes,
    "Agent tools a run_agent_tool step may use:",
    ...safeTools,
    "",
    `The request: """${text.slice(0, DRAFT_TEXT_MAX)}"""`,
  ].join("\n");
}

export interface DraftDeps {
  /** The workspace's lead model (getLlmProviderForWorkspace("lead", …)); injectable for tests. */
  llm: { isLive: boolean; generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> };
  tools?: readonly Pick<ToolDef, "name" | "description" | "kind">[];
}

/** Draft an automation from a description. Saves nothing. */
export async function draftAutomation(text: string, ctx: DraftContext, deps: DraftDeps): Promise<DraftResult> {
  const clean = text.trim().slice(0, DRAFT_TEXT_MAX);
  if (!clean) return { draft: null, problems: ["Describe what you want to automate."], mock: !deps.llm.isLive };
  const tools = deps.tools ?? allTools();
  if (!deps.llm.isLive) {
    const v = validateDraft(mockDraft(clean, ctx), ctx, tools);
    return v.ok ? { draft: v.draft, problems: [], mock: true } : { draft: null, problems: v.problems, mock: true };
  }
  const raw = parseDraftJson(await deps.llm.generate(draftPrompt(clean, ctx, tools), { maxTokens: 1500 }));
  if (!raw) return { draft: null, problems: ["The model didn't return a draft. Try describing it again in a sentence or two."], mock: false };
  const v = validateDraft(raw, ctx, tools);
  return v.ok ? { draft: v.draft, problems: [], mock: false } : { draft: null, problems: v.problems, mock: false };
}
