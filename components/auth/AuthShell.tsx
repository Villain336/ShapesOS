"use client";

// ShapesOS — the centered sign-in card shared by /login, /signup,
// /forgot-password, /reset-password and /login/link (Phase 6). Agentic OS:
// canvas page, white card (radius-lg, hairline shadow), page heading.
// Beta readiness (WS=legal): a footer line under the card links the terms,
// privacy policy, status page and contact (AuthFooterLinks, also used by
// the sign-in screen's own card in app/login/LoginClient.tsx).

import type { ReactNode } from "react";
import Link from "next/link";
import { MailCheck, type LucideIcon } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 py-10">
      <div className="w-full max-w-sm rounded-lg bg-paper p-8 shadow-hairline">{children}</div>
      <AuthFooterLinks />
    </div>
  );
}

const footerLink = "rounded-full px-2 py-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline";

/** Terms · Privacy · Status · Contact, under the sign-in / sign-up card. */
export function AuthFooterLinks() {
  const { t } = useI18n();
  return (
    <nav aria-label={t("legal.footer.legal")} className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
      <Link href="/terms" className={footerLink}>
        {t("legal.footer.terms")}
      </Link>
      <Link href="/privacy" className={footerLink}>
        {t("legal.footer.privacy")}
      </Link>
      <Link href="/status" className={footerLink}>
        {t("legal.footer.status")}
      </Link>
      <Link href="/contact" className={footerLink}>
        {t("legal.footer.contact")}
      </Link>
    </nav>
  );
}

/** "Check your email" state after a link was requested. Neutral: no status colour. */
export function SentNotice({
  title,
  message,
  icon: Icon = MailCheck,
  children,
}: {
  title: string;
  message: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <Icon className="size-6 text-ink" aria-hidden="true" />
      <h1 className="aos-heading">{title}</h1>
      <p className="text-sm text-muted">{message}</p>
      {children}
    </div>
  );
}
