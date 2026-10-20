// ShapesOS — API reference (Phase 4a). Renders the OpenAPI 3.1 document
// (lib/api/openapi.ts, served at /api/openapi.json) as a plain server page:
// no client script, no CDN UI (the CSP is nonce-based and same-origin), just
// tables and native <details> for the schemas. Any workspace member.

import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import { buildOpenApiSpec, documentedOperations } from "@/lib/api/openapi";
import { MCP_TOOL_NAMES, SCOPE_LABELS, TOOL_MIN_ROLE, scopeForTool } from "@/lib/mcp/scopes";
import { listTools } from "@/lib/mcp/tools";
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/events";
import { planHasFeature } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "API reference — ShapesOS",
  description: "The ShapesOS public API and webhook events, from the OpenAPI 3.1 document.",
};

type Json = Record<string, unknown>;

function refName(schema: unknown): string | null {
  const r = (schema as { $ref?: string } | undefined)?.$ref;
  return r ? r.split("/").pop() ?? null : null;
}

function SchemaBlock({ name, schema }: { name: string; schema: unknown }) {
  return (
    <details className="mt-2 rounded-md border border-line bg-canvas">
      <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-ink">{name}</summary>
      <pre className="max-h-80 overflow-auto border-t border-line bg-paper p-3 font-mono text-xs text-ink">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </details>
  );
}

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the exact request body string; header: ShapesOS-Signature
export function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay window
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  const got = Buffer.from(parts.v1 ?? "", "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}`;

export default async function DevelopersPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const doc = buildOpenApiSpec();
  const schemas = doc.components.schemas;
  const ops = documentedOperations(doc);
  const tools = listTools().filter((t) => (MCP_TOOL_NAMES as readonly string[]).includes(t.name));
  const apiOn = planHasFeature(workspace.plan, "api_access");
  const hooksOn = planHasFeature(workspace.plan, "webhooks");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">API reference</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {String(doc.info.title)} {String(doc.info.version)}: the MCP server, its OAuth flow, public lead capture,
          and the webhooks ShapesOS sends.
        </p>
      </div>
      <SettingsNav />

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline">
        <p className="text-sm text-ink">
          Machine-readable OpenAPI 3.1 document for code generators and API tools.
          {!apiOn && " Your plan doesn't include API access yet; see Billing."}
          {apiOn && !hooksOn && " Webhooks aren't included in your plan."}
        </p>
        <a
          href="/api/openapi.json"
          className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press"
        >
          <Download size={14} aria-hidden />
          openapi.json
        </a>
      </section>

      <section className="rounded-lg bg-paper p-5 shadow-hairline" aria-labelledby="dev-auth">
        <h2 id="dev-auth" className="aos-subheading">Authentication</h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
          <li>
            <span className="font-semibold">API key</span>: <span className="font-mono text-xs">Authorization: Bearer mcpk_…</span>.
            Admins create keys in{" "}
            <a href="/dashboard/settings/api-mcp" className="font-semibold underline">API and MCP</a>; each key belongs to one
            workspace, carries per-tool scopes and expires within a year.
          </li>
          <li>
            <span className="font-semibold">OAuth 2.1</span>: register at <span className="font-mono text-xs">/api/mcp/oauth/register</span>,
            send the user to <span className="font-mono text-xs">/api/mcp/oauth/authorize</span> (PKCE S256), exchange the code at{" "}
            <span className="font-mono text-xs">/api/mcp/oauth/token</span> for an <span className="font-mono text-xs">mcpt_…</span> token.
          </li>
          <li>
            Scopes are exact tool names (<span className="font-mono text-xs">tools:list_projects</span>) and are capped by the
            user&apos;s current role on every call.
          </li>
        </ul>
      </section>

      <section className="rounded-lg bg-paper p-5 shadow-hairline" aria-labelledby="dev-endpoints">
        <h2 id="dev-endpoints" className="aos-subheading">Endpoints</h2>
        <div className="mt-3 flex flex-col divide-y divide-line">
          {ops.map(({ path, method, op }) => {
            const body = (op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined)?.content?.[
              "application/json"
            ]?.schema;
            const bodyName = refName(body);
            const params = [
              ...(((doc.paths[path] as Json).parameters as Json[] | undefined) ?? []),
              ...((op.parameters as Json[] | undefined) ?? []),
            ];
            const security = (op.security as Array<Record<string, unknown>> | undefined) ?? [];
            return (
              <article key={`${method} ${path}`} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-6 items-center rounded-full bg-ink px-2.5 font-mono text-[0.6875rem] font-semibold uppercase text-paper">
                    {method}
                  </span>
                  <code className="font-mono text-sm text-ink">{path}</code>
                  <span className="text-xs text-muted">
                    {security.length === 0 ? "No auth" : security.map((s) => Object.keys(s)[0]).join(" or ")}
                  </span>
                </div>
                <p className="mt-1 text-sm font-semibold text-ink">{String(op.summary ?? "")}</p>
                {typeof op.description === "string" && <p className="mt-0.5 text-sm text-muted">{op.description}</p>}
                {params.length > 0 && (
                  <table className="mt-2 w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-line text-muted">
                        <th scope="col" className="py-1 pr-3 font-semibold">Parameter</th>
                        <th scope="col" className="py-1 pr-3 font-semibold">In</th>
                        <th scope="col" className="py-1 font-semibold">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {params.map((p) => (
                        <tr key={`${String(p.in)}-${String(p.name)}`} className="border-b border-line last:border-0">
                          <td className="py-1 pr-3 font-mono text-ink">
                            {String(p.name)}
                            {p.required ? " *" : ""}
                          </td>
                          <td className="py-1 pr-3 text-muted">{String(p.in)}</td>
                          <td className="py-1 text-muted">{String(p.description ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {bodyName && <SchemaBlock name={`Request body: ${bodyName}`} schema={schemas[bodyName]} />}
                <p className="mt-2 text-xs text-muted">
                  Responses:{" "}
                  {Object.entries(op.responses as Record<string, { description?: string }>)
                    .map(([code, r]) => `${code} ${r.description ?? ""}`.trim())
                    .join(" · ")}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg bg-paper p-5 shadow-hairline" aria-labelledby="dev-tools">
        <h2 id="dev-tools" className="aos-subheading">MCP tools</h2>
        <p className="mt-1 text-sm text-muted">
          Call with <span className="font-mono text-xs">tools/call</span> on <span className="font-mono text-xs">POST /mcp</span>.
          Unknown arguments are rejected; the workspace always comes from the credential.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">Tool</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Scope</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Min role</th>
                <th scope="col" className="py-2 font-semibold">What it does</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name} className="border-b border-line align-top last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs text-ink">{t.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-muted">{scopeForTool(t.name)}</td>
                  <td className="py-2 pr-3 text-xs text-muted">{TOOL_MIN_ROLE[t.name]}</td>
                  <td className="py-2 text-xs text-ink">
                    {SCOPE_LABELS[t.name].title}. {t.description}
                    <SchemaBlock name="Arguments" schema={schemas[`McpToolInput_${t.name}`]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg bg-paper p-5 shadow-hairline" aria-labelledby="dev-webhooks">
        <h2 id="dev-webhooks" className="aos-subheading">Webhook events</h2>
        <p className="mt-1 text-sm text-muted">
          Configure endpoints in <a href="/dashboard/settings/webhooks" className="font-semibold text-ink underline">Webhooks</a>.
          Every delivery is a JSON POST signed with <span className="font-mono text-xs">ShapesOS-Signature: t=…,v1=…</span>{" "}
          (HMAC-SHA256 of <span className="font-mono text-xs">t.body</span>, 5-minute replay window).
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">Event</th>
                <th scope="col" className="py-2 font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {WEBHOOK_EVENT_TYPES.map((type) => {
                const dataName = `WebhookData_${type.replace(/[^a-z0-9]+/gi, "_")}`;
                return (
                  <tr key={type} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-ink">{type}</td>
                    <td className="py-2 text-xs text-ink">
                      {WEBHOOK_EVENT_LABELS[type]}
                      <SchemaBlock name="data" schema={schemas[dataName]} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3 className="mt-4 text-sm font-semibold text-ink">Verify a delivery (Node.js)</h3>
        <pre className="mt-2 overflow-auto rounded-md bg-canvas p-3 font-mono text-xs text-ink">{VERIFY_SNIPPET}</pre>
      </section>
    </div>
  );
}
