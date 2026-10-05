// ShapesOS — SCIM 2.0 HTTP plumbing (RFC 7644 §3.12 errors, §3.4.2 lists).

export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCHEMA_SPC = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export type ScimErrorType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue";

export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: ScimErrorType;
  constructor(status: number, detail: string, scimType?: ScimErrorType) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }
}

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, "cache-control": "no-store", ...headers },
  });
}

export function scimErrorResponse(status: number, detail: string, scimType?: ScimErrorType): Response {
  return scimJson(
    { schemas: [SCHEMA_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status,
    status === 401 ? { "www-authenticate": 'Bearer realm="ShapesOS SCIM"' } : {},
  );
}

/** Map anything a SCIM handler throws to an RFC 7644 error body. */
export function scimErrorFrom(err: unknown): Response {
  if (err instanceof ScimError) return scimErrorResponse(err.status, err.message, err.scimType);
  const code = (err as { code?: unknown })?.code;
  if (code === "P2002") return scimErrorResponse(409, "A resource with that value already exists.", "uniqueness");
  if (code === "P2025") return scimErrorResponse(404, "Resource not found.");
  console.error("[scim] unhandled error:", err);
  return scimErrorResponse(500, "Internal server error");
}

/** Read and JSON-parse a SCIM request body (bounded). */
export async function readScimBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 1_000_000) throw new ScimError(413, "Request body too large.");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ScimError(400, "Request body must be a JSON object.", "invalidSyntax");
  }
}

/** startIndex/count (1-based; RFC 7644 §3.4.2.4), count capped at MAX_PAGE. */
export const MAX_PAGE = 200;
export function pagination(url: URL): { startIndex: number; count: number } {
  const si = Number(url.searchParams.get("startIndex") ?? "1");
  const c = Number(url.searchParams.get("count") ?? "100");
  return {
    startIndex: Number.isInteger(si) && si >= 1 ? si : 1,
    count: Number.isInteger(c) && c >= 0 ? Math.min(c, MAX_PAGE) : 100,
  };
}

export function listResponse(resources: unknown[], total: number, startIndex: number): Record<string, unknown> {
  return {
    schemas: [SCHEMA_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/**
 * The tiny filter subset IdPs actually send (Okta, Entra ID, OneLogin):
 *   <attr> eq "<value>"   with attr from `allowed` (case-insensitive).
 * Anything else is an invalidFilter error rather than a silently
 * unfiltered (= every user) answer.
 */
export function parseEqFilter(filter: string | null, allowed: string[]): { attr: string; value: string } | null {
  if (filter === null || filter.trim() === "") return null;
  const m = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, "Only filters of the form `attribute eq \"value\"` are supported.", "invalidFilter");
  const attr = allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
  if (!attr) throw new ScimError(400, `Filtering on ${m[1]} is not supported.`, "invalidFilter");
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

/** SCIM booleans arrive as true/false or (Entra ID) "True"/"False". */
export function scimBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}
