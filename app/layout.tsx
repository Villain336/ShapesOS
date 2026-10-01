import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@/components/crm/crm.css"; // CRM visual system, scoped under .crm
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`h-full antialiased ${archivo.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
