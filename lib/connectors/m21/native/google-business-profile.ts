// ShapesOS — M21 Google Business Profile adapter (Phase 4b).
//
// LIVE WIRING: with a vault credential this adapter calls the Business
// Profile APIs (lib/connectors/m21/live/gbp.ts):
//   GET  mybusinessaccountmanagement v1 /accounts → list_accounts() + health check
//   GET  mybusinessbusinessinformation v1 /accounts/{a}/locations → list_locations()
//   GET  mybusiness v4 …/locations/{l}/reviews → list_reviews() (pageToken paging)
//   PUT  mybusiness v4 …/reviews/{r}/reply → reply_to_review() [mutating]
//   POST mybusiness v4 …/locations/{l}/localPosts → create_post() [mutating]
// Mutating tools go through the agent loop's role + confirmation gates
// (lib/chat/connector-tools.ts). The authority review/listing flows use the
// same client through their own approval receipts (lib/authority/reviews/gbpClient.ts).
// Auth: Google OAuth2 Bearer (scope business.manage), refresh-on-401
// through the vault. API access needs Google's GBP API approval.
//
// MOCK MODE (no credential): deterministic demo location + reviews; every
// row flagged mock: true, names carry "(MOCK)". Mutations are echoed, not sent.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { clampInt, liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import {
  gbpCreatePost,
  gbpListAccounts,
  gbpListLocations,
  gbpListReviews,
  gbpPing,
  gbpReplyToReview,
  buildLocalPost,
  type GbpPostInput,
} from "../live/gbp";

const MOCK_LOCATION = "accounts/1000000001/locations/2000000001";

export class GoogleBusinessProfileAdapter implements ConnectorAdapter {
  readonly key = "google-business-profile";
  readonly displayName = "Google Business Profile";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      locationRef: {
        type: "string",
        description:
          "Default location, accounts/{accountId}/locations/{locationId}. Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    const loc = strProp("Location, accounts/{accountId}/locations/{locationId}.");
    return [
      {
        name: "list_accounts",
        description: "List Business Profile accounts the connected Google user manages.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_locations",
        description: "List locations (title, phone, website, category) in a Business Profile account.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { accountId: strProp("Numeric account id (accounts/{id}).") },
          required: ["accountId"],
        },
      },
      {
        name: "list_reviews",
        description: "Recent reviews for a location with rating, text, and any reply.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { locationRef: loc, limit: strProp("Max reviews (default 25).") },
        },
      },
      {
        name: "reply_to_review",
        description: "Post or replace the owner reply to a review. Google moderates replies before they show.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            locationRef: loc,
            reviewId: strProp("Review id."),
            comment: strProp("Reply text (max 4096 bytes)."),
          },
          required: ["reviewId", "comment"],
        },
      },
      {
        name: "create_post",
        description: "Publish a local post (update, offer, or event) on a location.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            locationRef: loc,
            topicType: strProp("update (default), offer, or event."),
            title: strProp("Title (offers and events)."),
            summary: strProp("Post text (max 1500 characters)."),
            actionUrl: strProp("Optional https link for the call-to-action button."),
            startDate: strProp("YYYY-MM-DD (offers and events)."),
            endDate: strProp("YYYY-MM-DD (offers and events)."),
          },
          required: ["summary"],
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
    const locationRef = String(args.locationRef ?? ctx.projectConfig?.locationRef ?? "");
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mockInvoke(tool, args, locationRef || MOCK_LOCATION);
    try {
      switch (tool) {
        case "list_accounts":
          return liveOk(await gbpListAccounts(auth, this.deps));
        case "list_locations":
          return liveOk(
            await gbpListLocations(auth, String(args.accountId ?? "").replace(/^accounts\//, ""), this.deps),
          );
        case "list_reviews":
          return liveOk(await gbpListReviews(auth, locationRef, clampInt(args.limit, 25, 1, 200), this.deps));
        case "reply_to_review":
          return liveOk(
            await gbpReplyToReview(auth, locationRef, String(args.reviewId ?? ""), String(args.comment ?? ""), this.deps),
          );
        case "create_post":
          return liveOk(await gbpCreatePost(auth, locationRef, postInput(args), this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
    try {
      return liveOk(await gbpPing(auth, this.deps));
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>, locationRef: string): InvokeResult {
    switch (tool) {
      case "list_accounts":
        return mockOk([{ name: "accounts/1000000001", accountName: "Harbor Dental (MOCK)", type: "LOCATION_GROUP", mock: true }]);
      case "list_locations":
        return mockOk([
          { locationRef: MOCK_LOCATION, title: "Harbor Dental Studio (MOCK)", websiteUri: "https://demo-site.local/", primaryPhone: "(555) 010-0000", primaryCategory: "Dentist", mock: true },
        ]);
      case "list_reviews":
        return mockOk({
          locationRef,
          averageRating: 4.7,
          totalReviewCount: 2,
          reviews: [
            { reviewId: "mock-review-1", reviewer: "Sam (MOCK)", rating: 5, comment: "Gentle and on time. (MOCK)", createTime: "2026-09-20T12:00:00Z", updateTime: "2026-09-20T12:00:00Z", reply: null, mock: true },
            { reviewId: "mock-review-2", reviewer: "Lee (MOCK)", rating: 4, comment: "Great cleaning, parking is tight. (MOCK)", createTime: "2026-09-12T09:00:00Z", updateTime: "2026-09-13T09:00:00Z", reply: { comment: "Thanks Lee! (MOCK)", updateTime: "2026-09-13T09:00:00Z", state: "APPROVED" }, mock: true },
          ],
        });
      case "reply_to_review":
        return mockOk({ reviewId: String(args.reviewId ?? ""), state: "PENDING", updateTime: null, mock: true, note: "Mock mode — nothing was sent to Google." });
      case "create_post":
        try {
          return mockOk({ post: buildLocalPost(postInput(args)), state: "LIVE", mock: true, note: "Mock mode — nothing was sent to Google." });
        } catch (err) {
          return { ...liveFailure(err, this.displayName), mock: true };
        }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}

function postInput(args: Record<string, unknown>): GbpPostInput {
  return {
    topicType: (String(args.topicType ?? "update").toLowerCase() as GbpPostInput["topicType"]),
    title: args.title as string | undefined,
    summary: String(args.summary ?? ""),
    actionUrl: (args.actionUrl as string | undefined) ?? null,
    startDate: (args.startDate as string | undefined) ?? null,
    endDate: (args.endDate as string | undefined) ?? null,
  };
}
