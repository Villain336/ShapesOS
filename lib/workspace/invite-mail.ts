// ShapesOS — invite emails (Phase 3, workstream I).
//
// When an admin invites a teammate, the single-use invite link is emailed
// over the deployment's existing mail path:
//   1. SMTP (SMTP_HOST + SMTP_FROM — the same settings as alert emails and
//      approval codes), else
//   2. Resend (RESEND_API_KEY + INVITE_MAIL_FROM), else
//   3. not sent: the admin copies the link by hand (the old behaviour, kept
//      as the fallback in the Members UI).
// Never throws: a failed send leaves the invite valid and is reported back
// so the UI can offer the copy-link fallback. The token itself is never
// logged.

import nodemailer from "nodemailer";
import { smtpSettings } from "@/lib/alerts/adapters";
import { createResendPort } from "@/lib/newsletter/resend";

export type InviteMailChannel = "smtp" | "resend";

export function inviteMailChannel(env: NodeJS.ProcessEnv = process.env): InviteMailChannel | null {
  if ((env.SMTP_HOST ?? "").trim() && (env.SMTP_FROM ?? "").trim()) return "smtp";
  if ((env.RESEND_API_KEY ?? "").trim() && (env.INVITE_MAIL_FROM ?? "").trim()) return "resend";
  return null;
}

/**
 * Absolute base URL for links in emails. Configured URLs win; the request
 * origin is only a fallback (the admin's own request, so a forged Host can
 * only mislead the admin's own invite). Null when nothing usable is known.
 */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env, requestOrigin?: string | null): string | null {
  for (const raw of [env.APP_URL, env.NEXTAUTH_URL, env.AUTH_URL, requestOrigin]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // not a URL — try the next source
    }
  }
  return null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface InviteMail {
  to: string;
  workspaceName: string;
  inviterName: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}

export function renderInviteEmail(m: InviteMail): { subject: string; text: string; html: string } {
  const days = Math.max(1, Math.round((m.expiresAt.getTime() - Date.now()) / 86_400_000));
  const subject = `${m.inviterName} invited you to ${m.workspaceName} on ShapesOS`.slice(0, 160);
  const text =
    `${m.inviterName} invited you to join the ${m.workspaceName} workspace on ShapesOS as ${m.role}.\n\n` +
    `Accept the invite: ${m.inviteUrl}\n\n` +
    `The link works once and expires in ${days} day${days === 1 ? "" : "s"}. ` +
    `Sign in with this email address (${m.to}) to accept. If you weren't expecting this, ignore it.`;
  const html = `<!doctype html><html><body style="font-family:Archivo,system-ui,-apple-system,sans-serif;color:#000000;background:#F3F3F1;margin:0;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:28px">
<h1 style="font-size:20px;font-weight:750;margin:0 0 12px">Join ${esc(m.workspaceName)} on ShapesOS</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 20px">${esc(m.inviterName)} invited you to the <strong>${esc(m.workspaceName)}</strong> workspace as ${esc(m.role)}.</p>
<p style="margin:0 0 20px"><a href="${esc(m.inviteUrl)}" style="display:inline-block;background:#000000;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">Accept invite</a></p>
<p style="font-size:13px;line-height:1.5;color:#5E5E5B;margin:0">The link works once and expires in ${days} day${days === 1 ? "" : "s"}. Sign in as ${esc(m.to)} to accept. If you weren't expecting this, ignore it.</p>
</div></body></html>`;
  return { subject, text, html };
}

export type InviteMailResult =
  | { sent: true; channel: InviteMailChannel }
  | { sent: false; reason: "not_configured" | "no_base_url" | "send_failed"; message: string };

export interface InviteMailDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real SMTP / Resend delivery. */
  deliver?: (channel: InviteMailChannel, msg: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;
}

/** Email an invite. `inviteUrl` may be relative (/invite?token=…); it is made absolute here. */
export async function sendInviteEmail(
  mail: Omit<InviteMail, "inviteUrl"> & { inviteUrl: string; requestOrigin?: string | null },
  deps: InviteMailDeps = {},
): Promise<InviteMailResult> {
  const env = deps.env ?? process.env;
  const channel = inviteMailChannel(env);
  if (!channel) {
    return { sent: false, reason: "not_configured", message: "Email isn't set up on this deployment. Copy the invite link and send it yourself." };
  }
  let url = mail.inviteUrl;
  if (!/^https?:\/\//.test(url)) {
    const base = appBaseUrl(env, mail.requestOrigin);
    if (!base) {
      return { sent: false, reason: "no_base_url", message: "Set APP_URL so invite emails can carry a full link. Copy the invite link for now." };
    }
    url = base + (url.startsWith("/") ? url : `/${url}`);
  }
  const { subject, text, html } = renderInviteEmail({ ...mail, inviteUrl: url });
  try {
    const from = channel === "smtp" ? (env.SMTP_FROM ?? "").trim() : (env.INVITE_MAIL_FROM ?? "").trim();
    const msg = { from, to: mail.to, subject, text, html };
    if (deps.deliver) await deps.deliver(channel, msg);
    else if (channel === "smtp") await deliverSmtp(msg);
    else await createResendPort((env.RESEND_API_KEY ?? "").trim()).sendEmail(msg);
    return { sent: true, channel };
  } catch (err) {
    console.error("[invite-mail] delivery failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
    return { sent: false, reason: "send_failed", message: "The invite email didn't go out. Copy the invite link and send it yourself." };
  }
}

async function deliverSmtp(msg: { from: string; to: string; subject: string; text: string; html: string }) {
  const smtp = smtpSettings();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
  });
  await transporter.sendMail({ ...msg, from: smtp.from });
}
