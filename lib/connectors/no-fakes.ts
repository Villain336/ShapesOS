// ShapesOS — Phase 11 (conncore): the "no fakes in production" audit.
//
// Every connector or integration that falls back to a fake / mock / fixture
// when nothing is connected is listed here, with a probe that calls the REAL
// resolver the product uses. In production (NODE_ENV=production, without the
// ALLOW_FAKE_PROVIDERS=1 demo opt-in) every probe must come back "refused"
// — the surface says "<provider> is not connected" — and never "fake".
// lib/connectors/__tests__/no-fakes.test.ts enumerates this list plus the
// whole built-in connector registry (lib/connectors/m21/no-fakes.ts guards
// every adapter), so a new fake-by-default path that is not guarded fails CI.
//
// Dev, tests and demo installs keep the labelled mocks.
//
// Not listed (already honest without a guard, checked in the audit):
//   - social publishing (lib/social/provider.ts — null → "not connected");
//   - transcription (lib/clipper/transcribe.ts — throws when unconfigured);
//   - GBP review signals (lib/intelligence/fleet/reviews.ts — "unconfigured");
//   - the real Composio execute path, Lob/PostGrid/Twilio/Resend live paths;
//   - the LLM router's mock drafts (Phase 7 model layer, labelled "mock" on
//     Settings → Providers; not a connector).
//
// Probes import lazily so this module stays cheap to import.

export type ProbeOutcome = "refused" | "fake" | "live";

export interface FakeSurface {
  key: string;
  label: string;
  /** Where the guard lives (file: function). */
  where: string;
  probe: () => Promise<ProbeOutcome>;
}

function isRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "not_connected" ||
    err.name === "FakeProviderRefusedError" ||
    err.name === "NotConfiguredError" ||
    /not connected|not configured/i.test(err.message)
  );
}

/** Run a resolver: a refusal → "refused"; a value → classify(value). */
async function attempt<T>(run: () => T | Promise<T>, classify: (v: T) => ProbeOutcome): Promise<ProbeOutcome> {
  try {
    return classify(await run());
  } catch (err) {
    if (isRefusal(err)) return "refused";
    throw err;
  }
}

const byName = (fakeNames: string[]) => (v: { name?: string }) =>
  fakeNames.includes(String(v?.name ?? "")) ? ("fake" as const) : ("live" as const);

