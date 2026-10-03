import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";
import { buildSecurityHeaders, shouldSendHsts } from "./lib/security/headers";

// Security headers (Milestone 11 baseline, Phase 1 HSTS): see
// lib/security/headers.ts for the policy and its compatibility notes.
// - Content-Security-Policy is NOT sent from here: it carries a per-request
//   nonce, so proxy.ts sets it (a static copy here would be a second CSP
//   header that browsers intersect with the nonce one).
// - HSTS in production unless NEXTAUTH_URL is explicitly http://.
// - X-Frame-Options: SAMEORIGIN — the landing-page preview uses a sandboxed
//   srcDoc iframe, which is unaffected by frame-ancestor policy.
const securityHeaders = buildSecurityHeaders({
  hsts: shouldSendHsts({ NODE_ENV: process.env.NODE_ENV, NEXTAUTH_URL: process.env.NEXTAUTH_URL }),
});

const nextConfig: NextConfig = {
  // Required for the self-hosted Docker image (see Dockerfile)
  output: "standalone",
  // CI runs the full `npm run typecheck` (next typegen + tsc) as its own gating
  // step, then builds; repeating the type check inside `next build` doubled
  // peak memory and got the runner killed. Only CI sets SKIP_BUILD_TYPECHECK —
  // local and Docker builds still type-check. (Next's memory-usage guide.)
  typescript: { ignoreBuildErrors: process.env.SKIP_BUILD_TYPECHECK === "1" },
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
  // The curated Activepieces pieces (lib/integrations/activepieces/pieces.ts)
  // are CommonJS packages with a deep dependency tree; keep them (and the
  // framework they share) external so Node loads them at runtime and the
  // standalone trace copies them, instead of Turbopack bundling them.
  serverExternalPackages: [
    "takumi-pdf",
    "ssh2",
    "cpu-features",
    "@activepieces/pieces-framework",
    "@activepieces/shared",
    "@activepieces/piece-webhook",
    "@activepieces/piece-schedule",
    "@activepieces/piece-http",
    "@activepieces/piece-smtp",
    "@activepieces/piece-google-sheets",
    "@activepieces/piece-mailchimp",
    "@activepieces/piece-twitter",
    "@activepieces/piece-facebook-pages",
    "@activepieces/piece-instagram-business",
    "@activepieces/piece-linkedin",
    "@activepieces/piece-slack",
    "@activepieces/piece-openai",
    "@activepieces/piece-rss",
  ],
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
