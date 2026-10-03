import type { Metadata } from "next";
import { connection } from "next/server";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@xyflow/react/dist/style.css"; // React Flow base styles (Business Graph mind-map view)

/* Agentic OS type (Tico 2026-10-01): Archivo for everything, JetBrains Mono
 * for tool calls, code, IDs, file paths and keycaps only. Loaded through
 * next/font with axes: ["wdth"] so the width axis survives — headings get
 * wider (115-125%), not just bolder. The CSS variables below are wired into
 * --aos-font-sans / --aos-font-mono in globals.css. */

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Marketr — marketing & SEO workspace",
  description:
    "Marketr is the open-source marketing and SEO workspace: keyword research, competitor gaps, content engine, and rank tracking.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Nonce-based CSP (proxy.ts): every page must render per request so Next
  // can stamp that request's nonce on its scripts — a page prerendered at
  // build time would ship nonce-less scripts the browser then blocks.
  await connection();
  return (
    <html
      lang="en"
      className={`h-full antialiased ${archivo.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
