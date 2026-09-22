// Marketr upload safety — adversarial verification (Phase A, fix 5).
//
// Run: npx tsx scripts/verify-upload-safety.mts
// Run 3x green before calling this done.
//
// Covers lib/security/upload-safety.ts + lib/security/malware-scan.ts:
//  1. Allow-list: images (png/jpeg/gif/webp/svg), PDF, text (txt/md/csv),
//     office (docx/xlsx/pptx) — everything else rejected with plain language.
//  2. Magic-byte verification: extension/MIME alone never trusted.
//  3. Size caps enforced via validateUploadBuffer.
//  4. EICAR test string blocked (built-in tripwire, no ClamAV needed).
//  5. SVG active content + raster-image polyglots rejected.
//  6. Filename/path hardening: safeFilename + resolveWithinDir.
//  7. Malware scanner: no-op stub when unconfigured, fail-closed ClamAV.
//
// No DB, no network (except a refused localhost connection for the
// fail-closed check), no live third-party calls.

import {
  containsEicar,
  imageLooksPolyglot,
  isTextualBuffer,
  resolveWithinDir,
  safeFilename,
  sniffFileKind,
  svgLooksDangerous,
  validateUploadBuffer,
  type UploadCategory,
} from "@/lib/security/upload-safety";
import {
  ClamAvScanner,
  getMalwareScanner,
  resetMalwareScannerForTests,
} from "@/lib/security/malware-scan";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MB25 = 25 * 1024 * 1024;

// ---- fixture builders -------------------------------------------------

function pngBuf(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
    Buffer.alloc(32, 0),
  ]);
}
function jpgBuf(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.alloc(64, 0),
  ]);
}
function gifBuf(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(32, 0)]);
}
function webpBuf(): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(40, 0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), size, Buffer.from("WEBP", "ascii"), Buffer.from("VP8 ", "ascii"), Buffer.alloc(32, 0)]);
}
function pdfBuf(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n", "utf8");
}
function svgCleanBuf(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    "utf8",
  );
}
function svgEvilBuf(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );
}
function zipBuf(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)]);
}
function exeBuf(): Buffer {
  // MZ header + NULs + high-entropy-ish filler: unmistakably binary.
  return Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(128, 0), Buffer.from([0x90, 0x90, 0x90])]);
}
const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function validate(buf: Buffer, filename: string, category: UploadCategory, maxBytes = MB25) {
  return validateUploadBuffer(buf, { filename, maxBytes, category });
}

// ---- 1. allow-list + magic bytes ---------------------------------------

console.log("allow-list and magic-byte verification");
{
  const r = validate(pngBuf(), "photo.png", "default");
  check("valid PNG accepted", r.ok === true && r.mime === "image/png" && r.ext === "png", JSON.stringify(r));
}
{
  const r = validate(jpgBuf(), "photo.jpg", "default");
  check("valid JPEG accepted", r.ok === true && r.mime === "image/jpeg");
}
{
  const r = validate(gifBuf(), "anim.gif", "default");
  check("valid GIF accepted", r.ok === true && r.mime === "image/gif");
}
{
  const r = validate(webpBuf(), "img.webp", "default");
  check("valid WebP accepted", r.ok === true && r.mime === "image/webp");
}
{
  const r = validate(pdfBuf(), "doc.pdf", "default");
  check("valid PDF accepted", r.ok === true && r.mime === "application/pdf");
}
{
  const r = validate(svgCleanBuf(), "logo.svg", "default");
  check("clean SVG accepted", r.ok === true && r.mime === "image/svg+xml");
}
{
  const r = validate(zipBuf(), "report.docx", "default");
  check(
    "zip bytes named .docx accepted as Word doc",
    r.ok === true && r.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && r.ext === "docx",
    JSON.stringify(r),
  );
}
{
  const r = validate(Buffer.from("name,email\nTico,t@x.com\n", "utf8"), "data.csv", "text");
  check("valid CSV accepted (text category)", r.ok === true);
}
{
  const r = validate(Buffer.from("# Title\n\nSome *markdown*.\n", "utf8"), "notes.md", "text");
  check("valid Markdown accepted (text category)", r.ok === true);
}

// ---- 2. spoofed extensions / type confusion ------------------------------

