// ShapesOS — Phase 18.2 (WS=comms): social DMs in the Mail app, through
// Zernio's inbox endpoints (lib/zernio/client.ts) behind its existing
// live / mock / off switch (lib/zernio/config.ts): live with the platform
// key, the labelled FAKE Zernio (every name "(MOCK)") in dev / demo, and
// nothing at all in production without a key.
//
// Tenancy: every call carries the workspace's OWN Zernio profile, and every
// conversation is kept only when its account is one this workspace mirrors
// (zernio_accounts) — another tenant's DMs never reach this workspace even
// if the platform key could see them. Sending checks the account the same
// way (requireOwnedAccount) before anything is sent.

import { createHash } from "node:crypto";
import type { MailMessageView, MailThreadView } from "./types";
import { threadKey } from "./types";

export interface SocialInbox {
  mode: "live" | "mock" | "off";
  accounts: number;
  threads: MailThreadView[];
  error: string | null;
}

const PLATFORM_LABEL: Record<string, string> = {
  facebook: "Messenger",
  instagram: "Instagram",
  twitter: "X",
  bluesky: "Bluesky",
  reddit: "Reddit",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
};

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p] ?? p;
}

async function scopeFor(workspaceId: string) {
  const { activeZernioMode } = await import("@/lib/zernio/config");
  const mode = activeZernioMode();
  if (mode === "off") return { mode, scope: null };
  const { getZernioScope } = await import("@/lib/zernio/tenancy");
  // Never creates a profile from the Mail app: a workspace that never set up
  // Zernio (Settings → Connectors → Zernio) simply has no social inbox.
  const scope = await getZernioScope(workspaceId, { create: false }).catch(() => null);
  return { mode, scope };
}

async function ownAccounts(workspaceId: string, profileRowId: string) {
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.zernioAccount.findMany({ where: { workspaceId, profileRowId, status: { not: "disconnected" } }, select: { accountId: true, platform: true, username: true } }),
  );
}

/** The workspace's social conversations (newest first). Never throws. */
export async function listSocialThreads(workspaceId: string, limit = 50): Promise<SocialInbox> {
  try {
    const { mode, scope } = await scopeFor(workspaceId);
    if (!scope) return { mode, accounts: 0, threads: [], error: null };
    const accounts = await ownAccounts(workspaceId, scope.profileRowId);
    const mine = new Map(accounts.map((a) => [a.accountId, a]));
    if (!mine.size) return { mode, accounts: 0, threads: [], error: null };
    const { conversations } = await scope.client.listInboxConversations({ profileId: scope.profileId, limit: Math.min(limit, 100) });
    const threads: MailThreadView[] = conversations
      .filter((c) => mine.has(c.accountId))
      .map((c) => {
        const acct = mine.get(c.accountId)!;
        return {
          key: threadKey({ source: "social", accountId: c.accountId, conversationId: c.id }),
          source: "social" as const,
          via: `${platformLabel(c.platform)}${acct.username ? ` · ${acct.username}` : ""}`,
          subject: c.participantName ?? platformLabel(c.platform),
          from: { name: c.participantName ?? null, address: c.participantId ?? null },
          participants: c.participantName ? [c.participantName] : [],
          snippet: c.lastMessage ? c.lastMessage.slice(0, 200) : null,
          lastMessageAt: c.updatedTime ?? new Date(0).toISOString(),
          messageCount: null,
          unread: (c.unreadCount ?? 0) > 0,
          archived: c.status === "archived",
          labels: [],
          tags: [],
          suggestedTags: [],
          summary: null,
          channel: c.platform,
          mock: scope.mode === "mock",
          organizable: false,
        };
      });
    return { mode, accounts: mine.size, threads, error: null };
  } catch (err) {
    return { mode: "off", accounts: 0, threads: [], error: err instanceof Error ? err.message.slice(0, 200) : "Zernio did not answer." };
  }
}

/** One conversation's messages; `markRead` (a person opened it) tells Zernio it was read. */
export async function readSocialThread(
  workspaceId: string,
  ref: { accountId: string; conversationId: string },
  opts: { markRead?: boolean } = {},
): Promise<{ messages: MailMessageView[]; mock: boolean; platform: string | null }> {
  const { scope } = await scopeFor(workspaceId);
  if (!scope) throw new Error("Social messages are not connected (Settings → Connectors → Zernio).");
  const { requireOwnedAccount } = await import("@/lib/zernio/tenancy");
  const acct = await requireOwnedAccount(scope, ref.accountId);
  const msgs = await scope.client.getInboxConversationMessages(ref.conversationId, { accountId: acct.accountId, limit: 100 });
  if (opts.markRead) await scope.client.markConversationRead(ref.conversationId, { accountId: acct.accountId }).catch(() => undefined);
  return {
    mock: scope.mode === "mock",
    platform: acct.platform,
    messages: msgs.map((m) => ({
      id: m.id,
      from: { name: m.senderName ?? null, address: m.senderId ?? null },
      to: [],
      cc: [],
      at: m.createdAt ?? new Date(0).toISOString(),
      subject: null,
      body: m.isDeleted ? "" : (m.message ?? ""),
      direction: m.direction === "outgoing" ? "outbound" : "inbound",
      status: null,
      channel: m.platform ?? acct.platform,
    })),
  };
}

/** Send a DM reply in a conversation (the caller already passed the tier gate / a person clicked Send). */
export async function sendSocialReply(workspaceId: string, ref: { accountId: string; conversationId: string }, text: string, idemSeed: string): Promise<{ messageId: string | null; mock: boolean }> {
  const body = text.trim();
  if (!body) throw new Error("Write a message first.");
  if (body.length > 9000) throw new Error("Keep the message under 9,000 characters.");
  const { scope } = await scopeFor(workspaceId);
  if (!scope) throw new Error("Social messages are not connected (Settings → Connectors → Zernio).");
  const { requireOwnedAccount } = await import("@/lib/zernio/tenancy");
  const acct = await requireOwnedAccount(scope, ref.accountId);
  const key = `shapesos-dm-${createHash("sha256").update(`${workspaceId}|${ref.conversationId}|${idemSeed}`).digest("hex").slice(0, 40)}`;
  const out = await scope.client.sendInboxMessage(ref.conversationId, { accountId: acct.accountId, message: body }, key);
  return { messageId: out.messageId, mock: scope.mode === "mock" };
}
