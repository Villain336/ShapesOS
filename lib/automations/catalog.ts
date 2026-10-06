// ShapesOS — Phase 18.3 (WS=flow): the Automations app's ONE trigger
// catalogue and ONE action catalogue, generated from what already exists —
// never a hand-kept copy, so a new webhook event, scheduler event, canvas
// trigger, alert trigger or agent tool joins automatically.
//
// Triggers (what can start something), each with the existing engine(s) that
// can act on it:
//   schedule              → workflow canvas (schedule trigger) · scheduled skill (cron)
//   scheduler events      → scheduled skill (event trigger)        lib/scheduler/events.ts
//   canvas triggers       → workflow canvas                        lib/workflow/catalog.ts
//   alert triggers        → alert rules                            lib/alerts/triggers.ts
//   outbound webhook events → a webhook endpoint (Settings → Webhooks), which
//                           can be a workflow's inbound webhook URL lib/webhooks/events.ts
//   inbound mail          → the CRM inbox / helpdesk               lib/messaging/inbound-email.ts
//   Slack mention         → the lead agent (a slack_mention run)   lib/slack/mention.ts
//
// Actions: every agent tool in the registry (lib/chat/tools.ts) with its
// approval tier exactly as the Store and the chat gate compute it
// (agentToolTier: safe = Tier 0; otherwise its action's tier; destructive,
// Tier 3 and never-auto actions "always ask" — no rule can make them run on
// their own). Plus the workflow canvas's own engine actions, which run
// inside a workflow (its approval gates apply).

import { EVENT_SOURCE_CATALOG } from "@/lib/scheduler/events";
import { NODE_CATALOG } from "@/lib/workflow/catalog";
import { TRIGGERS as ALERT_TRIGGERS } from "@/lib/alerts/triggers";
import { SUBSCRIBABLE_EVENT_TYPES, WEBHOOK_EVENT_LABELS } from "@/lib/webhooks/events";
import { allTools, toolAction, toolGroup, type ToolDef } from "@/lib/chat/tools";
import { agentToolTier } from "@/lib/store/catalogue";
import { NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";
import type { DoATier } from "@/lib/orchestrator/authority";

export const TRIGGER_SOURCES = ["schedule", "scheduler_event", "canvas", "alert", "webhook_event", "inbound_mail", "slack_mention"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/** The engines that exist today (the Automations app adds none). */
export const ENGINES = ["workflow", "scheduled_skill", "ops_workflow", "autopilot", "activepieces", "alert_rule", "cron_job", "webhook_endpoint", "inbox", "agent"] as const;
export type Engine = (typeof ENGINES)[number];

export interface TriggerEntry {
  /** "<source>:<key>", unique. */
  id: string;
  source: TriggerSource;
  key: string;
  label: string;
  description: string;
  engines: Engine[];
  /** Live in this build (alert triggers can be reserved for later). */
  live: boolean;
}

export interface ActionEntry {
  /** The agent tool name (or "canvas:<type>" for a canvas engine action). */
  name: string;
  description: string;
  engine: "agent_tool" | "workflow";
  /** Approval tier (0 runs on its own … 3 never automatic); null for canvas actions (gated by the workflow's approval steps). */
  tier: DoATier | null;
  /** Never runs without a person's OK, whatever a rule says. */
  alwaysAsks: boolean;
  /** The tool group a task's grant is made of (agent tools). */
  group: string | null;
  kind: string;
}

/** The trigger catalogue (pure). */
export function triggerCatalog(): TriggerEntry[] {
  const out: TriggerEntry[] = [
    {
      id: "schedule:cron",
      source: "schedule",
      key: "cron",
      label: "On a schedule",
      description: "A cron schedule in a time zone (every Monday at 9:00, every hour …).",
      engines: ["workflow", "scheduled_skill"],
      live: true,
    },
  ];
  for (const e of EVENT_SOURCE_CATALOG) {
    out.push({ id: `scheduler_event:${e.source}`, source: "scheduler_event", key: e.source, label: e.label, description: e.description, engines: ["scheduled_skill"], live: true });
  }
  for (const n of NODE_CATALOG.trigger) {
    if (n.type === "schedule") continue; // the shared schedule trigger above
    out.push({ id: `canvas:${n.type}`, source: "canvas", key: n.type, label: n.label, description: n.description, engines: ["workflow"], live: true });
  }
  for (const a of ALERT_TRIGGERS) {
    out.push({ id: `alert:${a.key}`, source: "alert", key: a.key, label: a.label, description: a.description, engines: ["alert_rule"], live: a.live });
  }
  for (const type of SUBSCRIBABLE_EVENT_TYPES) {
    out.push({
      id: `webhook_event:${type}`,
      source: "webhook_event",
      key: type,
      label: WEBHOOK_EVENT_LABELS[type],
      description: `Sent as the "${type}" event to the webhook endpoints that subscribe to it (one of them can be a workflow's inbound webhook URL).`,
      engines: ["webhook_endpoint", "workflow"],
      live: true,
    });
  }
  out.push({
    id: "inbound_mail:reply",
    source: "inbound_mail",
    key: "reply",
    label: "An email reply arrives",
    description: "A reply to mail sent from ShapesOS threads into the lead's conversation; mail to the support address opens a helpdesk ticket.",
    engines: ["inbox"],
    live: true,
  });
  out.push({
    id: "slack_mention:mention",
    source: "slack_mention",
    key: "mention",
    label: "Someone mentions ShapesOS in Slack",
    description: "The lead agent picks it up as a run; its replies and writes still wait for a person's OK.",
    engines: ["agent"],
    live: true,
  });
  return out;
}

/** One agent tool's catalogue entry (the Store's tier arithmetic). */
export function actionEntryForTool(tool: Pick<ToolDef, "name" | "description" | "kind">): ActionEntry {
  const tier = agentToolTier(tool, toolAction(tool.name), NEVER_AUTO_ACTIONS);
  return { name: tool.name, description: tool.description, engine: "agent_tool", tier: tier.tier, alwaysAsks: tier.alwaysAsks, group: toolGroup(tool.name), kind: tool.kind };
}

/** The action catalogue (pure given the registry): every agent tool once, then the canvas engine actions. */
export function actionCatalog(tools: readonly Pick<ToolDef, "name" | "description" | "kind">[] = allTools()): ActionEntry[] {
  const seen = new Set<string>();
  const out: ActionEntry[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(actionEntryForTool(t));
  }
  for (const n of [...NODE_CATALOG.action, ...NODE_CATALOG.approval, ...NODE_CATALOG.logic]) {
    out.push({ name: `canvas:${n.type}`, description: n.description, engine: "workflow", tier: null, alwaysAsks: n.type === "approval_gate", group: null, kind: "canvas" });
  }
  return out;
}
