// Marketr — POST /api/mail/providers/[id]/health
//
// Re-validate the stored key against the provider and update the health
// fields. Never returns key material.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { mailGuard, badRequest } from "../../../_lib";
import { getMailProviderRow } from "@/lib/mail/service";
import { LobProvider } from "@/lib/mail/lob";
import { PostGridProvider } from "@/lib/mail/postgrid";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let row;
  try {
    row = await getMailProviderRow(gate.workspaceId, id);
  } catch {
    return Response.json({ error: "Mail provider not found" }, { status: 404 });
  }

  const enc = row.mode === "live" ? row.liveKeyEnc : row.testKeyEnc;
  if (!enc) {
    await prisma.mailProvider.update({
      where: { id: row.id },
      data: { health: "unconfigured", healthCheckedAt: new Date(), healthMessage: `No ${row.mode} key stored` },
    });
    return badRequest(`No ${row.mode} key stored for this provider`);
  }

  let key: string;
  try {
    key = secrets().decrypt(enc);
  } catch {
    await prisma.mailProvider.update({
      where: { id: row.id },
      data: { health: "error", healthCheckedAt: new Date(), healthMessage: "Stored key could not be decrypted" },
    });
    return badRequest("Stored key could not be decrypted");
  }

  try {
    const provider = row.provider === "lob" ? new LobProvider(key) : new PostGridProvider(key);
    const check = await provider.validateConnection();
    await prisma.mailProvider.update({
      where: { id: row.id },
      data: {
        health: check.ok ? "healthy" : "degraded",
        healthCheckedAt: new Date(),
        healthMessage: check.detail ?? null,
      },
    });
    return Response.json({ ok: check.ok, health: check.ok ? "healthy" : "degraded", detail: check.detail });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "health check failed").slice(0, 300);
    await prisma.mailProvider.update({
      where: { id: row.id },
      data: { health: "error", healthCheckedAt: new Date(), healthMessage: msg },
    });
    return Response.json({ ok: false, health: "error", detail: msg }, { status: 502 });
  }
}
