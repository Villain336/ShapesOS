// ShapesOS — OpenAPI 3.1 document for the public API (Phase 4a, audit §7 item 13).
//
// "Public API" = what an API key / OAuth token (or a public capability
// token) can reach without a browser session:
//   POST /mcp                                   MCP over streamable HTTP (JSON-RPC 2.0)
//   POST /api/mcp/oauth/register                OAuth 2.1 dynamic client registration
//   GET  /api/mcp/oauth/authorize               OAuth 2.1 authorization (browser hop)
//   POST /api/mcp/oauth/token                   OAuth 2.1 code → access token
//   GET|POST /api/crm/public/forms/{token}      public lead-capture form
//   GET  /api/openapi.json                      this document
// plus the outbound `webhooks` (OpenAPI 3.1) ShapesOS POSTs to your endpoints.
//
// Schemas come from the zod schemas the code actually validates with
// (z.toJSONSchema, draft 2020-12 = OpenAPI 3.1's dialect): every MCP tool's
// input, the public form body, every webhook event payload. The JSON-RPC
// envelope and the OAuth bodies are small zod schemas declared here (the
// OAuth routes validate by hand; keep them in step).
// lib/api/__tests__/openapi.test.ts checks the structure and that every
// documented path/method exists as a route file.

import { z } from "zod";
import { listTools } from "@/lib/mcp/tools";
import { MCP_TOOL_NAMES, SCOPE_LABELS, TOOL_MIN_ROLE, scopeForTool } from "@/lib/mcp/scopes";
import { PublicSubmitSchema } from "@/lib/crm/public-form";
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/webhooks/events";
import {
  DEFAULT_TOLERANCE_SECONDS,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
} from "@/lib/webhooks/signing";

export const API_VERSION = "1.0.0";

type Json = Record<string, unknown>;

/** zod → JSON Schema (input side), without the per-schema $schema key. */
export function jsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

// ---------------------------------------------------------------------------
// Doc-side zod schemas (shapes the routes produce/accept)
// ---------------------------------------------------------------------------

const JsonRpcId = z.union([z.string(), z.number(), z.null()]);

const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.optional().describe("Omit for notifications (answered 202)"),
  method: z.enum(["initialize", "notifications/initialized", "tools/list", "tools/call"]),
  params: z.record(z.string(), z.unknown()).optional(),
});

const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId,
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

const ToolCallResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string().describe("JSON-encoded tool result") })),
  isError: z.boolean(),
});

const OAuthRegisterRequest = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().optional(),
  scope: z.string().optional().describe("Space-separated tools:<name> scopes"),
});

const OAuthRegisterResponse = z.object({
  client_id: z.string(),
  client_name: z.string().nullable(),
  redirect_uris: z.array(z.string()),
  scope: z.string(),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.literal("authorization_code")),
  response_types: z.array(z.literal("code")),
});

const OAuthTokenRequest = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  redirect_uri: z.string(),
  client_id: z.string(),
  code_verifier: z.string().optional().describe("PKCE verifier (required when a challenge was sent)"),
});

const OAuthTokenResponse = z.object({
  access_token: z.string().describe("mcpt_… bearer token"),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  scope: z.string(),
});

const OAuthError = z.object({ error: z.string() });
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });

const PublicFormConfig = z.object({
  form: z.object({ name: z.string(), pipeline: z.string().optional(), fields: z.unknown() }).passthrough(),
});
const PublicFormResult = z.object({ ok: z.literal(true), duplicate: z.boolean().optional() });

function webhookEnvelopeFor(type: WebhookEventType): Json {
  return {
    type: "object",
    required: ["id", "type", "apiVersion", "createdAt", "workspaceId", "data"],
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Event id (evt_…), identical across endpoints and redeliveries — dedupe on it" },
      type: { const: type },
      apiVersion: { const: WEBHOOK_API_VERSION },
      createdAt: { type: "string", format: "date-time" },
      workspaceId: { type: "string" },
      data: ref(webhookDataName(type)),
    },
  };
}

