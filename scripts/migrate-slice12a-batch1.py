#!/usr/bin/env python3
"""Batch 1: mechanical token migration for thin settings/alerts/files/clips page shells.
Visual-only. Applies exact-string replacements in a fixed order (longest first).
Idempotent: rerunning changes nothing after the first pass.
"""
import sys

FILES = [
    "app/dashboard/settings/page.tsx",
    "app/dashboard/settings/agents/page.tsx",
    "app/dashboard/settings/alerts/page.tsx",
    "app/dashboard/settings/api-mcp/page.tsx",
    "app/dashboard/settings/audit/page.tsx",
    "app/dashboard/settings/automation/page.tsx",
    "app/dashboard/settings/brand-kits/page.tsx",
    "app/dashboard/settings/connectors/page.tsx",
    "app/dashboard/settings/defaults/page.tsx",
    "app/dashboard/settings/experiments/page.tsx",
    "app/dashboard/settings/governance/page.tsx",
    "app/dashboard/settings/mail/page.tsx",
    "app/dashboard/settings/media/page.tsx",
    "app/dashboard/settings/members/page.tsx",
    "app/dashboard/settings/notifications/page.tsx",
    "app/dashboard/settings/security/page.tsx",
    "app/dashboard/settings/skills/page.tsx",
    "app/dashboard/settings/usage/page.tsx",
    "app/dashboard/settings/white-label/page.tsx",
    "app/dashboard/settings/brand/intelligence/page.tsx",
    "app/dashboard/files/page.tsx",
    "app/dashboard/alerts/page.tsx",
    "app/dashboard/clips/page.tsx",
    "app/dashboard/reviews/page.tsx",
]

# (old, new) — applied in this order, all exact-string (not regex).
REPLACEMENTS = [
    # page shells
    ("bg-[#FAFAF7]", "bg-canvas"),
    ("text-xl font-bold tracking-tight text-stone-900", "aos-heading"),
    ("text-xl font-bold tracking-tight text-ink", "aos-heading"),
    ("bg-white/60", "bg-paper"),
    ("bg-white/50", "bg-paper"),
    ("bg-stone-900/30", "bg-ink/30"),
    ("shadow-xl", "shadow-overlay"),
    # text tones
    ("text-stone-900", "text-ink"),
    ("text-stone-800", "text-ink"),
    ("text-stone-700", "text-ink"),
    ("text-stone-600", "text-muted"),
    ("text-stone-500", "text-muted"),
    ("text-stone-400", "text-subtle"),
    ("text-stone-300", "text-subtle"),
    ("text-zinc-800", "text-ink"),
    ("text-zinc-600", "text-muted"),
    ("text-zinc-500", "text-muted"),
    ("text-zinc-400", "text-subtle"),
    # borders / dividers / surfaces
    ("border-stone-200", "border-line"),
    ("border-stone-100", "border-line"),
    ("divide-stone-200", "divide-line"),
    ("divide-stone-100", "divide-line"),
    ("border-zinc-200", "border-line"),
    ("border-zinc-100", "border-line"),
    ("bg-stone-200", "bg-canvas"),
    ("bg-stone-100", "bg-canvas"),
    ("bg-stone-50", "bg-canvas"),
    ("bg-zinc-100", "bg-canvas"),
    ("bg-zinc-50", "bg-canvas"),
    # hovers
    ("hover:bg-stone-100", "hover:bg-hover-paper"),
    ("hover:bg-[var(--brand-50)]", "hover:bg-hover-paper"),
    ("group-hover:text-[var(--brand-700)]", "group-hover:text-ink"),
    ("hover:text-stone-600", "hover:text-ink"),
    ("hover:text-stone-800", "hover:text-ink"),
    ("hover:border-zinc-400", "hover:border-ink"),
    # violet brand -> ink primary
    ("border-violet-600", "border-ink"),
    ("text-violet-700", "text-ink"),
    ("text-violet-600", "text-ink"),
    ("bg-violet-600", "bg-ink"),
    ("hover:bg-violet-700", "hover:bg-night-hover"),
    ("focus:border-violet-400", "focus:border-focus"),
    ("focus-visible:ring-violet-600", "focus-visible:ring-focus"),
    # dynamic-brand var refs -> tokens (shims map them to ink anyway;
    # the WhiteLabelSettings live-preview strip is NOT in this batch)
    ("text-[var(--brand-700)]", "text-ink"),
    ("border-brand-600", "border-ink"),
    ("text-brand-700", "text-ink"),
    ("accent-brand-600", "accent-ink"),
    # semantic colors in these shells -> neutrals
    ("bg-emerald-50 text-emerald-700", "bg-canvas text-muted border border-line"),
    ("bg-emerald-900/40 text-emerald-700", "bg-canvas text-muted"),
    ("text-emerald-600", "text-ink"),
    ("text-emerald-700", "text-ink"),
    ("text-amber-700", "text-muted"),
    ("text-red-600", "text-failed-text"),
    ("text-red-700", "text-failed-text"),
]

def migrate(path):
    with open(path) as f:
        src = f.read()
    orig = src
    for old, new in REPLACEMENTS:
        if old in src:
            src = src.replace(old, new)
    if src != orig:
        with open(path, "w") as f:
            f.write(src)
        print(f"migrated: {path}")
    else:
        print(f"no-change: {path}")

if __name__ == "__main__":
    for f in FILES:
        try:
            migrate(f)
        except FileNotFoundError:
            print(f"MISSING: {f}", file=sys.stderr)
