// Marketr — /api/mail/providers/[id]
// GET    → one connection (redacted)
// DELETE → disconnect (deletes the row; campaigns keep working in test mode)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { mailGuard, badRequest } from "../../_lib";
import { getMailProviderRow } from "@/lib/mail/service";

export const dynamic = "force-dynamic";

function redact(row: {
  id: string;
  provider: string;
  mode: string;
  testKeyEnc: string | null;
  liveKeyEnc: string | null;
  webhookSecretEnc: string | null;
  health: string;
  healthCheckedAt: Date | null;
  healthMessage: string | null;
}) {
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    hasTestKey: !!row.testKeyEnc,
    hasLiveKey: !!row.liveKeyEnc,
    hasWebhookSecret: !!row.webhookSecretEnc,
    health: row.health,
    healthCheckedAt: row.healthCheckedAt,
    healthMessage: row.healthMessage,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const row = await getMailProviderRow(gate.workspaceId, id);
    return Response.json({ provider: redact(row) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Not found" }, { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    await getMailProviderRow(gate.workspaceId, id);
    await prisma.mailProvider.delete({ where: { id } });
    return Response.json({ disconnected: true });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Disconnect failed");
  }
}
