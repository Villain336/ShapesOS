import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";

// Milestone 11: baseline security headers.
// - HSTS is only sent when the app URL is https (never on http://localhost).
// - X-Frame-Options: SAMEORIGIN — the landing-page preview uses a sandboxed
//   srcDoc iframe, which is unaffected by frame-ancestor policy.
// - No Content-Security-Policy is set yet: Monaco (@monaco-editor/react)
//   loads its editor assets from a CDN and needs 'unsafe-eval' for workers,
//   so a CSP would be either broken or theater. CSP is an explicit follow-up
//   once editor assets are self-hosted (see README § Enterprise security).
const isHttps = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  ...(isHttps
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Required for the self-hosted Docker image (see Dockerfile)
  output: "standalone",
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
