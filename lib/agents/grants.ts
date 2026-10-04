// ShapesOS — Phase 5: agents and the tool groups they may use (PURE).
//
// One lead agent (the Strategist) hands work to sub-agents (lib/aos/agents.ts
// names them). Every tool an agent can call belongs to exactly one TOOL GROUP;
// a task's GRANT is the set of groups it may use. The grant is always worked
// out here, on the server — the client only says what it would like.
//
//   grant = (requested groups ∪ always-granted) ∩ the agent's maximum
//         ∩ the parent run's grant (a delegated sub-agent never gets more
//           than the run that handed the work off)
//
// Role checks (ToolDef.minRole) still apply on top of the grant, and the
// confirmation / approval gates still apply on top of both: a grant only
// ever NARROWS what an agent may do.

import { LEAD_AGENT, SUB_AGENTS, type SubAgentKey } from "@/lib/aos/agents";

export type AgentKey = "lead" | SubAgentKey;

export const AGENT_KEYS: readonly AgentKey[] = ["lead", ...(Object.keys(SUB_AGENTS) as SubAgentKey[])];

export function isAgentKey(v: unknown): v is AgentKey {
  return typeof v === "string" && (AGENT_KEYS as readonly string[]).includes(v);
}

export const TOOL_GROUPS = [
  "workspace", // read this workspace's own data, load skills (always granted)
  "web", // look things up on the web (SERP data, research answers)
  "data", // analytics sources (Search Console, GA4, ad accounts)
  "content", // draft content, reports, QR codes
  "media", // generate images (OpenAI image model; metered)
  "site", // site audits, CMS saves and publishes
  "email", // email accounts and senders
  "calendar", // calendars
  "files", // documents in connected drives / Notion
  "social", // social scheduling
  "automation", // workflows, autopilot approvals, automation flows
  "ops", // business operations (invoices, POs, projects, HR)
  "connectors", // custom MCP servers and other connected apps
  "delegate", // hand work to a sub-agent (lead only)
  "code", // code runner (arrives with the sandbox, Phase 8)
  "ship", // push branches and open pull requests — leaves the sandbox (Phase 8)
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export function isToolGroup(v: unknown): v is ToolGroup {
  return typeof v === "string" && (TOOL_GROUPS as readonly string[]).includes(v);
}

export const TOOL_GROUP_LABELS: Readonly<Record<ToolGroup, string>> = {
  workspace: "Workspace data",
  web: "Web",
  data: "Analytics",
  content: "Content",
  media: "Images",
  site: "Website",
  email: "Email",
  calendar: "Calendar",
  files: "Files",
  social: "Social",
  automation: "Automations",
  ops: "Operations",
  connectors: "Connected apps",
  delegate: "Hand off to sub-agents",
  code: "Code runner",
  ship: "Push and pull requests",
};

/**
 * Phase 8: groups whose tools need infrastructure that may not be there.
 * "code" works exactly when a sandbox provider reports available
 * (lib/sandbox sandboxAvailability(), read server-side and passed in — this
 * module stays pure). Unknown availability counts as unavailable: offered
 * in the UI as unavailable with the reason, never faked.
 */
export interface GroupAvailability {
  code?: { ok: true } | { ok: false; reason: string } | null;
}

export const CODE_UNAVAILABLE_DEFAULT = "No code sandbox is available on this server.";

/** The groups that can't be used right now, each with the reason. PURE. */
export function unavailableGroups(availability?: GroupAvailability | null): ReadonlyMap<ToolGroup, string> {
  const out = new Map<ToolGroup, string>();
  const code = availability?.code;
  if (!code) out.set("code", CODE_UNAVAILABLE_DEFAULT);
  else if (!code.ok) out.set("code", code.reason || CODE_UNAVAILABLE_DEFAULT);
  return out;
}

/** Every task may read its own workspace (it's how an agent grounds itself). */
export const ALWAYS_GRANTED: readonly ToolGroup[] = ["workspace"];

/**
 * The most each agent may ever use. Sub-agents mirror the frozen executor
 * allow-lists in lib/orchestrator/executors (researcher reads, drafter
 * drafts, actor acts …), widened only to the chat tools of the same nature.
 */
export const AGENT_MAX_GROUPS: Readonly<Record<AgentKey, readonly ToolGroup[]>> = {
  lead: TOOL_GROUPS,
  researcher: ["workspace", "web", "data", "files"],
  planner: ["workspace", "calendar", "files"],
  drafter: ["workspace", "content", "media", "email", "files", "calendar"],
  analyst: ["workspace", "data", "web", "files", "code"],
  scheduler: ["workspace", "calendar", "automation"],
  // media: images for the social posts and site pages the Operator ships.
  // ship: the Operator takes code from a branch to a pull request (the lead
  // has every group). Never always-granted: it must be asked for.
  actor: ["workspace", "email", "calendar", "site", "social", "media", "automation", "ops", "connectors", "files", "code", "ship"],
};

export interface GrantInput {
  agentKey: AgentKey;
  /** Groups the user asked for. Empty / omitted = the agent's defaults. */
  requested?: readonly string[] | null;
  /** The grant of the run that handed this work off (delegation). */
  parentGrant?: readonly string[] | null;
}

export interface Grant {
  groups: ToolGroup[];
  /** Requested groups that were dropped (unknown, or beyond the agent / parent). */
  dropped: string[];
}

function ordered(groups: Iterable<ToolGroup>): ToolGroup[] {
  const set = new Set(groups);
  return TOOL_GROUPS.filter((g) => set.has(g));
}

/** Work out a task's grant. PURE; the only place grants are computed. */
export function computeGrant(input: GrantInput): Grant {
  const max = new Set<ToolGroup>(AGENT_MAX_GROUPS[input.agentKey]);
  const requested = (input.requested ?? []).filter((r) => typeof r === "string" && r.trim());
  const dropped: string[] = [];
  let groups: Set<ToolGroup>;
  if (requested.length === 0) {
    groups = new Set(max);
  } else {
    groups = new Set<ToolGroup>(ALWAYS_GRANTED);
    // The lead keeps its hand-off ability: a narrowed lead can still pass
    // work to a sub-agent, and the child inherits the narrowed grant.
    if (input.agentKey === "lead") groups.add("delegate");
    for (const r of requested) {
      if (isToolGroup(r) && max.has(r)) groups.add(r);
      else dropped.push(r);
    }
    for (const g of [...groups]) if (!max.has(g)) groups.delete(g);
  }
  if (input.parentGrant) {
    const parent = new Set(input.parentGrant);
    for (const g of [...groups]) {
      if (!parent.has(g)) {
        groups.delete(g);
        if (requested.includes(g)) dropped.push(g);
      }
    }
  }
  return { groups: ordered(groups), dropped: [...new Set(dropped)] };
}

/** A null grant means "no task grant" (legacy callers): everything the role allows. */
export function isGroupGranted(grant: readonly string[] | null | undefined, group: ToolGroup): boolean {
  if (!grant) return true;
  return grant.includes(group);
}

/** Which group a connector's tools fall in (connector.<key>.<tool>). */
export function connectorGroup(connectorKey: string): ToolGroup {
  switch (connectorKey) {
    case "gmail":
    case "resend":
    case "outlook": // Phase 11 (conncore)
      return "email";
    case "google-calendar":
    case "outlook-calendar": // Phase 11 (conncore)
      return "calendar";
    case "google-drive":
    case "notion":
      return "files";
    case "buffer":
      return "social";
    case "wordpress":
    case "webflow":
      return "site";
    case "dataforseo":
      return "web";
    case "hubspot": // Phase 11 (conncore): CRM sync is business operations
      return "ops";
    case "google-search-console":
    case "ga4":
    case "google-ads":
    case "meta-ads":
      return "data";
    default:
      return "connectors";
  }
}

/**
 * The automation action a mutating connector tool stands for, so the same
 * per-agent rules (lib/automation/policy.ts) decide whether it may run
 * without asking. Unknown writes map to a Tier-2 kind: they always ask.
 */
export function connectorAction(connectorKey: string, tool: string): string {
  const key = `${connectorKey}.${tool}`;
  switch (key) {
    case "buffer.create_post":
      return "post_owned_social";
    case "buffer.schedule_post":
      return "schedule_owned_content";
    case "buffer.delete_post":
      return "delete_social_post";
    case "wordpress.save_content":
    case "webflow.publish_site":
      return "publish_owned";
    case "resend.send_test_email":
      return "send_internal_note";
    // Phase 11 (conncore): email to anyone is external — Tier 2, always asks.
    case "gmail.send_email":
    case "gmail.reply_to_message":
    case "outlook.send_email":
    case "outlook.reply_to_message":
      return "send_outreach_email";
    // Phase 11 (conncore): a HubSpot pull writes your CRM records.
    case "hubspot.sync_from_hubspot":
      return "write_crm_record";
    default:
      return "connector_write";
  }
}

/** The composer's tool chips and the group each one grants. */
export const COMPOSER_TOOL_GROUPS = { web: "web", email: "email", code: "code" } as const satisfies Record<string, ToolGroup>;

export function agentDisplayName(agentKey: AgentKey): string {
  return agentKey === "lead" ? LEAD_AGENT.name : SUB_AGENTS[agentKey].name;
}
