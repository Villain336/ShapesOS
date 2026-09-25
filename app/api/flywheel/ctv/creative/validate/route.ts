// Marketr — POST /api/flywheel/ctv/creative/validate
//
// ffprobe-based creative validation (IAB Tech Lab Dec 2025 draft + optional
// publisher tightening). BLOCKS submission of non-compliant creative: the
// response carries pass=false and the named failing checks; callers must
// refuse to attach the creative to a buy. Results are persisted +
// audit-logged.
//
// Body: { fileId? | videoPath?, campaignId?, creativeId?, publisher? }
// - fileId: workspace file (files service) — preferred
// - videoPath: absolute /tmp path (dev/test ingestion only)

import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../../_lib";
import {
  validateCreative,
  assertCreativePasses,
} from "@/lib/flywheel/ctv/validator";
import { rulesForPublisher, getPublisherRule } from "@/lib/flywheel/ctv/publisher-rules";
import { resolveCtvStore } from "@/lib/flywheel/ctv/store";
import { readFile as readWorkspaceFile } from "@/lib/filesystem/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ValidateSchema = z.object({
  fileId: z.string().trim().min(1).max(128).optional(),
  videoPath: z.string().trim().min(1).max(512).optional(),
  campaignId: z.string().trim().min(1).max(64).optional(),
  creativeId: z.string().trim().min(1).max(128).optional(),
  publisher: z.string().trim().min(1).max(64).optional(),
}).refine((d) => d.fileId || d.videoPath, { message: "fileId or videoPath is required" });

async function resolveBytes(
  workspaceId: string,
  d: z.infer<typeof ValidateSchema>,
): Promise<{ bytes: Buffer; label: string }> {
  if (d.fileId) {
    const got = await readWorkspaceFile({ workspaceId, fileId: d.fileId });
    if (!got) throw new Error("File not found in workspace");
    return { bytes: got.bytes, label: got.meta.filename };
  }
  // videoPath: restricted to /tmp ingestion (dev/test). Never arbitrary paths.
  const p = d.videoPath!;
  if (!p.startsWith(tmpdir() + "/")) {
    throw new Error("videoPath is restricted to the OS temp dir (use fileId for workspace files)");
  }
  const { readFile } = await import("node:fs/promises");
  return { bytes: await readFile(p), label: p };
}

export async function POST(req: NextRequest) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const parsed = ValidateSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const d = parsed.data;

  if (d.publisher && !getPublisherRule(d.publisher)) {
    return badRequest(`Unknown publisher "${d.publisher}". Known: tubi, roku, pluto, freevee, hulu, peacock, samsung, lg, vibe-network.`);
  }

  try {
    const { bytes, label } = await resolveBytes(gate.workspaceId, d);
    const tmpPath = join(tmpdir(), `ctv-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    await writeFile(tmpPath, bytes);
    let validation;
    try {
      const rules = rulesForPublisher(d.publisher);
      validation = await validateCreative(tmpPath, { publisher: d.publisher, publisherRules: rules });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }

    const sha = createHash("sha256").update(bytes).digest("hex");
    const store = await resolveCtvStore();
    const creativeId = d.creativeId ?? `file:${label}`;
    const row = await store.createValidation({
      workspaceId: gate.workspaceId,
      campaignId: d.campaignId ?? null,
      creativeId,
      creativeSha256: sha,
      ffprobeJson: validation.probe,
      pass: validation.pass,
      checks: validation.checks,
      durationSeconds: validation.durationSeconds,
      publisher: d.publisher ?? null,
      publisherRulesVersion: validation.publisherRulesVersion,
      validatedBy: gate.userId,
    });
    await store.audit({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "creative_validated",
      subjectType: "creative", subjectId: row.id,
      detail: { creativeId, pass: validation.pass, sha256: sha, failing: validation.checks.filter((c) => !c.passed).map((c) => c.name) },
    });

    // Fail-closed helper exercised here too: the response states pass; the
    // route does NOT throw (the UI needs the named failures). attach-spot
    // and buy paths call assertCreativePasses() and hard-block.
    void assertCreativePasses;
    return Response.json({ validation: row, pass: validation.pass, checks: validation.checks });
  } catch (err) {
    return safetyError(err);
  }
}
