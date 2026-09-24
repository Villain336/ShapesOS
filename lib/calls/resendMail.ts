// Marketr — booking mail port backed by Resend (R5).
//
// Real delivery for booking confirmations/reminders without workspace
// settings: if RESEND_API_KEY and BOOKING_MAIL_FROM are both set, the
// reminder runner sends via Resend; otherwise the LogMailPort stub from
// lib/calls/reminders.ts is used (safe default — never sends anywhere
// by accident). Fake mail ports stay injectable for tests.

import { createResendPort } from "@/lib/newsletter/resend";
import { LogMailPort, type MailPort } from "./reminders";

export interface ResendBookingMailConfig {
  apiKey: string;
  from: string;
}

export function createResendBookingMailPort(config: ResendBookingMailConfig): MailPort {
  const port = createResendPort(config.apiKey);
  return {
    async send(opts) {
      await port.sendEmail({
        from: config.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.body.replace(/\n/g, "<br>"),
      });
      return { ok: true };
    },
  };
}

/** Resend when credentials are present, the stub log port otherwise. */
export function resolveBookingMailPort(): MailPort {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_MAIL_FROM;
  if (apiKey && from) return createResendBookingMailPort({ apiKey, from });
  return new LogMailPort();
}
