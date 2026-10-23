"use client";

// ShapesOS — Phase 22 (chat): a generative-UI block (OpenUI Lang).
//
// INTERIM: the OpenUI renderer and the ShapesOS component library
// (lib/genui) are the next slice. Until they land, the program the
// render_ui tool streams is shown as its source (mono, read-only) so the
// block model, its streaming and its persistence are already in place —
// nothing generated is executed or rendered as markup.

import { StatusShape } from "@/components/aos/StatusShape";
import type { ChatBlock } from "@/lib/chat/blocks";
import { useI18n } from "@/components/i18n/I18nProvider";
import { CodeBlock } from "../Markdown";

type GenUiModel = Extract<ChatBlock, { kind: "genui" }>;

export interface GenUiHandlers {
  /** A generated button: { tool, args } through the gate; a form submit: a user turn with structured input. */
  onAction?: (event: { type: string; params: Record<string, unknown>; label: string; formState?: Record<string, unknown> }, block: GenUiModel) => void | Promise<void>;
  /** Form / $variable changes (debounced by the caller before persisting). */
  onStateUpdate?: (state: Record<string, unknown>, block: GenUiModel) => void;
  /** Open a /dashboard record in the panel. */
  onOpenHref?: (href: string, title?: string) => void;
}

export function GenUiBlock({ block }: { block: GenUiModel; handlers?: GenUiHandlers }) {
  const { t } = useI18n();
  const failed = block.status !== "executed" && block.status !== "running";
  return (
    <section className="overflow-hidden rounded-md bg-paper shadow-hairline" aria-label={t("chat.panel.kinds.page")} data-genui={block.toolUseId ?? block.toolCallId}>
      {failed ? (
        <p className="px-3 py-2 text-sm text-failed-text">{t("chat.genui.error", { error: block.resultText ?? block.status })}</p>
      ) : block.streaming || !block.program ? (
        <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
          <StatusShape status="running" size={9} live />
          {t("chat.genui.streaming")}
        </p>
      ) : null}
      {block.program ? <CodeBlock code={block.program} lang="openui" className="m-2" /> : null}
    </section>
  );
}

export default GenUiBlock;
