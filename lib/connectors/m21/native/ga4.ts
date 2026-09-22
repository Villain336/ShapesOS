// Marketr — M21 GA4 adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Google Analytics Data API v1:
//   POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
//     → traffic_report() and top_pages()
// Auth: OAuth2 Bearer access_token (scope analytics.readonly); the property
// id (numeric, e.g. 123456789) is picked per project via projectConfig.
// Docs: https://developers.google.com/analytics/devguides/reporting/data/v1
//
// MOCK MODE: deterministic demo metrics; every row flagged mock: true,
// labels carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, numProp, mockOk, fail } from "../types";

export class Ga4Adapter implements ConnectorAdapter {
  readonly key = "ga4";
  readonly displayName = "Google Analytics 4";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      propertyId: {
        type: "string",
        description:
          "GA4 property id (numeric, e.g. 123456789). Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "traffic_report",
        description:
          "Sessions, users, engagement rate, and conversions for a GA4 property over a date range.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            propertyId: strProp("GA4 property id (numeric)."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
          },
          required: ["propertyId", "startDate", "endDate"],
        },
      },
      {
        name: "top_pages",
        description: "Top landing pages by sessions with users, engagement, and conversions.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            propertyId: strProp("GA4 property id (numeric)."),
            startDate: strProp("Start date YYYY-MM-DD."),
            endDate: strProp("End date YYYY-MM-DD."),
            limit: numProp("Max pages to return (default 10)."),
          },
          required: ["propertyId", "startDate", "endDate"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const propertyId =
      (args.propertyId as string | undefined) ??
      (ctx.projectConfig?.propertyId as string | undefined) ??
      "987654321";
    switch (tool) {
      case "traffic_report":
        return mockOk({
          propertyId,
          startDate: args.startDate,
          endDate: args.endDate,
          sessions: 18432,
          totalUsers: 14210,
          newUsers: 11887,
          engagementRate: 0.62,
          conversions: 431,
          mock: true,
        });
      case "top_pages": {
        const limit = Math.min(Number(args.limit) || 10, 50);
        const pages = [
          { pagePath: "/", pageTitle: "Home (MOCK)", sessions: 6210, users: 5400, engagementRate: 0.58, conversions: 148 },
          { pagePath: "/services/implants/", pageTitle: "Dental Implants (MOCK)", sessions: 2412, users: 2201, engagementRate: 0.71, conversions: 96 },
          { pagePath: "/blog/5-tips-healthy-smile/", pageTitle: "5 tips for a healthy smile (MOCK)", sessions: 1884, users: 1770, engagementRate: 0.66, conversions: 21 },
          { pagePath: "/contact/", pageTitle: "Contact (MOCK)", sessions: 1201, users: 1105, engagementRate: 0.74, conversions: 112 },
        ];
        return mockOk({
          propertyId,
          rows: pages.slice(0, limit).map((p) => ({ ...p, mock: true })),
        });
      }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
