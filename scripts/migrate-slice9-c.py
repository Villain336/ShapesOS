#!/usr/bin/env python3
"""Slice 9 mechanical pass C: hand-written brand-var buttons/inputs -> atoms.
Exact-string replacements; re-runs ./ui import injection after.
Run from ~/workspace/marketr.
"""
import re, sys
from pathlib import Path

ROOT = Path("components/crm")

# primary buttons -> btnPrimary
PRIMARY = [
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-[var(--brand-700)]',
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)]',
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50',
]
# ghost buttons -> btnGhost
GHOST = [
    'inline-flex items-center gap-1.5 rounded-md border border-control bg-white px-3 py-[7px] text-[13px] font-semibold text-ink hover:bg-canvas disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md border border-control bg-white px-3 py-[7px] text-[13px] font-semibold text-ink hover:bg-canvas',
    'rounded-md border border-control bg-white px-3 py-[7px] text-[13px] font-semibold text-ink hover:bg-canvas',
    'rounded-md border border-control bg-white px-4 py-2 text-[13px] font-semibold text-ink hover:bg-canvas',
    'rounded-md border border-control bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-canvas disabled:opacity-50',
    'rounded-md border border-control bg-white px-4 py-2 text-[13px] font-semibold text-ink',
    'rounded-md border border-control bg-white px-3 py-1.5 text-[13px] font-semibold text-ink',
    'inline-flex items-center gap-1.5 rounded-md border border-control bg-white px-3 py-2 text-[13px] font-semibold text-muted hover:bg-canvas disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md border border-control bg-white px-3 py-2 text-[13px] font-semibold text-ink hover:bg-canvas disabled:opacity-50',
    'inline-flex items-center gap-1.5 rounded-md border border-control bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-canvas',
]
# inputs -> inputCls (+ width kept outside)
INPUTS = [
    ('w-full rounded-md border border-control bg-white px-3 py-2 text-[13px] text-ink focus:border-[var(--brand-600)] focus:outline-none',
     '`${inputCls} w-full`'),
    ('rounded-md border border-control bg-white px-2 py-1.5 text-[13px] text-ink focus:border-[var(--brand-600)] focus:outline-none',
     '{inputCls}'),
    ('w-64 rounded-md border border-control bg-white px-3 py-[7px] text-[13px] text-ink placeholder:text-subtle focus:border-[var(--brand-600)] focus:outline-none',
     '`${inputCls} w-64`'),
    ('w-56 rounded-md border border-control bg-white py-1.5 pl-8 pr-2 text-[13px] text-ink placeholder:text-subtle focus:border-[var(--brand-600)] focus:outline-none',
     '`${inputCls} w-56 pl-8`'),
]

ATOMS = ["btnPrimary", "btnPrimarySm", "btnGhost", "btnGhostSm", "btnDeny",
         "btnApprove", "btnReview", "btnExecute",
         "inputCls", "selectCls", "labelCls", "sectionTitleCls",
         "chipCls", "tabCls", "tableWrapCls", "tableCls", "trClickableCls",
         "kanbanColCls", "kanbanColOverCls", "kanbanCardCls",
         "backdropCls", "slideoverCls", "modalWrapCls", "modalCardCls",
         "errorBoxCls", "noteBoxCls", "infoBoxCls", "needsBoxCls"]
UI_IMPORT_RE = re.compile(r'import\s*\{([^}]*)\}\s*from\s*"\./ui"\s*;', re.S)

def inject_imports(text: str) -> str:
    used = sorted({a for a in ATOMS if re.search(r"\b" + a + r"\b", text)})
    if not used:
        return text
    m = UI_IMPORT_RE.search(text)
    if m:
        existing = [n.strip() for n in m.group(1).split(",") if n.strip()]
        merged = sorted(set(existing) | set(used))
        return text[:m.start()] + "import { " + ", ".join(merged) + ' } from "./ui";' + text[m.end():]
    lines = text.split("\n")
    last = max(i for i, l in enumerate(lines)
               if l.startswith("import ") or l.strip().startswith("} from "))
    lines.insert(last + 1, "import { " + ", ".join(used) + ' } from "./ui";')
    return "\n".join(lines)

def main() -> None:
    for f in sorted(ROOT.glob("*.tsx")):
        if f.name == "ui.tsx":
            continue
        t = f.read_text()
        orig = t
        for old in PRIMARY:
            t = t.replace('className="' + old + '"', 'className={btnPrimary}')
        for old in GHOST:
            t = t.replace('className="' + old + '"', 'className={btnGhost}')
        for old, new in INPUTS:
            t = t.replace('className="' + old + '"', 'className=' + new)
        # singletons
        t = t.replace('className="hover:bg-[var(--brand-50)]/40"', 'className={trClickableCls}')
        t = t.replace('inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-700)] hover:underline',
                      'inline-flex items-center gap-1 text-[12px] font-semibold text-ink hover:underline')
        t = t.replace('h-full rounded-full bg-[var(--brand-600)]', 'h-full rounded-full bg-ink')
        t = re.sub(r"\bbg-white\b", "bg-paper", t)
        if t != orig:
            t = inject_imports(t)
            f.write_text(t)
            print("atoms", f.name)

if __name__ == "__main__":
    sys.exit(main())
