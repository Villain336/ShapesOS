// ShapesOS — Phase 18.1 (WS=find): Settings → You → Language and region.
import { LanguageForm } from "@/components/preferences/PreferencesForm";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Language and region — ShapesOS" };

export default async function LanguagePage() {
  const { prefs, i18n } = await youContext();
  const { t } = i18n;
  return (
    <YouFrame title={t("prefs.language.title")} subtitle={t("prefs.language.subtitle")} note={t("prefs.appliesEverywhere")}>
      <LanguageForm initial={prefs} />
    </YouFrame>
  );
}
