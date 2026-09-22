import type { Metadata } from "next";
import "./globals.css";

/* Type comes from @fontsource/inter + @fontsource/newsreader, imported in
 * globals.css — no next/font needed. */

export const metadata: Metadata = {
  title: "Marketr — marketing & SEO workspace",
  description:
    "Marketr is the open-source marketing and SEO workspace: keyword research, competitor gaps, content engine, and rank tracking.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
