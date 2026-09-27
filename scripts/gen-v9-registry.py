#!/usr/bin/env python3
"""Generate the v9 Tier 1S registry additions for allowlist.ts.

Reads data/corpus/backups/wave-9/registry-meta.json, verifies each playbook file
exists and is >=2000 chars (the ingest gate's bar), and inserts:
  - SEED_SOURCES entries (tier "learn-only", fetchUrls [], playbook {...})
  - SYNTHESIS_PLAYBOOKS entries
before the closing of each array in lib/intelligence/corpus/allowlist.ts.

Idempotent-ish: refuses to run twice (checks for the v9 marker comment).
Sources whose playbook is missing/thin are reported and NOT registered —
they stay pending in the manifest.
"""
import json, os, re, sys

REPO = "/home/hatch/workspace/marketr"
ALLOW = f"{REPO}/lib/intelligence/corpus/allowlist.ts"
SYN_DIR = f"{REPO}/data/corpus/synthesis"
MARKER = "// === v9 Tier 1S wave (2026-09-27): 281-source catalog synthesis ==="

def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')

def main() -> None:
    meta = json.load(open("data/corpus/backups/wave-9/registry-meta.json"))
    src = open(ALLOW).read()
    if MARKER in src:
        print("v9 marker already present — refusing to double-insert")
        sys.exit(1)

    targets = [(sid, v) for sid, v in meta.items() if not v["acquisition_only"]]
    ok, skipped = [], []
    for sid, v in sorted(targets):
        fp = os.path.join(SYN_DIR, f"{sid}-playbook.md")
        if not os.path.exists(fp):
            skipped.append((sid, "missing file"))
            continue
        if os.path.getsize(fp) < 2000:
            skipped.append((sid, f"thin ({os.path.getsize(fp)} chars)"))
            continue
        ok.append((sid, v))

    seed_lines = ["", MARKER]
    pb_lines = ["", MARKER]
    for sid, v in ok:
        seed_lines.append("  {")
        seed_lines.append(f'    id: "{esc(sid)}",')
        seed_lines.append(f'    title: "{esc(v["name"])}",')
        seed_lines.append(f'    author: "{esc(v["manifest_author"])}",')
        seed_lines.append('    tier: "learn-only",')
        seed_lines.append('    license: "learn-only",')
        seed_lines.append('    licenseUrl: "",')
        seed_lines.append(f'    pillar: "{v["pillar"]}",')
        seed_lines.append(f'    teaches: "{esc(v["teaches"])}",')
        seed_lines.append("    fetchUrls: [],")
        seed_lines.append('    format: "html",')
        seed_lines.append("    pendingReason: undefined,")
        seed_lines.append(f'    playbook: {{ file: "{esc(sid)}-playbook.md", synthesizedFrom: ["{esc(v["name"])}"] }},')
        seed_lines.append("  },")
        pb_lines.append(
            f'  {{ sourceId: "{esc(sid)}", file: "{esc(sid)}-playbook.md", '
            f'title: "{esc(v["name"])}", synthesizedFrom: ["{esc(v["name"])}"] }},'
        )

    # Insert SEED_SOURCES entries before the array's closing "];" at col 0.
    # (Line-based: Area 1's concurrent edits moved the old text anchors.)
    lines = src.split("\n")
    seed_close = None
    in_seed = False
    for i, ln in enumerate(lines):
        if ln.startswith("export const SEED_SOURCES"):
            in_seed = True
        elif in_seed and ln == "];":
            seed_close = i
            break
    assert seed_close is not None, "SEED_SOURCES close not found"
    lines[seed_close:seed_close] = seed_lines

    # Insert SYNTHESIS_PLAYBOOKS entries before its closing "];".
    pb_close = None
    in_pb = False
    for i, ln in enumerate(lines):
        if ln.startswith("export const SYNTHESIS_PLAYBOOKS"):
            in_pb = True
        elif in_pb and ln == "];":
            pb_close = i
            break
    assert pb_close is not None, "SYNTHESIS_PLAYBOOKS close not found"
    lines[pb_close:pb_close] = pb_lines

    src = "\n".join(lines)
    open(ALLOW, "w").write(src)
    print(f"registered {len(ok)} sources; skipped {len(skipped)}")
    for sid, why in skipped:
        print(f"  SKIP {sid}: {why}")

if __name__ == "__main__":
    main()
