// ShapesOS — Phase 21A (WS=agentweb): run a channel of the ladder.
//
//   structured data   REAL  answered from schema.org JSON-LD already parsed: typed, no page text, no model
//   documented API    REAL  a GET operation from an OpenAPI description (writes are never run)
//   NLWeb /ask        REAL  GET /ask?query=… &mode=list&streaming=false, results clipped
//   declared form     REAL  a WebMCP declarative form filled and submitted THROUGH the governed
//                           session: every keystroke and the submit are judged by the safety kernel
//   imperative WebMCP, site MCP    detected only; running them needs a live page / an MCP client
//
// Everything a site sends back is third-party data: callers wrap it as such.

import { checkNavigation } from "./capabilities";
import type { ApiOperation, ChannelReport, DeclaredTool } from "./channels";
import type { SafetyKernel } from "./kernel";
import type { BrowserSession } from "./provider";
import type { ElementInfo } from "./types";

export interface ChannelRun {
  ok: boolean;
  channel: "structured-data" | "documented-api" | "declared-tools";
  steps?: number;
  data?: unknown;
  error?: string;
}

export interface NetDeps {
  fetchFn: typeof fetch;
  /** SSRF guard; throws for a private or internal address. */
  checkUrl: (url: string) => Promise<string>;
}

const BODY_CAP = 200_000;
const clip = (s: unknown, n = 300) => String(s ?? "").slice(0, n);
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

export function runStructured(report: ChannelReport, intent: string): ChannelRun {
  if (report.structured.entities.length === 0) return { ok: false, channel: "structured-data", error: "The page has no schema.org data." };
  const want = words(intent);
  const data = report.structured.entities.map((e) => {
    const entries = Object.entries(e.props).filter(([k]) => k !== "name" && !k.startsWith("@"));
    const hit = entries.filter(([k]) => words(k).some((w) => want.includes(w)));
    return { type: e.type, name: e.name, props: Object.fromEntries((hit.length ? hit : entries).map(([k, v]) => [k, typeof v === "string" ? clip(v) : v])) };
  });
  return { ok: true, channel: "structured-data", data };
}

async function getJson(url: string, deps: NetDeps): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    await deps.checkUrl(url);
    const res = await deps.fetchFn(url, { redirect: "manual", headers: { accept: "application/json", "user-agent": "ShapesOS-Agent/1.0 (+https://shapesos.com/agents)" } });
    if (res.status >= 300 && res.status < 400) return { ok: false, error: "The site redirected the request; redirects are not followed." };
    if (!res.ok) return { ok: false, error: `The API answered HTTP ${res.status}.` };
    const text = (await res.text()).slice(0, BODY_CAP);
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: true, body: clip(text, 2000) };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The request failed." };
  }
}

export async function runApiOperation(op: ApiOperation, origin: string, args: Record<string, unknown>, deps: NetDeps): Promise<ChannelRun> {
  if (!op.readOnly) return { ok: false, channel: "documented-api", error: `${op.operationId} is a write operation; agents only run reads through this channel.` };
  if (/\{[^}]+\}/.test(op.path)) return { ok: false, channel: "documented-api", error: `${op.operationId} needs path parameters, which this release does not fill.` };
  const u = new URL(op.path, origin);
  if (u.origin !== origin) return { ok: false, channel: "documented-api", error: "The operation points at another origin." };
  for (const p of op.parameters) if (args[p] !== undefined) u.searchParams.set(p, String(args[p]));
  const r = await getJson(u.toString(), deps);
  return r.ok ? { ok: true, channel: "documented-api", data: r.body } : { ok: false, channel: "documented-api", error: r.error };
}

export async function runNlweb(endpoint: string, query: string, deps: NetDeps, siteOrigin?: string): Promise<ChannelRun> {
  const u = new URL(endpoint);
  if (siteOrigin && u.origin !== siteOrigin) return { ok: false, channel: "declared-tools", error: "The /ask endpoint is on another origin than the site." };
  u.search = new URLSearchParams({ query, mode: "list", streaming: "false" }).toString();
  const r = await getJson(u.toString(), deps);
  if (!r.ok) return { ok: false, channel: "declared-tools", error: r.error };
  const results = (r.body as { results?: Array<Record<string, unknown>> } | null)?.results;
  if (!Array.isArray(results)) return { ok: false, channel: "declared-tools", error: "/ask did not return results." };
  return { ok: true, channel: "declared-tools", data: results.slice(0, 10).map((x) => ({ url: clip(x.url, 500), name: clip(x.name, 150), description: clip(x.description) })) };
}

export interface FormDeps {
  session: BrowserSession;
  kernel: SafetyKernel;
  /** Asked for every step the kernel says needs a person (the send). */
  approve: (reason: string) => boolean;
}

/** Fill a declared WebMCP form through the governed session and submit it. */
export async function runDeclaredForm(tool: DeclaredTool, args: Record<string, unknown>, deps: FormDeps): Promise<ChannelRun> {
  const fail = (error: string, steps = 0): ChannelRun => ({ ok: false, channel: "declared-tools", steps, error });
  if (tool.source !== "webmcp-declarative" || !tool.form) return fail(`${tool.name} is a ${tool.source} tool; this release only runs declared forms.`);
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === "");
  if (missing.length) return fail(`Missing: ${missing.join(", ")}.`);

  const snap = await deps.session.snapshot();
  const page = { url: snap.url, origin: new URL(snap.url).origin, title: snap.title };
  if (!checkNavigation(deps.kernel.caps, tool.form.action).ok) return fail("The form submits to another origin than the task's.");
  const inForm = snap.controls.filter((c) => c.form?.action === tool.form!.action);
  let steps = 0;

  for (const key of Object.keys(schema.properties ?? {})) {
    if (args[key] === undefined) continue;
    const field = inForm.find((c) => c.fieldName === key);
    if (!field) return fail(`The form has no field "${key}".`, steps);
    const d = deps.kernel.authorize({ kind: "type", element: field, page, value: String(args[key]) });
    if (d.decision === "handoff" || d.decision === "refuse") return fail(`The person has to do this: ${d.reasons.join("; ")}.`, steps);
    if (d.decision === "confirm" && !deps.approve(d.reasons.join("; "))) return fail(`Waiting for the person to confirm: ${d.reasons.join("; ")}.`, steps);
    await deps.session.type(field.ref, String(args[key]));
    steps += 1;
  }

  const submit: ElementInfo | undefined = inForm.find((c) => c.role === "button");
  if (!submit) return fail("The form has no submit button.", steps);
  const d = deps.kernel.authorize({ kind: "click", element: submit, page });
  if (d.decision === "handoff" || d.decision === "refuse") return fail(`The person has to do this: ${d.reasons.join("; ")}.`, steps);
  if (d.decision === "confirm" && !deps.approve(d.reasons.join("; "))) return fail(`Waiting for the person to approve the send: ${d.reasons.join("; ")}.`, steps);
  const out = await deps.session.click(submit.ref);
  steps += 1;
  if (out.blocked) return fail(`The form tried to go to ${out.blocked.origin ?? "another address"}; paused.`, steps);
  return { ok: true, channel: "declared-tools", steps, data: { url: out.url } };
}
