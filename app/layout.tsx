import type { Metadata } from "next";
import { connection } from "next/server";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@xyflow/react/dist/style.css"; // React Flow base styles (Business Graph mind-map view)
// Phase 18.1 (WS=find): the person's theme, contrast, density, motion, text
// size and language, applied to <html> server-side (no flash), and the i18n
// provider for client components.
import { getShellState } from "@/lib/preferences/server";
import { shellClassNames } from "@/lib/preferences/shell";
import { getCatalogue } from "@/lib/i18n/server";
import { I18nProvider } from "@/components/i18n/I18nProvider";

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
  title: "ShapesOS — marketing & SEO workspace",
  description:
    "ShapesOS is the open-source marketing and SEO workspace: keyword research, competitor gaps, content engine, and rank tracking.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Nonce-based CSP (proxy.ts): every page must render per request so Next
  // can stamp that request's nonce on its scripts — a page prerendered at
  // build time would ship nonce-less scripts the browser then blocks.
  await connection();
  const state = await getShellState();
  const messages = state.locale === "en" ? undefined : await getCatalogue(state.locale);
  return (
    <html
      lang={state.locale}
      className={`h-full antialiased ${archivo.variable} ${jetbrainsMono.variable} ${shellClassNames(state.shell).join(" ")}`}
    >
      <body className="min-h-full flex flex-col">
        <I18nProvider locale={state.locale} messages={messages} timeZone={state.timeZone} hourCycle={state.hourCycle}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
