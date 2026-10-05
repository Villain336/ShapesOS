// ShapesOS — "What's running on mock data" inventory (Phase 6, single-key setup).
//
// One pure function over the environment (plus two facts the page already
// knows: the LLM routing status and whether this workspace has a Context.dev
// key in the vault). No I/O, no process.env reads, so it is unit-tested
// directly and the Settings → Providers page renders exactly what it says.
//
// Every check mirrors the code that actually decides live vs mock — keep them
// in sync when one changes (the reference is named next to each check):
//   LLM            lib/llm/router.ts (passed in as llmRoutingStatus())
//   Images         lib/images/openai.ts imageServiceStatus()
//   SEO data       lib/providers/index.ts getSeoProvider()
//   Context.dev    lib/knowledge/contextdev/keys.ts resolveContextDevKey()
//   Email          lib/messaging/provider.ts getEmailProvider()
//                  lib/workspace/invite-mail.ts inviteMailChannel()
//                  lib/alerts/adapters.ts (SMTP_HOST + SMTP_FROM)
//   SMS / calls    lib/messaging/provider.ts getSmsProvider(),
//                  lib/calls/provider.ts getProvider()
//   Stripe         lib/metering/billing.ts isBillingConfigured()
//   Composio       lib/integrations/actions/discovery.ts getToolRouter()
//   Activepieces   lib/integrations/activepieces/config.ts
//   Code sandbox   lib/sandbox/index.ts sandboxAvailability() (passed in)
//   Hosting        lib/deploy/index.ts hostingConnectorFor() — per connection
//                  (Vercel / Cloudflare Pages / Netlify; demo flag), passed in
//
// A mocked feature is configuration, not an agent state: the UI renders
// these as neutral chips, never with the agent status colours.
// Never returns key material — only env var NAMES and booleans.

import { fakeProvidersAllowed } from "@/lib/env/secrets";
import { normalizeEngineUrl } from "@/lib/integrations/activepieces/config";
import type { LlmWorkload, LlmWorkloadStatus } from "@/lib/llm/router";
import { imageServiceStatus } from "@/lib/images/openai";

export type FeatureMode =
  /** Real third-party calls. */
  | "live"
  /** Runs, but on labelled mock / fake / fixture data. */
  | "mock"
  /** Disabled with an honest "not configured" message — nothing is faked. */
  | "off";

export interface FeatureStatus {
  key: string;
  label: string;
  mode: FeatureMode;
  /** One sentence: what happens now, and why. */
  detail: string;
  /** Env var names to set to go live (empty for a vault-held key). */
  envVars: string[];
}

export type EnvLike = Record<string, string | undefined>;

export interface InventoryFacts {
  /** llmRoutingStatus() — the router decides; this module only reports. */
  llm: Record<LlmWorkload, Pick<LlmWorkloadStatus, "isLive" | "model" | "fallback" | "singleKey" | "failover"> & Partial<Pick<LlmWorkloadStatus, "retention">>>;
  /** Whether this workspace has an active Context.dev key in the vault;
   *  null when it could not be checked. */
  contextDevConnected: boolean | null;
  /**
   * Phase 8: sandboxAvailability() — whether the agent code tools have a
   * sandbox provider (Docker / E2B / Daytona) right now. Omitted = not
   * checked (the entry is left out).
   */
  sandbox?: { ok: boolean; provider: string | null; reason?: string } | null;
  /**
   * Phase 9: this workspace's hosting connections by provider label, split
   * live / demo (tokens are per connection, not env). Omitted = not checked.
   */
  hosting?: { live: string[]; demo: string[] } | null;
}

const set = (env: EnvLike, k: string) => Boolean((env[k] ?? "").trim());

const WORKLOAD_LABEL: Record<LlmWorkload, string> = {
  copy: "AI writing (client-facing copy)",
  bulk: "AI agent loop, skills and summaries",
  background: "AI background jobs (digests, decay checks)",
  lead: "AI lead agent and planner",
  subagent: "AI sub-agents (research, writing, analysis)",
  code: "AI code agent",
  code_max: "AI code agent escalation",
};

function llmEntry(w: LlmWorkload, s: InventoryFacts["llm"][LlmWorkload]): FeatureStatus {
  const parts: string[] = [];
  if (s.isLive) {
    parts.push(`Live on ${s.model}.`);
    if (s.singleKey) parts.push(s.singleKey);
    if (s.retention) parts.push(s.retention);
    parts.push(s.failover ? `Fails over to ${s.failover} on rate limits and outages.` : "No failover model configured.");
  } else {
    parts.push(`Labelled mock drafts — ${s.fallback ?? "no provider configured"}.`);
  }
  return {
    key: `llm-${w}`,
    label: WORKLOAD_LABEL[w],
    mode: s.isLive ? "live" : "mock",
    detail: parts.join(" "),
    envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", `LLM_MODEL_${w.toUpperCase()}`],
  };
}

/** Message/telephony providers default to "fake"; a fake one in production
 *  without ALLOW_FAKE_PROVIDERS=1 refuses to run (off, not mock). */
