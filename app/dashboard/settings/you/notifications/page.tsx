// ShapesOS — Phase 18.1 (WS=find): Settings → You → Notifications (the
// person's own channels; workspace defaults stay in Workspace → Notifications).
import { NotificationPrefsForm } from "@/components/preferences/PreferencesForm";
import { YouFrame, youContext } from "../_shared";
// Phase 18.3 (WS=flow): connect this browser to Web Push (lib/push/web.ts).
import { WebPushSwitch } from "@/components/offline/WebPushSwitch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your notifications — ShapesOS" };

export default async function YourNotificationsPage() {
  const { prefs, i18n } = await youContext();
  const { t } = i18n;
  return (
    <YouFrame title={t("prefs.notifications.title")} subtitle={t("prefs.notifications.subtitle")} note={t("prefs.appliesEverywhere")}>
      <NotificationPrefsForm initial={prefs} />
      <div className="mt-6">
        <WebPushSwitch />
      </div>
    </YouFrame>
  );
}
