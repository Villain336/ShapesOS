// Marketr — POST /api/mail/providers/connect
//
// Connect a mail provider (Lob or PostGrid).
//   { provider: "lob" | "postgrid", key, mode?: "test" | "live",
//     webhookSecret? }
//
// Flow: test key FIRST. The key is validated against the provider's test
// endpoint before anything is stored; live keys are allowed but stored
// with the mode flag and the UI must show the mode. Keys are encrypted via
// lib/secrets before storage; validation errors never echo key material.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { mailGuard, badRequest } from "../../_lib";
import { LobProvider } from "@/lib/mail/lob";
import { PostGridProvider } from "@/lib/mail/postgrid";
import { ProviderNotConfiguredError } from "@/lib/mail/provider";

export const dynamic = "force-dynamic";

const ConnectSchema = z.object({
  provider: z.enum(["lob", "postgrid"]),
  key: z.string().trim().min(8).max(500),
  mode: z.enum(["test", "live"]).default("test"),
  webhookSecret: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = ConnectSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const { provider, key, mode, webhookSecret } = parsed.data;

  // Validate the key against the provider BEFORE storing anything.
  // Test mode: validated via the test endpoint (render-only).
  // Live mode: validated via a cheap read against the live API.
  try {
    const candidate =
      provider === "lob"
        ? new LobProvider(key)
        : new PostGridProvider(key);
    const check = await candidate.validateConnection();
    if (!check.ok) return badRequest(`${provider}: key validation failed`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "validation failed";
    // Never echo key material.
    return badRequest(`${provider}: ${msg.slice(0, 300)}`);
  }

  const enc = secrets();
  const data = {
    workspaceId: gate.workspaceId,
    provider,
    mode,
    testKeyEnc: mode === "test" ? enc.encrypt(key) : undefined,
    liveKeyEnc: mode === "live" ? enc.encrypt(key) : undefined,
    webhookSecretEnc: webhookSecret ? enc.encrypt(webhookSecret) : undefined,
    health: "healthy",
    healthCheckedAt: new Date(),
    healthMessage: mode === "test" ? "Test key validated (render-only)" : "Live key validated — real postage possible",
  };

  try {
    const row = await prisma.mailProvider.upsert({
      where: { workspaceId_provider: { workspaceId: gate.workspaceId, provider } },
      create: data,
      update: {
        mode,
        ...(mode === "test" ? { testKeyEnc: data.testKeyEnc } : { liveKeyEnc: data.liveKeyEnc }),
        ...(webhookSecret ? { webhookSecretEnc: data.webhookSecretEnc } : {}),
        health: "healthy",
        healthCheckedAt: new Date(),
        healthMessage: data.healthMessage,
      },
    });
    return Response.json(
      {
        provider: {
          id: row.id,
          provider: row.provider,
          mode: row.mode,
          hasTestKey: !!row.testKeyEnc,
          hasLiveKey: !!row.liveKeyEnc,
          hasWebhookSecret: !!row.webhookSecretEnc,
          health: row.health,
          healthCheckedAt: row.healthCheckedAt,
        },
        live: mode === "live",
        warning:
          mode === "live"
            ? "LIVE mode — this key can spend real postage. Live sends still require an approved MailApproval."
            : null,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) return badRequest(e.message);
    return badRequest("Could not store provider connection");
  }
}
