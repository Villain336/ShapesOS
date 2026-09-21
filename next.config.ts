import type { NextConfig } from "next";

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
  serverExternalPackages: ["takumi-pdf"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
