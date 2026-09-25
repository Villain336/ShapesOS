// Marketr — GET /api/mail/providers
//
// List the workspace's mail provider connections. Key material is NEVER
// returned — only hints, mode, and health.

import { prisma } from "@/lib/prisma";
import { mailGuard } from "../_lib";

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

export async function GET() {
  const gate = await mailGuard("viewer");
  if (gate instanceof Response) return gate;

  const rows = await prisma.mailProvider.findMany({
    where: { workspaceId: gate.workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return Response.json({ providers: rows.map(redact), workspaceId: gate.workspaceId });
}
