// Marketr — workspace filesystem: download response headers (Phase B, W3).
//
// XSS / content-type-confusion hardening, extracted for testability:
// - Served MIME comes from the sniffed mime recorded at upload (caller passes
//   it in); never from the filename extension or a client header.
// - Inline disposition only for a small safe list (images, PDF). Everything
//   else (SVG, HTML, text, office docs) is attachment.
// - X-Content-Type-Options: nosniff and Content-Security-Policy: sandbox on
//   every download — stored active content can never execute in our origin.

/** MIME types safe to render inline in the browser. */
export const INLINE_SAFE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** True when the sniffed mime may be served inline (otherwise attachment). */
export function isInlineSafeMime(mimeType: string): boolean {
  return INLINE_SAFE_MIMES.has(mimeType);
}

/**
 * Build the security headers for a file download. `mimeType` must be the
 * sniffed mime stored in the registry at upload time.
 */
export function buildDownloadHeaders(
  mimeType: string,
  filename: string,
  opts: { forceAttachment?: boolean } = {},
): Record<string, string> {
  const inline = !opts.forceAttachment && isInlineSafeMime(mimeType);
  const safeName = filename.replace(/["\\\r\n]/g, "_").slice(0, 200) || "file";
  return {
    "content-type": mimeType,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  };
}
