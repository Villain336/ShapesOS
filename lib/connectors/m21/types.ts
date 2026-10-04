// Marketr — M21 connectors, uniform interface (spec §7, §11).
//
// Every data source (22 built-in native adapters + workspace-custom MCP
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
