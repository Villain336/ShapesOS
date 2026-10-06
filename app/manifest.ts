// ShapesOS — Phase 18.3 (WS=flow): the web app manifest (Next 16
// app/manifest.ts metadata route → /manifest.webmanifest; see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md).
// Installable: name, standalone display, start URL inside the app, and PNG
// icons (192, 512, maskable 512) rendered from the brand mark
// (public/brand/logo-mark.svg → public/pwa/). Colours are the Agentic OS
// tokens (DESIGN.md): background = canvas #F3F3F1, theme = ink #000000.
// The manifest is public (no user data); manifest-src 'self' is already in
// the CSP (lib/security/headers.ts).

import type { MetadataRoute } from "next";

const PWA_BACKGROUND = "#F3F3F1"; // --aos-canvas (light)
const PWA_THEME = "#000000"; // --aos-ink (light)

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "ShapesOS",
    short_name: "ShapesOS",
    description: "The agentic operating system for your business: apps, agents and approvals in one place.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_THEME,
    categories: ["business", "productivity"],
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Notes", url: "/dashboard/notes", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192" }] },
      { name: "Mail", url: "/dashboard/mail", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192" }] },
      { name: "Approvals", url: "/dashboard/approvals", icons: [{ src: "/pwa/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
