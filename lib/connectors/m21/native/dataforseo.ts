// Marketr — M21 DataForSEO adapter.
//
// LIVE PATH (proven in-repo, M2/M3): delegates to lib/providers — the
// DataForSeoProvider used across milestones 2–22. When a decrypted api_key
// credential (login + password) is present, it constructs DataForSeoProvider
// directly and calls it for real. Otherwise it falls back to getSeoProvider()
// (env-key live, or the labeled mock when no credentials are configured).
// No new API code — the provider layer is the single source of truth.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, numProp, mockOk, liveOk, fail } from "../types";
import { DataForSeoProvider } from "@/lib/providers/dataforseo";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import type { SeoDataProvider } from "@/lib/providers/types";

function pickProvider(
  credential: DecryptedCredential | null,
): { provider: SeoDataProvider; live: boolean } {
  if (credential && credential.kind === "api_key") {
    const login = credential.payload.apiKey as string | undefined;
    const password =
      (credential.payload.apiSecret as string | undefined) ??
      (credential.payload.password as string | undefined);
    if (login && password) {
      return { provider: new DataForSeoProvider(String(login), String(password)), live: true };
    }
  }
  const provider = getSeoProvider();
  const status = providerStatus();
  return { provider, live: status.isLive };
}

export class DataForSeoAdapter implements ConnectorAdapter {
  readonly key = "dataforseo";
  readonly displayName = "DataForSEO";
  readonly authType = "api_key" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      locationCode: {
        type: "number",
        description: "Default DataForSEO location code (2840 = United States).",
      },
      languageCode: { type: "string", description: 'Default language code ("en").' },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "keyword_ideas",
        description: "Keyword ideas for a seed phrase with volume, difficulty, CPC, and intent.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            seed: strProp("Seed keyword or phrase."),
            limit: numProp("Max ideas (default 25)."),
          },
          required: ["seed"],
        },
      },
      {
        name: "serp_snapshot",
        description: "Organic SERP snapshot (top 10 results) for a keyword.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { keyword: strProp("Keyword to fetch the SERP for.") },
          required: ["keyword"],
        },
      },
      {
        name: "competitor_keywords",
        description: "Keywords a competitor domain ranks for, with position and volume.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            domain: strProp("Competitor domain, e.g. example.com."),
            limit: numProp("Max keywords (default 25)."),
          },
          required: ["domain"],
        },
      },
      {
        name: "backlinks_summary",
        description: "Backlink profile summary for a domain (referring domains, total backlinks).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { domain: strProp("Domain to summarize backlinks for.") },
          required: ["domain"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const { provider, live } = pickProvider(credential);
    const locationCode =
      (args.locationCode as number | undefined) ??
      (ctx.projectConfig?.locationCode as number | undefined);
    const languageCode =
      (args.languageCode as string | undefined) ??
      (ctx.projectConfig?.languageCode as string | undefined);
    const wrap = (data: unknown): InvokeResult =>
      live ? liveOk(data) : mockOk(data);
    try {
      switch (tool) {
        case "keyword_ideas":
          return wrap(
            await provider.keywordIdeas({
              seed: String(args.seed),
              limit: Number(args.limit) || 25,
              ...(locationCode ? { locationCode } : {}),
              ...(languageCode ? { languageCode } : {}),
            }),
          );
        case "serp_snapshot":
          return wrap(
            await provider.serpResults({
              keyword: String(args.keyword),
              ...(locationCode ? { locationCode } : {}),
              ...(languageCode ? { languageCode } : {}),
            }),
          );
        case "competitor_keywords":
          return wrap(
            await provider.competitorKeywords({
              domain: String(args.domain),
              limit: Number(args.limit) || 25,
              ...(locationCode ? { locationCode } : {}),
              ...(languageCode ? { languageCode } : {}),
            }),
          );
        case "backlinks_summary":
          return wrap(await provider.backlinksSummary({ target: String(args.domain) }));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
