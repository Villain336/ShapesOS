// ShapesOS — Phase 21A (WS=agentweb): the agent-readiness audit (PURE).
//
// Extends the Phase 10/11 SEO checks instead of duplicating them: JSON-LD
// validity is lib/audit/structured-data.ts + lib/seo/jsonld.ts, robots/sitemap
// presence is what lib/audit's missing-robots-sitemap already reports. New here
// is everything an agent needs on top: llms.txt, an AI-usage policy, schema.org
// actions, WebMCP forms, NLWeb/MCP, an API description, labelled controls and
// machine-readable contact, plus the question the owner actually cares about:
// "can an agent complete this site's top tasks, and through which channel?"
// (answered with the same channel ladder the agents use: lib/agentweb/channels.ts).
//
// Honest by construction: every weight below is OUR judgement of what helps an
// agent, not a measured ranking factor; llms.txt in particular is cheap and not
// proven to matter. Checks that cannot apply (a static site cannot run /ask) are
// "na" and leave the denominator rather than failing the site.

import { extractJsonLdBlocks } from "@/lib/audit/structured-data";
import { validateJsonLdText } from "@/lib/seo/jsonld";
import { detectChannels, mergeReports, selectChannel, type ChannelId, type ChannelReport, type SiteProbe } from "../channels";
import { findForms, type SiteTaskKind } from "./actions";
import { parseLlmsTxt } from "./llmstxt";
import { readAiPolicy } from "./robots-ai";

export interface ReadinessInput {
  /** Absolute origin of the live (or draft) site. */
  origin: string;
  pages: { path: string; html: string }[];
  /** Fetched well-known files keyed by path: /llms.txt, /robots.txt, /sitemap.xml, /ask?query=ping, /openapi.json … */
  files: Record<string, { status: number; body: string }>;
  /** Can this site run server endpoints (/ask, /mcp)? False for plain static hosting. */
  endpoints: boolean;
}

export type CheckStatus = "pass" | "partial" | "fail" | "na";
export interface ReadinessCheck {
  id: string;
  label: string;
  weight: number;
  /** Points earned; null when the check does not apply. */
  earned: number | null;
  status: CheckStatus;
  detail: string;
  fix?: string;
}
export interface ReadinessFix {
  id: string;
  text: string;
  points: number;
}
export type TaskKind = SiteTaskKind | "ask";
export interface TaskOutcome {
  kind: TaskKind;
  task: string;
  can: boolean;
  channel: ChannelId;
  /** What exactly would be used (a tool name, an operation, an action type). */
  via: string;
  note: string;
}
export interface ReadinessReport {
  score: number;
  checks: ReadinessCheck[];
  fixes: ReadinessFix[];
  tasks: TaskOutcome[];
  channels: ChannelReport;
}

const ok = (c: Omit<ReadinessCheck, "status" | "earned"> & { earned: number | null }): ReadinessCheck => ({
  ...c,
  status: c.earned === null ? "na" : c.earned >= c.weight ? "pass" : c.earned > 0 ? "partial" : "fail",
});

const file = (i: ReadinessInput, path: string): string | null => {
  const f = i.files[path];
  return f && f.status === 200 ? f.body : null;
};

const TASKS: Record<TaskKind, { task: string; intent: string }> = {
  contact: { task: "Contact the business", intent: "contact the business send a message" },
  booking: { task: "Book an appointment", intent: "book a booking appointment reservation" },
  quote: { task: "Ask for a quote", intent: "request a quote estimate" },
  ask: { task: "Ask a question about the business", intent: "ask a question about the business" },
};
const ACTION_KIND: Record<string, SiteTaskKind> = { CommunicateAction: "contact", ReserveAction: "booking", QuoteAction: "quote" };

