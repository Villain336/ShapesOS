// ShapesOS — OpenAPI 3.1 document (Phase 4a): structurally valid, every
// $ref resolves, and every documented path + method exists as a route file.
// Run: npx tsx --test lib/api/__tests__/openapi.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiSpec, documentedOperations, type OpenApiDocument } from "../openapi";
import { MCP_TOOL_NAMES } from "@/lib/mcp/scopes";
import { WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/events";

const ROOT = path.resolve(__dirname, "../../..");
const doc = buildOpenApiSpec({ serverUrl: "https://app.example.test" });
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** "/api/crm/public/forms/{token}" → app/api/crm/public/forms/[token]/route.ts */
function routeFileFor(p: string): string {
  const segs = p.split("/").filter(Boolean).map((s) => s.replace(/^\{(.+)\}$/, "[$1]"));
  return path.join(ROOT, "app", ...segs, "route.ts");
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) collectRefs(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

function resolvePointer(d: OpenApiDocument, pointer: string): unknown {
  assert.ok(pointer.startsWith("#/"), `only local refs: ${pointer}`);
  let cur: unknown = d;
  for (const raw of pointer.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = (cur as Record<string, unknown> | undefined)?.[key];
  }
  return cur;
}

describe("OpenAPI document — structure", () => {
  it("is an OpenAPI 3.1 document with info, servers and paths", () => {
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(typeof doc.info.title, "string");
    assert.match(String(doc.info.version), /^\d+\.\d+\.\d+$/);
    assert.deepEqual(doc.servers, [{ url: "https://app.example.test" }]);
    assert.ok(Object.keys(doc.paths).length >= 5);
    for (const p of Object.keys(doc.paths)) assert.match(p, /^\//, p);
    // Round-trips as JSON (what the route serves).
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
  });

  it("every operation has a unique operationId and responses; path params are declared", () => {
    const ids = new Set<string>();
    const all = [
      ...documentedOperations(doc),
      ...Object.entries(doc.webhooks).flatMap(([name, item]) =>
        Object.entries(item).map(([method, op]) => ({ path: name, method, op })),
      ),
    ];
    for (const { path: p, method, op } of all) {
      assert.ok(METHODS.includes(method), `${p} ${method}`);
      const id = op.operationId as string;
      assert.ok(id && !ids.has(id), `operationId ${id} unique`);
      ids.add(id);
      const responses = op.responses as Record<string, unknown>;
      assert.ok(responses && Object.keys(responses).length > 0, `${p} ${method} has responses`);
      for (const code of Object.keys(responses)) assert.match(code, /^([1-5]\d\d|[1-5]XX|default)$/, `${p} ${code}`);
    }
    for (const [p, item] of Object.entries(doc.paths)) {
      const templated = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = [
        ...((item.parameters as unknown as Array<{ name: string; in: string; required?: boolean }>) ?? []),
        ...Object.values(item).flatMap((op) => ((op as { parameters?: Array<{ name: string; in: string; required?: boolean }> }).parameters ?? [])),
      ].filter((x) => x.in === "path");
      for (const name of templated) {
        const param = declared.find((d) => d.name === name);
        assert.ok(param, `${p} declares path param ${name}`);
        assert.equal(param!.required, true, `${p} path param ${name} is required`);
      }
    }
  });

  it("every $ref resolves and every security requirement names a scheme", () => {
    for (const r of collectRefs(doc)) assert.ok(resolvePointer(doc, r), `unresolved ${r}`);
    const schemes = doc.components.securitySchemes;
    for (const { op } of documentedOperations(doc)) {
      for (const req of (op.security as Array<Record<string, string[]>> | undefined) ?? []) {
        for (const [name, scopes] of Object.entries(req)) {
          assert.ok(schemes[name], `unknown scheme ${name}`);
          if (name === "OAuth2") {
            const flowScopes = (schemes.OAuth2 as { flows: { authorizationCode: { scopes: Record<string, string> } } })
              .flows.authorizationCode.scopes;
            for (const s of scopes) assert.ok(s in flowScopes, `unknown scope ${s}`);
          }
        }
      }
    }
  });

  it("schemas come from the live zod schemas (MCP tools, public form, webhook payloads)", () => {
    const schemas = doc.components.schemas;
    for (const tool of MCP_TOOL_NAMES) {
      const s = schemas[`McpToolInput_${tool}`] as { type?: string; additionalProperties?: unknown };
      assert.ok(s, `tool ${tool}`);
      assert.equal(s.type, "object");
      assert.equal(s.additionalProperties, false, `${tool} input is strict`);
    }
    const rank = schemas.McpToolInput_get_rank_report as { required?: string[]; properties: Record<string, { maximum?: number }> };
    assert.deepEqual(rank.required, ["projectId"]);
    assert.equal(rank.properties.limit!.maximum, 100);
    const form = schemas.PublicFormSubmission as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual(form.required, ["name"]);
    assert.ok("utm" in form.properties && "promoCode" in form.properties);
    for (const s of Object.values(schemas)) assert.equal((s as { $schema?: string }).$schema, undefined);
  });

  it("documents every webhook event with the signature headers", () => {
    assert.deepEqual(Object.keys(doc.webhooks).sort(), [...WEBHOOK_EVENT_TYPES].sort());
    const lead = doc.webhooks["lead.created"]!.post as { parameters: Array<{ name: string; in: string }> };
    assert.ok(lead.parameters.some((p) => p.name === "ShapesOS-Signature" && p.in === "header"));
    const env = doc.components.schemas.WebhookEvent_lead_created as { properties: { type: { const: string } } };
    assert.equal(env.properties.type.const, "lead.created");
  });
});

describe("OpenAPI document — every documented path exists as a route", () => {
  for (const { path: p, method } of documentedOperations(doc)) {
    it(`${method.toUpperCase()} ${p}`, () => {
      const file = routeFileFor(p);
      assert.ok(existsSync(file), `${p} → ${path.relative(ROOT, file)} is missing`);
      const src = readFileSync(file, "utf8");
      assert.match(
        src,
        new RegExp(`export (async )?function ${method.toUpperCase()}\\(`),
        `${path.relative(ROOT, file)} has no ${method.toUpperCase()} handler`,
      );
    });
  }
});
