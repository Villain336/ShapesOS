// ShapesOS — Phase 18.3 (WS=trust): Settings → You → Privacy. The person's
// half of the Privacy & Security center: where you're signed in (the session
// registry; sign one or all others out), phones with the app, what agents
// read for you, and what agents remember from your work (with "forget").
// Any member; every list is the caller's own.

import { headers } from "next/headers";
import { readSessionToken } from "@/lib/auth/mfa/token";
import { listUserSessions } from "@/lib/auth/sessions";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listDevices } from "@/lib/push/devices";
import { loadDataAccess } from "@/lib/privacy/data-access";
import { listMemory } from "@/lib/privacy/memory";
import { SessionsPanel, DevicesPanel } from "@/components/trust/SessionsPanel";
import { DataAccessTable } from "@/components/trust/DataAccessTable";
import { MemoryControls } from "@/components/trust/MemoryControls";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy — ShapesOS" };

function Section({ id, title, help, children }: { id: string; title: string; help: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h2 id={id} className="aos-subheading">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-muted">{help}</p>
      </div>
      {children}
    </section>
  );
}

export default async function YourPrivacyPage() {
  const { userId, i18n } = await youContext();
  const { t } = i18n;
  const user = await requireUser();
  const workspace = await getOrCreateWorkspace(userId, user?.email);
  const token = await readSessionToken({ headers: await headers() }).catch(() => null);
  const sid = token && token.sub === userId && typeof token.sid === "string" ? token.sid : null;
  const [sessions, devices, reads, memories] = await Promise.all([
    listUserSessions(userId, sid).catch(() => []),
    withWorkspaceScope(workspace.id, (tx) => listDevices(tx, { workspaceId: workspace.id, userId })).catch(() => []),
    loadDataAccess({ workspaceId: workspace.id, forUserId: userId }).catch(() => []),
    listMemory({ workspaceId: workspace.id, store: "episode", forUserId: userId }).catch(() => []),
  ]);
  return (
    <YouFrame title={t("trust.privacy.title")} subtitle={t("trust.privacy.subtitle")}>
      <Section id="privacy-sessions" title={t("trust.privacy.sessions.title")} help={t("trust.privacy.sessions.help")}>
        <SessionsPanel initial={sessions} currentListed={sessions.some((s) => s.current)} />
      </Section>
      <Section id="privacy-devices" title={t("trust.privacy.devices.title")} help={t("trust.privacy.devices.help")}>
        <DevicesPanel initial={devices.map((d) => ({ id: d.id, platform: d.platform, deviceName: d.deviceName, tokenHint: d.tokenHint, lastSeenAt: d.lastSeenAt }))} />
      </Section>
      <Section id="privacy-reads" title={t("trust.privacy.reads.title")} help={t("trust.privacy.reads.help")}>
        <DataAccessTable scope="me" initial={reads} />
      </Section>
      <Section id="privacy-memory" title={t("trust.privacy.memory.title")} help={t("trust.privacy.memory.help")}>
        <MemoryControls scope="me" initial={memories} />
      </Section>
    </YouFrame>
  );
}
