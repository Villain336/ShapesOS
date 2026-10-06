// ShapesOS — Phase 18.1 (WS=find): Settings → You → Appearance.
import { AppearanceForm } from "@/components/preferences/PreferencesForm";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appearance — ShapesOS" };

export default async function AppearancePage() {
  const { prefs, i18n } = await youContext();
  const { t } = i18n;
  return (
    <YouFrame title={t("prefs.appearance.title")} subtitle={t("prefs.appearance.subtitle")} note={t("prefs.appliesEverywhere")}>
      <AppearanceForm initial={prefs} />
    </YouFrame>
  );
}