function webhookDataName(type: WebhookEventType): string {
  return `WebhookData_${type.replace(/[^a-z0-9]+/gi, "_")}`;
}

function toolSchemaName(tool: string): string {
  return `McpToolInput_${tool}`;
}

// ---------------------------------------------------------------------------

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: Json;
  servers: Json[];
  tags: Json[];
  paths: Record<string, Record<string, Json | Json[]>>;
  webhooks: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> };
}

export function buildOpenApiSpec(opts: { serverUrl?: string } = {}): OpenApiDocument {
  const schemas: Record<string, Json> = {
    JsonRpcRequest: jsonSchema(JsonRpcRequest),
    JsonRpcResponse: jsonSchema(JsonRpcResponse),
    McpToolCallResult: jsonSchema(ToolCallResult),
    OAuthRegisterRequest: jsonSchema(OAuthRegisterRequest),
    OAuthRegisterResponse: jsonSchema(OAuthRegisterResponse),
    OAuthTokenRequest: jsonSchema(OAuthTokenRequest),
    OAuthTokenResponse: jsonSchema(OAuthTokenResponse),
    OAuthError: jsonSchema(OAuthError),
    Error: jsonSchema(ErrorBody),
    PublicFormSubmission: jsonSchema(PublicSubmitSchema),
    PublicFormConfig: jsonSchema(PublicFormConfig),
    PublicFormResult: jsonSchema(PublicFormResult),
  };

  // MCP tool inputs, straight from the strict zod schemas tools/call enforces.
  const tools = listTools().filter((t) => (MCP_TOOL_NAMES as readonly string[]).includes(t.name));
  const toolCallVariants: Json[] = [];
  for (const tool of tools) {
    schemas[toolSchemaName(tool.name)] = { ...jsonSchema(tool.inputSchema), description: tool.description };
    toolCallVariants.push({
      type: "object",
      title: tool.name,
      required: ["jsonrpc", "id", "method", "params"],
      properties: {
        jsonrpc: { const: "2.0" },
        id: { type: ["string", "number"] },
        method: { const: "tools/call" },
        params: {
          type: "object",
          required: ["name", "arguments"],
          properties: { name: { const: tool.name }, arguments: ref(toolSchemaName(tool.name)) },
        },
      },
    });
  }
  schemas.McpToolsCallRequest = {
    description: "tools/call — one variant per tool; the key/token needs the tools:<name> scope",
    oneOf: toolCallVariants,
  };

  for (const type of WEBHOOK_EVENT_TYPES) {
    schemas[webhookDataName(type)] = jsonSchema(WEBHOOK_EVENT_SCHEMAS[type]);
    schemas[`WebhookEvent_${type.replace(/[^a-z0-9]+/gi, "_")}`] = webhookEnvelopeFor(type);
  }

  const oauthScopes = Object.fromEntries(
    MCP_TOOL_NAMES.map((t) => [scopeForTool(t), `${SCOPE_LABELS[t].title} (min role: ${TOOL_MIN_ROLE[t]})`]),
  );

  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: ref("Error") } },
  });
  const oauthErrorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: ref("OAuthError") } },
  });
  const rpcResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: ref("JsonRpcResponse") } },
  });

  const paths: OpenApiDocument["paths"] = {
    "/mcp": {
      post: {
        operationId: "mcpRpc",
        tags: ["MCP"],
        summary: "Call the MCP server (JSON-RPC 2.0 over streamable HTTP)",
        description:
          "One JSON-RPC call per request (no batches): initialize, notifications/initialized, tools/list, tools/call. " +
          "The workspace comes from the credential, never from arguments. The workspace must have MCP turned on " +
          "(Settings → API and MCP) and a plan with API access. Credit-using tools are metered before they run.",
        security: [{ ApiKey: [] }, { OAuth2: Object.keys(oauthScopes) }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { oneOf: [ref("JsonRpcRequest"), ref("McpToolsCallRequest")] },
            },
          },
        },
        responses: {
          "200": {
            description: "JSON-RPC result or JSON-RPC error (tool errors are results with isError: true)",
            content: { "application/json": { schema: ref("JsonRpcResponse") } },
          },
          "202": { description: "Notification accepted (no body)" },
          "400": rpcResponse("Parse error or invalid JSON-RPC request"),
          "401": rpcResponse("Missing, unknown, expired or revoked credential"),
          "403": rpcResponse("MCP turned off for the workspace, or the plan doesn't include API access"),
          "429": {
            ...rpcResponse("Per-credential rate limit"),
            headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait" } },
          },
        },
      },
    },
    "/api/mcp/oauth/register": {
      post: {
        operationId: "oauthRegister",
        tags: ["OAuth"],
        summary: "Register an OAuth client (RFC 7591 dynamic client registration)",
        description: "Public by design: returns a client_id only. Rate limited per IP. Redirect URIs are validated.",
        security: [],
        requestBody: { required: true, content: { "application/json": { schema: ref("OAuthRegisterRequest") } } },
        responses: {
          "201": { description: "Client registered", content: { "application/json": { schema: ref("OAuthRegisterResponse") } } },
          "400": oauthErrorResponse("Invalid redirect_uris or scope"),
          "429": oauthErrorResponse("Rate limited"),
        },
      },
    },
    "/api/mcp/oauth/authorize": {
      get: {
        operationId: "oauthAuthorize",
        tags: ["OAuth"],
        summary: "Start an OAuth 2.1 authorization (browser)",
        description:
          "Opened in the user's browser. Signed-out users are sent to sign in first; the user then sees a consent " +
          "screen naming the client, the redirect host and every scope. Approval redirects to redirect_uri with ?code&state.",
        security: [],
        parameters: [
          { name: "response_type", in: "query", required: true, schema: { const: "code" } },
          { name: "client_id", in: "query", required: true, schema: { type: "string" } },
          { name: "redirect_uri", in: "query", required: true, schema: { type: "string", format: "uri" } },
          { name: "scope", in: "query", schema: { type: "string" }, description: "Space-separated tools:<name> scopes" },
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "code_challenge", in: "query", schema: { type: "string" }, description: "PKCE S256 challenge" },
          { name: "code_challenge_method", in: "query", schema: { const: "S256" } },
        ],
        responses: {
          "302": { description: "To sign-in, or to the consent screen" },
          "400": { description: "Invalid request (rendered as an HTML error page, never redirected)" },
        },
      },
    },
    "/api/mcp/oauth/token": {
      post: {
        operationId: "oauthToken",
        tags: ["OAuth"],
        summary: "Exchange an authorization code for an access token",
        description: "Codes are single-use, expire after 10 minutes, and are bound to client_id + redirect_uri.",
        security: [],
        requestBody: { required: true, content: { "application/json": { schema: ref("OAuthTokenRequest") } } },
        responses: {
          "200": { description: "Access token", content: { "application/json": { schema: ref("OAuthTokenResponse") } } },
          "400": oauthErrorResponse("invalid_request, unsupported_grant_type, or an invalid/used/expired code"),
          "429": oauthErrorResponse("Rate limited"),
        },
      },
    },
    "/api/crm/public/forms/{token}": {
      parameters: [
        {
          name: "token",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^mkfrm_" },
          description: "The form's capability token (create forms in CRM → Forms)",
        },
      ],
      get: {
        operationId: "publicFormConfig",
        tags: ["Lead capture"],
        summary: "Read a public lead-capture form's configuration",
        security: [],
        responses: {
          "200": { description: "Form configuration", content: { "application/json": { schema: ref("PublicFormConfig") } } },
          "404": errorResponse("Unknown or disabled form"),
        },
      },
      post: {
        operationId: "publicFormSubmit",
        tags: ["Lead capture"],
        summary: "Submit a lead through a public form",
        description:
          "Creates a lead in the form's pipeline (source website_form). Body cap 2 KB; 10 submissions/min per token+IP. " +
          "Duplicates are acknowledged without revealing the existing lead. Fires the lead.created webhook.",
        security: [],
        requestBody: { required: true, content: { "application/json": { schema: ref("PublicFormSubmission") } } },
        responses: {
          "201": { description: "Accepted", content: { "application/json": { schema: ref("PublicFormResult") } } },
          "400": errorResponse("Invalid JSON, body too large, or invalid fields"),
          "404": errorResponse("Unknown or disabled form"),
          "429": errorResponse("Rate limited"),
        },
      },
    },
    "/api/openapi.json": {
      get: {
        operationId: "openApiDocument",
        tags: ["Meta"],
        summary: "This OpenAPI 3.1 document",
        security: [],
        responses: {
          "200": { description: "The document", content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
  };

  const signatureDescription =
    `HMAC-SHA256 signature: \`t=<unix seconds>,v1=<hex>\` where v1 = HMAC_SHA256(secret, "<t>.<raw body>") and the key ` +
    `is the endpoint's whole signing secret (whsec_…). Compare in constant time and reject t older than ` +
    `${DEFAULT_TOLERANCE_SECONDS} seconds (replay window).`;

  const webhooks: OpenApiDocument["webhooks"] = {};
  for (const type of WEBHOOK_EVENT_TYPES) {
    webhooks[type] = {
      post: {
        operationId: `webhook_${type.replace(/[^a-z0-9]+/gi, "_")}`,
        tags: ["Webhooks"],
        summary: WEBHOOK_EVENT_LABELS[type],
        description:
          "Sent to every enabled endpoint subscribed to this event (Settings → Webhooks). Answer 2xx within 10 seconds; " +
          "anything else is retried with exponential backoff (1m, 4m, 16m … capped at 24h, 8 attempts) and then marked failed. " +
          "Redirects are not followed.",
        parameters: [
          { name: SIGNATURE_HEADER, in: "header", required: true, schema: { type: "string" }, description: signatureDescription },
          { name: EVENT_ID_HEADER, in: "header", required: true, schema: { type: "string" } },
          { name: EVENT_TYPE_HEADER, in: "header", required: true, schema: { const: type } },
          { name: DELIVERY_ID_HEADER, in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(`WebhookEvent_${type.replace(/[^a-z0-9]+/gi, "_")}`) } },
        },
        responses: {
          "2XX": { description: "Received — no further attempts" },
          default: { description: "Retried with backoff" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "ShapesOS API",
      version: API_VERSION,
      description:
        "The ShapesOS public API: the MCP server (tools over JSON-RPC), its OAuth 2.1 flow, public lead capture, " +
        "and the outbound webhooks ShapesOS sends. Authenticate with a workspace API key (mcpk_…, Settings → API and MCP) " +
        "or an OAuth access token (mcpt_…). Keys belong to one workspace and carry per-tool scopes.",
    },
    servers: [{ url: opts.serverUrl ?? "/" }],
    tags: [
      { name: "MCP", description: "Model Context Protocol server" },
      { name: "OAuth", description: "OAuth 2.1 authorization for MCP clients" },
      { name: "Lead capture", description: "Public forms (capability token)" },
      { name: "Webhooks", description: "Events ShapesOS sends to your endpoints" },
      { name: "Meta", description: "This document" },
    ],
    paths,
    webhooks,
    components: {
      schemas,
      securitySchemes: {
        ApiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "mcpk_…",
          description: "Workspace API key (admin-created, expires within a year, scoped per tool).",
        },
        OAuth2: {
          type: "oauth2",
          description: "OAuth 2.1 authorization code + PKCE; clients self-register via /api/mcp/oauth/register.",
          flows: {
            authorizationCode: {
              authorizationUrl: "/api/mcp/oauth/authorize",
              tokenUrl: "/api/mcp/oauth/token",
              scopes: oauthScopes,
            },
          },
        },
      },
    },
  };
}

/** Every [path, method] the document declares (for tests and the docs page). */
export function documentedOperations(doc: OpenApiDocument): Array<{ path: string; method: string; op: Json }> {
  const out: Array<{ path: string; method: string; op: Json }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) out.push({ path, method, op: op as Json });
    }
  }
  return out;
}
