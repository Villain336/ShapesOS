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
  /** Phase 18.3 (WS=trust): apps this workspace blocks for agents (Agent app access). */
  blocked?: readonly string[] | null;
}

/** Phase 18.3: why a blocked app's chip is off in the composer and agent picker. */
export const BLOCKED_FOR_AGENTS_REASON = "Blocked for agents in this workspace (Settings → Privacy and security → Agent app access).";

export const CODE_UNAVAILABLE_DEFAULT = "No code sandbox is available on this server.";

/** The groups that can't be used right now, each with the reason. PURE. */
export function unavailableGroups(availability?: GroupAvailability | null): ReadonlyMap<ToolGroup, string> {
  const out = new Map<ToolGroup, string>();
  const code = availability?.code;
  if (!code) out.set("code", CODE_UNAVAILABLE_DEFAULT);
  else if (!code.ok) out.set("code", code.reason || CODE_UNAVAILABLE_DEFAULT);
  for (const g of blockableGroups(availability?.blocked)) out.set(g, BLOCKED_FOR_AGENTS_REASON);
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

/**
 * Phase 16 (deleg): groups a SUB-AGENT may have only when they are asked for
 * by name — never part of its defaults. "delegate" lets a sub-agent hand
 * work one level further down (depth 2); it is OFF unless the plan (or the
 * user) explicitly grants it, and still never wider than the parent's grant.
 */
export const SUB_AGENT_OPT_IN_GROUPS: readonly ToolGroup[] = ["delegate"];

export interface GrantInput {
  agentKey: AgentKey;
  /** Groups the user asked for. Empty / omitted = the agent's defaults. */
  requested?: readonly string[] | null;
  /** The grant of the run that handed this work off (delegation). */
  parentGrant?: readonly string[] | null;
  /**
   * Phase 18.3 (WS=trust): agent app permissions — the workspace's blocked
   * tool groups (WorkspaceSettings.agentBlockedGroups, lib/agents/
   * app-permissions.ts). Removed from every grant, whatever was requested or
   * inherited. Never-blockable groups (ALWAYS_GRANTED) stay. Empty / omitted =
   * today's behaviour.
   */
  blockedGroups?: readonly string[] | null;
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
    // Phase 16: a sub-agent's opt-in groups count only when asked for by name.
    const optIn = new Set<ToolGroup>(input.agentKey === "lead" ? [] : SUB_AGENT_OPT_IN_GROUPS);
    for (const r of requested) {
      if (isToolGroup(r) && (max.has(r) || optIn.has(r))) groups.add(r);
      else dropped.push(r);
    }
    for (const g of [...groups]) if (!max.has(g) && !(optIn.has(g) && requested.includes(g))) groups.delete(g);
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
  // Phase 18.3: the workspace's app permissions narrow every grant last, so
  // nothing above (a request, the agent's defaults, a parent) can re-add a
  // blocked app. A grant only ever narrows here.
  for (const g of blockableGroups(input.blockedGroups)) {
    if (groups.delete(g) && requested.includes(g)) dropped.push(g);
  }
  return { groups: ordered(groups), dropped: [...new Set(dropped)] };
}

/**
 * Phase 18.3 (WS=trust): groups an admin may block for agents ("Allow … to
 * access Mail?"). Everything except ALWAYS_GRANTED — an agent that can't read
 * its own workspace can't do anything.
 */
export const BLOCKABLE_GROUPS: readonly ToolGroup[] = TOOL_GROUPS.filter((g) => !ALWAYS_GRANTED.includes(g));

/** The valid, blockable groups in a stored block list (unknown names ignored). PURE. */
export function blockableGroups(blocked: readonly string[] | null | undefined): ToolGroup[] {
  if (!blocked?.length) return [];
  const set = new Set(blocked);
  return BLOCKABLE_GROUPS.filter((g) => set.has(g));
}

/** Is this group blocked for agents by the workspace's app permissions? PURE. */
export function isGroupBlocked(blocked: readonly string[] | null | undefined, group: ToolGroup): boolean {
  return blockableGroups(blocked).includes(group);
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
    case "shopify": // Phase 11 (bizsync): commerce + accounting sync is business operations
    case "quickbooks":
    case "xero":
    case "gusto": // Phase 14 (connectors): payroll is business operations
      return "ops";
    // Phase 11 (devtools): issue trackers are project operations ("code" is
    // the sandbox runner and is unavailable without one).
    case "linear":
    case "jira":
      return "ops";
    case "airtable": // Phase 11 (devtools): bases are working documents (like Notion databases)
      return "files";
    case "supabase": // Phase 11 (devtools): read-only SQL is analysis
      return "data";
    case "netlify": // Phase 11 (devtools): hosting for your own sites
      return "site";
    case "google-search-console":
    case "ga4":
    case "google-ads":
    case "meta-ads":
      return "data";
    // Phase 15.4 (zernio): it acts (ads, budgets) as well as reads, so it is
    // a connected app (lead + the Operator), not an analytics source.
    case "zernio":
      return "connectors";
    default:
      return "connectors";
  }
}

