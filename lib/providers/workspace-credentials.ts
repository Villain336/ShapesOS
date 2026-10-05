// ShapesOS — Phase 15.1: the keys a WORKSPACE can bring (Settings → Providers).
//
// Pure, client-safe definitions (no secrets, no I/O): which workspace-held
// credentials exist, their form fields, and — for sidecars — which host env
// var each field stands in for. The vault stores them through
// lib/vault/workspace-credential.ts under `connectorKey` (one per
// workspace); the API is /api/settings/keys; the registry
// (lib/providers/key-sources.ts) points at these ids.
//   model:*     the workspace's own Anthropic / OpenAI key (BYOK, 0 credits)
//   sidecar:*   the workspace's own Postiz / Listmonk / … instance (required
//               on DEPLOYMENT_MODE=hosted; overrides env when self-hosted)
//   outreach:*  the workspace's own Smartlead / Instantly sending account

export type CredentialKind = "model" | "sidecar" | "outreach";

export type SidecarKey = "postiz" | "listmonk" | "plane" | "ghost" | "documenso" | "growthbook" | "umami" | "chatwoot";

export const SIDECAR_KEYS: readonly SidecarKey[] = ["postiz", "listmonk", "plane", "ghost", "documenso", "growthbook", "umami", "chatwoot"];

export interface CredentialField {
  name: string;
  label: string;
  /** Secret fields are write-only: never returned, never shown. */
  secret: boolean;
  /** "url" fields are SSRF-checked before they are saved. */
  type: "url" | "text";
  required: boolean;
  /** Sidecars: the host env var this field replaces for the workspace. */
  env?: string;
  placeholder?: string;
}

export interface WorkspaceCredentialDef {
  id: string;
  kind: CredentialKind;
  label: string;
  /** Vault connector key (one connection per workspace). */
  connectorKey: string;
  fields: CredentialField[];
  /** One sentence shown under the form. */
  help: string;
  /** Sidecars: env vars set to a fixed value when the workspace connects one. */
  fixedEnv?: Record<string, string>;
}

const secret = (name: string, label: string, env?: string): CredentialField => ({ name, label, secret: true, type: "text", required: true, env });
const url = (name: string, label: string, env: string, placeholder: string): CredentialField => ({
  name, label, secret: false, type: "url", required: true, env, placeholder,
});
const text = (name: string, label: string, env: string | undefined, required = true, placeholder?: string): CredentialField => ({
  name, label, secret: false, type: "text", required, env, placeholder,
});

const sidecar = (
  key: SidecarKey,
  label: string,
  fields: CredentialField[],
  help: string,
  fixedEnv?: Record<string, string>,
): WorkspaceCredentialDef => ({ id: `sidecar:${key}`, kind: "sidecar", label, connectorKey: `sidecar-${key}`, fields, help, fixedEnv });

