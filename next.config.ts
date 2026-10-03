import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";
import { buildSecurityHeaders, shouldSendHsts } from "./lib/security/headers";

// Security headers (Milestone 11 baseline, Phase 1 CSP/HSTS): see
// lib/security/headers.ts for the policy and its compatibility notes.
// - Content-Security-Policy on every response (script-src-attr 'none' blocks
//   injected event-handler XSS; object/base/frame-ancestors locked down).
// - HSTS in production unless NEXTAUTH_URL is explicitly http://.
// - X-Frame-Options: SAMEORIGIN — the landing-page preview uses a sandboxed
//   srcDoc iframe, which is unaffected by frame-ancestor policy.
const securityHeaders = buildSecurityHeaders({
  hsts: shouldSendHsts({ NODE_ENV: process.env.NODE_ENV, NEXTAUTH_URL: process.env.NEXTAUTH_URL }),
});

const nextConfig: NextConfig = {
  // Required for the self-hosted Docker image (see Dockerfile)
  output: "standalone",
  // No X-Powered-By (also suppresses the "Next.js, Payload" header that
  // withPayload adds when this is left unset).
  poweredByHeader: false,
  // Milestone 12: takumi-pdf ships a wasm binary with bundler-specific entry
  // points. Externalize it so Node's own resolver picks the `node` condition
  // (readFileSync-based wasm load) instead of Turbopack bundling the
  // Vite-specific `?url` entry and failing the build.
  // ssh2 (lib/sitefiles/sftp.ts) ships an optional native binding
  // (sshcrypto.node) that Turbopack cannot bundle; when it compiles (normal on
  // CI/Docker images with build tools) the production build fails. Keep it and
  // its optional native dep external so Node resolves them at runtime.
  serverExternalPackages: ["takumi-pdf", "ssh2", "cpu-features"],
  // Phase 12: the standalone trace copies onnxruntime's .node binding but not
  // its companion libonnxruntime.so, so any route touching @xenova/transformers
  // (embeddings — e.g. /dashboard/intelligence/repurpose) 500s at runtime with
  // "cannot open shared object file". Force-include the native lib.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1.14.0",
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withPayload(nextConfig);
