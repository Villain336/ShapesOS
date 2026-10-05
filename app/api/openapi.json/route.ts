// ShapesOS — OpenAPI 3.1 document for the public API (Phase 4a).
// GET /api/openapi.json → the spec built by lib/api/openapi.ts.
// Public, read-only: it describes the API surface (paths, schemas, scopes,
// webhook payloads) and carries no workspace data or secrets.
// The server URL is the configured APP_URL / NEXTAUTH_URL / AUTH_URL, never
// the request's Host header (the response is cacheable), else relative "/".

import { buildOpenApiSpec } from "@/lib/api/openapi";
import { appBaseUrl } from "@/lib/workspace/invite-mail";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(buildOpenApiSpec({ serverUrl: appBaseUrl(process.env, null) ?? "/" }), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
