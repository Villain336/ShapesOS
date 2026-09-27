// Marketr — Phase 12 "embeds": Chatwoot live-chat widget (MIT core).
// Client component. Rendered ONLY when chatwootWidgetConfig() returns a
// config — i.e. CHATWOOT_BASE_URL + CHATWOOT_WEBSITE_TOKEN are set AND the
// operator explicitly opted in with CHATWOOT_WIDGET_ENABLED=true. Off by
// default, always.

"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    chatwootSDK?: { run: (opts: { websiteToken: string; baseUrl: string }) => void };
  }
}

export function ChatwootWidget({
  baseUrl,
  websiteToken,
}: {
  baseUrl: string;
  websiteToken: string;
}) {
  useEffect(() => {
    const script = document.createElement("script");
    script.src = `${baseUrl}/packs/js/sdk.js`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      try {
        window.chatwootSDK?.run({ websiteToken, baseUrl });
      } catch {
        // Chatwoot failed to boot — the dashboard works fine without chat.
      }
    };
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, [baseUrl, websiteToken]);

  return null;
}
