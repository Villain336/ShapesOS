// Marketr — Phase 5 SAFETY: shared OTP challenge store instance.
//
// Module-level singleton shared by the OTP-mint and approve routes.
// TEST/FAKE posture: in-memory. PRODUCTION NOTE: persist challenges in the
// DB or a short-lived KV store — a process restart must not resurrect or
// lose pending challenges silently.
//
// Phase 1: the code is delivered OUT-OF-BAND to the approver's sign-in email
// (SMTP_HOST/SMTP_FROM, the same settings as alert emails) and never
// returned by the API. Without SMTP, development servers print it to the
// server console instead; production refuses to mint (fail closed).

import nodemailer from "nodemailer";
import { smtpSettings } from "@/lib/alerts/adapters";
import { OtpChallengeStore } from "./safety";

export const otpChallenges = new OtpChallengeStore();

export type OtpDelivery = { ok: true; channel: "email" | "dev-console" } | { ok: false; error: string };

/** Send an approval OTP to the approver. Never throws; never logs the code in production. */
export async function deliverApprovalOtp(opts: {
  to: string | null | undefined;
  code: string;
  approvalId: string;
  expiresAt: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<OtpDelivery> {
  const env = opts.env ?? process.env;
  const smtpConfigured = !!(env.SMTP_HOST ?? "").trim() && !!(env.SMTP_FROM ?? "").trim();
  if (!smtpConfigured) {
    if (env.NODE_ENV === "production") {
      return { ok: false, error: "Approval codes are sent by email. Set SMTP_HOST and SMTP_FROM to enable high-value approvals." };
    }
    console.info(`[media-otp] dev only (no SMTP): approval ${opts.approvalId} code ${opts.code}`);
    return { ok: true, channel: "dev-console" };
  }
  const to = opts.to?.trim();
  if (!to) return { ok: false, error: "Your account has no email address to send the approval code to." };
  try {
    const smtp = smtpSettings();
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
    });
    const minutes = Math.max(1, Math.round((opts.expiresAt.getTime() - Date.now()) / 60_000));
    await transporter.sendMail({
      from: smtp.from,
      to,
      subject: "Your ShapesOS approval code",
      text: `Your code to approve media buy ${opts.approvalId} is ${opts.code}.\n\nIt expires in ${minutes} minutes and works once. If you didn't request it, ignore this email.`,
    });
    return { ok: true, channel: "email" };
  } catch (err) {
    console.error("[media-otp] delivery failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Couldn't send the approval code. Try again." };
  }
}
