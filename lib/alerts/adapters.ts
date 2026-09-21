// Marketr — alert hub channel adapters (milestone 13).
//
// One common sendAlert(title, body, links) shape; each channel type has a
// plain-config sender (SlackConfig / TelegramConfig / email) that is fully
// unit-testable against a mock HTTP endpoint, plus a dispatchToChannel()
// helper that decrypts the stored channel config and routes to the sender.
// WhatsApp is explicitly out of scope (phased per spec).

import type { AlertChannel, AlertChannelType } from "@prisma/client";
import nodemailer from "nodemailer";
import { getSecretsProvider } from "@/lib/secrets";

export interface AlertLink {
  label: string;
  url: string;
}

export interface AlertPayload {
  title: string;
  body: string;
  links?: AlertLink[];
}

export interface AdapterResult {
  ok: boolean;
  /** Short machine-readable error when !ok (never includes secrets). */
  error?: string;
  /** Provider response summary for the audit trail (truncated, no secrets). */
  providerResponse?: string;
}

// ---------------------------------------------------------------- Slack ---

export interface SlackConfig {
  webhookUrl: string;
}

/** Incoming webhook POST. Block Kit-lite: header + body + link context. */
export async function sendSlack(config: SlackConfig, payload: AlertPayload): Promise<AdapterResult> {
  // Note: the strict hooks.slack.com check lives in validateChannelConfig()
  // (lib/alerts/channels.ts, enforced at the API layer). The adapter accepts
  // any http(s) URL so it can be smoke-tested against a mock endpoint.
  if (!config.webhookUrl || !/^https?:\/\//.test(config.webhookUrl)) {
    return { ok: false, error: "invalid slack webhook url" };
  }
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: payload.title.slice(0, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: payload.body.slice(0, 2900) } },
  ];
  if (payload.links?.length) {
    const linkText = payload.links
      .map((l) => `<${l.url}|${l.label}>`)
      .join(" · ")
      .slice(0, 1000);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: linkText }] });
  }
  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await res.text()).slice(0, 300);
    if (!res.ok) return { ok: false, error: `slack http ${res.status}`, providerResponse: text };
    return { ok: true, providerResponse: text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "slack send failed" };
  }
}

// -------------------------------------------------------------- Telegram ---

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Bot API sendMessage. HTML parse mode, links appended as <a> tags. */
export async function sendTelegram(config: TelegramConfig, payload: AlertPayload): Promise<AdapterResult> {
  if (!config.botToken || !config.chatId) {
    return { ok: false, error: "telegram bot token or chat id missing" };
  }
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let text = `<b>${esc(payload.title)}</b>\n\n${esc(payload.body)}`.slice(0, 3900);
  if (payload.links?.length) {
    const linkText = payload.links.map((l) => `<a href="${l.url}">${esc(l.label)}</a>`).join(" · ");
    text = `${text}\n\n${linkText}`.slice(0, 4000);
  }
  // TELEGRAM_API_BASE override exists for smoke tests against a mock endpoint;
  // production always uses https://api.telegram.org.
  const base = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
  const api = `${base}/bot${config.botToken}/sendMessage`;
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.text()).slice(0, 500);
    if (!res.ok) return { ok: false, error: `telegram http ${res.status}`, providerResponse: json };
    return { ok: true, providerResponse: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "telegram send failed" };
  }
}

// ----------------------------------------------------------------- Email ---

export interface EmailChannelConfig {
  to: string;
  cc?: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Instance-level SMTP settings from env. Throws when incomplete. */
export function smtpSettings(): SmtpSettings {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const from = (process.env.SMTP_FROM ?? "").trim();
  if (!host || !from) {
    throw new Error("SMTP_HOST and SMTP_FROM must be set to send alert emails");
  }
  const port = Number(process.env.SMTP_PORT ?? "587");
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: (process.env.SMTP_SECURE ?? "").toLowerCase() === "true",
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from,
  };
}

/** Plain server-rendered HTML email (react-email/emailcn lands in M19). */
export function renderAlertEmail(payload: AlertPayload): { subject: string; html: string; text: string } {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  const links = (payload.links ?? [])
    .map((l) => `<a href="${l.url}" style="color:#2563eb">${esc(l.label)}</a>`)
    .join(" &middot; ");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:24px">
<h2 style="font-size:18px;margin:0 0 12px">${esc(payload.title)}</h2>
<p style="font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(payload.body)}</p>
${links ? `<p style="font-size:14px;margin-top:16px">${links}</p>` : ""}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">
<p style="font-size:12px;color:#6b7280">Sent by Marketr alert hub. Manage rules in your workspace settings.</p>
</body></html>`;
  const text = `${payload.title}\n\n${payload.body}${payload.links?.length ? `\n\n${payload.links.map((l) => `${l.label}: ${l.url}`).join("\n")}` : ""}`;
  return { subject: payload.title.slice(0, 120), html, text };
}

export async function sendEmail(
  config: EmailChannelConfig,
  payload: AlertPayload,
  settings?: SmtpSettings,
): Promise<AdapterResult> {
  const to = config.to?.trim();
  if (!to) return { ok: false, error: "email recipient missing" };
  let smtp: SmtpSettings;
  try {
    smtp = settings ?? smtpSettings();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "smtp not configured" };
  }
  const { subject, html, text } = renderAlertEmail(payload);
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
    });
    const info = await transporter.sendMail({
      from: smtp.from,
      to,
      ...(config.cc?.trim() ? { cc: config.cc.trim() } : {}),
      subject,
      text,
      html,
    });
    return { ok: true, providerResponse: String(info.messageId ?? "accepted").slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "email send failed" };
  }
}

// --------------------------------------------------------------- Routing ---

/** Decrypted per-channel config shapes (what lives in configEnc). */
export type ChannelConfig = SlackConfig | TelegramConfig | EmailChannelConfig;

/** Decrypt a channel's configEnc. Throws on tamper/format errors. */
export function decryptChannelConfig(channel: AlertChannel): ChannelConfig {
  return JSON.parse(getSecretsProvider().decrypt(channel.configEnc)) as ChannelConfig;
}

/**
 * Dispatch one payload to one channel. Returns a result row suitable for
 * AlertEvent.results. Never throws — failures are captured in the result.
 */
export async function dispatchToChannel(
  channel: AlertChannel,
  payload: AlertPayload,
): Promise<{ channelId: string; name: string; type: AlertChannelType; ok: boolean; error?: string; providerResponse?: string }> {
  const base = { channelId: channel.id, name: channel.name, type: channel.type };
  let config: ChannelConfig;
  try {
    config = decryptChannelConfig(channel);
  } catch {
    return { ...base, ok: false, error: "channel config undecryptable" };
  }
  let r: AdapterResult;
  if (channel.type === "slack") r = await sendSlack(config as SlackConfig, payload);
  else if (channel.type === "telegram") r = await sendTelegram(config as TelegramConfig, payload);
  else r = await sendEmail(config as EmailChannelConfig, payload);
  return { ...base, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.providerResponse ? { providerResponse: r.providerResponse } : {}) };
}

/** Non-sensitive UI hint for a channel config (stored on the channel row). */
export function channelHint(type: AlertChannelType, config: ChannelConfig): string {
  if (type === "slack") {
    const url = (config as SlackConfig).webhookUrl ?? "";
    return url.length > 14 ? `…${url.slice(-14)}` : "";
  }
  if (type === "telegram") {
    const chatId = (config as TelegramConfig).chatId ?? "";
    return chatId ? `chat ${chatId}` : "";
  }
  return (config as EmailChannelConfig).to ?? "";
}
