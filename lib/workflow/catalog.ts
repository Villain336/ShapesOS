// Marketr — automation canvas: node catalog (redesign §2).
//
// Single source of truth for every node kind/type the canvas supports.
// Used by the execution engine, the /nodes validation, and the client
// palette / config inspector.

export type WorkflowNodeKind = "trigger" | "action" | "approval" | "logic";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "textarea" | "select" | "checkbox";
  options?: string[];
  placeholder?: string;
  hint?: string;
  /** When true the engine requires a non-empty value at run time. */
  required?: boolean;
}

export interface NodeTypeDef {
  type: string;
  label: string;
  description: string;
  /** Phosphor icon name rendered client-side. */
  icon: string;
  defaultLabel: string;
  defaultConfig: Record<string, unknown>;
  fields: ConfigField[];
}

export const NODE_CATALOG: Record<WorkflowNodeKind, NodeTypeDef[]> = {
  trigger: [
    {
      type: "manual",
      label: "Manual",
      description: "Run by hand from the canvas (\"Run now\").",
      icon: "Play",
      defaultLabel: "Manual trigger",
      defaultConfig: {},
      fields: [],
    },
    {
      type: "schedule",
      label: "Schedule",
      description: "Fire on a cron schedule via the workflows cron sweep.",
      icon: "Clock",
      defaultLabel: "Schedule",
      defaultConfig: { cron: "0 9 * * *" },
      fields: [
        {
          key: "cron",
          label: "Cron (5-field)",
          type: "text",
          placeholder: "0 9 * * *",
          hint: "Minute hour day month weekday. Checked every minute by /api/cron/workflows.",
          required: true,
        },
      ],
    },
    {
      type: "rank_drop",
      label: "Keyword rank drop",
      description: "Fire when a tracked keyword drops by a threshold.",
      icon: "TrendDown",
      defaultLabel: "Rank drop",
      defaultConfig: { dropThreshold: 10, keywordId: "" },
      fields: [
        { key: "dropThreshold", label: "Drop threshold (positions)", type: "number", placeholder: "10", required: true },
        { key: "keywordId", label: "Keyword id (blank = any tracked keyword)", type: "text" },
      ],
    },
    {
      type: "competitor_published",
      label: "Competitor published",
      description: "Fire when a monitored competitor publishes new content.",
      icon: "Target",
      defaultLabel: "Competitor published",
      defaultConfig: { competitorId: "" },
      fields: [{ key: "competitorId", label: "Competitor id (blank = any monitored)", type: "text" }],
    },
    {
      type: "decay_detected",
      label: "Content decay detected",
      description: "Fire when the decay sweep flags new decaying pages.",
      icon: "Leaf",
      defaultLabel: "Decay detected",
      defaultConfig: {},
      fields: [],
    },
    {
      type: "webhook",
      label: "Webhook",
      description: "Fire on an inbound webhook call (v1: fired manually via run API).",
      icon: "WebhooksLogo",
      defaultLabel: "Webhook",
      defaultConfig: { secret: "" },
      fields: [{ key: "secret", label: "Shared secret", type: "text", hint: "v1: informational only." }],
    },
  ],
  action: [
    {
      type: "generate_draft",
      label: "Generate content draft",
      description: "Run the content engine (M4) and enqueue a pending autopilot item.",
      icon: "Lightning",
      defaultLabel: "Generate draft",
      defaultConfig: { topic: "", brief: "" },
      fields: [
        { key: "topic", label: "Topic / keyword", type: "text", placeholder: "best crm for agencies", required: true },
        { key: "brief", label: "Brief (optional)", type: "textarea", placeholder: "Angle, audience, key points…" },
      ],
    },
    {
      type: "run_audit",
      label: "Run SEO audit",
      description: "Run a site audit and expose {auditId, totalIssues, errorIssues} to later nodes.",
      icon: "Scan",
      defaultLabel: "Run audit",
      defaultConfig: { siteId: "" },
      fields: [
        {
          key: "siteId",
          label: "Site id (blank = project's first site)",
          type: "text",
          hint: "Uses mock findings when the site has no live provider.",
        },
      ],
    },
    {
      type: "apply_internal_links",
      label: "Apply internal-link suggestions",
      description: "Refresh the project's internal-link suggestions (M16 sync path).",
      icon: "LinkSimple",
      defaultLabel: "Apply internal links",
      defaultConfig: {},
      fields: [],
    },
    {
      type: "send_alert",
      label: "Send alert",
      description: "Emit an alert through the alert hub (deduped per run + node).",
      icon: "Bell",
      defaultLabel: "Send alert",
      defaultConfig: { title: "", body: "", severity: "info", trigger: "workflow" },
      fields: [
        { key: "title", label: "Title", type: "text", required: true },
        { key: "body", label: "Body", type: "textarea" },
        { key: "severity", label: "Severity", type: "select", options: ["info", "warn", "critical"] },
        { key: "trigger", label: "Trigger key", type: "text", placeholder: "workflow" },
      ],
    },
    {
      type: "generate_report",
      label: "Generate report",
      description: "Render a branded PDF report from a report template.",
      icon: "ChartBar",
      defaultLabel: "Generate report",
      defaultConfig: { templateId: "" },
      fields: [
        { key: "templateId", label: "Report template id", type: "text", required: true },
      ],
    },
    {
      type: "publish_approved",
      label: "Publish approved item",
      description: "Publish an already-approved autopilot item (blank = the item approved at the last gate).",
      icon: "Rocket",
      defaultLabel: "Publish approved",
      defaultConfig: { itemId: "" },
      fields: [
        {
          key: "itemId",
          label: "Autopilot item id (blank = last gate approval)",
          type: "text",
          hint: "Fail-closed: the item must be in approved status.",
        },
      ],
    },
  ],
  approval: [
    {
      type: "approval_gate",
      label: "Approval gate",
      description: "Pause the run and push a pending item into the existing approval queue. Resumes on approve/reject.",
      icon: "ShieldCheck",
      defaultLabel: "Approval gate",
      defaultConfig: { message: "" },
      fields: [
        {
          key: "message",
          label: "Message for the reviewer",
          type: "textarea",
          placeholder: "What is being proposed and why…",
        },
      ],
    },
  ],
  logic: [
    {
      type: "condition",
      label: "Condition",
      description: "Branch on run context. Connect edges labeled \"true\" / \"false\".",
      icon: "GitFork",
      defaultLabel: "Condition",
      defaultConfig: { field: "audit.errorIssues", operator: "gt", value: "0" },
      fields: [
        {
          key: "field",
          label: "Context field (dot path)",
          type: "text",
          placeholder: "audit.errorIssues",
          hint: "Dot path into run context, e.g. audit.errorIssues or draft.wordCount.",
          required: true,
        },
        {
          key: "operator",
          label: "Operator",
          type: "select",
          options: ["eq", "neq", "gt", "gte", "lt", "lte", "contains"],
        },
        { key: "value", label: "Compare value", type: "text", required: true },
      ],
    },
    {
      type: "delay",
      label: "Delay",
      description: "Pause the run inline. v1 cap: 300s (longer delays are rejected).",
      icon: "Timer",
      defaultLabel: "Delay",
      defaultConfig: { seconds: 60 },
      fields: [
        {
          key: "seconds",
          label: "Seconds (max 300)",
          type: "number",
          placeholder: "60",
          required: true,
        },
      ],
    },
  ],
};

export const NODE_KINDS = Object.keys(NODE_CATALOG) as WorkflowNodeKind[];

export function isValidNodeKind(kind: string): kind is WorkflowNodeKind {
  return (NODE_KINDS as string[]).includes(kind);
}

export function nodeTypeDef(kind: string, type: string): NodeTypeDef | null {
  if (!isValidNodeKind(kind)) return null;
  return NODE_CATALOG[kind].find((d) => d.type === type) ?? null;
}

/** Edge labels the engine understands on condition branches. */
export const CONDITION_LABELS = ["true", "false"] as const;

/** Trigger types that can start a run by themselves. */
export const EVENT_TRIGGER_TYPES = ["rank_drop", "competitor_published", "decay_detected", "webhook"] as const;
