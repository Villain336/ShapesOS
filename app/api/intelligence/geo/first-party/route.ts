// Marketr — Phase 10 M3 API: first-party correlation signals.
// GET /api/intelligence/geo/first-party?projectId=…&brandDomain=… (viewer+)
//
// Returns the honest anchors for AI-visibility estimates:
//   - GSC AI-Overview impressions (M1 gsc_snapshot; honest empty when unflagged)
//   - GA4 AI-referrer traffic (adapter is MOCK-ONLY today → labeled)
//   - AI-crawler log shipping docs pointer (the user ships logs; we parse them)

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { gscAiOverviewReport, summarizeAiReferrers } from "@/lib/intelligence/geo/first-party";
import { searchBrandedMentions } from "@/lib/intelligence/geo/mentions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const params = new URL(req.url).searchParams;
  const projectId = params.get("projectId") ?? "";
  const brand = (params.get("brand") ?? "").trim();
  const brandDomain = (params.get("brandDomain") ?? "").trim();
  // ?licensedNews=1 → also query the licensed news adapter (off by default,
  // graceful when M3_LICENSED_NEWS_PROVIDER / M3_NEWSAPI_KEY are unset).
  const includeLicensed = params.get("licensedNews") === "1";

  const gsc = projectId
    ? await gscAiOverviewReport(workspace.id, projectId)
    : {
        windows: [],
        totalImpressions: 0,
        totalClicks: 0,
        noAioRowsFlagged: true,
        note: "No projectId — connect a project with GSC snapshots for AI-Overview impressions.",
      };

  // GA4 adapter is MOCK-ONLY today: report the honest empty, not demo numbers.
  const ga4 = summarizeAiReferrers([]);

  const mentions =
    brand && brandDomain
      ? await searchBrandedMentions(brand, brandDomain, {
          includeLicensed,
          workspaceId: workspace.id,
        })
      : [];

  return Response.json({
    gsc,
    ga4: {
      ...ga4,
      note: "GA4 connector is MOCK-ONLY today. Connect GA4 (official API) and this endpoint will report live AI-referrer sessions.",
    },
    crawlerLogs: {
      note: "Ship your server logs to Marketr to track AI-crawler activity (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Bytespider) — the preceding indicator of citing.",
      docs: "/docs/ai-visibility-log-shipping.md",
    },
    brandedMentions: mentions,
  });
}
