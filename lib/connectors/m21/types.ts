// Marketr — M21 connectors, uniform interface (spec §7, §11).
//
// Every data source (28 built-in native adapters + workspace-custom MCP
// servers) implements ConnectorAdapter so the agent loop, skill-declared
// tool gating, and project data-source bindings all go through one
// interface. Credentials are decrypted server-side only (lib/vault) and
// injected at invoke() time — the agent never sees them.

/** One tool a connector exposes to the agent loop. */
export interface ConnectorToolDef {
  name: string;
  description: string;
  /** true when the tool writes/mutates/publishes something externally. */
  mutating: boolean;
  /**
   * Phase 14 (approvals): the tool may destroy data (MCP destructiveHint:
   * true). A destructive tool never runs without asking, whatever a rule says.
   */
  destructive?: boolean;
  argsSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/** A decrypted credential handed to an adapter at invoke() time. */
export interface DecryptedCredential {
  kind: "oauth2" | "api_key";
  /**
   * oauth2: { access_token, refresh_token?, token_type?, expires_at?,
   *           client_id?, client_secret?, scope?, ...provider extras }
   * api_key: { apiKey, baseUrl?, ... }
   */
  payload: Record<string, unknown>;
}

/** Per-call context (no secrets). */
export interface InvokeContext {
  workspaceId: string;
  projectId?: string;
  userId: string;
  /** ProjectDataSource.projectConfig, e.g. { property: "sc-domain:example.com" }. */
  projectConfig?: Record<string, unknown>;
  /**
   * Phase 4b: silent token refresh for live adapters. Called at most once
   * per request when the provider answers 401; persists the refreshed token
   * through the vault (lib/vault/refresh.ts) and returns the new credential,
   * or null when the connection needs re-auth. Never carries a secret itself.
   */
  refreshCredential?: () => Promise<DecryptedCredential | null>;
}

/** Uniform result shape every adapter returns from invoke(). */
export interface InvokeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** true when the data came from the labeled mock path. */
  mock?: boolean;
  /**
   * Closed error code for live failures (lib/connectors/m21/live/http.ts
   * ConnectorErrorCode). Never carries provider text or secrets.
   */
  errorCode?: string;
}

export interface ConnectorAdapter {
  readonly key: string;
  readonly displayName: string;
  readonly authType: "oauth2" | "api_key" | "none";
  /** JSON Schema (object) describing adapter-specific config fields. */
  readonly configSchema: Record<string, unknown>;
  listTools(): ConnectorToolDef[];
  invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult>;
  /**
   * Phase 4b: cheap live liveness call (e.g. list one site/account) used by
   * the manual connector health check. Only live-wired adapters define it.
   */
  healthCheck?(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult>;
  /**
   * Phase 15.4 (zernio): refine the automation action of a mutating call from
   * SERVER-SIDE state (e.g. a budget change is "update_campaign_budget" —
   * Tier 3 — unless a live read proves it lowers spend). Returns null to keep
   * the static connectorAction(); must fail safe (any doubt → null / the
   * stricter action). Never trusts the model's description of the call.
   */
  resolveAction?(tool: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<string | null>;
  /**
   * Phase 15.4 (zernio): a dry run before a mutating call is PROPOSED (e.g. an
   * ad create's validateOnly). ok:false → the call is refused and never
   * proposed; ok:true → its summary is shown with the proposal. null = no dry
   * run for this tool.
   */
  preflight?(tool: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<InvokeResult | null>;
}

/** Tool argument helper: string property. */
export function strProp(description: string): { type: string; description: string } {
  return { type: "string", description };
}

export function numProp(description: string): { type: string; description: string } {
  return { type: "number", description };
}

export function boolProp(description: string): { type: string; description: string } {
  return { type: "boolean", description };
}

/** Shared mock-result envelope helpers. */
export function mockOk(data: unknown): InvokeResult {
  return { ok: true, data, mock: true };
}

export function liveOk(data: unknown): InvokeResult {
  return { ok: true, data, mock: false };
}

export function fail(error: string): InvokeResult {
  return { ok: false, error };
}
