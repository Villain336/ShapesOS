#!/usr/bin/env python3
"""Slice 9 mechanical pass B: design-token mapping across components/crm/*.tsx.
Exact word-boundary replacements only. Visual migration only.
Run from ~/workspace/marketr.
"""
import re, sys
from pathlib import Path

ROOT = Path("components/crm")

# (pattern, replacement) — regex with \b boundaries, applied in order.
PAIRS = [
    # text colors
    (r"\btext-stone-900\b", "text-ink"), (r"\btext-stone-800\b", "text-ink"),
    (r"\btext-stone-700\b", "text-ink"),
    (r"\btext-stone-600\b", "text-muted"), (r"\btext-stone-500\b", "text-muted"),
    (r"\btext-stone-400\b", "text-subtle"), (r"\btext-stone-300\b", "text-subtle"),
    (r"\btext-violet-900\b", "text-ink"), (r"\btext-violet-800\b", "text-ink"),
    (r"\btext-violet-700\b", "text-ink"), (r"\btext-violet-600\b", "text-ink"),
    (r"\btext-red-700\b", "text-failed-text"), (r"\btext-red-600\b", "text-failed-text"),
    (r"\btext-green-800\b", "text-ink"), (r"\btext-green-700\b", "text-ink"),
    (r"\btext-green-600\b", "text-ink"),
    (r"\btext-amber-900\b", "text-ink"), (r"\btext-amber-800\b", "text-ink"),
    (r"\btext-amber-700\b", "text-ink"), (r"\btext-amber-500\b", "text-ink"),
    (r"\btext-blue-700\b", "text-ink"), (r"\btext-teal-700\b", "text-ink"),
    # backgrounds
    (r"\bbg-stone-200\b", "bg-line"),
    (r"\bbg-stone-100\b", "bg-canvas"), (r"\bbg-stone-50\b", "bg-canvas"),
    (r"\bbg-violet-100\b", "bg-canvas"), (r"\bbg-violet-50\b", "bg-canvas"),
    (r"\bbg-red-100\b", "bg-failed-tint"), (r"\bbg-red-50\b", "bg-failed-tint"),
    (r"\bbg-green-100\b", "bg-canvas"), (r"\bbg-green-50\b", "bg-canvas"),
    (r"\bbg-amber-100\b", "bg-canvas"), (r"\bbg-amber-50\b", "bg-canvas"),
    (r"\bbg-blue-100\b", "bg-canvas"),
    (r"\bbg-\[#FAFAF7\]", "bg-canvas"),
    # borders
    (r"\bborder-stone-300\b", "border-control"),
    (r"\bborder-stone-200\b", "border-line"), (r"\bborder-stone-100\b", "border-line"),
    (r"\bborder-red-200\b", "border-failed"),
    (r"\bborder-green-200\b", "border-line"),
    (r"\bborder-amber-300\b", "border-line"), (r"\bborder-amber-200\b", "border-line"),
    # hovers
    (r"\bhover:bg-stone-100\b", "hover:bg-hover-paper"),
    (r"\bhover:bg-stone-50\b", "hover:bg-hover-paper"),
    (r"\bhover:text-stone-800\b", "hover:text-ink"),
    (r"\bhover:text-stone-700\b", "hover:text-ink"),
    (r"\bhover:text-stone-500\b", "hover:text-ink"),
    (r"\bhover:bg-red-50\b", "hover:bg-failed-tint"),
    (r"\bhover:text-red-600\b", "hover:text-failed-text"),
    (r"\bhover:bg-violet-50\b", "hover:bg-hover-paper"),
    (r"\bhover:text-violet-700\b", "hover:text-ink"),
    # radii + shadows
    (r"\brounded-\[12px\]", "rounded-lg"),
    (r"\brounded-\[10px\]", "rounded-md"),
    (r"\brounded-lg\b", "rounded-md"),
    (r"\bshadow-xl\b", "shadow-overlay"), (r"\bshadow-lg\b", "shadow-overlay"),
    # raw hex in inline styles
    (r"#7c3aed", "var(--aos-ink)"),
    (r"#e7e5e4", "var(--aos-line)"),
]

def main() -> None:
    total = 0
    for f in sorted(ROOT.glob("*.tsx")):
        if f.name == "ui.tsx":
            continue
        text = f.read_text()
        orig = text
        for pat, rep in PAIRS:
            text, n = re.subn(pat, rep, text)
            total += n
        if text != orig:
            f.write_text(text)
            print("tokens", f.name)
    print("replacements:", total)

if __name__ == "__main__":
    sys.exit(main())
