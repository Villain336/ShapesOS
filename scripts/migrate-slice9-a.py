#!/usr/bin/env python3
"""Slice 9 mechanical pass A: crm-* class strings -> Agentic OS atom references.
Exact-string replacements only; then injects the needed ./ui imports.
Run from ~/workspace/marketr. Visual migration only.
"""
import re, sys
from pathlib import Path

ROOT = Path("components/crm")

# (old, new) exact-string replacements, longest patterns first.
REPLS = [
    # table wrapper shared by crm-table blocks
    ('className="overflow-x-auto rounded-[10px] border border-stone-200 bg-white"',
     'className={tableWrapCls}'),
    # inputs
    ('className="crm-input !py-[6px] pl-8 !text-[12.5px] w-[220px]"',
     'className={`${inputCls} pl-8 w-[220px] py-[6px]! text-[12.5px]!`}'),
    ('className="crm-input flex-1 !py-[6px] !text-[12.5px]"',
     'className={`${inputCls} flex-1 py-[6px]! text-[12.5px]!`}'),
    ('className="crm-input max-w-sm flex-1 !text-[13px]"',
     'className={`${inputCls} max-w-sm flex-1`}'),
    ('className="crm-input mt-2 min-h-[90px] w-full"',
     'className={`${inputCls} mt-2 min-h-[90px] w-full`}'),
    ('className="crm-input mt-1 w-full"',
     'className={`${inputCls} mt-1 w-full`}'),
    ('className="crm-input w-full pl-8"',
     'className={`${inputCls} w-full pl-8`}'),
    ('className="crm-input w-full"',
     'className={`${inputCls} w-full`}'),
    ('className="crm-input flex-1"',
     'className={`${inputCls} flex-1`}'),
    ('className="crm-input w-16"',
     'className={`${inputCls} w-16`}'),
    ('className="crm-input w-28"',
     'className={`${inputCls} w-28`}'),
    ('className="crm-input w-36"',
     'className={`${inputCls} w-36`}'),
    ('className="crm-input w-24"',
     'className={`${inputCls} w-24`}'),
    ('className="crm-input pl-8"',
     'className={`${inputCls} pl-8`}'),
    ('className="crm-input"',
     'className={inputCls}'),
    # selects
    ('className="crm-select !py-[6px] !text-[12.5px]"',
     'className={`${selectCls} py-[6px]! text-[12.5px]!`}'),
    ('className="crm-select w-full !text-[13px]"',
     'className={`${selectCls} w-full`}'),
    ('className="crm-select w-full"',
     'className={`${selectCls} w-full`}'),
    ('className="crm-select w-36"',
     'className={`${selectCls} w-36`}'),
    ('className="crm-select"',
     'className={selectCls}'),
    # labels / section titles
    ('className="crm-label"',
     'className={labelCls}'),
    ('className="crm-section-title !mb-0"',
     'className={`${sectionTitleCls} mb-0!`}'),
    ('className="crm-section-title"',
     'className={sectionTitleCls}'),
    # buttons
    ('className="crm-btn-primary !py-[6px] !text-[12.5px]"',
     'className={btnPrimarySm}'),
    ('className="crm-btn-primary !py-1 !px-2.5 !text-[12px]"',
     'className={btnPrimarySm}'),
    ('className="crm-btn-primary"',
     'className={btnPrimary}'),
    ('className="crm-btn-ghost !py-[6px] !text-[12.5px]"',
     'className={btnGhostSm}'),
    ('className="crm-btn-ghost !py-1 !px-2.5 !text-[12px]"',
     'className={btnGhostSm}'),
    ('className="crm-btn-ghost !py-1.5"',
     'className={btnGhostSm}'),
    ('className="crm-btn-ghost !px-2.5"',
     'className={btnGhostSm}'),
    ('className="crm-btn-ghost !text-[12.5px]"',
     'className={btnGhostSm}'),
    ('className="crm-btn-ghost"',
     'className={btnGhost}'),
    # tables (regex: keep trailing width classes)
    # overlays
    ('className="crm-backdrop"',
     'className={backdropCls}'),
    ('className="crm-modal-card"',
     'className={modalCardCls}'),
    ('className="crm-modal"',
     'className={modalWrapCls}'),
    ('className="crm-slideover items-center justify-center"',
     'className={`${slideoverCls} items-center justify-center`}'),
    ('className="crm-slideover"',
     'className={slideoverCls}'),
    # chips / tabs / kanban
    ('className="crm-chip crm-chip-violet"',
     'className={chipCls}'),
    ('className={`crm-chip ${f.enabled ? "crm-chip-green" : "crm-chip-gray"}`}',
     'className={chipCls}'),
    ('className="crm-tab inline-flex items-center gap-1.5"',
     'className={tabCls(tab === t.id)}'),
    ('className="crm-kanban-col"',
     'className={overCol === s.id ? `${kanbanColCls} ${kanbanColOverCls}` : kanbanColCls}'),
    ('className="crm-kanban-card"',
     'className={kanbanCardCls}'),
]

TABLE_RE = re.compile(r'className="crm-table w-full([^"]*)"')

# per-file local consts that shadow the atom names
LOCAL_CONSTS = {
    "FilterToolbar.tsx": (
        'const selectCls = "crm-select !py-[6px] !text-[12.5px] max-w-[150px]";',
        'const selectSm = `${selectCls} max-w-[150px] py-[6px]! text-[12.5px]!`;',
        [("className={selectCls}", "className={selectSm}")],
    ),
    "LeadSlideOver.tsx": (
        'const inputCls = "crm-input w-full !text-[13px]";',
        "",
        [("className={inputCls}", "className={`${inputCls} w-full`}")],
    ),
    "modals.tsx": (
        'const inputCls = "crm-input w-full !text-[13px]";',
        "",
        [("className={inputCls}", "className={`${inputCls} w-full`}")],
    ),
}

ATOMS = ["btnPrimary", "btnPrimarySm", "btnGhost", "btnGhostSm", "btnDeny",
         "btnApprove", "btnReview", "btnExecute",
         "inputCls", "selectCls", "labelCls", "sectionTitleCls",
         "chipCls", "tabCls", "tableWrapCls", "tableCls",
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
        new = "import { " + ", ".join(merged) + ' } from "./ui";'
        return text[:m.start()] + new + text[m.end():]
    # no ./ui import: add after the last import line
    lines = text.split("\n")
    last = max(i for i, l in enumerate(lines)
               if l.startswith("import ") or l.strip().startswith("} from "))
    lines.insert(last + 1, "import { " + ", ".join(used) + ' } from "./ui";')
    return "\n".join(lines)

def main() -> None:
    files = sorted(ROOT.glob("*.tsx"))
    for f in files:
        if f.name == "ui.tsx":
            continue
        text = f.read_text()
        orig = text
        # local shadowing consts first
        if f.name in LOCAL_CONSTS:
            old, new, extra = LOCAL_CONSTS[f.name]
            assert old in text, f"{f.name}: local const not found"
            text = text.replace(old, new)
            for a, b in extra:
                text = text.replace(a, b)
        for old, new in REPLS:
            if old in text:
                text = text.replace(old, new)
        text = TABLE_RE.sub(
            lambda m: "className={`" + "${tableCls}" + m.group(1) + "`}", text)
        # kanban: drop the now-redundant data-over attribute
        text = text.replace("\n            data-over={overCol === s.id}", "")
        if text != orig:
            text = inject_imports(text)
            f.write_text(text)
            print("migrated", f.name)

if __name__ == "__main__":
    sys.exit(main())
