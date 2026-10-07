// ShapesOS — Phase 19A (WS=server): Settings → You → Cursor — the voice
// cursor in ShapesOS Desktop: its voice, talk minutes used / included, what
// it runs on, and the download. The person's own settings (any member).

import { CursorSettings } from "@/components/cursor/CursorSettings";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { talkAllowance } from "@/lib/cursor/metering";
import { cursorVisionProvider } from "@/lib/cursor/brain";
import { sttProviderName } from "@/lib/voice/stt";
import { ttsProviderName } from "@/lib/voice/tts";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cursor — ShapesOS" };

export default async function CursorSettingsPage() {
  const { i18n } = await youContext();
  const { t } = i18n;
  const user = await requireUser();
  const ws = user?.id ? await getOrCreateWorkspace(user.id, user.email).catch(() => null) : null;
  const allowance = ws ? await talkAllowance(ws.id).catch(() => null) : null;
  const vision = ws ? await cursorVisionProvider(ws.id).catch(() => "none" as const) : "none";
  return (
    <YouFrame title={t("cursor.title")} subtitle={t("cursor.subtitle")} note={t("prefs.appliesEverywhere")}>
      <CursorSettings
        talk={{ used: allowance?.used ?? 0, included: allowance ? allowance.included : 0 }}
        providers={{ stt: sttProviderName(), tts: ttsProviderName(), vision }}
      />
    </YouFrame>
  );
}