/**
 * Phase 14 (approvals): connectors whose writes move money or the books
 * (accounting, payroll). A write on one of them without its own mapping
 * below falls to "money_connector_write" — a Tier-3 kind that can never be
 * auto-approved — instead of the per-connector write_<key> switch.
 */
export const MONEY_CONNECTOR_KEYS: ReadonlySet<string> = new Set(["quickbooks", "xero", "gusto"]);

/**
 * The automation action a mutating connector tool stands for, so the same
 * per-agent rules (lib/automation/policy.ts) decide whether it may run
 * without asking. Phase 14: an unmapped write is "write_<key>" (one switch
 * per connector, e.g. write_slack — Tier 2: asks unless a rule says auto);
 * on a money connector it is "money_connector_write" (Tier 3, always asks).
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
    // Phase 21B (drive): removing a Drive folder for good is irreversible — the
    // key carries "delete", so it is Tier 3 (never auto). The other Drive writes
    // fall to write_google_drive (Tier 2, asks unless a rule says Auto-run).
    case "google-drive.delete_folder":
      return "delete_drive_folder";
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
    // Phase 11 (devtools): issue writes are project records — Tier 2, always asks.
    case "linear.create_issue":
    case "linear.update_issue":
    case "linear.add_comment":
    case "jira.create_issue":
    case "jira.transition_issue":
    case "jira.add_comment":
      return "write_project_record";
    // Phase 11 (devtools): Airtable record writes — Tier 2 (Phase 14: the
    // per-connector write_airtable switch).
    case "airtable.create_records":
    case "airtable.update_records":
      return "write_airtable";
    // Phase 11 (devtools): deploying your own site, like webflow.publish_site.
    case "netlify.trigger_deploy":
      return "publish_owned";
    // Phase 11 (bizsync): a store pull writes products, stock, orders and
    // contacts; pushing stock changes a public store — both Tier 2, ask.
    case "shopify.sync_from_shopify":
      return "import_commerce_data";
    case "shopify.push_inventory":
      return "update_store_inventory";
    // Phase 11 (bizsync): accounting — contacts are CRM writes (Tier 2);
    // posting the books is Tier 3 (never automated, always asks).
    case "quickbooks.import_contacts":
    case "xero.import_contacts":
      return "write_crm_record";
    case "quickbooks.post_to_quickbooks":
    case "xero.post_to_xero":
      return "post_to_accounting";
    // Phase 14 (connectors): Gusto. Sending a pay run is money — Tier 3
    // (send_payroll_to_provider is in TIER3_EXACT_KINDS: never automated,
    // always asks). Saving suggested employee matches is a Tier-2 write.
    case "gusto.send_payroll":
      return "send_payroll_to_provider";
    case "gusto.sync_employees":
      return "write_gusto";
    // Phase 15.4 (zernio): ads are money. Creating an ad is buy_media and
    // resuming a campaign restarts spend — both Tier 3, never automated. A
    // budget change is update_campaign_budget (Tier 3) unless the adapter's
    // live read proves it lowers spend (ZernioAdapter.resolveAction →
    // lower_campaign_budget, Tier 2). Pausing stops delivery (Tier 2); lead
    // forms and audiences are Tier 2 writes. Any other Zernio write falls to
    // money_connector_write (Tier 3) — fail closed.
    case "zernio.ads_create":
      return "buy_media";
    case "zernio.ads_resume":
      return "resume_ad_campaign";
    case "zernio.ads_update_budget":
      return "update_campaign_budget";
    case "zernio.ads_pause":
      return "pause_ad_campaign";
    case "zernio.ads_create_lead_form":
      return "write_ad_lead_form";
    case "zernio.ads_create_audience":
      return "write_ad_audience";
    default:
      if (connectorKey === "zernio") return "money_connector_write";
      return defaultConnectorWriteAction(connectorKey);
  }
}

/** Phase 14: "google-calendar" → "write_google_calendar"; money connectors → money_connector_write. */
export function defaultConnectorWriteAction(connectorKey: string): string {
  if (MONEY_CONNECTOR_KEYS.has(connectorKey)) return "money_connector_write";
  const slug = connectorKey.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  return slug ? `write_${slug}` : "connector_write";
}

/** The composer's tool chips and the group each one grants. */
export const COMPOSER_TOOL_GROUPS = { web: "web", email: "email", code: "code" } as const satisfies Record<string, ToolGroup>;

export function agentDisplayName(agentKey: AgentKey): string {
  return agentKey === "lead" ? LEAD_AGENT.name : SUB_AGENTS[agentKey].name;
}