export const FAKE_SURFACES: readonly FakeSurface[] = [
  {
    key: "messaging-sms",
    label: "SMS (Twilio)",
    where: "lib/messaging/provider.ts: getSmsProvider",
    probe: async () => {
      const { getSmsProvider } = await import("@/lib/messaging/provider");
      return attempt(() => getSmsProvider(), byName(["fake"]));
    },
  },
  {
    key: "messaging-email",
    label: "Email (Resend / SMTP)",
    where: "lib/messaging/provider.ts: getEmailProvider",
    probe: async () => {
      const { getEmailProvider } = await import("@/lib/messaging/provider");
      return attempt(() => getEmailProvider(), byName(["fake"]));
    },
  },
  {
    key: "telephony",
    label: "Calls (Twilio voice)",
    where: "lib/calls/provider.ts: getProvider",
    probe: async () => {
      const { getProvider } = await import("@/lib/calls/provider");
      return attempt(() => getProvider(), byName(["fake"]));
    },
  },
  {
    key: "callrail",
    label: "CallRail tracking numbers",
    where: "lib/media/callrail.ts: FakeCallRailProvider.provisionNumber",
    probe: async () => {
      const { FakeCallRailProvider } = await import("@/lib/media/callrail");
      return attempt(
        () => new FakeCallRailProvider().provisionNumber({ workspaceId: "ws", stationRef: "s", buyId: "b" } as never),
        () => "fake",
      );
    },
  },
  {
    key: "direct-mail",
    label: "Direct mail (Lob / PostGrid)",
    where: "lib/mail/service.ts: fallbackMailProvider",
    probe: async () => {
      const { fallbackMailProvider } = await import("@/lib/mail/service");
      return attempt(() => fallbackMailProvider(), (v) => (v.providerName === "fake" ? "fake" : "live"));
    },
  },
  {
    key: "gbp-posts",
    label: "Google Business Profile posts and insights",
    where: "lib/local/gbp-live.ts: gbpFallbackProvider",
    probe: async () => {
      const { gbpFallbackProvider } = await import("@/lib/local/gbp-live");
      const p = gbpFallbackProvider();
      if (p.name === "mock-gbp") return "fake";
      return attempt(() => p.listPosts("locations/1"), () => "fake");
    },
  },
  {
    key: "gbp-reviews",
    label: "Google Business Profile reviews (authority)",
    where: "lib/authority/fake.ts: resolveGbpClient",
    probe: async () => {
      const { resolveGbpClient } = await import("@/lib/authority/fake");
      return attempt(() => resolveGbpClient({}), (c) => (c.name.startsWith("fake") ? "fake" : "live"));
    },
  },
  {
    key: "sending-partner",
    label: "Outreach sending (Smartlead / Instantly)",
    where: "lib/authority/fake.ts: resolveSendingPartner",
    probe: async () => {
      const mod = await import("@/lib/authority/fake");
      return attempt(() => mod.resolveSendingPartner({}), (c) => (c.name.startsWith("fake") ? "fake" : "live"));
    },
  },
  {
    key: "llm-judge",
    label: "AEO answer judge",
    where: "lib/authority/fake.ts: resolveLlmJudge",
    probe: async () => {
      const mod = await import("@/lib/authority/fake");
      return attempt(() => mod.resolveLlmJudge({}), (c) => (c.name.startsWith("fake") ? "fake" : "live"));
    },
  },
  {
    key: "lde",
    label: "Local Data Exchange",
    where: "lib/authority/fake.ts: resolveLdeClient",
    probe: async () => {
      const { resolveLdeClient } = await import("@/lib/authority/fake");
      return attempt(() => resolveLdeClient({ featureFlag: true }), (c) => (c.name.startsWith("fake") ? "fake" : "live"));
    },
  },
  {
    key: "hunter",
    label: "Prospect discovery (Hunter.io)",
    where: "lib/authority/outreach/prospects.ts: resolveHunterAdapter",
    probe: async () => {
      const { resolveHunterAdapter } = await import("@/lib/authority/outreach/prospects");
      return attempt(() => resolveHunterAdapter({}), () => "fake");
    },
  },
  {
    key: "aeo-engines",
    label: "AEO answer engines",
    where: "lib/authority/aeo/engines.ts: resolveEngineClient",
    probe: async () => {
      const { resolveEngineClient } = await import("@/lib/authority/aeo/engines");
      return attempt(() => resolveEngineClient("openai"), () => "fake");
    },
  },
  {
    key: "enrichment",
    label: "Contact enrichment",
    where: "lib/enrichment/provider.ts: getEnrichmentProviders",
    probe: async () => {
      const { getEnrichmentProviders } = await import("@/lib/enrichment/provider");
      return attempt(() => getEnrichmentProviders(), (ps) => (ps.some((p) => p.name === "fake") ? "fake" : "live"));
    },
  },
  {
    key: "seo-data",
    label: "Keyword and SERP data (DataForSEO)",
    where: "lib/providers/index.ts: getSeoProvider",
    probe: async () => {
      const { getSeoProvider } = await import("@/lib/providers/index");
      const p = getSeoProvider();
      if (p.name === "mock") return "fake";
      if (p.isLive) return "live";
      return attempt(() => p.keywordIdeas({ seed: "x" }), () => "fake");
    },
  },
  {
    key: "composio-catalog",
    label: "Composio tool catalogue",
    where: "lib/integrations/actions/discovery.ts: getToolRouter",
    probe: async () => {
      const { getToolRouter } = await import("@/lib/integrations/actions/discovery");
      const router = getToolRouter();
      const kits = await router.listToolkits();
      if (kits.length > 0) return "fake";
      return attempt(() => router.getToolkitTools("gmail"), () => "fake");
    },
  },
  {
    key: "dooh",
    label: "DOOH inventory",
    where: "lib/media/dooh.ts: getDoohProvider",
    probe: async () => {
      const { getDoohProvider } = await import("@/lib/media/dooh");
      return attempt(() => getDoohProvider(), byName(["fake"]));
    },
  },
  {
    key: "virtual-cards",
    label: "Virtual cards",
    where: "lib/media/cards.ts: cardProviderFor",
    probe: async () => {
      const { cardProviderFor } = await import("@/lib/media/cards");
      return attempt(() => cardProviderFor("fake"), byName(["fake"]));
    },
  },
  {
    key: "lift",
    label: "Branded-search lift data",
    where: "lib/media/lift.ts: FakeLiftProvider",
    probe: async () => {
      const { FakeLiftProvider } = await import("@/lib/media/lift");
      return attempt(() => new FakeLiftProvider(), () => "fake");
    },
  },
  {
    key: "budget-shift",
    label: "Ad platform budget shifts",
    where: "lib/flywheel/reallocation/checkout.ts: createFixturePlatformAdapter",
    probe: async () => {
      const { createFixturePlatformAdapter } = await import("@/lib/flywheel/reallocation/checkout");
      return attempt(
        () =>
          createFixturePlatformAdapter().applyBudgetShift({
            sourceCampaignRef: "a",
            destCampaignRef: "b",
            amountCents: 1,
            idempotencyKey: "k",
            correlationId: "c",
          } as never),
        () => "fake",
      );
    },
  },
  {
    key: "vibe-ctv",
    label: "CTV campaigns (Vibe)",
    where: "lib/flywheel/ctv/vibe.ts: createVibeAdapter",
    probe: async () => {
      const { createVibeAdapter } = await import("@/lib/flywheel/ctv/vibe");
      return attempt(() => createVibeAdapter(), (a) => (a.testMode ? "fake" : "live"));
    },
  },
  {
    key: "testlab-send",
    label: "A/B test email sending",
    where: "lib/flywheel/testlab/assignment.ts: resolveNurturePort",
    probe: async () => {
      const { resolveNurturePort } = await import("@/lib/flywheel/testlab/assignment");
      return attempt(() => resolveNurturePort(), (r) => (r.real ? "live" : "fake"));
    },
  },
  {
    key: "insurance",
    label: "Insurance carrier (CoverForce)",
    where: "lib/insurance/coverforce.ts: CoverForceVendor",
    probe: async () => {
      const { CoverForceVendor } = await import("@/lib/insurance/coverforce");
      return attempt(() => new CoverForceVendor({ mode: "fixture" }), () => "fake");
    },
  },
  {
    key: "demo-hosting",
    label: "Demo hosting connections",
    where: "lib/deploy/index.ts: buildDeployTarget",
    probe: async () => {
      const { buildDeployTarget } = await import("@/lib/deploy/index");
      return attempt(() => buildDeployTarget("vercel", { demo: true }), () => "fake");
    },
  },
  {
    key: "demo-sftp",
    label: "Demo SFTP connections",
    where: "lib/sitefiles/index.ts: getSiteFileProvider",
    probe: async () => {
      const { getSiteFileProvider } = await import("@/lib/sitefiles/index");
      return attempt(
        () =>
          getSiteFileProvider({ id: "c", label: "l", host: "h", port: 22, username: "u", authType: "password", secretEnc: "", demo: true }),
        () => "fake",
      );
    },
  },
];
