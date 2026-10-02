#!/usr/bin/env python3
"""Slice 12b mechanical migration: Agentic OS tokens for VOICE / ACTIONS /
AUTHORITY / SUBSTRATE / SETTINGS-PROVIDERS.

Mechanical pass only: stone/brand/red token swaps, uppercase kill, shape
normalization. Semantics (chips, buttons, inputs, sentence case) are
hand-edited after this pass. Visual only — no logic changes.

Usage: python3 scripts/migrate-slice12b.py [--dry-run]
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

FILES = [
    # voice (16)
    "app/dashboard/voice/layout.tsx",
    "app/dashboard/voice/tabs.tsx",
    "app/dashboard/voice/_client.tsx",
    "app/dashboard/voice/page.tsx",
    "app/dashboard/voice/sessions/page.tsx",
    "app/dashboard/voice/sessions/[id]/page.tsx",
    "app/dashboard/voice/scripts/page.tsx",
    "app/dashboard/voice/consent/page.tsx",
    "app/dashboard/voice/studio/page.tsx",
    "app/dashboard/voice/pronunciation/page.tsx",
    "app/dashboard/voice/AgentsApp.tsx",
    "app/dashboard/voice/sessions/SessionsApp.tsx",
    "app/dashboard/voice/sessions/[id]/SessionDetailApp.tsx",
    "app/dashboard/voice/consent/ConsentApp.tsx",
    "app/dashboard/voice/scripts/ScriptsApp.tsx",
    "app/dashboard/voice/studio/VoiceoverStudio.tsx",
    "app/dashboard/voice/pronunciation/PronunciationApp.tsx",
    # actions (2)
    "app/dashboard/actions/page.tsx",
    "app/dashboard/actions/ActionsClient.tsx",
    # authority (19 incl. area-owned _components)
    "app/dashboard/authority/page.tsx",
    "app/dashboard/authority/layout.tsx",
    "app/dashboard/authority/outreach/page.tsx",
    "app/dashboard/authority/outreach/_components/OutreachActions.tsx",
    "app/dashboard/authority/outreach/campaigns/[id]/page.tsx",
    "app/dashboard/authority/aeo/page.tsx",
    "app/dashboard/authority/aeo/_components/AeoActions.tsx",
    "app/dashboard/authority/intelligence/page.tsx",
    "app/dashboard/authority/intelligence/_components/FinalizeReportButton.tsx",
    "app/dashboard/authority/intelligence/_components/GenerateReportButton.tsx",
    "app/dashboard/authority/intelligence/_components/PlanBoard.tsx",
    "app/dashboard/authority/listings/page.tsx",
    "app/dashboard/authority/listings/_components/brief-builder.tsx",
    "app/dashboard/authority/listings/_components/connect-button.tsx",
    "app/dashboard/authority/pr/page.tsx",
    "app/dashboard/authority/pr/_components/PrActions.tsx",
    "app/dashboard/authority/reviews/page.tsx",
    "app/dashboard/authority/reviews/_components/ReviewActions.tsx",
    # substrate (27)
    "app/dashboard/substrate/page.tsx",
    "app/dashboard/substrate/layout.tsx",
    "app/dashboard/substrate/tabs.tsx",
    "app/dashboard/substrate/ui.tsx",
    "app/dashboard/substrate/graph/layout.tsx",
    "app/dashboard/substrate/graph/page.tsx",
    "app/dashboard/substrate/graph/connectors/page.tsx",
    "app/dashboard/substrate/graph/er-queue/page.tsx",
    "app/dashboard/substrate/graph/er-queue/er-queue-client.tsx",
    "app/dashboard/substrate/graph/connectors/connectors-client.tsx",
    # NOTE: graph/mindmap-client.tsx excluded — canvas internals stay;
    # chrome is hand-edited.
    "app/dashboard/substrate/campaigns/layout.tsx",
    "app/dashboard/substrate/campaigns/page.tsx",
    "app/dashboard/substrate/campaigns/[id]/page.tsx",
    "app/dashboard/substrate/campaigns/new/page.tsx",
    "app/dashboard/substrate/campaigns/proposals/page.tsx",
    "app/dashboard/substrate/campaigns/client-actions.tsx",
    "app/dashboard/substrate/memory/layout.tsx",
    "app/dashboard/substrate/memory/page.tsx",
    "app/dashboard/substrate/memory/learnings/page.tsx",
    "app/dashboard/substrate/memory/episodes/page.tsx",
    "app/dashboard/substrate/memory/consolidation/page.tsx",
    "app/dashboard/substrate/memory/consolidation/consolidation-trigger.tsx",
    "app/dashboard/substrate/memory/recall/page.tsx",
    "app/dashboard/substrate/memory/recall/recall-client.tsx",
    "app/dashboard/substrate/memory/playbook/page.tsx",
    "app/dashboard/substrate/memory/playbook/playbook-review-buttons.tsx",
    # settings (1)
    "app/dashboard/settings/providers/page.tsx",
]

# Ordered plain-string replacements. Order matters: hover/qualified
# variants before the generic token.
REPLACEMENTS = [
    ("hover:bg-stone-50", "hover:bg-hover-paper"),
    ("hover:bg-stone-100", "hover:bg-hover-paper"),
    ("hover:bg-stone-200", "hover:bg-hover-paper"),
    ("hover:bg-[var(--brand-50)]/40", "hover:bg-hover-paper"),
    ("hover:bg-[var(--brand-700)]", "hover:bg-night-hover"),
    ("hover:bg-[var(--brand-600)]", "hover:bg-night-hover"),
    ("hover:bg-red-700", "hover:bg-failed/90"),
    ("hover:bg-red-600", "hover:bg-failed/90"),
    ("hover:bg-red-50", "hover:bg-failed-tint"),
    ("hover:bg-amber-50", "hover:bg-needs-tint"),
    ("hover:text-stone-800", "hover:text-ink"),
    ("hover:text-stone-700", "hover:text-ink"),
    ("hover:text-stone-600", "hover:text-ink"),
    ("bg-[var(--brand-600)]/70", "bg-ink/70"),
    ("bg-[var(--brand-600)]", "bg-ink"),
    ("bg-[var(--brand-700)]", "bg-night-hover"),
    ("text-[var(--brand-700)]", "text-ink"),
    ("text-[var(--brand-600)]", "text-ink"),
    ("border-[var(--brand-600)]", "border-ink"),
    ("accent-[var(--brand-600)]", "accent-ink"),
    ("focus:border-[var(--brand-600)]", "focus:border-focus"),
    ("bg-[var(--brand-50)]", "bg-canvas"),
    ("bg-[#FAFAF7]", "bg-canvas"),
    ("bg-stone-50", "bg-paper"),
    ("bg-stone-100", "bg-paper"),
    ("bg-stone-200", "bg-line"),
    ("bg-stone-300", "bg-disabled-fg"),
    ("bg-white", "bg-paper"),
    ("border-stone-200", "border-line"),
    ("border-stone-100", "border-line"),
    ("border-stone-300", "border-line"),
    ("divide-stone-200", "divide-line"),
    ("divide-stone-100", "divide-line"),
    ("text-stone-900", "text-ink"),
    ("text-stone-800", "text-ink"),
    ("text-stone-700", "text-muted"),
    ("text-stone-600", "text-muted"),
    ("text-stone-500", "text-muted"),
    ("text-stone-400", "text-subtle"),
    ("text-stone-300", "text-subtle"),
    ("placeholder:text-stone-400", "placeholder:text-subtle"),
    ("bg-red-600", "bg-failed"),
    ("bg-red-50/60", "bg-failed-tint"),
    ("bg-red-50", "bg-failed-tint"),
    ("text-red-800", "text-failed-text"),
    ("text-red-700", "text-failed-text"),
    ("text-red-600", "text-failed-text"),
    ("border-red-200", "border-failed"),
    ("border-red-100", "border-failed"),
    ("bg-amber-50", "bg-needs-tint"),
    ("border-amber-200", "border-needs"),
    ("bg-black", "bg-ink"),
    ("text-black", "text-ink"),
    ("border-black", "border-ink"),
    ("rounded-xl", "rounded-lg"),
    ("shadow-sm", "shadow-hairline"),
]

DROP_TOKENS = {"uppercase", "tracking-wide", "tracking-widest"}


def strip_eyebrow_tokens(src: str) -> tuple[str, int]:
    """Remove uppercase/tracking eyebrow tokens from className="..." strings."""
    n = 0

    def fix(m: re.Match) -> str:
        nonlocal n
        toks = m.group(1).split(" ")
        kept = [t for t in toks if t not in DROP_TOKENS]
        n += len(toks) - len(kept)
        return 'className="' + " ".join(kept) + '"'

    out = re.sub(r'className="([^"]*)"', fix, src)
    return out, n


def main() -> None:
    dry = "--dry-run" in sys.argv
    total_files = 0
    total_repl = 0
    for rel in FILES:
        p = ROOT / rel
        src = p.read_text()
        orig = src
        repl_count = 0
        for old, new in REPLACEMENTS:
            c = src.count(old)
            if c:
                src = src.replace(old, new)
                repl_count += c
        src, dropped = strip_eyebrow_tokens(src)
        if src != orig:
            total_files += 1
            total_repl += repl_count
            print(f"{rel}: {repl_count} token swaps, {dropped} eyebrow tokens dropped")
            if not dry:
                p.write_text(src)
    print(f"---\n{total_files} files changed, {total_repl} token swaps{' (dry run)' if dry else ''}")


if __name__ == "__main__":
    main()
