// Marketr — Canva Connect API port (milestone 22).
//
// API surface (verified against Canva Connect API docs, Sept 2026):
//   Base:        https://api.canva.com/rest/v1
//   OAuth:       authorization-code flow; tokens expire after 4h, refreshable.
//   Scopes:      design:meta:read (list designs), design:content:read (export),
//                design:content:write (autofill), asset:read/write,
//                brandtemplate:meta:read, brandtemplate:content:read,
//                brandtemplate:content:write, folder:read, profile:read.
// Endpoints used: GET /designs, GET /designs/{id}, GET /brand-templates,
//   POST /autofills, POST /exports, GET /exports/{id}, GET /folders, GET /users/me.
// Caveats (documented, not resolved here):
//   1. Public Canva integrations require Canva's review/approval before they
//      work for end users beyond the developer's own account.
//   2. Brand-template autofill is Enterprise-oriented: the `brandtemplate:*`
//      scopes and /autofills require the connected Canva account to have brand
//      templates available (Canva Pro/Teams/Enterprise depending on plan).
//   3. Exact export formats/sizes are plan-limited; the production wrapper
//      passes formats through and surfaces provider errors.

export const CANVA_API_BASE = "https://api.canva.com/rest/v1";
export const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
export const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";

export interface CanvaDesign {
  id: string;
  title: string;
  designType: string;
  thumbnailUrl: string | null;
  editUrl: string;
  updatedAt: string;
}

export interface CanvaFolder {
  id: string;
  name: string;
}

export interface CanvaBrandTemplate {
  id: string;
  title: string;
  designType: string;
  thumbnailUrl: string | null;
  dataset: Array<{ name: string; type: string }> | null; // autofill field schema, when readable
}

export interface CanvaExport {
  id: string;
  status: "in_progress" | "success" | "failed";
  downloadUrls: string[];
}

export interface CanvaOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

/** Injectable port — production OAuth wrapper or MockCanvaPort for tests. */
export interface CanvaPort {
  /** Build the OAuth authorization URL for the connect flow. */
  authorizeUrl(params: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    codeChallenge?: string;
  }): string;
  /** Exchange an authorization code for tokens. */
  exchangeCode(params: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
  }): Promise<CanvaOAuthTokens>;
  /** Refresh an expired access token. */
  refreshToken(params: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<CanvaOAuthTokens>;
  /** Revoke the current access token (best-effort). */
  revokeToken(params: { clientId: string; accessToken: string }): Promise<void>;
  /** The authenticated user's profile (validates the token). */
  getProfile(accessToken: string): Promise<{ id: string; displayName: string }>;
  /** List designs, newest first. query filters by title. */
  listDesigns(
    accessToken: string,
    opts?: { query?: string; continuation?: string; limit?: number; folderId?: string },
  ): Promise<{ designs: CanvaDesign[]; continuation: string | null }>;
  /** Single design metadata. */
  getDesign(accessToken: string, designId: string): Promise<CanvaDesign>;
  listFolders(accessToken: string): Promise<CanvaFolder[]>;
  /** Brand templates visible to the connected account (plan-limited). */
  listBrandTemplates(accessToken: string): Promise<CanvaBrandTemplate[]>;
  /** Autofill a brand template with data → returns the new design id. */
  autofill(
    accessToken: string,
    brandTemplateId: string,
    data: Record<string, { type: "text" | "image"; text?: string; assetId?: string }>,
  ): Promise<{ designId: string }>;
  /** Start an export job for a design. format: png | jpg | pdf | mp4. */
  startExport(
    accessToken: string,
    designId: string,
    format: "png" | "jpg" | "pdf" | "mp4",
  ): Promise<{ exportId: string }>;
  /** Poll an export job. */
  getExport(accessToken: string, exportId: string): Promise<CanvaExport>;
}

// ---------------------------------------------------------------------------
// Production wrapper — real HTTPS calls. Used only when real credentials are
// configured. All verification in this milestone runs against MockCanvaPort.
// ---------------------------------------------------------------------------

async function canvaFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${CANVA_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body.message === "string" ? body.message : `Canva API error ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function toDesign(d: Record<string, unknown>): CanvaDesign {
  const thumbs = (d.thumbnail as Record<string, unknown> | undefined)?.url;
  return {
    id: String(d.id),
    title: String(d.title ?? "Untitled design"),
    designType: String(d.design_type ?? ""),
    thumbnailUrl: typeof thumbs === "string" ? thumbs : null,
    // Real shape: design.urls.edit_url (view-only URL) + the export API
    // downloads a copy. Narrow the optional nested object defensively.
    editUrl: String(
      (typeof d.urls === "object" && d.urls !== null
        ? (d.urls as Record<string, unknown>).edit_url
        : undefined) ?? `https://www.canva.com/design/${d.id}/edit`,
    ),
    updatedAt: String(d.updated_at ?? ""),
  };
}

