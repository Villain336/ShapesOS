"use client";

// ShapesOS — Phase 19B (WS=panel): shared bits of the Dress Rehearsal screens.

import { Info } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";

export const inputClass =
  "h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]";

export function SyntheticNote({ fake }: { fake?: boolean }) {
  const { t } = useI18n();
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
      <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span>
        <strong className="font-semibold">{t("rehearsal.banner")}</strong>
        {fake ? <span className="block text-muted">{t("rehearsal.fakeModel")}</span> : null}
      </span>
    </p>
  );
}
