#!/usr/bin/env python3
"""R07 recipe verifier. Applies the 4 recipe checks to every trace in
traces-r07-pilot.jsonl. Prints pass/reject stats + top rejection reasons.
Exit code 0 if zero rejects, 1 otherwise."""
import json, re, sys, os
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r07_data import VOICES, MECHANISMS

BANNED = ["game-changing", "gamechanger", "game-changer", "revolutionary",
          "revolutionize", "revolutionise", "unlock", "unlocks", "unlocked",
          "unlocking", "unleash", "disrupt", "disruptive", "disruption",
          "cutting-edge", "cutting edge", "groundbreaking", "mind-blowing",
          "mindblowing", "jaw-dropping", "jawdropping"]

EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF\ufe0f]")

PATH = os.path.expanduser("~/workspace/marketr/training/traces/traces-r07-pilot.jsonl")


def parse_variants(output):
    """Parse VARIANT blocks -> list of dicts {n, mech, status, text}."""
    out = []
    blocks = re.split(r"^VARIANT (\d+) \[mechanism: ([^\]]+)\] \[status: ([^\]]+)\]\n",
                      output, flags=re.M)
    # blocks[0] is header; then groups of (n, mech, status, body)
    it = iter(blocks[1:])
    for n, mech, status, body in zip(it, it, it, it):
        m = re.search(r'^"((?:[^"\\]|\\.)*)"', body, flags=re.M)
        text = m.group(1) if m else ""
        out.append({"n": int(n), "mech": mech.strip(), "status": status.strip(), "text": text})
    return out


def check(rec):
    reasons = []
    b = rec["brief"]
    out = rec["output"]
    variants = parse_variants(out)

    # 1. brand voice card present; winner consistent with it
    voice_names = [v["name"] for v in VOICES.values()]
    if not any(vn in b["constraints"] for vn in voice_names):
        reasons.append("no-voice-card-in-brief")
    wm = re.search(r"^WINNER: Variant (\d+)", out, flags=re.M)
    if not wm:
        reasons.append("no-winner-line")
        winner_idx = None
    else:
        winner_idx = int(wm.group(1)) - 1
        if not (0 <= winner_idx < len(variants)):
            reasons.append("winner-index-out-of-range")
        elif variants[winner_idx]["status"] != "endorsed":
            reasons.append("winner-not-endorsed")
    rat = re.search(r"^RATIONALE: (.*)", out, flags=re.M)
    if not rat or not rat.group(1).strip():
        reasons.append("no-rationale")
    elif not any(vn in rat.group(1) for vn in voice_names):
        reasons.append("rationale-ignores-voice")

    # 2. no hype adjectives in endorsed copy (winner + endorsed variants + rationale)
    endorsed_text = " ".join(v["text"] for v in variants if v["status"] == "endorsed")
    if winner_idx is not None and 0 <= winner_idx < len(variants):
        endorsed_text += " " + variants[winner_idx]["text"]
    if rat:
        endorsed_text += " " + rat.group(1)
    low = endorsed_text.lower()
    hits = [w for w in BANNED if w in low]
    if hits:
        reasons.append("hype-in-endorsed-copy:" + ",".join(sorted(set(hits))))
    # rejected variants MAY contain hype words, but must be marked rejected (already parsed)
    if EMOJI_RE.search(rec["reasoning_trace"] + out):
        reasons.append("emoji-present")

    # 3. performance numbers labeled modeled/simulated with significance caveat
    if "MODELED A/B RESULT" in out:
        if "simulat" not in out.lower():
            reasons.append("ab-numbers-not-labeled-simulated")
        if "p<0.05" not in out and "p < 0.05" not in out:
            reasons.append("ab-missing-significance-note")
        if "not measured" not in out.lower() and "not real results" not in out.lower():
            reasons.append("ab-missing-not-measured-disclaimer")

    # 4. each variant's mechanism named (from taxonomy)
    if not variants:
        reasons.append("no-variants-parsed")
    for v in variants:
        if v["mech"] not in MECHANISMS:
            reasons.append(f"variant-{v['n']}-mechanism-unnamed:{v['mech']}")
        if not v["text"]:
            reasons.append(f"variant-{v['n']}-empty-text")

    # schema sanity
    if not rec.get("corpus_chunk_ids"):
        reasons.append("no-chunk-ids")
    if rec.get("license_class") not in ("TIER-2-OPEN", "TIER-1S-SYNTH"):
        reasons.append("bad-license-class")
    # license/chunk consistency: any 1s- chunk -> must be TIER-1S-SYNTH
    has_1s = any(c.startswith("1s-") for c in rec.get("corpus_chunk_ids", []))
    if has_1s and rec.get("license_class") != "TIER-1S-SYNTH":
        reasons.append("license-mismatch-1s-chunk-not-synth")
    if not has_1s and rec.get("license_class") != "TIER-2-OPEN":
        reasons.append("license-mismatch-no-1s-chunk-not-open")
    # split present
    if rec.get("split") not in ("train", "held-out"):
        reasons.append("bad-split")
    return reasons


def main():
    recs = [json.loads(l) for l in open(PATH) if l.strip()]
    passes, rejects = 0, []
    reason_counter = Counter()
    for rec in recs:
        rs = check(rec)
        if rs:
            rejects.append((rec["record_id"], rs))
            for r in rs:
                reason_counter[r.split(":")[0]] += 1
        else:
            passes += 1
    # family split integrity: no family across splits
    fam_split = {}
    for rec in recs:
        fam_split.setdefault(rec["duplicate_family"], set()).add(rec["split"])
    leaked = {f: s for f, s in fam_split.items() if len(s) > 1}
    print(f"records: {len(recs)} | PASS: {passes} | REJECT: {len(rejects)}")
    print(f"families: {len(fam_split)} | families leaking across splits: {len(leaked)}")
    if leaked:
        print("LEAKED:", list(leaked)[:5])
    print("top rejection reasons:")
    for reason, n in reason_counter.most_common(15):
        print(f"  {n:4d}  {reason}")
    if rejects:
        print("first rejected ids:", [r[0] for r in rejects[:10]])
    # hash uniqueness
    hashes = [r["content_hash"] for r in recs]
    print(f"duplicate content_hashes: {len(hashes) - len(set(hashes))}")
    return 1 if (rejects or leaked) else 0


if __name__ == "__main__":
    sys.exit(main())
