// Marketr — MCP server scope registry (Phase C, W5).
//
// Scopes are per-tool fixed constants ("tools:<name>"). No wildcards, no
// prefix matching, no "*". A key/token holds exactly the tools it was granted.

/** Every v1 MCP tool. The scope for a tool is `tools:<name>`. */
export const MCP_TOOL_NAMES = [
  "list_projects",
  "get_rank_report",
  "run_seo_audit",
  "get_keyword_ideas",
  "draft_content_brief",
  "get_site_health",
  "list_scheduled_skills",
  "get_usage_summary",
  "analyze_serp",
  "research_keywords",
  /* INTEGRATION:activepieces */
  "automation_trigger_flow",
  "automation_flow_status",
  /* END */
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function scopeForTool(tool: string): string {
  return `tools:${tool}`;
}

/** True only for exact, known tool scopes — never prefix/wildcard matching. */
export function isKnownScope(scope: string): boolean {
  if (!scope.startsWith("tools:")) return false;
  const name = scope.slice("tools:".length);
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Credit passthrough per tool (credit table v1, 1 credit = $0.01).
 * The metering call uses action "mcp_tool_call"; this documents the
 * passthrough credits carried in evidenceRef ("mcp:<tool>:<credits>").
 * Read-only local-data tools cost 0; vendor-backed tools cost their
 * underlying action's credits.
 */
export const TOOL_CREDIT_PASSTHROUGH: Record<McpToolName, { action: string; credits: number }> = {
  list_projects: { action: "project_list", credits: 0 },
  get_rank_report: { action: "rank_check", credits: 1 },
  run_seo_audit: { action: "site_audit", credits: 30 },
  get_keyword_ideas: { action: "keyword_ideas", credits: 50 },
  draft_content_brief: { action: "content_brief", credits: 5 },
  get_site_health: { action: "rank_check", credits: 1 },
  list_scheduled_skills: { action: "skill_list", credits: 0 },
  get_usage_summary: { action: "usage_summary", credits: 0 },
  analyze_serp: { action: "serp_analysis", credits: 1 },
  research_keywords: { action: "keyword_research", credits: 40 },
  /* INTEGRATION:activepieces */
  automation_trigger_flow: { action: "automation_flow_trigger", credits: 0 },
  automation_flow_status: { action: "automation_flow_status", credits: 0 },
  /* END */
};

/** Human-readable scope labels for the consent screen and key UI. */
export const SCOPE_LABELS: Record<McpToolName, { title: string; description: string }> = {
  list_projects: {
    title: "List projects",
    description: "See project names, domains, and locales in this workspace.",
  },
  get_rank_report: {
    title: "Rank reports",
    description: "Read keyword ranking snapshots for a project (1 credit per call).",
  },
  run_seo_audit: {
    title: "SEO audits",
    description: "Run an on-page SEO audit for a project (30 credits per call).",
  },
  get_keyword_ideas: {
    title: "Keyword ideas",
    description: "Generate keyword ideas for a seed term (50 credits per call).",
  },
  draft_content_brief: {
    title: "Content briefs",
    description: "Draft a content brief for a keyword (5 credits per call).",
  },
  get_site_health: {
    title: "Site health",
    description: "Read connector health and recent audit status (1 credit per call).",
  },
  list_scheduled_skills: {
    title: "Scheduled skills",
    description: "List automation schedules and their status (read-only).",
  },
  get_usage_summary: {
    title: "Usage summary",
    description: "Read this workspace's credit usage summary (read-only).",
  },
  analyze_serp: {
    title: "SERP analysis",
    description: "Analyze the live search results page for a keyword — top results, SERP features, and a deterministic breakdown (1 credit per call).",
  },
  research_keywords: {
    title: "Keyword research",
    description: "Full keyword research task: seed metrics plus a clustered ideas report (40 credits per call).",
  },
  /* INTEGRATION:activepieces */
  automation_trigger_flow: {
    title: "Automation flows",
    description: "Trigger a published Activepieces webhook flow on the workspace's automation engine (free; requires the engine to be connected).",
  },
  automation_flow_status: {
    title: "Flow run status",
    description: "Read the status of an Activepieces flow run (read-only, free).",
  },
  /* END */
};
