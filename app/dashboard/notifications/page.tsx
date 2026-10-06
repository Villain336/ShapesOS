// ShapesOS — notification center (Phase 3 J).
// The signed-in member's own notifications in the current workspace: new
// approvals, decisions on their requests, alerts, failed agent runs and
// teammates joining. Read state is per member.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import NotificationsList from "./NotificationsList";
// Phase 18.1 (WS=find): the page in the person's language.
import { getI18n } from "@/lib/i18n/server";
// Phase 18.3 (WS=trust): the lead agent's daily summary, when the person opted in (read only).
import { getUserPreferencesCached } from "@/lib/preferences";
import { readNotificationSummary } from "@/lib/notifications/summary.server";
import { briefingParts } from "@/lib/desktop/briefing";
import { AgentAvatar } from "@/components/aos/AgentAvatar";
import { LEAD_AGENT } from "@/lib/aos/agents";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Notifications — ShapesOS",
  description: "Approvals waiting on you, decisions on your requests, alerts, failed runs and team changes.",
};

export default async function NotificationsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");
  const { t } = await getI18n();
  const prefs = await getUserPreferencesCached(user.id).catch(() => null);
  const summary = prefs?.notifications.summary
    ? await readNotificationSummary(workspace.id, user.id, prefs.timeZone).catch(() => null)
    : null;
  const parts = summary?.status === "ready" && summary.body ? briefingParts(summary.body) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">{t("notifications.pageTitle")}</h1>
        <p className="mt-1 text-md text-muted">{t("notifications.pageSubtitle", { workspace: workspace.name })}</p>
      </div>
      {parts ? (
        <section aria-labelledby="notif-summary-h" className="rounded-lg bg-paper p-5 shadow-hairline" data-testid="notification-summary">
          <div className="flex items-center gap-2">
            <AgentAvatar name={LEAD_AGENT.name} size="sm" />
            <h2 id="notif-summary-h" className="aos-subheading">
              {t("trust.notifications.summaryTitle")}
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted">{t("trust.notifications.summaryBy")}</p>
          <div className="mt-3 flex flex-col gap-1 text-md text-ink">
            {parts.lead.map((l, i) => (
              <p key={`l${i}`}>{l}</p>
            ))}
            {parts.bullets.length ? (
              <ul className="ml-5 list-disc">
                {parts.bullets.map((b, i) => (
                  <li key={`b${i}`}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}
      <NotificationsList />
    </div>
  );
}
