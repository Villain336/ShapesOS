"use client";

// ShapesOS — Phase 22 (chat): a generative-UI block (OpenUI Lang). The
// program streams in with the render_ui tool's arguments and is drawn by the
// ShapesOS OpenUI library (lib/genui/library.tsx) through <Renderer
// isStreaming>. Every action a generated button fires goes through the
// chat's tool gate (ChatContext.runUiAction → executeTool: tiers, approvals,
// audit) — nothing generated can call the network itself. Form / $variable
// state persists on the message (uiState) so a reload keeps the values.

import dynamic from "next/dynamic";
import { StatusShape } from "@/components/aos/StatusShape";
import type { ChatBlock } from "@/lib/chat/blocks";
import { useI18n } from "@/components/i18n/I18nProvider";

type GenUiModel = Extract<ChatBlock, { kind: "genui" }>;

export interface GenUiHandlers {
  /** A generated button: { tool, args } through the gate; a form submit: a user turn with structured input. */
  onAction?: (event: { type: string; params: Record<string, unknown>; label: string; formState?: Record<string, unknown> }, block: GenUiModel) => void | Promise<void>;
  /** Form / $variable changes (debounced by the caller before persisting). */
  onStateUpdate?: (state: Record<string, unknown>, block: GenUiModel) => void;
  /** Open a /dashboard record in the panel. */
  onOpenHref?: (href: string, title?: string) => void;
}

// The OpenUI runtime and the component library load only when a genui block
// is on screen (they are not part of the chat shell's bundle).
const OpenUiView = dynamic(() => import("@/lib/genui/view").then((m) => m.OpenUiView), {
  ssr: false,
  loading: () => <GenUiPending />,
});

function GenUiPending() {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
      <StatusShape status="running" size={9} live />
      {t("chat.genui.streaming")}
    </p>
  );
}

export function GenUiBlock({ block, handlers = {} }: { block: GenUiModel; handlers?: GenUiHandlers }) {
  const { t } = useI18n();
  const failed = block.status !== "executed" && block.status !== "running";
  return (
    <section className="overflow-hidden rounded-md bg-paper shadow-hairline" aria-label={t("chat.panel.kinds.page")} data-genui={block.toolUseId ?? block.toolCallId}>
      {failed ? (
        <p className="px-3 py-2 text-sm text-failed-text">{t("chat.genui.error", { error: block.resultText ?? block.status })}</p>
      ) : block.program ? (
        <div className="p-3">
          <OpenUiView
            program={block.program}
            streaming={block.streaming}
            initialState={block.uiState}
            onAction={(e) => handlers.onAction?.(e, block)}
            onStateUpdate={(s) => handlers.onStateUpdate?.(s, block)}
            onOpenHref={handlers.onOpenHref}
          />
        </div>
      ) : (
        <GenUiPending />
      )}
    </section>
  );
}

export default GenUiBlock;