export function createCanvaPort(): CanvaPort {
  return {
    authorizeUrl({ clientId, redirectUri, scopes, state, codeChallenge }) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
      });
      return `${CANVA_AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchangeCode({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
      const res = await fetch(CANVA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error("Canva token exchange failed.");
      return {
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token),
        expiresInSeconds: Number(body.expires_in ?? 14400),
        scopes: String(body.scope ?? "").split(" ").filter(Boolean),
      };
    },
    async refreshToken({ clientId, clientSecret, refreshToken }) {
      const res = await fetch(CANVA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error("Canva token refresh failed — reconnect the account.");
      return {
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token ?? refreshToken),
        expiresInSeconds: Number(body.expires_in ?? 14400),
        scopes: String(body.scope ?? "").split(" ").filter(Boolean),
      };
    },
    async revokeToken({ clientId, accessToken }) {
      // Best-effort: Canva exposes no documented revocation endpoint in the
      // Connect API; deleting locally + logging is the supported path.
      void clientId;
      void accessToken;
    },
    async getProfile(accessToken) {
      const body = (await canvaFetch(accessToken, "/users/me")) as Record<string, unknown>;
      const user = (body.user ?? body) as Record<string, unknown>;
      return { id: String(user.id ?? ""), displayName: String(user.display_name ?? "") };
    },
    async listDesigns(accessToken, opts = {}) {
      const q = new URLSearchParams();
      if (opts.query) q.set("query", opts.query);
      if (opts.continuation) q.set("continuation", opts.continuation);
      if (opts.limit) q.set("limit", String(opts.limit));
      if (opts.folderId) q.set("folder_id", opts.folderId);
      const body = (await canvaFetch(accessToken, `/designs?${q.toString()}`)) as Record<string, unknown>;
      const items = (body.items ?? []) as Record<string, unknown>[];
      return {
        designs: items.map(toDesign),
        continuation: typeof body.continuation === "string" ? body.continuation : null,
      };
    },
    async getDesign(accessToken, designId) {
      const body = (await canvaFetch(accessToken, `/designs/${designId}`)) as Record<string, unknown>;
      return toDesign(body);
    },
    async listFolders(accessToken) {
      const body = (await canvaFetch(accessToken, "/folders")) as Record<string, unknown>;
      const items = (body.items ?? []) as Record<string, unknown>[];
      return items.map((f) => ({ id: String(f.id), name: String(f.name ?? "Folder") }));
    },
    async listBrandTemplates(accessToken) {
      const body = (await canvaFetch(accessToken, "/brand-templates")) as Record<string, unknown>;
      const items = (body.items ?? []) as Record<string, unknown>[];
      return items.map((t) => ({
        id: String(t.id),
        title: String(t.title ?? "Brand template"),
        designType: String(t.design_type ?? ""),
        thumbnailUrl:
          typeof (t.thumbnail as Record<string, unknown> | undefined)?.url === "string"
            ? String((t.thumbnail as Record<string, unknown>).url)
            : null,
        dataset: Array.isArray(t.dataset)
          ? (t.dataset as Array<{ name: string; type: string }>)
          : null,
      }));
    },
    async autofill(accessToken, brandTemplateId, data) {
      const body = (await canvaFetch(accessToken, "/autofills", {
        method: "POST",
        body: JSON.stringify({ brand_template_id: brandTemplateId, data }),
      })) as Record<string, unknown>;
      const job = (body.job ?? {}) as Record<string, unknown>;
      return { designId: String(job.id ?? body.design_id ?? "") };
    },
    async startExport(accessToken, designId, format) {
      const body = (await canvaFetch(accessToken, "/exports", {
        method: "POST",
        body: JSON.stringify({ design_id: designId, format }),
      })) as Record<string, unknown>;
      const job = (body.job ?? {}) as Record<string, unknown>;
      return { exportId: String(job.id ?? "") };
    },
    async getExport(accessToken, exportId) {
      const body = (await canvaFetch(accessToken, `/exports/${exportId}`)) as Record<string, unknown>;
      const job = (body.job ?? {}) as Record<string, unknown>;
      const urls = (job.urls ?? []) as Array<{ url?: string }>;
      return {
        id: String(job.id ?? exportId),
        status: job.status === "success" ? "success" : job.status === "failed" ? "failed" : "in_progress",
        downloadUrls: urls.map((u) => String(u.url ?? "")).filter(Boolean),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock port — deterministic, zero network. All M22 verification runs against it.
// ---------------------------------------------------------------------------

export interface MockCanvaOptions {
  /** Simulate a plan where brand templates/autofill are unavailable. */
  planLimited?: boolean;
  /** Make the next N calls fail with the given error. */
  failNext?: number;
  failMessage?: string;
}

export function createMockCanvaPort(opts: MockCanvaOptions = {}): CanvaPort & {
  calls: Array<{ method: string; args: unknown }>;
  __options: MockCanvaOptions;
} {
  const calls: Array<{ method: string; args: unknown }> = [];
  const maybeFail = (method: string) => {
    if ((opts.failNext ?? 0) > 0) {
      opts.failNext = (opts.failNext ?? 0) - 1;
      throw new Error(opts.failMessage ?? `Mock Canva failure in ${method}`);
    }
  };

  const mockDesigns: CanvaDesign[] = [
    {
      id: "DAGmock001",
      title: "Launch announcement",
      designType: "instagram-post",
      thumbnailUrl: "https://mock.canva.example/thumb/DAGmock001.png",
      editUrl: "https://www.canva.com/design/DAGmock001/edit",
      updatedAt: "2026-09-20T10:00:00Z",
    },
    {
      id: "DAGmock002",
      title: "Q3 promo banner",
      designType: "presentation",
      thumbnailUrl: "https://mock.canva.example/thumb/DAGmock002.png",
      editUrl: "https://www.canva.com/design/DAGmock002/edit",
      updatedAt: "2026-09-19T10:00:00Z",
    },
  ];
  const mockTemplates: CanvaBrandTemplate[] = [
    {
      id: "TPLmock001",
      title: "Brand promo template",
      designType: "instagram-post",
      thumbnailUrl: "https://mock.canva.example/thumb/TPLmock001.png",
      dataset: [
        { name: "headline", type: "text" },
        { name: "subheadline", type: "text" },
        { name: "hero_image", type: "image" },
      ],
    },
  ];
  const exports: Record<string, CanvaExport> = {};

  const port: CanvaPort = {
    authorizeUrl: ({ clientId, redirectUri, scopes, state }) => {
      calls.push({ method: "authorizeUrl", args: { clientId, redirectUri, scopes, state } });
      return `${CANVA_AUTHORIZE_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes.join(" "))}&state=${state}`;
    },
    exchangeCode: async (params) => {
      calls.push({ method: "exchangeCode", args: params });
      maybeFail("exchangeCode");
      return {
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresInSeconds: 14400,
        scopes: ["design:meta:read", "design:content:read"],
      };
    },
    refreshToken: async (params) => {
      calls.push({ method: "refreshToken", args: params });
      maybeFail("refreshToken");
      return {
        accessToken: "mock-access-token-refreshed",
        refreshToken: "mock-refresh-token-2",
        expiresInSeconds: 14400,
        scopes: [],
      };
    },
    revokeToken: async (params) => {
      calls.push({ method: "revokeToken", args: params });
    },
    getProfile: async () => {
      calls.push({ method: "getProfile", args: {} });
      maybeFail("getProfile");
      return { id: "mock-user-1", displayName: "Mock User" };
    },
    listDesigns: async (_token, opts2 = {}) => {
      calls.push({ method: "listDesigns", args: opts2 });
      maybeFail("listDesigns");
      const q = (opts2.query ?? "").toLowerCase();
      const designs = q ? mockDesigns.filter((d) => d.title.toLowerCase().includes(q)) : mockDesigns;
      return { designs, continuation: null };
    },
    getDesign: async (_token, designId) => {
      calls.push({ method: "getDesign", args: { designId } });
      maybeFail("getDesign");
      const d = mockDesigns.find((x) => x.id === designId);
      if (!d) throw new Error("Design not found.");
      return d;
    },
    listFolders: async () => {
      calls.push({ method: "listFolders", args: {} });
      return [{ id: "mock-folder-1", name: "Mock folder" }];
    },
    listBrandTemplates: async () => {
      calls.push({ method: "listBrandTemplates", args: {} });
      maybeFail("listBrandTemplates");
      if (opts.planLimited) return [];
      return mockTemplates;
    },
    autofill: async (_token, brandTemplateId, data) => {
      calls.push({ method: "autofill", args: { brandTemplateId, data } });
      maybeFail("autofill");
      if (opts.planLimited) {
        throw new Error("Brand-template autofill is not available on this Canva plan.");
      }
      if (!mockTemplates.some((t) => t.id === brandTemplateId)) throw new Error("Brand template not found.");
      return { designId: "DAGmock-autofilled-1" };
    },
    startExport: async (_token, designId, format) => {
      calls.push({ method: "startExport", args: { designId, format } });
      maybeFail("startExport");
      const exportId = `EXP-${designId}-${format}`;
      exports[exportId] = {
        id: exportId,
        status: "in_progress",
        downloadUrls: [],
      };
      return { exportId };
    },
    getExport: async (_token, exportId) => {
      calls.push({ method: "getExport", args: { exportId } });
      const job = exports[exportId];
      if (!job) throw new Error("Export job not found.");
      // Mock: second poll onwards succeeds.
      if (job.status === "in_progress") {
        job.status = "success";
        job.downloadUrls = [`https://mock.canva.example/exports/${exportId}.png`];
      }
      return job;
    },
  };

  return { ...port, calls, __options: opts };
}

/** Scopes Marketr requests for the Canva Connect integration. */
export const CANVA_SCOPES = [
  "design:meta:read",
  "design:content:read",
  "design:content:write",
  "asset:read",
  "asset:write",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
  "brandtemplate:content:write",
  "folder:read",
  "profile:read",
];
