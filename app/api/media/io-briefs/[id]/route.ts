// Marketr — GET/PATCH /api/media/io-briefs/[id] (Phase 5 B3).
//
// Signature tracking: the rep keeps the signature; Marketr tracks
// draft → sent_to_rep → signed → proof_received (cancelled from any
// state). Proof-of-run capture closes the loop (proof_of_run_url).
// PATCH is editor+; GET is viewer+.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../../_lib";
import { SqlIoBriefStore, appendBuyingEvent, buyingTablesReady } from "@/lib/media/buying-store";
import { IO_SIGNATURE_FLOW, type IoSignatureStatus } from "@/lib/media/io-briefs";

export const dynamic = "force-dynamic";

const RepContactSchema = z.object({
  name: z.string().min(1),
  company: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  rateCardRef: z.string().max(200).optional(),
});

const PatchSchema = z.object({
  signatureStatus: z.enum(["draft", "sent_to_rep", "signed", "proof_received", "cancelled"]).optional(),
  repContact: RepContactSchema.nullable().optional(),
  proofOfRunUrl: z.string().max(2000).nullable().optional(),
});

const FLOW_INDEX: Record<IoSignatureStatus | "cancelled", number> = {
  draft: 0,
  sent_to_rep: 1,
  signed: 2,
  proof_received: 3,
  cancelled: -1,
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated." }, { status: 503 });
  }
  const store = new SqlIoBriefStore();
  const brief = await store.get(id, gate.workspaceId);
  if (!brief) return Response.json({ error: "IO brief not found" }, { status: 404 });
  return Response.json({ brief, signatureFlow: IO_SIGNATURE_FLOW });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated." }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  const store = new SqlIoBriefStore();
  const brief = await store.get(id, gate.workspaceId);
  if (!brief) return Response.json({ error: "IO brief not found" }, { status: 404 });

  const { signatureStatus, repContact, proofOfRunUrl } = parsed.data;
  if (signatureStatus) {
    const from = brief.signatureStatus as IoSignatureStatus | "cancelled";
    const to = signatureStatus as IoSignatureStatus | "cancelled";
    // Forward-only along the signature flow; "cancelled" is reachable from
    // any state; re-opening a signed brief requires a new brief (honest IO
    // semantics — a signed IO is a contract).
    if (to !== "cancelled" && from !== "cancelled" && FLOW_INDEX[to] < FLOW_INDEX[from]) {
      return badRequest(
        `Cannot move signature status backwards (${from} → ${to}). Issue a new brief for changed terms.`,
      );
    }
    if (from === "cancelled" && to !== "cancelled") {
      return badRequest("A cancelled brief cannot be re-opened — issue a new brief.");
    }
    if (to === "signed" && !brief.repContact && !repContact) {
      return badRequest("Attach the rep contact before marking the brief signed.");
    }
    if (to === "proof_received" && !proofOfRunUrl && !brief.proofOfRunUrl) {
      return badRequest("Attach the proof-of-run URL when marking proof received.");
    }
  }

  const updated = await store.updateSignature(id, gate.workspaceId, {
    signatureStatus,
    repContact: repContact === undefined ? undefined : (repContact as unknown as Record<string, unknown> | null),
    proofOfRunUrl: proofOfRunUrl === undefined ? undefined : proofOfRunUrl,
  });

  // Buying-lifecycle audit (append-only): io_brief.<transition>.
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: `io_brief.${signatureStatus ?? "updated"}`,
    entityType: "io_brief",
    entityId: id,
    payloadHash: null,
    detail: { from: brief.signatureStatus, to: signatureStatus ?? brief.signatureStatus, proofOfRun: Boolean(proofOfRunUrl) },
  });
  return Response.json({ brief: updated });
}