export function assessReadiness(input: ReadinessInput): ReadinessReport {
  const home = input.pages.find((p) => /^\/?index\.html?$/i.test(p.path)) ?? input.pages[0];
  const probe = (html: string, files: SiteProbe["files"]): SiteProbe => ({ origin: input.origin, html, files });
  const reports = input.pages.map((p) => detectChannels(probe(p.html, p === home ? input.files : {})));
  const channels = reports.length ? mergeReports(reports) : detectChannels(probe("", input.files));
  const forms = input.pages.flatMap((p) => findForms(p.html).map((f) => ({ ...f, path: p.path })));
  const taskForms = forms.filter((f) => f.kind);

  const checks: ReadinessCheck[] = [];

  // 1. llms.txt
  {
    const body = file(input, "/llms.txt");
    const parsed = body === null ? null : parseLlmsTxt(body);
    checks.push(
      ok({
        id: "llms-txt",
        label: "llms.txt",
        weight: 10,
        earned: parsed === null ? 0 : parsed.valid ? 10 : 5,
        detail: parsed === null ? "There is no /llms.txt." : parsed.valid ? `llms.txt lists ${parsed.sections.reduce((n, s) => n + s.links.length, 0)} page(s).` : `llms.txt exists but ${parsed.problems[0]!.charAt(0).toLowerCase()}${parsed.problems[0]!.slice(1)}`,
        fix: "Publish an llms.txt: a title, a one-line summary and links to the pages that matter. Cheap and harmless, though not proven to change what AI products cite.",
      }),
    );
  }

  // 2. robots.txt and the AI-usage policy
  {
    const body = file(input, "/robots.txt");
    const pol = readAiPolicy(body);
    let earned = 0;
    let detail = "There is no /robots.txt.";
    if (pol.present) {
      if (pol.blocksEveryone) {
        earned = 0;
        detail = "robots.txt tells every crawler to stay out, which also shuts out search and answer engines.";
      } else if (pol.explicit || pol.managed) {
        earned = 10;
        detail = `robots.txt states an AI-usage policy (${pol.decided.length} AI crawler${pol.decided.length === 1 ? "" : "s"} named).`;
      } else {
        earned = 5;
        detail = "robots.txt exists but says nothing about AI search, answer or training use.";
      }
    }
    checks.push(ok({ id: "robots-ai", label: "robots.txt and AI-usage policy", weight: 10, earned, detail, fix: "Add an AI-usage section to robots.txt (search, answer input, training): you decide each one, we write it. robots.txt is advisory; well-behaved crawlers follow it, nothing enforces it." }));
  }

  // 3. sitemap
  {
    const has = file(input, "/sitemap.xml") !== null || readAiPolicy(file(input, "/robots.txt")).hasSitemap;
    checks.push(ok({ id: "sitemap", label: "Sitemap", weight: 5, earned: has ? 5 : 0, detail: has ? "A sitemap is published." : "No sitemap.xml and robots.txt names none.", fix: "Publish a sitemap.xml (SiteBuilder writes one on every publish) so crawlers and agents can list your pages." }));
  }

  // 4. JSON-LD validity (the Phase 11 validator)
  {
    let total = 0;
    const bad: string[] = [];
    for (const p of input.pages) {
      for (const b of extractJsonLdBlocks(p.html)) {
        total++;
        if (validateJsonLdText(b.raw).some((i) => i.severity === "error")) bad.push(p.path);
      }
    }
    const earned = total === 0 ? 0 : bad.length === 0 ? 15 : bad.length < total ? 8 : 0;
    checks.push(
      ok({
        id: "jsonld",
        label: "Structured data (JSON-LD)",
        weight: 15,
        earned,
        detail: total === 0 ? "No schema.org JSON-LD on any page." : bad.length === 0 ? `${total} valid JSON-LD block(s).` : `${bad.length} of ${total} JSON-LD block(s) are invalid (${[...new Set(bad)].slice(0, 3).join(", ")}).`,
        fix: "Add valid schema.org JSON-LD (Organization and WebSite on the home page; Product, FAQPage, BreadcrumbList where they fit).",
      }),
    );
  }

  // 5. potentialAction for the tasks the site really has
  {
    const kinds = new Set(taskForms.map((f) => f.kind!));
    const declared = new Set(channels.structured.actions.map((a) => ACTION_KIND[a.type]).filter(Boolean));
    const covered = [...kinds].filter((k) => declared.has(k)).length;
    const earned = kinds.size === 0 ? (declared.size ? 15 : 0) : Math.round((covered / kinds.size) * 15);
    checks.push(
      ok({
        id: "potential-action",
        label: "schema.org actions (contact, booking, quote)",
        weight: 15,
        earned,
        detail: kinds.size === 0 ? (declared.size ? `${declared.size} action(s) declared.` : "No contact, booking or quote form was found, and no action is declared.") : `${covered} of ${kinds.size} task type(s) declared as a schema.org action.`,
        fix: "Declare your contact, booking and quote forms as schema.org potentialAction (CommunicateAction, ReserveAction, QuoteAction) so agents can find the entry point without scraping.",
      }),
    );
  }

  // 6. Declarative WebMCP forms. toolautosubmit is a risk, never a reward.
  {
    const annotated = taskForms.filter((f) => f.annotated);
    const auto = input.pages.reduce((n, p) => n + (p.html.match(/<form\b[^>]*\btoolautosubmit\b/gi)?.length ?? 0), 0);
    const total = taskForms.length;
    let earned = total === 0 ? 0 : Math.round((annotated.length / total) * 15);
    if (auto > 0) earned = Math.max(0, earned - Math.ceil(15 / Math.max(1, total)) * auto);
    checks.push(
      ok({
        id: "webmcp-forms",
        label: "WebMCP form annotations",
        weight: 15,
        earned,
        detail: `${annotated.length} of ${total} task form(s) are annotated as WebMCP tools.${auto ? ` ${auto} form(s) use toolautosubmit: an agent can submit them without the visitor confirming.` : ""}`,
        fix: "Annotate contact, booking and quote forms with toolname, tooldescription and toolparamdescription (WebMCP declarative API). Leave toolautosubmit off so the visitor confirms.",
      }),
    );
  }

  // 7. NLWeb /ask and MCP (needs a server)
  {
    const tools = channels.declaredTools;
    const ask = tools.find((t) => t.source === "nlweb");
    const mcp = tools.find((t) => t.source === "site-mcp");
    const earned = input.endpoints ? (ask ? (ask.verified ? 6 : 3) : 0) + (mcp ? 4 : 0) : null;
    checks.push(
      ok({
        id: "nlweb-mcp",
        label: "NLWeb /ask and MCP",
        weight: 10,
        earned,
        detail: !input.endpoints ? "This site is served as static files, which cannot run /ask or /mcp." : `${ask ? (ask.verified ? "/ask answers" : "/ask is declared but did not answer") : "no /ask endpoint"}; ${mcp ? "an MCP server is declared" : "no MCP server declared"}.`,
        fix: "Serve /ask (NLWeb) and /mcp over your published content, and declare them with <link rel=\"nlweb\"> and <link rel=\"mcp\">.",
      }),
    );
  }

  // 8. API description
  {
    const openapi = channels.apis.some((a) => a.kind === "openapi");
    const feed = channels.apis.some((a) => a.kind === "feed");
    checks.push(ok({ id: "openapi", label: "API description", weight: 5, earned: openapi ? 5 : feed ? 2 : 0, detail: openapi ? "An OpenAPI description is published." : feed ? "A feed is published, but no OpenAPI description." : "No OpenAPI description or feed.", fix: "If the site has a public API, publish an OpenAPI description at /openapi.json. A brochure site can skip this." }));
  }

  // 9. Labelled controls (agents and people both rely on accessible names)
  {
    const fields = forms.flatMap((f) => f.fields.map((x) => ({ ...x, path: f.path }))).filter((f) => !["hidden", "submit", "button", "reset", "image"].includes(f.type));
    const bad = fields.filter((f) => !f.labelled);
    checks.push(
      ok({
        id: "form-labels",
        label: "Labelled form controls",
        weight: 10,
        earned: fields.length === 0 ? null : Math.round(((fields.length - bad.length) / fields.length) * 10),
        detail: fields.length === 0 ? "The site has no forms." : bad.length === 0 ? `All ${fields.length} form fields have a label.` : `${bad.length} of ${fields.length} fields lack a label (${[...new Set(bad.map((b) => b.path))].slice(0, 3).join(", ")}).`,
        fix: "Give every form field a visible <label> (a placeholder is not a label). Agents driving the page, and screen readers, depend on it.",
      }),
    );
  }

  // 10. Machine-readable contact
  {
    const blob = input.pages.map((p) => p.html).join("\n");
    const ld = input.pages.flatMap((p) => extractJsonLdBlocks(p.html).map((b) => b.raw)).join("\n");
    const has = /"(telephone|email|contactPoint)"/.test(ld) || /href=["'](tel|mailto):/i.test(blob);
    checks.push(ok({ id: "contact", label: "Machine-readable contact", weight: 5, earned: has ? 5 : 0, detail: has ? "A phone number or email is available as a link or in structured data." : "No tel:/mailto: link and no telephone, email or contactPoint in structured data.", fix: "Add telephone and email (or a ContactPoint) to your Organization JSON-LD, and use tel: and mailto: links." }));
  }

  const applicable = checks.filter((c) => c.earned !== null);
  const max = applicable.reduce((s, c) => s + c.weight, 0);
  const got = applicable.reduce((s, c) => s + (c.earned ?? 0), 0);
  const fixes = applicable
    .filter((c) => (c.earned ?? 0) < c.weight && c.fix)
    .map((c) => ({ id: c.id, text: c.fix!, points: c.weight - (c.earned ?? 0) }))
    .sort((a, b) => b.points - a.points);

  // Top tasks: the kinds the site has, plus asking a question. Which rung of the ladder would an agent use?
  const kinds = new Set<TaskKind>(["ask"]);
  for (const f of taskForms) kinds.add(f.kind!);
  for (const a of channels.structured.actions) if (ACTION_KIND[a.type]) kinds.add(ACTION_KIND[a.type]);
  const tasks: TaskOutcome[] = [...kinds].sort().map((kind) => {
    const sel = selectChannel(channels, { intent: TASKS[kind].intent });
    const via = sel.tool ? `${sel.tool.name} (${sel.tool.source})` : sel.operation ? sel.operation.operationId : sel.action ? sel.action.type : sel.channel;
    const hasForm = kind === "ask" || taskForms.some((f) => f.kind === kind);
    const drives = sel.channel === "a11y-tree";
    return {
      kind,
      task: TASKS[kind].task,
      can: sel.channel !== "vision" && (!drives || hasForm || kind === "ask"),
      channel: sel.channel,
      via,
      note: drives
        ? kind === "ask"
          ? "No ask endpoint: an agent can only read the pages, with a browser if needed."
          : "Nothing is declared for this, so an agent has to drive the page with a browser (slower and less reliable); the submission still needs the visitor's confirmation."
        : sel.reason,
    };
  });

  return { score: max === 0 ? 0 : Math.round((got / max) * 100), checks, fixes, tasks, channels };
}
