// ShapesOS — "Draft — not legal advice, pending lawyer review" (beta
// readiness, WS=legal). Shown on every legal page while
// LEGAL_DRAFT_PENDING_REVIEW is true. A NIGHT (black) banner on purpose: the
// four status colours mean agent states only (docs/design/DESIGN.md), so a
// document notice uses the neutral night surface like toasts do.

import { FileWarning } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";
import { LEGAL_DRAFT_PENDING_REVIEW } from "@/lib/legal/public-pages";

export async function DraftBanner() {
  if (!LEGAL_DRAFT_PENDING_REVIEW) return null;
  const { t } = await getI18n();
  return (
    <div role="note" data-testid="legal-draft-banner" className="aos-night flex items-start gap-3 rounded-md bg-night px-5 py-3 text-paper">
      <FileWarning className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-base font-semibold leading-5">{t("legal.draft.title")}</p>
        <p className="mt-0.5 text-sm leading-5 text-night-soft">{t("legal.draft.body")}</p>
      </div>
    </div>
  );
}
