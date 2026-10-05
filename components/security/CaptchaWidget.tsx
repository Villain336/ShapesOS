"use client";

// ShapesOS — CAPTCHA widget for the login step-up (Phase 4a). Loads the
// provider's script on demand (only after the server asked for a CAPTCHA).
// The script is inserted by this nonce'd bundle, so the strict CSP's
// 'strict-dynamic' admits it; the widget iframe is allowed by frame-src https:.

import { useEffect, useRef } from "react";

export interface CaptchaPublicConfig {
  provider: "turnstile" | "hcaptcha";
  siteKey: string;
}

interface WidgetApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | number;
  reset?: (id?: string | number) => void;
  remove?: (id?: string | number) => void;
}

const SCRIPT_SRC: Record<CaptchaPublicConfig["provider"], string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  hcaptcha: "https://js.hcaptcha.com/1/api.js?render=explicit",
};

function api(provider: CaptchaPublicConfig["provider"]): WidgetApi | undefined {
  const w = window as unknown as { turnstile?: WidgetApi; hcaptcha?: WidgetApi };
  return provider === "turnstile" ? w.turnstile : w.hcaptcha;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-captcha-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.captchaSrc = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("CAPTCHA script failed to load")));
    document.head.appendChild(s);
  });
}

export function CaptchaWidget({
  config,
  onToken,
  resetKey,
}: {
  config: CaptchaPublicConfig;
  onToken: (token: string | null) => void;
  /** Change to get a fresh challenge (tokens are single use). */
  resetKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let widgetId: string | number | undefined;
    onToken(null);
    loadScript(SCRIPT_SRC[config.provider])
      .then(() => {
        const a = api(config.provider);
        if (cancelled || !a || !ref.current) return;
        ref.current.innerHTML = "";
        widgetId = a.render(ref.current, {
          sitekey: config.siteKey,
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      cancelled = true;
      const a = api(config.provider);
      if (widgetId !== undefined) a?.remove?.(widgetId);
    };
    // onToken is a state setter from the parent; re-render on resetKey only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.provider, config.siteKey, resetKey]);
  return <div ref={ref} className="min-h-[65px]" aria-label="Security check" />;
}
