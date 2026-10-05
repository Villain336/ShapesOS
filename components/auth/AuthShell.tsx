// ShapesOS — the centered sign-in card shared by /login, /signup,
// /forgot-password, /reset-password and /login/link (Phase 6). Agentic OS:
// canvas page, white card (radius-lg, hairline shadow), page heading.

import type { ReactNode } from "react";
import { MailCheck, type LucideIcon } from "lucide-react";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
      <div className="w-full max-w-sm rounded-lg bg-paper p-8 shadow-hairline">{children}</div>
    </div>
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
