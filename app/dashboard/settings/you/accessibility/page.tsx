// ShapesOS — Phase 18.1 (WS=find): Settings → You → Accessibility.
import { AccessibilityForm } from "@/components/preferences/PreferencesForm";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accessibility — ShapesOS" };

export default async function AccessibilityPage() {
  const { prefs, i18n } = await youContext();
  const { t } = i18n;
  return (
    <YouFrame title={t("prefs.accessibility.title")} subtitle={t("prefs.accessibility.subtitle")} note={t("prefs.appliesEverywhere")}>
      <AccessibilityForm initial={prefs} />
    </YouFrame>
  );
}
