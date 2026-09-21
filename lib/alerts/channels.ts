// Marketr — shared alert-hub validation + audit helpers (milestone 13).

import type { AlertChannelType } from "@prisma/client";
import type { ChannelConfig } from "@/lib/alerts/adapters";
import { channelHint } from "@/lib/alerts/adapters";
import { getSecretsProvider } from "@/lib/secrets";
import { prisma } from "@/lib/prisma";

/** Validate a channel config for its type. Returns a normalized config. */
export function validateChannelConfig(
  type: AlertChannelType,
  raw: unknown,
): { ok: true; config: ChannelConfig } | { ok: false; error: string } {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (type === "slack") {
    const webhookUrl = String(c.webhookUrl ?? "").trim();
    if (!/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
      return { ok: false, error: "slack requires a webhookUrl starting with https://hooks.slack.com/" };
    }
    return { ok: true, config: { webhookUrl } };
  }
  if (type === "telegram") {
    const botToken = String(c.botToken ?? "").trim();
    const chatId = String(c.chatId ?? "").trim();
    if (!botToken || !chatId) {
      return { ok: false, error: "telegram requires botToken and chatId" };
    }
    return { ok: true, config: { botToken, chatId } };
  }
  // email
  const to = String(c.to ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: "email requires a valid recipient address (to)" };
  }
  const cc = String(c.cc ?? "").trim();
  if (cc && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cc)) {
    return { ok: false, error: "email cc is not a valid address" };
  }
  return { ok: true, config: cc ? { to, cc } : { to } };
}

/** Encrypt + hint for storage. Secrets never leave the server. */
export function sealChannelConfig(type: AlertChannelType, config: ChannelConfig): { configEnc: string; hint: string } {
  const secrets = getSecretsProvider();
  return {
    configEnc: secrets.encrypt(JSON.stringify(config)),
    hint: channelHint(type, config),
  };
}

/** Workspace-scoped alert-hub audit event (milestone 11 pattern). */
export async function auditAlertHub(
  workspaceId: string,
  action:
    | "alert_channel_created"
    | "alert_channel_updated"
    | "alert_channel_deleted"
    | "alert_rule_created"
    | "alert_rule_updated"
    | "alert_rule_deleted",
  ref: string,
  summary: string,
  actor: "user" | "system",
  approvedBy: string | null,
) {
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: null,
      connectionId: null,
      filePath: ref,
      actor,
      action,
      summary: summary.slice(0, 280),
      approvedBy,
    },
  });
}
