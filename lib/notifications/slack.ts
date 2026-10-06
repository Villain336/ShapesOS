// ShapesOS — Phase 18.3 (WS=trust): notifications as Slack direct messages.
//
// Reuses the workspace's Slack app (lib/slack: SlackInstallation + the vault
// bot token, the same path Slack mentions answer through) — not a new
// integration. Only when the workspace has the Slack app installed AND the
// person is mapped: the bot finds them by their membership email
// (users.lookupByEmail). Best-effort: never throws; a person who isn't in the
// Slack team is skipped. The person's Slack channel is opt-in
// (lib/notifications/channels.ts).

import type { NotificationInput } from "./store";

export interface SlackDeliveryDeps {
  /** The workspace's enabled Slack install (its vault connection), or null. */
  installation(workspaceId: string): Promise<{ connectionId: string } | null>;
  /** The member's email in this workspace. */
  emailOf(workspaceId: string, userId: string): Promise<string | null>;
  /** DM this email through the install's bot; false when the person isn't in the Slack team. */
  sendDm(connectionId: string, email: string, text: string): Promise<boolean>;
  appUrl(): string | null;
}

/** The DM text: title, body, link back. PURE. */
export function slackText(n: Pick<NotificationInput, "title" | "body" | "href">, appUrl: string | null): string {
  const link = n.href && appUrl ? `${appUrl.replace(/\/$/, "")}${n.href}` : null;
  return [`*${n.title.trim()}*`, n.body?.trim() || null, link ? `<${link}|Open in ShapesOS>` : null].filter(Boolean).join("\n").slice(0, 3000);
}

export const defaultSlackDeps: SlackDeliveryDeps = {
  async installation(workspaceId) {
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    return withWorkspaceScope(workspaceId, (tx) =>
      tx.slackInstallation.findFirst({ where: { workspaceId, enabled: true }, orderBy: { createdAt: "asc" }, select: { connectionId: true } }),
    );
  },
  async emailOf(workspaceId, userId) {
    const { prisma } = await import("@/lib/prisma");
    const m = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { email: true } });
    return m?.email ?? (userId.startsWith("email:") ? userId.slice(6) : null);
  },
  async sendDm(connectionId, email, text) {
    const { loadLiveCredential } = await import("@/lib/connectors/m21/live/credentials");
    const { tokenSourceFrom } = await import("@/lib/connectors/m21/live/http");
    const { slackLookupUserByEmail, slackOpenDm, slackPostMessage } = await import("@/lib/slack/api");
    const { credential, refreshCredential } = await loadLiveCredential(connectionId);
    const auth = tokenSourceFrom(credential, { refreshCredential });
    if (!auth) return false;
    const slackUser = await slackLookupUserByEmail(auth, email);
    if (!slackUser) return false;
    const channel = await slackOpenDm(auth, slackUser);
    await slackPostMessage(auth, { channel, text });
    return true;
  },
  appUrl() {
    for (const raw of [process.env.APP_URL, process.env.NEXTAUTH_URL, process.env.AUTH_URL]) {
      try {
        if (raw) return new URL(raw).origin;
      } catch {
        /* next */
      }
    }
    return null;
  },
};

export interface SlackDeliveryResult {
  sent: number;
  skipped: number;
}

/** DM each notification to its recipient (inputs already passed the person's Slack channel). */
export async function deliverSlack(inputs: readonly NotificationInput[], deps: SlackDeliveryDeps = defaultSlackDeps): Promise<SlackDeliveryResult> {
  const out: SlackDeliveryResult = { sent: 0, skipped: 0 };
  const installs = new Map<string, { connectionId: string } | null>();
  for (const n of inputs) {
    try {
      if (!installs.has(n.workspaceId)) installs.set(n.workspaceId, await deps.installation(n.workspaceId).catch(() => null));
      const install = installs.get(n.workspaceId);
      const email = install ? await deps.emailOf(n.workspaceId, n.userId) : null;
      if (!install || !email) {
        out.skipped++;
        continue;
      }
      if (await deps.sendDm(install.connectionId, email, slackText(n, deps.appUrl()))) out.sent++;
      else out.skipped++;
    } catch (err) {
      out.skipped++;
      console.warn("[notifications] Slack DM skipped:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
