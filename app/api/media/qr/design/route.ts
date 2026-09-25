// Marketr — Phase 5 A1: POST /api/media/qr/design
//
// Chat-first QR designer endpoint: natural-language style request ->
// styled QR rendered on the REAL matrix -> automated validation ->
// real scan test -> print-lock (sha256) on success.
//
// The styling layer never touches the encoded data. A design that fails
// validation or the scan test returns ok:false with named reasons (and the
// bolder auto-regenerated variant when that passes); it is NEVER
// print-locked and can never reach the per-buy approval object.

import { prisma } from "@/lib/prisma";
import { auditStudio } from "@/lib/studio/service";
import {
  designQr,
  printLockQr,
  QrDesignerError,
  type BrandContext,
  type ModuleGlyphKind,
  type ShapeMask,
  type FinderStyle,
} from "@/lib/studio/qr-designer";
import { badRequest, mediaGuard, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export async function POST(req: Request) {
  const g = await mediaGuard("editor");
  if (g instanceof Response) return g;
  const body = await readJson(req);

  const targetUrl = str(body.targetUrl);
  const stylePrompt = str(body.stylePrompt);
  if (!targetUrl) return badRequest("targetUrl is required.");
  if (!stylePrompt) return badRequest("stylePrompt is required — describe the look in natural language.");

  const brand = body.brand as BrandContext | undefined;
  const shapeMask = str(body.shapeMask) as ShapeMask | undefined;
  if (shapeMask && !["square", "round"].includes(shapeMask)) return badRequest('shapeMask must be "square" or "round".');
  const finderStyle = str(body.finderStyle) as FinderStyle | undefined;
  const glyphKind = str(body.glyphKind) as ModuleGlyphKind | undefined;
  if (glyphKind && !["square", "rounded", "dots", "custom-svg"].includes(glyphKind)) {
    return badRequest('glyphKind must be one of "square" | "rounded" | "dots" | "custom-svg".');
  }

  let result;
  try {
    result = await designQr({
      targetUrl,
      stylePrompt,
      brand,
      shapeMask,
      finderStyle,
      glyphKind,
      customGlyphSvg: str(body.customGlyphSvg),
      customGlyphLabel: str(body.customGlyphLabel),
      frameCta: str(body.frameCta),
      logoDataUrl: str(body.logoDataUrl),
    });
  } catch (err) {
    if (err instanceof QrDesignerError) return badRequest(err.message);
    throw err;
  }

  // Print-lock ONLY a fully verified design. The lock hash is what the
  // per-buy approval object binds (spec §4 tracking_links qr_png_url).
  let lock: Awaited<ReturnType<typeof printLockQr>> | null = null;
  if (result.ok && result.png && result.validation?.ok && result.scanTest.passed) {
    try {
      lock = await printLockQr({
        workspaceId: g.workspaceId,
        result,
        targetUrl,
        createdBy: g.userId,
      });
      await auditStudio(
        prisma,
        g.workspaceId,
        null,
        "studio_qr_print_locked",
        `QR print-locked for ${targetUrl} (${result.spec.glyphLabel}, ${result.spec.shapeMask} mask) — sha256 ${lock.hash.slice(0, 12)}….`,
        "user",
      );
    } catch (err) {
      if (err instanceof QrDesignerError) return badRequest(err.message);
      throw err;
    }
  } else {
    await auditStudio(
      prisma,
      g.workspaceId,
      null,
      "studio_qr_designed",
      `QR design attempt for ${targetUrl} did not verify: ${(result.validation?.issues ?? []).map((i) => i.code).join(", ") || result.fatal || "unknown"}.`,
      "user",
    );
  }

  return Response.json({
    ok: result.ok,
    regenerated: result.regenerated,
    attempts: result.attempts,
    fatal: result.fatal ?? null,
    spec: {
      moduleGlyph: result.spec.moduleGlyph,
      glyphLabel: result.spec.glyphLabel,
      shapeMask: result.spec.shapeMask,
      foreground: result.spec.foreground,
      background: result.spec.background,
      finderStyle: result.spec.finderStyle,
      frameCta: result.spec.frameCta,
      errorCorrection: result.spec.errorCorrection,
      quietZoneModules: result.spec.quietZoneModules,
      fillFraction: result.spec.fillFraction,
      hasLogo: !!result.spec.logoImagePng,
    },
    matrix: result.matrix,
    validation: result.validation,
    scanTest: result.scanTest,
    previewPng: result.png ? `data:image/png;base64,${result.png.toString("base64")}` : null,
    svg: result.svg,
    lock: lock
      ? {
          hash: lock.hash,
          qrPngUrl: lock.qrPngUrl,
          pngPath: lock.pngPath,
          svgPath: lock.svgPath,
          targetUrl: lock.targetUrl,
          validatedAt: lock.validatedAt,
        }
      : null,
  });
}
