// Phase 6: for each of the six formerly mock-only adapters, a provider error
// that echoes the bare access token (not "Bearer …"-shaped, so the regex
// scrubber alone would miss it) is mapped to a closed errorCode and the
// token never appears in the result. Also: a 401 whose refresh fails is
// auth_rejected with a reconnect message, again without the token.
// Run: npx tsx --test lib/connectors/m21/live/__tests__/no-token-leak.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import type { ConnectorAdapter } from "../../types";
import { GoogleSearchConsoleAdapter } from "../../native/google-search-console";
import { Ga4Adapter } from "../../native/ga4";
import { GoogleDriveAdapter } from "../../native/google-drive";
import { NotionAdapter } from "../../native/notion";
import { MetaAdsAdapter } from "../../native/meta-ads";
import { GoogleAdsAdapter } from "../../native/google-ads";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith } from "./fixtures";
import type { LiveDeps } from "../http";

const TOKEN = "plaintoken0123456789";
const DEV_TOKEN = "devtoken-abcdef-999";

interface Case {
  name: string;
  make: (deps: LiveDeps) => ConnectorAdapter;
  tool: string;
  args: Record<string, unknown>;
  /** A 400 body the provider would send, echoing the token bare. */
  errorBody: unknown;
  /** A body that means "token invalid" for this provider. */
  authStatus: number;
  authBody: unknown;
}

const echo = `invalid request for token ${TOKEN} (dev ${DEV_TOKEN})`;

const CASES: Case[] = [
  {
    name: "google-search-console",
    make: (d) => new GoogleSearchConsoleAdapter(d),
    tool: "query_performance",
    args: { property: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-30" },
    errorBody: { error: { code: 400, message: echo } },
    authStatus: 401,
    authBody: { error: { code: 401, message: "Invalid Credentials" } },
  },
  {
    name: "ga4",
    make: (d) => new Ga4Adapter(d),
    tool: "traffic_report",
    args: { propertyId: "123456789", startDate: "2026-09-01", endDate: "2026-09-30" },
    errorBody: { error: { code: 400, message: echo, status: "INVALID_ARGUMENT" } },
    authStatus: 401,
    authBody: { error: { code: 401, message: "Request had invalid authentication credentials." } },
  },
  {
    name: "google-drive",
    make: (d) => new GoogleDriveAdapter(d),
    tool: "search_files",
    args: { query: "brief" },
    errorBody: { error: { code: 400, message: echo } },
    authStatus: 401,
    authBody: { error: { code: 401, message: "Invalid Credentials" } },
  },
  {
    name: "notion",
    make: (d) => new NotionAdapter(d),
    tool: "search_pages",
    args: { query: "brand" },
    errorBody: { object: "error", status: 400, code: "validation_error", message: echo },
    authStatus: 401,
    authBody: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." },
  },
  {
    name: "meta-ads",
    make: (d) => new MetaAdsAdapter(d),
    tool: "account_insights",
    args: { adAccountId: "act_123" },
    errorBody: { error: { message: echo, type: "OAuthException", code: 100 } },
    authStatus: 400,
    authBody: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } },
  },
  {
    name: "google-ads",
    make: (d) => new GoogleAdsAdapter(d),
    tool: "campaign_report",
    args: { customerId: "1234567890" },
    errorBody: {
      error: { code: 400, message: echo, details: [{ errors: [{ errorCode: { queryError: "BAD_VALUE" }, message: echo }] }] },
    },
    authStatus: 401,
    authBody: { error: { code: 401, message: "Request is missing required authentication credential." } },
  },
];

let savedDev: string | undefined;

describe("live adapters never leak the stored token in errors", () => {
  before(() => {
    savedDev = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = DEV_TOKEN;
  });
  after(() => {
    if (savedDev === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = savedDev;
  });

  for (const c of CASES) {
    it(`${c.name}: a 400 echoing the token maps to bad_request with the token redacted`, async () => {
      const f = scriptedFetch([jsonResponse(400, c.errorBody)]);
      const r = await c.make(liveDeps(f.fetchImpl).deps).invoke(c.tool, c.args, oauthCred(TOKEN), ctxWith());
      assert.equal(r.ok, false);
      assert.equal(r.mock, false, "a live failure is never labelled as mock");
      assert.equal(r.errorCode, "bad_request", r.error);
      const serialized = JSON.stringify(r);
      assert.ok(!serialized.includes(TOKEN), serialized);
      // Only Google Ads sends the developer token, so only it can redact it.
      if (c.name === "google-ads") assert.ok(!serialized.includes(DEV_TOKEN), serialized);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    });

    it(`${c.name}: 401 → refresh fails → auth_rejected, no retry loop, no token`, async () => {
      const f = scriptedFetch([jsonResponse(c.authStatus, c.authBody)]);
      const ctx = ctxWith({ refreshCredential: async () => null });
      const r = await c.make(liveDeps(f.fetchImpl).deps).invoke(c.tool, c.args, oauthCred(TOKEN), ctx);
      assert.equal(r.ok, false);
      assert.equal(r.errorCode, "auth_rejected", r.error);
      assert.equal(ctx.refreshCalls(), 1);
      assert.equal(f.calls.length, 1);
      assert.ok(!JSON.stringify(r).includes(TOKEN));
    });
  }
});