console.log("spoofed extensions and type confusion");
{
  const r = validate(exeBuf(), "photo.png", "default");
  check("exe renamed to .png rejected", r.ok === false, JSON.stringify(r));
}
{
  const r = validate(exeBuf(), "run.exe", "default");
  check("plain .exe rejected", r.ok === false);
}
{
  const r = validate(pngBuf(), "photo.jpg", "default");
  check("PNG bytes named .jpg rejected (mismatch)", r.ok === false && /doesn't match/i.test(r.reason));
}
{
  const r = validate(jpgBuf(), "photo.jpeg", "default");
  check("JPEG bytes named .jpeg accepted (alias)", r.ok === true);
}
{
  const r = validate(zipBuf(), "backup.zip", "default");
  check("generic .zip rejected in default category", r.ok === false && /isn't allowed/i.test(r.reason));
}
{
  const r = validate(pdfBuf(), "doc.pdf", "images");
  check("PDF rejected in images-only category", r.ok === false);
}
{
  const binaryTxt = Buffer.concat([Buffer.from("hello", "utf8"), Buffer.from([0x00, 0x01, 0x02]), Buffer.alloc(64, 0xff)]);
  const r = validate(binaryTxt, "notes.txt", "text");
  check("binary blob named .txt rejected", r.ok === false);
  check("isTextualBuffer spots NUL bytes", isTextualBuffer(binaryTxt) === false);
}

// ---- 3. EICAR --------------------------------------------------------------

console.log("EICAR tripwire");
{
  check("EICAR string detected", containsEicar(Buffer.from(EICAR, "utf8")) === true);
  const r = validate(Buffer.from(EICAR, "utf8"), "test.txt", "default");
  check("EICAR as .txt blocked", r.ok === false && /malware/i.test(r.reason), JSON.stringify(r));
}
{
  const r = validate(Buffer.from(EICAR, "utf8"), "eicar.com", "default");
  check("EICAR as .com blocked", r.ok === false);
}

// ---- 4. active content / polyglots --------------------------------------------

console.log("active content and polyglots");
{
  check("evil SVG flagged", svgLooksDangerous(svgEvilBuf()) === true);
  check("clean SVG not flagged", svgLooksDangerous(svgCleanBuf()) === false);
  const r = validate(svgEvilBuf(), "logo.svg", "default");
  check("SVG with <script> rejected", r.ok === false && /active content/i.test(r.reason));
}
{
  const gifar = Buffer.concat([gifBuf(), Buffer.from("<html><script>alert(1)</script>", "utf8")]);
  check("GIFAR detected as polyglot", imageLooksPolyglot(gifar) === true);
  check("clean PNG not polyglot", imageLooksPolyglot(pngBuf()) === false);
  const r = validate(gifar, "anim.gif", "default");
  check("GIFAR rejected", r.ok === false && /embedded web content/i.test(r.reason));
}
{
  const pngPoly = Buffer.concat([pngBuf(), Buffer.from("<script>alert(1)</script>", "utf8")]);
  const r = validate(pngPoly, "photo.png", "default");
  check("PNG+script polyglot rejected", r.ok === false);
}

// ---- 5. size caps ---------------------------------------------------------------

console.log("size caps");
{
  const big = Buffer.concat([pngBuf(), Buffer.alloc(MB25, 0x41)]); // 25MB + 48B
  const r = validate(big, "big.png", "default", MB25);
  check("oversize file rejected", r.ok === false && /too large/i.test(r.reason) && /25 MB/.test(r.reason));
}
{
  const r = validate(Buffer.alloc(0), "empty.png", "default");
  check("empty file rejected", r.ok === false && /empty/i.test(r.reason));
}

// ---- 6. archive category (websites upload) -----------------------------------------

console.log("archive category");
{
  const r = validate(zipBuf(), "site.zip", "archive");
  check("zip accepted in archive category", r.ok === true && r.mime === "application/zip");
}
{
  const r = validate(Buffer.from("<!doctype html><html><body>hi</body></html>", "utf8"), "page.html", "archive");
  check("html accepted in archive category", r.ok === true && r.mime === "text/html");
}
{
  const r = validate(exeBuf(), "site.zip", "archive");
  check("exe renamed to .zip rejected", r.ok === false);
}
{
  const r = validate(zipBuf(), "site.zip", "default");
  check("zip rejected outside archive category", r.ok === false);
}

// ---- 7. sniffFileKind spot checks ---------------------------------------------------

console.log("sniffFileKind");
{
  check("sniff png", sniffFileKind(pngBuf())?.mime === "image/png");
  check("sniff jpeg", sniffFileKind(jpgBuf())?.mime === "image/jpeg");
  check("sniff gif", sniffFileKind(gifBuf())?.mime === "image/gif");
  check("sniff webp", sniffFileKind(webpBuf())?.mime === "image/webp");
  check("sniff pdf", sniffFileKind(pdfBuf())?.mime === "application/pdf");
  check("sniff zip", sniffFileKind(zipBuf())?.mime === "application/zip");
  check("sniff exe → null", sniffFileKind(exeBuf()) === null);
}

// ---- 8. filename / path hardening -----------------------------------------------------

console.log("filename and path hardening");
{
  check("traversal stripped to basename", safeFilename("../../etc/passwd") === "passwd", safeFilename("../../etc/passwd"));
  check("windows traversal stripped", safeFilename("..\\..\\win.ini") === "win.ini");
  check("unsafe chars replaced", safeFilename("my file (1).png") === "my_file_1_.png");
  check("long names bounded", safeFilename("a".repeat(200) + ".png").length <= 120);
  check("empty → fallback", safeFilename("...") === "file");
}
{
  const abs = resolveWithinDir("/base/dir", "x.png");
  check("resolveWithinDir joins", abs === "/base/dir/x.png", abs);
  let threw = false;
  try {
    resolveWithinDir("/base/dir", "../evil.png");
  } catch {
    threw = true;
  }
  check("resolveWithinDir blocks traversal", threw === true);
}

// ---- 9. malware scanner wiring -----------------------------------------------------------

console.log("malware scanner");
{
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  resetMalwareScannerForTests();
  const s = getMalwareScanner();
  check("no CLAMAV_HOST → no-op scanner", s.name === "noop");
  const r = await s.scanBuffer(pngBuf());
  check("no-op scanner passes clean buffer", r.clean === true);
}
{
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = "1"; // refused → fail closed
  resetMalwareScannerForTests();
  const s = getMalwareScanner();
  check("CLAMAV_HOST set → clamav scanner", s.name === "clamav");
  let threw = false;
  try {
    await new ClamAvScanner("127.0.0.1", 1, 1000).scanBuffer(pngBuf());
  } catch {
    threw = true;
  }
  check("unreachable ClamAV fails closed (throws)", threw === true);
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  resetMalwareScannerForTests();
}

// ---- summary -------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
