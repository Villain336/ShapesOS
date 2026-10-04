// ShapesOS — sign-in emails for email accounts (Phase 6).
//
// Reuses the deployment's mail path (lib/workspace/invite-mail.ts):
//   1. SMTP (SMTP_HOST + SMTP_FROM), else
//   2. Resend (RESEND_API_KEY + INVITE_MAIL_FROM), else
//   3. development only (NODE_ENV !== "production"): the link is printed to
//      the server console so a local install works without a mailer.
// In production with no mailer, email sign-in is OFF: the routes answer 503
// "Email sign-in isn't configured" and /login hides the email options.
//
// Links are built from the CONFIGURED base URL (APP_URL / NEXTAUTH_URL /
// AUTH_URL). The request's own origin is used only in development: in
// production a forged Host header must never be able to point a reset link
// (and its token) at someone else's domain.
//
// The token rides in the URL fragment (#token=…), so it never reaches a
// server access log or a Referer header; the page reads it client-side.
// Never throws; the token is never logged outside the development console.

import { HttpError } from "@/lib/api/errors";
import {
  appBaseUrl,
  deliverMail,
  inviteMailChannel,
  mailFromAddress,
  type InviteMailChannel,
} from "@/lib/workspace/invite-mail";
import { TOKEN_TTL_MS, type EmailTokenPurpose } from "./tokens";

export type EmailAuthDelivery = InviteMailChannel | "console";

export const LINK_PATH = "/login/link";
export const RESET_PATH = "/reset-password";

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

/** How sign-in emails go out on this deployment, or null when they can't. */
export function emailAuthDelivery(env: NodeJS.ProcessEnv = process.env): EmailAuthDelivery | null {
  const channel = inviteMailChannel(env);
  if (channel) return channel;
  return isProduction(env) ? null : "console";
}

/** Base URL for links: configured URL; the request origin only outside production. */
export function emailAuthBaseUrl(env: NodeJS.ProcessEnv = process.env, requestOrigin?: string | null): string | null {
  return appBaseUrl(env, null) ?? (isProduction(env) ? null : appBaseUrl(env, requestOrigin));
}

/** Email sign-in is usable: a delivery path and (in production) a configured base URL. */
export function emailAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailAuthDelivery(env) !== null && (!isProduction(env) || appBaseUrl(env, null) !== null);
}

export class EmailAuthUnavailableError extends HttpError {
  constructor() {
    super(503, "Email sign-in isn't configured on this server. Sign in another way, or ask the operator to set up email.", {
      code: "email_auth_unconfigured",
    });
    this.name = "EmailAuthUnavailableError";
  }
}

export type AuthMailKind = "verify" | "login" | "login_new" | "reset" | "already_registered";

export interface AuthMail {
  kind: AuthMailKind;
  to: string;
  /** Absolute link (with #token=… for token links). */
  url: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function ttlText(purpose: EmailTokenPurpose): string {
  const mins = Math.round(TOKEN_TTL_MS[purpose] / 60_000);
  return mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
}

const COPY: Record<AuthMailKind, { subject: string; heading: string; body: string; button: string; footer: string }> = {
  verify: {
    subject: "Confirm your email for ShapesOS",
    heading: "Confirm your email",
    body: "Confirm this address to finish creating your ShapesOS account.",
    button: "Confirm email",
    footer: `The link works once and expires in ${ttlText("verify")}. If you didn't sign up, ignore this email and no account will be activated.`,
  },
  login: {
    subject: "Your ShapesOS sign-in link",
    heading: "Sign in to ShapesOS",
    body: "Use this link to sign in. You don't need your password.",
    button: "Sign in",
    footer: `The link works once and expires in ${ttlText("login")}. If you didn't ask for it, ignore this email.`,
  },
  login_new: {
    subject: "Finish signing up for ShapesOS",
    heading: "Welcome to ShapesOS",
    body: "Use this link to create your account and sign in.",
    button: "Create account and sign in",
    footer: `The link works once and expires in ${ttlText("login")}. If you didn't ask for it, ignore this email and no account will be created.`,
  },
  reset: {
    subject: "Reset your ShapesOS password",
    heading: "Reset your password",
    body: "Use this link to choose a new password.",
    button: "Choose a new password",
    footer: `The link works once and expires in ${ttlText("reset")}. If you didn't ask for it, ignore this email and your password stays the same.`,
  },
  already_registered: {
    subject: "You already have a ShapesOS account",
    heading: "You already have an account",
    body: "Someone tried to sign up with this address, but it already has a ShapesOS account. Sign in, or reset your password if you've forgotten it.",
    button: "Sign in",
    footer: "If this wasn't you, ignore this email. Nothing about your account changed.",
  },
};

export function renderAuthEmail(m: AuthMail): { subject: string; text: string; html: string } {
  const c = COPY[m.kind];
  const text = `${c.heading}\n\n${c.body}\n\n${c.button}: ${m.url}\n\n${c.footer}`;
  const html = `<!doctype html><html><body style="font-family:Archivo,system-ui,-apple-system,sans-serif;color:#000000;background:#F3F3F1;margin:0;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:28px">
<h1 style="font-size:20px;font-weight:750;margin:0 0 12px">${esc(c.heading)}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 20px">${esc(c.body)}</p>
<p style="margin:0 0 20px"><a href="${esc(m.url)}" style="display:inline-block;background:#000000;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">${esc(c.button)}</a></p>
<p style="font-size:13px;line-height:1.5;color:#5E5E5B;margin:0">${esc(c.footer)}</p>
</div></body></html>`;
  return { subject: c.subject, text, html };
}

/** "/login/link#token=…" or "/reset-password#token=…" on the base URL. */
export function tokenLink(base: string, purpose: EmailTokenPurpose, token: string): string {
  return `${base}${purpose === "reset" ? RESET_PATH : LINK_PATH}#token=${encodeURIComponent(token)}`;
}

export type AuthMailResult = { sent: true; via: EmailAuthDelivery } | { sent: false; reason: "not_configured" | "send_failed" };

export interface AuthMailDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real delivery (SMTP / Resend / console). */
  deliver?: (via: EmailAuthDelivery, msg: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;
}

export async function sendAuthEmail(mail: AuthMail, deps: AuthMailDeps = {}): Promise<AuthMailResult> {
  const env = deps.env ?? process.env;
  const via = emailAuthDelivery(env);
  if (!via) return { sent: false, reason: "not_configured" };
  const { subject, text, html } = renderAuthEmail(mail);
  const msg = { from: via === "console" ? "" : mailFromAddress(via, env), to: mail.to, subject, text, html };
  try {
    if (deps.deliver) await deps.deliver(via, msg);
    else if (via === "console") {
      // Development only (emailAuthDelivery never returns "console" in production).
      if (isProduction(env)) return { sent: false, reason: "not_configured" };
      console.info(`[auth-mail] no mailer configured (development): "${subject}" for ${mail.to}\n  ${mail.url}`);
    } else await deliverMail(via, msg, env);
    return { sent: true, via };
  } catch (err) {
    // Code/name only: provider error text can echo the message body (and so the link).
    const code = (err as { code?: unknown; name?: unknown })?.code ?? (err as { name?: unknown })?.name ?? "unknown";
    console.error(`[auth-mail] ${via} delivery failed (${String(code).slice(0, 60)})`);
    return { sent: false, reason: "send_failed" };
  }
}
