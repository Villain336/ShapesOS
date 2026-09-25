// Marketr — Phase 5 A1: POST /api/media/qr/validate
//
// Execution-time re-verification for a print-locked QR asset (feeds the S3
// executor pre-flight "re-hash creatives" check): byte-identity against the
// bound sha256 hash plus a real decoder scan test against the exact target
// URL. Design-time checks (contrast, finder integrity, glyph fill, quiet
// zone) were proven when the asset was print-locked; here we prove THESE
// bytes are THOSE bytes and still decode.

import { listDir, readFile } from "@/lib/filesystem/service";
import { computeQrAssetHash, scanTestQr } from "@/lib/studio/qr-designer";
import { badRequest, mediaGuard, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function resolveAssetBytes(workspaceId: string, assetHash: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{64}$/i.test(assetHash)) return null;
  const listing = await listDir({ workspaceId, prefix: "/files/studio/qr" });
  const name = `${assetHash.toLowerCase()}.png`;
  const file = listing.files.find((f) => f.filename.toLowerCase() === name || f.logicalPath.endsWith(`/${name}`));
  if (!file) return null;
  const got = await readFile({ workspaceId, fileId: file.id });
  return got?.bytes ?? null;
}

export async function POST(req: Request) {
  const g = await mediaGuard("viewer");
  if (g instanceof Response) return g;
  const body = await readJson(req);

  const targetUrl = str(body.targetUrl);
  if (!targetUrl) return badRequest("targetUrl is required.");

  let bytes: Buffer | null = null;
  const assetHash = str(body.assetHash);
  const pngBase64 = str(body.pngBase64);
  if (assetHash) {
    bytes = await resolveAssetBytes(g.workspaceId, assetHash);
    if (!bytes) return badRequest("Unknown QR asset hash in this workspace.", { assetHash });
  } else if (pngBase64) {
    try {
      bytes = Buffer.from(pngBase64, "base64");
    } catch {
      return badRequest("pngBase64 is not valid base64.");
    }
    if (bytes.length === 0) return badRequest("pngBase64 decoded to empty bytes.");
  } else {
    return badRequest("Provide assetHash (print-locked) or pngBase64.");
  }

  const expectedHash = str(body.expectedHash)?.toLowerCase() ?? null;
  const hash = computeQrAssetHash(bytes);
  const hashMatches = expectedHash ? hash === expectedHash : null;
  const scan = scanTestQr(bytes, targetUrl.trim());
  const ok = scan.passed && (hashMatches ?? true);

  return Response.json({
    ok,
    hash,
    expectedHash,
    hashMatches,
    scanTest: scan,
    message: ok
      ? "Asset verified: bytes match the bound hash and decode to the exact target URL."
      : !scan.passed
        ? "HALT — the asset does not decode to the exact target URL."
        : "HALT — asset bytes do not match the bound creative hash.",
  });
}