function fakeMode(env: EnvLike): FeatureMode {
  return fakeProvidersAllowed(env as NodeJS.ProcessEnv) ? "mock" : "off";
}

function selected(env: EnvLike, k: string, fallback: string): string {
  return ((env[k] ?? fallback) as string).trim().toLowerCase() || fallback;
}

export function mockInventory(env: EnvLike, facts: InventoryFacts): FeatureStatus[] {
  const out: FeatureStatus[] = [];

  for (const w of Object.keys(WORKLOAD_LABEL) as LlmWorkload[]) out.push(llmEntry(w, facts.llm[w]));

  // Images: the image service decides (same OpenAI key as text — LLM_API_KEY
  // when non-empty, else OPENAI_API_KEY — and an allow-listed image model).
  const img = imageServiceStatus(env);
  const selfHost = (env.LLM_SELF_HOST ?? "").trim() === "1";
  out.push({
    key: "images",
    label: "AI image generation",
    mode: img.live ? "live" : "off",
    detail: img.live
      ? selfHost
        ? `Key set, but LLM_SELF_HOST=1 points the OpenAI base URL at your local server, which may not serve images (${img.model}).`
        : `Live through the OpenAI Images API on ${img.model}.`
      : img.configured
        ? `Off — ${img.reason} Nothing fake is generated.`
        : "Off — image generation needs an OpenAI key. Nothing fake is generated.",
    envVars: ["OPENAI_API_KEY", "LLM_IMAGE_MODEL"],
  });

  const dfs = set(env, "DATAFORSEO_LOGIN") && set(env, "DATAFORSEO_PASSWORD");
  out.push({
    key: "seo-data",
    label: "Keyword and SERP data (DataForSEO)",
    mode: dfs ? "live" : "mock",
    detail: dfs
      ? "Live DataForSEO keyword ideas, SERP analysis and rank checks."
      : "Keyword ideas, SERP analysis and rank checks return labelled mock rows.",
    envVars: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
  });

  // Phase 15.1: Context.dev is "Both" — the workspace's own key, else the
  // platform key (CONTEXTDEV_API_KEY, charged in credits).
  const ctx = facts.contextDevConnected;
  const ctxPlatform = set(env, "CONTEXTDEV_API_KEY");
  out.push({
    key: "contextdev",
    label: "Web research and crawling (Context.dev)",
    mode: ctx || ctxPlatform ? "live" : "off",
    detail: ctx
      ? "Live with this workspace's own Context.dev key (no credits)."
      : ctxPlatform
        ? "Live on the platform Context.dev key — 1 credit per Context.dev credit. Connect your own key to use none."
        : ctx === null
          ? "Could not check this workspace's Context.dev key."
          : "Off — research, brand sync and page monitors report \"not connected\" until this workspace connects a Context.dev key.",
    envVars: ["CONTEXTDEV_API_KEY"],
  });

  // Campaign / sequence email: messaging provider (default fake).
  const emailProvider = selected(env, "MESSAGING_EMAIL_PROVIDER", "fake");
  const resendKey = set(env, "RESEND_API_KEY");
  out.push(
    emailProvider === "resend"
      ? {
          key: "email-messaging",
          label: "Campaign and sequence email",
          mode: resendKey ? "live" : "off",
          detail: resendKey
            ? "Live through Resend."
            : "Resend is selected but RESEND_API_KEY is missing — sends fail with \"not configured\".",
          envVars: ["MESSAGING_EMAIL_PROVIDER", "RESEND_API_KEY"],
        }
      : {
          key: "email-messaging",
          label: "Campaign and sequence email",
          mode: fakeMode(env),
          detail:
            fakeMode(env) === "mock"
              ? "The fake provider simulates delivery — no email leaves the server."
              : "The fake provider is refused in production — sends fail until Resend is configured.",
          envVars: ["MESSAGING_EMAIL_PROVIDER", "RESEND_API_KEY"],
        },
  );

  // Alerts, approval codes and invites: SMTP; invites can also use Resend.
  const smtp = set(env, "SMTP_HOST") && set(env, "SMTP_FROM");
  const inviteResend = resendKey && set(env, "INVITE_MAIL_FROM");
  out.push({
    key: "email-system",
    label: "Alert, approval-code and invite email",
    mode: smtp ? "live" : "off",
    detail: smtp
      ? "Live through SMTP."
      : inviteResend
        ? "Invites go out through Resend; alert and approval-code emails are off until SMTP is set."
        : "Off — alert and approval-code emails are not sent and invite links must be copied by hand.",
    envVars: ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS"],
  });

  const twilio = set(env, "TWILIO_ACCOUNT_SID") && set(env, "TWILIO_AUTH_TOKEN");
  for (const [key, label, selector] of [
    ["sms", "SMS (Twilio)", "MESSAGING_SMS_PROVIDER"],
    ["calls", "Call tracking and voice (Twilio)", "CALLS_PROVIDER"],
  ] as const) {
    const chosen = selected(env, selector, "fake");
    const fake = fakeMode(env);
    out.push({
      key,
      label,
      mode: chosen === "twilio" ? (twilio ? "live" : "off") : fake,
      detail:
        chosen === "twilio"
          ? twilio
            ? "Live through Twilio."
            : "Twilio is selected but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing — sends fail with \"not configured\"."
          : fake === "mock"
            ? "The fake provider simulates delivery — nothing reaches a phone."
            : "The fake provider is refused in production — set up Twilio.",
      envVars: [selector, "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    });
  }

  const stripe = set(env, "STRIPE_SECRET_KEY") && set(env, "STRIPE_WEBHOOK_SECRET");
  out.push({
    key: "stripe",
    label: "Billing (Stripe)",
    mode: stripe ? "live" : "off",
    detail: stripe
      ? "Live Stripe checkout, portal and webhooks."
      : "Off — checkout and the billing portal fail closed; credits still meter locally.",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  });

  const composio = set(env, "COMPOSIO_API_KEY");
  out.push({
    key: "composio",
    label: "App actions (Composio)",
    mode: composio ? "live" : "mock",
    detail: composio
      ? "Live Composio tool router."
      : "Tool discovery serves a built-in fixture catalogue; no app action reaches Composio.",
    envVars: ["COMPOSIO_API_KEY"],
  });

  // Phase 15.4 (zernio): the Zernio platform key (LIVE / pre-added) — ads on 7
  // networks + social on 16 platforms. lib/zernio/config.ts zernioMode().
  // (The keys workstream owns this page's layout; this is Zernio's own row.)
  const zernio = set(env, "ZERNIO_API_KEY");
  out.push({
    key: "zernio",
    label: "Ads and social through Zernio (platform key)",
    mode: zernio ? "live" : fakeProvidersAllowed(env as NodeJS.ProcessEnv) ? "mock" : "off",
    detail: zernio
      ? "Live, pre-added: every workspace gets its own Zernio profile and connects accounts on Settings → Connectors → Zernio."
      : fakeProvidersAllowed(env as NodeJS.ProcessEnv)
        ? "Runs on the labelled fake Zernio — connect flows, ads and posts are simulated and marked mock."
        : "Off — Zernio tools and publishing say \"Zernio is not connected\"; nothing is faked.",
    envVars: ["ZERNIO_API_KEY", "ZERNIO_BASE_URL"],
  });

  const ap = normalizeEngineUrl(env.ACTIVEPIECES_URL) !== null && set(env, "ACTIVEPIECES_API_KEY");
  out.push({
    key: "activepieces",
    label: "Automation flows (Activepieces)",
    mode: ap ? "live" : "off",
    detail: ap
      ? "Live — published webhook flows can be triggered."
      : "Off — automation actions report \"not connected\"; nothing is triggered.",
    envVars: ["ACTIVEPIECES_URL", "ACTIVEPIECES_API_KEY"],
  });

  // Code sandbox: never mocked — without a provider the code tools are off
  // and say why (lib/sandbox/tools.ts).
  if (facts.sandbox !== undefined) {
    const sb = facts.sandbox;
    out.push({
      key: "sandbox",
      label: "Code sandbox (agent code tools)",
      mode: sb?.ok ? "live" : "off",
      detail: sb?.ok
        ? `Live on ${sb.provider === "e2b" ? "E2B" : sb.provider === "daytona" ? "Daytona" : "Docker"} — agents read, write and run code in an isolated sandbox per run.`
        : `Off — ${sb?.reason ?? "the sandbox provider could not be checked."} Code tools say so and do nothing.`,
      envVars: ["SANDBOX_PROVIDER", "DOCKER_HOST", "E2B_API_KEY", "DAYTONA_API_KEY"],
    });
  }

  // Hosting deploys: tokens live per connection (Sites → Hosting), so the
  // mode comes from this workspace's connections, never from env.
  if (facts.hosting !== undefined) {
    const h = facts.hosting;
    const live = [...new Set(h?.live ?? [])];
    const demo = [...new Set(h?.demo ?? [])];
    out.push({
      key: "hosting",
      label: "Hosting deploys (Vercel, Cloudflare Pages, Netlify)",
      mode: live.length ? "live" : demo.length ? "mock" : "off",
      detail: live.length
        ? `Live through ${live.join(", ")}${demo.length ? `; demo connections (labelled mock) for ${demo.join(", ")}` : ""}.`
        : demo.length
          ? `Only demo connections (${demo.join(", ")}) — deploys and rollbacks are labelled mock; nothing is published.`
          : h === null
            ? "Off — hosting connections could not be checked."
            : "Off — no hosting connection yet. Connect one under a project's Sites → Hosting.",
      envVars: [],
    });
  }

  return out;
}

/** The entries that are not live, mock first (they look like they work). */
export function notLive(entries: FeatureStatus[]): FeatureStatus[] {
  const rank: Record<FeatureMode, number> = { mock: 0, off: 1, live: 2 };
  return entries.filter((e) => e.mode !== "live").sort((a, b) => rank[a.mode] - rank[b.mode]);
}
