// ShapesOS — Phase 10 (finance): email delivery for invoices, credit notes,
// quotes and payment reminders, with the PDF attached.
//
// Reuses the deployment's existing mail path (lib/workspace/invite-mail.ts —
// the same channel as invites and sign-in mail):
//   1. SMTP (SMTP_HOST + SMTP_FROM, settings from lib/alerts/adapters), else
//   2. Resend (RESEND_API_KEY + INVITE_MAIL_FROM), else
//   3. outside production: the labelled FAKE transport — nothing leaves the
//      server, the send is logged as "[finance-mail:fake]" and recorded as
//      deliveryStatus "fake" (never reported as delivered);
//      in production: "not_configured".
// Never throws: the outcome is returned and recorded on the document.

import nodemailer from "nodemailer";
import { Resend } from "resend";
import { smtpSettings } from "@/lib/alerts/adapters";
import { inviteMailChannel, mailFromAddress, type InviteMailChannel } from "@/lib/workspace/invite-mail";

export type DeliveryStatus = "sent" | "fake" | "not_configured" | "no_recipient" | "failed";

export interface FinanceMail {
  to: string | null | undefined;
  subject: string;
  text: string;
  html: string;
  attachment?: { filename: string; content: Buffer };
  /** Display name for the From header (the workspace / sender name). */
  fromName?: string;
}

export interface DeliveryResult {
  status: DeliveryStatus;
  channel?: InviteMailChannel | "fake";
  message: string;
}

export interface DeliveryDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real SMTP / Resend transport. */
  transport?: (channel: InviteMailChannel, msg: FinanceMail & { from: string; to: string }) => Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** Agentic OS-styled transactional email body (paper card on canvas). */
export function renderFinanceEmail(args: { heading: string; paragraphs: string[]; buttonLabel?: string; buttonUrl?: string | null; footer?: string | null }) {
  const html = `<!doctype html><html><body style="font-family:Archivo,system-ui,-apple-system,sans-serif;color:#000000;background:#F3F3F1;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:28px">
<h1 style="font-size:20px;font-weight:750;margin:0 0 12px">${esc(args.heading)}</h1>
${args.paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${esc(p)}</p>`).join("\n")}
${args.buttonUrl && args.buttonLabel ? `<p style="margin:6px 0 20px"><a href="${esc(args.buttonUrl)}" style="display:inline-block;background:#000000;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">${esc(args.buttonLabel)}</a></p>` : ""}
${args.footer ? `<p style="font-size:13px;line-height:1.5;color:#5E5E5B;margin:0">${esc(args.footer)}</p>` : ""}
</div></body></html>`;
  const text = [args.heading, "", ...args.paragraphs, ...(args.buttonUrl ? ["", `${args.buttonLabel}: ${args.buttonUrl}`] : []), ...(args.footer ? ["", args.footer] : [])].join("\n");
  return { html, text };
}

export async function deliverFinanceMail(mail: FinanceMail, deps: DeliveryDeps = {}): Promise<DeliveryResult> {
  const env = deps.env ?? process.env;
  const to = (mail.to ?? "").trim();
  if (!isEmail(to)) {
    return { status: "no_recipient", message: "No customer email on file. Add one to the document or the CRM contact, then send again." };
  }
  const channel = inviteMailChannel(env);
  if (!channel) {
    if (env.NODE_ENV === "production") {
      return { status: "not_configured", message: "Email isn't set up on this server (SMTP or Resend). Download the PDF and send it yourself." };
    }
    // FAKE transport (development / tests only) — clearly labelled.
    console.log(`[finance-mail:fake] to=${to} subject=${mail.subject} attachment=${mail.attachment?.filename ?? "none"}`);
    return { status: "fake", channel: "fake", message: "Development mode: the email was logged, not sent (no SMTP or Resend configured)." };
  }
  const from = mailFromAddress(channel, env);
  try {
    if (deps.transport) await deps.transport(channel, { ...mail, from, to });
    else if (channel === "smtp") await sendSmtp({ ...mail, from, to });
    else await sendResend((env.RESEND_API_KEY ?? "").trim(), { ...mail, from, to });
    return { status: "sent", channel, message: `Emailed to ${to}.` };
  } catch (err) {
    const code = (err as { code?: unknown; name?: unknown })?.code ?? (err as { name?: unknown })?.name ?? "unknown";
    console.error(`[finance-mail] ${channel} delivery failed (${String(code).slice(0, 60)})`);
    return { status: "failed", channel, message: "The email didn't go out. Check the mail settings, or download the PDF and send it yourself." };
  }
}

async function sendSmtp(msg: FinanceMail & { from: string; to: string }) {
  const smtp = smtpSettings();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
  });
  await transporter.sendMail({
    from: msg.fromName ? { name: msg.fromName, address: smtp.from } : smtp.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    ...(msg.attachment ? { attachments: [{ filename: msg.attachment.filename, content: msg.attachment.content, contentType: "application/pdf" }] } : {}),
  });
}

async function sendResend(apiKey: string, msg: FinanceMail & { from: string; to: string }) {
  const resend = new Resend(apiKey);
  const res = await resend.emails.send({
    from: msg.fromName ? `${msg.fromName.replace(/[<>"]/g, "")} <${msg.from}>` : msg.from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(msg.attachment ? { attachments: [{ filename: msg.attachment.filename, content: msg.attachment.content }] } : {}),
  });
  if (res.error) throw Object.assign(new Error("resend send failed"), { name: (res.error as { name?: string }).name ?? "resend_error" });
}
