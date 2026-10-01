// Marketr — Phase 18 slices 4–5: manual-or-CSV spend import → AdReport.
// POST /api/ads/guided/import { accountId, csv } → { ok, batchId, upserted, skippedNoCampaign }
//
// The guided reporting path: the user exports spend from the platform's ad
// manager, pastes/uploads the CSV, and rows land in AdReport via the
// slice-1 ingest. Lineage: platformReceiptId = "import:<batchId>";
// approvalId is null — this is a report, not a spend action, and no
// SpendApproval authorizes it. Rows whose campaign_external_id matches no
// registered campaign are counted as skipped, never misattributed.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  WalmartGuidedError,
  buildWalmartImportInput,
} from "@/lib/adplatforms/walmart/guided";
import {
  SpotifyGuidedError,
  buildSpotifyImportInput,
} from "@/lib/adplatforms/spotify/guided";
import { AdReportError, ingestAdReportRows } from "@/lib/adplatforms/reporting";

const MAX_CSV_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { accountId?: string; csv?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  if (typeof body.csv !== "string" || !body.csv.trim()) {
    return NextResponse.json({ error: "csv is required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.csv, "utf8") > MAX_CSV_BYTES) {
    return NextResponse.json({ error: "CSV is too large (2 MB max)" }, { status: 400 });
  }

  const account = await prisma.adAccount.findFirst({
    where: { id: body.accountId, workspaceId: workspace.id },
    include: { platform: { select: { key: true, displayName: true } } },
  });
  if (!account) return NextResponse.json({ error: "Ad account not found" }, { status: 404 });
  if (account.platform.key !== "walmart" && account.platform.key !== "spotify") {
    return NextResponse.json(
      { error: `Spend import is only supported for guided platforms (not "${account.platform.displayName}")` },
      { status: 400 },
    );
  }

  const batchId = randomUUID();
  try {
    const ingestInput =
      account.platform.key === "walmart"
        ? buildWalmartImportInput({
            workspaceId: workspace.id,
            accountId: account.id,
            csv: body.csv,
            batchId,
          })
        : buildSpotifyImportInput({
            workspaceId: workspace.id,
            accountId: account.id,
            csv: body.csv,
            batchId,
          });
    const result = await ingestAdReportRows(ingestInput);
    return NextResponse.json({ ok: true, batchId, ...result });
  } catch (e) {
    if (e instanceof WalmartGuidedError || e instanceof SpotifyGuidedError || e instanceof AdReportError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not import the spend CSV" }, { status: 500 });
  }
}