export const WORKSPACE_CREDENTIALS: readonly WorkspaceCredentialDef[] = [
  {
    id: "model:anthropic",
    kind: "model",
    label: "Anthropic",
    connectorKey: "byok-anthropic",
    fields: [secret("apiKey", "API key")],
    help: "Agents and writing run on your key and use no AI credits. Checked with one free call before it is saved.",
  },
  {
    id: "model:openai",
    kind: "model",
    label: "OpenAI",
    connectorKey: "byok-openai",
    fields: [secret("apiKey", "API key")],
    help: "Text workloads run on your key and use no AI credits. Checked with one free call before it is saved.",
  },
  sidecar("postiz", "Postiz", [url("url", "Postiz URL", "POSTIZ_URL", "https://postiz.example.com"), secret("apiKey", "API key", "POSTIZ_API_KEY")],
    "Your own Postiz for social scheduling."),
  sidecar("listmonk", "Listmonk", [
    url("url", "Listmonk URL", "LISTMONK_URL", "https://lists.example.com"),
    text("user", "API user", "LISTMONK_USER"),
    secret("token", "API token", "LISTMONK_TOKEN"),
  ], "Your own Listmonk for newsletter lists and campaigns."),
  sidecar("plane", "Plane", [
    url("baseUrl", "Plane URL", "PLANE_BASE_URL", "https://plane.example.com"),
    secret("apiKey", "API key", "PLANE_API_KEY"),
    text("workspaceSlug", "Workspace slug", "PLANE_WORKSPACE_SLUG"),
  ], "Your own Plane for project issues."),
  sidecar("ghost", "Ghost", [url("url", "Ghost URL", "GHOST_URL", "https://blog.example.com"), secret("adminApiKey", "Admin API key", "GHOST_ADMIN_API_KEY")],
    "Your own Ghost for blog publishing."),
  sidecar("documenso", "Documenso", [url("url", "Documenso URL", "DOCUMENSO_URL", "https://sign.example.com"), secret("apiKey", "API key", "DOCUMENSO_API_KEY")],
    "Your own Documenso for e-signatures."),
  sidecar("growthbook", "GrowthBook", [
    url("apiHost", "GrowthBook API host", "GROWTHBOOK_API_HOST", "https://growthbook-api.example.com"),
    secret("apiKey", "Secret API key", "GROWTHBOOK_API_KEY"),
    text("clientKey", "SDK client key", "GROWTHBOOK_CLIENT_KEY", false),
  ], "Your own GrowthBook for feature flags and experiments."),
  sidecar("umami", "Umami", [
    url("url", "Umami URL", "UMAMI_URL", "https://analytics.example.com"),
    secret("apiKey", "API key", "UMAMI_API_KEY"),
    text("websiteId", "Website ID", "UMAMI_WEBSITE_ID", false),
    { name: "scriptUrl", label: "Script URL", secret: false, type: "url", required: false, env: "UMAMI_SCRIPT_URL", placeholder: "https://analytics.example.com/script.js" },
  ], "Your own Umami for cookieless analytics."),
  sidecar("chatwoot", "Chatwoot", [
    url("baseUrl", "Chatwoot URL", "CHATWOOT_BASE_URL", "https://chat.example.com"),
    text("websiteToken", "Website token", "CHATWOOT_WEBSITE_TOKEN"),
  ], "Your own Chatwoot for the live chat widget.", { CHATWOOT_WIDGET_ENABLED: "true" }),
  {
    id: "outreach:smartlead",
    kind: "outreach",
    label: "Smartlead",
    connectorKey: "outreach-smartlead",
    fields: [secret("apiKey", "API key"), text("relayCampaignIds", "Relay campaign IDs (one per step, comma-separated)", undefined)],
    help: "Cold email goes out from your Smartlead account and domains.",
  },
  {
    id: "outreach:instantly",
    kind: "outreach",
    label: "Instantly",
    connectorKey: "outreach-instantly",
    fields: [secret("apiKey", "API key"), text("relayCampaignIds", "Relay campaign IDs (one per step, comma-separated)", undefined)],
    help: "Cold email goes out from your Instantly account and domains.",
  },
];

export function credentialDef(id: string): WorkspaceCredentialDef | null {
  return WORKSPACE_CREDENTIALS.find((d) => d.id === id) ?? null;
}

export function sidecarDef(key: SidecarKey): WorkspaceCredentialDef {
  const d = credentialDef(`sidecar:${key}`);
  if (!d) throw new Error(`unknown sidecar ${key}`);
  return d;
}

/** Every env var a sidecar reads (its fields' env names + fixed ones). */
export function sidecarEnvVars(key: SidecarKey): string[] {
  const d = sidecarDef(key);
  return [...d.fields.map((f) => f.env).filter((e): e is string => Boolean(e)), ...Object.keys(d.fixedEnv ?? {})];
}

/**
 * Validate a submitted form (shape only — remote checks happen in the API).
 * Returns the cleaned payload or the first problem. Unknown fields are dropped.
 */
export function cleanCredentialValues(
  def: WorkspaceCredentialDef,
  values: Record<string, unknown>,
): { ok: true; payload: Record<string, string> } | { ok: false; error: string } {
  const payload: Record<string, string> = {};
  for (const f of def.fields) {
    const raw = values[f.name];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) {
      if (f.required) return { ok: false, error: `${f.label} is required.` };
      continue;
    }
    if (v.length > 4096) return { ok: false, error: `${f.label} is too long.` };
    payload[f.name] = f.type === "url" ? v.replace(/\/+$/, "") : v;
  }
  return { ok: true, payload };
}
