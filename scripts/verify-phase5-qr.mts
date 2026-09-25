// Marketr — Phase 5 A1 verification: chat-generated QR designer.
//
// 1. Styled QR (custom snake glyph + round mask + brand colors + logo),
//    target https://example.com/board-47 → validation must PASS.
// 2. (same run) automated validation passes.
// 3. Real decoder (jsqr) must decode the EXACT target URL.
// 4. Deliberately ultra-thin glyph → validation must FAIL with a named reason.
// 5. Finder-tampering attempt (foreground == background) → rejected; the
//    print-lock gate must refuse it.
// Run: npx tsx scripts/verify-phase5-qr.mts

import { PNG } from "pngjs";
import {
  designQr,
  generateQrMatrix,
  renderStyledQr,
  validateRenderedQr,
  glyphFromLlmSvg,
  printLockQr,
  computeQrAssetHash,
  QrDesignerError,
  type QrStyleSpec,
} from "../lib/studio/qr-designer";

const TARGET = "https://example.com/board-47";
let failures = 0;

function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Placeholder brand logo: 64x64 PNG with a purple disc on white. */
function placeholderLogoDataUrl(): string {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (64 * y + x) << 2;
      const dx = x - 32;
      const dy = y - 32;
      const inDisc = dx * dx + dy * dy <= 26 * 26;
      png.data[i] = inDisc ? 124 : 255;
      png.data[i + 1] = inDisc ? 58 : 255;
      png.data[i + 2] = inDisc ? 237 : 255;
      png.data[i + 3] = 255;
    }
  }
  return "data:image/png;base64," + PNG.sync.write(png).toString("base64");
}

const thinRectSvg = "M0.02,0.48 L0.98,0.48 L0.98,0.52 L0.02,0.52 Z";

function baseSpec(over: Partial<QrStyleSpec> = {}): QrStyleSpec {
  return {
    moduleGlyph: "custom-svg",
    glyphLabel: "test glyph",
    shapeMask: "round",
    foreground: "#7C3AED",
    background: "#FFFFFF",
    finderStyle: "solid",
    logoImagePng: null,
    frameCta: null,
    errorCorrection: "H",
    quietZoneModules: 4,
    fillFraction: 0.5,
    ...over,
  };
}

// ── Case 1–3: end-to-end styled design ────────────────────────────────────────
const designed = await designQr({
  targetUrl: TARGET,
  stylePrompt: "round QR, modules as little snakes, brand purple #7C3AED on white, logo in the center",
  brand: { foreground: "#7C3AED", background: "#FFFFFF", logoDataUrl: placeholderLogoDataUrl() },
});

check("case 1 — styled design verifies (snake glyph + round mask + brand colors + logo)", designed.ok, designed.attempts.join(" | "));
check("case 1b — no bolder fallback needed (first attempt passed)", !designed.regenerated);
check("case 2 — automated validation ok", !!designed.validation?.ok, `contrast ${designed.validation?.metrics.contrastRatio.toFixed(2)}:1, fill ${(100 * (designed.validation?.metrics.meanGlyphFill ?? 0)).toFixed(0)}%, finders ${(100 * (designed.validation?.metrics.finderMatchPct ?? 0)).toFixed(1)}%`);
check(
  "case 3 — real decoder returns the EXACT target URL",
  designed.scanTest.passed && designed.scanTest.decoded === TARGET,
  `decoded: ${designed.scanTest.decoded}`,
);

// Hash determinism (the binding value for the approval object).
if (designed.png) {
  const h1 = computeQrAssetHash(designed.png);
  const h2 = computeQrAssetHash(designed.png);
  check("hash — sha256 deterministic over PNG bytes", h1 === h2 && /^[0-9a-f]{64}$/.test(h1), h1.slice(0, 16) + "…");
} else {
  check("hash — sha256 deterministic over PNG bytes", false, "no PNG rendered");
}

// ── Case 4: ultra-thin glyph must FAIL validation with a named reason ────────
{
  const matrix = generateQrMatrix(TARGET);
  const thin = glyphFromLlmSvg(thinRectSvg, { label: "hairline", fillFraction: 0.04, minFeatureWidth: 0.04 });
  const spec = baseSpec({ shapeMask: "square", glyphLabel: "hairline", fillFraction: thin.fillFraction });
  const rendered = renderStyledQr(matrix, spec, thin, { modulePx: 14 });
  const v = validateRenderedQr(rendered, matrix, spec, TARGET);
  const named = v.issues.some((i) => i.code === "glyph-too-thin");
  check("case 4 — ultra-thin glyph FAILS validation", !v.ok, `fill ${(100 * v.metrics.meanGlyphFill).toFixed(1)}%`);
  check("case 4b — failure names the reason (glyph-too-thin)", named, v.issues.map((i) => i.code).join(","));
  check("case 4c — thin glyph does NOT decode", !v.metrics.decodeOk);
}

// ── Case 5: finder-tampering attempt (invisible finders) is rejected ─────────
{
  const matrix = generateQrMatrix(TARGET);
  const spec = baseSpec({ shapeMask: "square", foreground: "#FFFFFF", background: "#FFFFFF", glyphLabel: "squares", moduleGlyph: "square", fillFraction: 1 });
  const { designGlyph } = await import("../lib/studio/qr-designer");
  const rendered = renderStyledQr(matrix, spec, designGlyph("square"), { modulePx: 14 });
  const v = validateRenderedQr(rendered, matrix, spec, TARGET);
  const codes = v.issues.map((i) => i.code);
  check("case 5 — tampered style (fg == bg) FAILS validation", !v.ok, codes.join(","));
  check(
    "case 5b — failure names contrast and/or finder damage",
    codes.includes("contrast-too-low") || codes.includes("finder-pattern-damaged"),
    codes.join(","),
  );

  // The print-lock gate must refuse an unverified design.
  const badResult = await designQr({
    targetUrl: TARGET,
    stylePrompt: "invisible",
    brand: { foreground: "#FFFFFF", background: "#FFFFFF" },
  });
  check("case 5c — tampered design never verifies (even after regen)", !badResult.ok);
  let threw = false;
  try {
    await printLockQr({
      workspaceId: "ws_test",
      result: badResult,
      targetUrl: TARGET,
      createdBy: "test",
      storeFile: async () => ({ fileId: "stub" }),
    });
  } catch (err) {
    threw = err instanceof QrDesignerError;
  }
  check("case 5d — printLockQr REFUSES unverified designs", threw);
}

// ── Case 6: print-lock succeeds for the verified design (stubbed store) ──────
{
  let threw = false;
  let lock: Awaited<ReturnType<typeof printLockQr>> | null = null;
  try {
    lock = await printLockQr({
      workspaceId: "ws_test",
      result: designed,
      targetUrl: TARGET,
      createdBy: "test",
      storeFile: async () => ({ fileId: "stub" }),
    });
  } catch {
    threw = true;
  }
  check("case 6 — verified design print-locks with sha256", !threw && !!lock && /^[0-9a-f]{64}$/.test(lock.hash), lock ? lock.hash.slice(0, 16) + "…" : "threw");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
