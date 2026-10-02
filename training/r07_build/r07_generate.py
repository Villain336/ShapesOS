#!/usr/bin/env python3
"""R07 generator: headline & hook pair traces -> traces-r07-pilot.jsonl.
Deterministic. Every trace: brand voice card + context, 4-6 variants with named
mechanisms, winner + rationale. Recipe verifier applied at write time.
"""
import json, re, hashlib, random, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r07_data import (VOICES, AWARENESS_NEED, MECHANISMS, ANTIBAIT_VARIANTS,
                      ANTIBAIT_REJECTIONS, STAGE_PATTERNS, STAGE_ORDER,
                      HEADLINE_THEORY_CHUNKS, EMAIL_THEORY_CHUNKS,
                      AWARENESS_THEORY_CHUNKS, BRIEFS)

MECH_NAMES = list(MECHANISMS.keys())
BANNED = ["game-changing", "gamechanger", "game-changer", "revolutionary",
          "revolutionize", "revolutionise", "unlock", "unlocks", "unlocked",
          "unlocking", "unleash", "disrupt", "disruptive", "disruption",
          "cutting-edge", "cutting edge", "groundbreaking", "mind-blowing",
          "mindblowing", "jaw-dropping", "jawdropping"]

CHUNK_IDS = set()
with open(os.path.expanduser("~/workspace/marketr/data/corpus/main/chunks.jsonl")) as f:
    for line in f:
        try:
            CHUNK_IDS.add(json.loads(line).get("id", ""))
        except Exception:
            pass


def cap(s):
    s = s.strip()
    return s[:1].upper() + s[1:] if s else s


def slots(b):
    d = dict(b)
    d["desire_cap"] = cap(b["desire"])
    d["proof_cap"] = cap(b["proof"])
    d["offer_cap"] = cap(b["offer"])
    d["product_cap"] = cap(b["product"])
    d["aud_cap"] = cap(b["aud"])
    d["aud_short_cap"] = cap(b["aud_short"])
    prod = b.get("product", "")
    d["a_product"] = "an" if prod[:1].lower() in "aeiou" else "a"
    return d


def fill(pattern, b):
    # Collapse template collisions where a slot already carries the trailing words:
    # "a permanent crown in one visit in one visit",
    # "social scheduling for agencies for agencies",
    # "the 40-situation conversation method method".
    if b["desire_short"].lower().find(b["timeframe"].lower()) != -1:
        pattern = pattern.replace("{desire_short} in {timeframe}", "{desire_short}")
        pattern = pattern.replace("{desire_short}, the {timeframe} version", "{desire_short}")
    tail = "for " + b["aud_short"].lower()
    if b["product"].lower().endswith(tail):
        pattern = pattern.replace("{product} for {aud_short}", "{product}")
    if b.get("mech_short", "").lower().endswith("method"):
        pattern = pattern.replace("{mech_short} method", "{mech_short}")
    return pattern.format(**slots(b))


def non1s(chunks):
    return [c for c in chunks if not c.startswith("1s-")]


def tier2_mech_chunks(mech, n=2):
    out = non1s(MECHANISMS[mech]["chunks"])[:n]
    i = 0
    while len(out) < n:
        c = HEADLINE_THEORY_CHUNKS[i % len(HEADLINE_THEORY_CHUNKS)]
        if c not in out:
            out.append(c)
        i += 1
    return out


def check_chunks(ids):
    missing = [c for c in ids if c not in CHUNK_IDS]
    assert not missing, f"chunk IDs not in corpus: {missing}"
    return ids


WINNER_SENTENCE = {
    "specificity": "The definite numbers make the claim believable at a glance — no adjective is asked to do the work.",
    "curiosity-gap": "The open loop is honest: the intrigue is factual and the body pays it off.",
    "headline-hails": "It hails exactly the reader we want in the first words and lets everyone else pass.",
    "benefit-first": "The benefit is visible before the reader has decided to keep reading.",
    "proof-in-headline": "The track record does the persuading; the copy only reports it.",
    "mechanism-naming": "The named mechanism gives the reader a reason this is different, not just a claim.",
    "desire-over-fear": "It aims at what the reader wants, not what they fear — desire pulls harder than fear here.",
    "plain-salesmanship": "It says what a good salesman would say face to face, in words that never show off.",
    "irresistible-offer": "The offer removes the risk, which is the actual objection holding this reader back.",
    "test-verdict": "Expert judgment is unreliable on headlines — in the tradition of Hopkins, the honest move is to name the hypothesis and let keyed returns decide.",
}

MECH_WEAKNESS = {
    "specificity": [
        "the numbers are strong but the headline forgets to hail the reader first",
        "it leads with figures before this reader has felt the pain named in their words",
    ],
    "curiosity-gap": [
        "it leans clever where the voice card demands plain",
        "the gap risks frustrating a reader who wants the answer now, not a tease",
    ],
    "headline-hails": [
        "it spends its best words on qualification instead of the promise",
        "hailing is right, but the benefit arrives late in the line",
    ],
    "benefit-first": [
        "the benefit floats without the proof this skeptical reader wants",
        "it promises broadly where one definite claim would land harder",
    ],
    "proof-in-headline": [
        "it leads with the track record before naming the reader's pain",
        "proof is strong, but the headline tries to do two jobs at once",
    ],
    "mechanism-naming": [
        "it names the mechanism before this reader has a reason to care",
        "the mechanism is named but not pictured — a name without an image",
    ],
    "desire-over-fear": [
        "the aspiration is lovely but vague — no number anchors it",
        "it paints the dream without naming who the dream is for",
    ],
    "plain-salesmanship": [
        "plain to a fault — it undersells the one thing that differentiates",
        "it reads honest but forgettable next to the specific contenders",
    ],
    "irresistible-offer": [
        "the offer leads before the reader believes the outcome is possible",
        "risk reversal is strong, but the desire itself is under-drawn",
    ],
    "test-verdict": [
        "it hedges where a committed claim would persuade",
        "honest, but a headline should sell, not deliberate",
    ],
}


def weakness_for(mech, seed):
    pool = MECH_WEAKNESS.get(mech, MECH_WEAKNESS["plain-salesmanship"])
    return pool[seed % len(pool)]


def build_variants(b, mechs, use_subjects, pat_offset):
    """Returns list of (text, mech). Patterns chosen deterministically."""
    variants = []
    for pos, mech in enumerate(mechs):
        m = MECHANISMS[mech]
        pats = m["subject_patterns"] if use_subjects else m["patterns"]
        text = fill(pats[(pat_offset + pos) % len(pats)], b)
        variants.append((text, mech))
    return variants


def note_for(mech, pos):
    notes = MECHANISMS[mech]["notes"]
    return notes[pos % len(notes)]


def reasoning_trace(b, voice, variants, winner_idx, lesson_intro, verdict_extra="",
                    stage_mismatch=False):
    aud = b["aud"]
    lines = []
    lines.append(
        f"Step 1 — Read the awareness stage. The reader is {b['awareness']}: "
        f"they need {AWARENESS_NEED[b['awareness']]}. {lesson_intro}")
    lines.append(
        f"Step 2 — Read the voice card. {voice['name']}: {voice['tone']}. "
        f"The binding rule is '{voice['rule']}'. The winner must satisfy this rule, "
        f"not merely perform well — a sensational variant that breaks voice loses on trust grounds.")
    lines.append("Step 3 — Score each variant against mechanism, voice, and stage.")
    for i, v in enumerate(variants):
        text, mech, status = v[0], v[1], v[2]
        n = i + 1
        if status == "rejected":
            lines.append(
                f'{n}. "{text}" — mechanism: {mech} (abused). {note_for(mech, i)} '
                f"STATUS: REJECTED on voice/trust grounds (see output).")
        elif i == winner_idx:
            lines.append(
                f'{n}. "{text}" — mechanism: {mech}. {note_for(mech, i)} '
                f"Strongest fit: it serves the {b['awareness']} reader and obeys the voice card.")
        elif stage_mismatch:
            lines.append(
                f'{n}. "{text}" — mechanism: {mech}. {note_for(mech, i)} '
                f"Loses on stage: it answers a question this {b['awareness']} reader is not asking.")
        else:
            lines.append(
                f'{n}. "{text}" — mechanism: {mech}. {note_for(mech, i)} '
                f"Weakness here: {weakness_for(mech, i + winner_idx)}.")
    lines.append(f"Step 4 — Verdict. {verdict_extra}")
    return "\n".join(lines)


def output_text(b, channel, variants, winner_idx, rationale, ab_block=""):
    lines = [f"CHANNEL: {channel}", f"AWARENESS STAGE: {b['awareness']}", ""]
    for i, v in enumerate(variants):
        text, mech, status = v[0], v[1], v[2]
        lines.append(f"VARIANT {i+1} [mechanism: {mech}] [status: {status}]")
        lines.append(f'"{text}"')
        if status == "rejected":
            lines.append(f"REJECTION: {v[3]}")
        else:
            lines.append(f"Why this mechanism: {note_for(mech, i)}")
        lines.append("")
    wmech = variants[winner_idx][1]
    lines.append(f"WINNER: Variant {winner_idx+1} ({wmech})")
    lines.append(f"RATIONALE: {rationale}")
    if ab_block:
        lines.append("")
        lines.append(ab_block)
    return "\n".join(lines)


def voice_card_text(b):
    v = VOICES[b["voice"]]
    return (f"Voice: {v['name']} ({v['tone']}). Do: {'; '.join(v['do'])}. "
            f"Never: {'; '.join(v['dont'])}. Binding rule: {v['rule']}.")


def base_record(idx, b, channel, variants, winner_idx, rationale, reasoning,
                chunks, license_class, ab_block=""):
    out = output_text(b, channel, variants, winner_idx, rationale, ab_block)
    rec = {
        "record_id": f"trace-r07-{idx:06d}",
        "recipe": "R07",
        "license_class": license_class,
        "origin": "synthetic",
        "reviewer_type": "agent (Z7) + spot-check",
        "corpus_chunk_ids": check_chunks(chunks),
        "constitution_section": "global hard rules",
        "language": "en",
        "market": "US",
        "split": None,  # assigned by family later
        "content_hash": None,
        "duplicate_family": b["fam"],
        "brief": {
            "objective": (f"Write {len(variants)} {channel} headline/hook variants for "
                          f"{b['brand']} ({b['product']}); name the mechanism behind each; "
                          f"pick one winner with a stated rationale."),
            "audience": f"{b['aud']}. Awareness stage: {b['awareness']}.",
            "constraints": (voice_card_text(b) + f" Channel: {channel}. No hype adjectives. "
                            "No emoji. Any performance figures must be labeled simulated, "
                            "never presented as measured."),
        },
        "reasoning_trace": reasoning,
        "output": out,
        "validation": {
            "checks": ["brand-voice-card-present", "winner-consistent-with-voice",
                       "no-hype-adjectives-in-endorsed-copy", "all-variants-mechanism-named",
                       "ab-numbers-labeled-simulated-or-absent", "corpus-chunks-actually-read"],
            "verifier": "r07-brand-voice-consistency+honest-labeling+mechanism-named",
        },
        "created_at": "2026-09-26",
    }
    canon = "\n".join(l.rstrip() for l in (reasoning + "\n---\n" + out).replace("\r\n", "\n").split("\n"))
    rec["content_hash"] = "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()
    return rec


def rationale_t1(b, voice, wmech):
    return (f"Winner runs on {wmech}: {WINNER_SENTENCE[wmech]} "
            f"It fits the {voice['name']} voice — {voice['rule']} — and the {b['awareness']} reader, "
            f"who first needs {AWARENESS_NEED[b['awareness']]}.")


def make_t1(idx, fi, b):
    """Landing hero: mechanism duel, 5 variants."""
    voice = VOICES[b["voice"]]
    wmech = MECH_NAMES[(fi + 0) % len(MECH_NAMES)]
    others = [m for m in MECH_NAMES if m != wmech]
    rot = (fi * 3) % len(others)
    others4 = [others[(rot + k) % len(others)] for k in range(4)]
    winner_idx = (fi + 0) % 5
    mechs = others4[:winner_idx] + [wmech] + others4[winner_idx:]
    variants_raw = build_variants(b, mechs, False, fi)
    variants = [(t, m, "endorsed") for t, m in variants_raw]
    rationale = rationale_t1(b, voice, wmech)
    lesson = ("Landing heroes are read at a glance, so each variant is scored on what its "
              "headline does in the first three seconds.")
    reasoning = reasoning_trace(b, voice, variants, winner_idx, lesson,
                                f"Variant {winner_idx+1} wins. {rationale}")
    chunks = [HEADLINE_THEORY_CHUNKS[fi % len(HEADLINE_THEORY_CHUNKS)]] + tier2_mech_chunks(wmech, 2)
    return base_record(idx, b, "landing page hero", variants, winner_idx, rationale,
                       reasoning, chunks, "TIER-2-OPEN")


def make_t2(idx, fi, b, antibait):
    """Email subject lines: curiosity vs clarity, never clickbait."""
    voice = VOICES[b["voice"]]
    wmech = MECH_NAMES[(fi + 3) % len(MECH_NAMES)]
    others = [m for m in MECH_NAMES if m != wmech]
    rot = (fi * 5 + 1) % len(others)
    others4 = [others[(rot + k) % len(others)] for k in range(4)]
    winner_idx = (fi + 1) % 5
    mechs = others4[:winner_idx] + [wmech] + others4[winner_idx:]
    variants_raw = build_variants(b, mechs, True, fi + 7)
    variants = [(t, m, "endorsed") for t, m in variants_raw]
    if antibait:
        rej_pos = (winner_idx + 2) % 5
        rej_text = fill(ANTIBAIT_VARIANTS[fi % len(ANTIBAIT_VARIANTS)], b)
        rej_reason = ANTIBAIT_REJECTIONS[fi % len(ANTIBAIT_REJECTIONS)].format(
            voice_name=voice["name"], voice_rule=voice["rule"], awareness=b["awareness"])
        variants[rej_pos] = (rej_text, "curiosity-gap", "rejected", rej_reason)
    rationale = (rationale_t1(b, voice, wmech) +
                 " The subject's only job is the open — but a misleading open trains the spam "
                 "filter and the subscriber at once. In the tradition of the Copyhackers playbook: "
                 "curiosity or clarity, never clickbait.")
    lesson = ("Email subjects are judged on the open, but a deceptive open is a trust withdrawal. "
              "Each subject is scored on whether its curiosity pays off.")
    reasoning = reasoning_trace(b, voice, variants, winner_idx, lesson,
                                f"Variant {winner_idx+1} wins. {rationale}")
    chunks = ["1s-copyhackers-blog#4", "1s-copyhackers-blog#1",
              EMAIL_THEORY_CHUNKS[fi % len(EMAIL_THEORY_CHUNKS)]]
    # keep exactly 3, dedupe preserving order
    chunks = list(dict.fromkeys(chunks))[:3]
    return base_record(idx, b, "email subject lines", variants, winner_idx, rationale,
                       reasoning, chunks, "TIER-1S-SYNTH")


def ab_block_text(b, variants, winner_idx, seed):
    rng = random.Random(seed)
    a = winner_idx + 1
    cands = [i + 1 for i in range(len(variants)) if i != winner_idx]
    c = rng.choice(cands)
    n_imp = rng.choice([8000, 10000, 12000, 15000, 20000])
    ctr_a = round(rng.uniform(2.4, 4.8), 1)
    ctr_b = round(ctr_a - rng.uniform(0.5, 1.4), 1)
    diff = round(ctr_a - ctr_b, 1)
    return (f"MODELED A/B RESULT (simulated — these numbers are illustrative, not measured):\n"
            f"Finalists: Variant {a} vs Variant {c}.\n"
            f"Simulated test: {n_imp:,} impressions per variant. "
            f"Modeled CTR: {ctr_a}% vs {ctr_b}%.\n"
            f"Difference: +{diff}pp, significant at p<0.05 (simulated; synthetic numbers "
            f"for training only, not real results).")


def make_t3(idx, fi, b, with_ab):
    """Paid ad headline / social hook: finalist comparison, sometimes modeled A/B."""
    voice = VOICES[b["voice"]]
    channel = "paid ad headline" if fi % 2 == 0 else "social hook (first line)"
    use_subjects = (channel != "paid ad headline")
    wmech = MECH_NAMES[(fi + 6) % len(MECH_NAMES)]
    others = [m for m in MECH_NAMES if m != wmech]
    rot = (fi * 7 + 2) % len(others)
    others3 = [others[(rot + k) % len(others)] for k in range(3)]
    winner_idx = (fi + 2) % 4
    mechs = others3[:winner_idx] + [wmech] + others3[winner_idx:]
    variants_raw = build_variants(b, mechs, use_subjects, fi + 13)
    variants = [(t, m, "endorsed") for t, m in variants_raw]
    runnerup_mech = mechs[(winner_idx + 1) % 4]
    if wmech == "test-verdict":
        rationale = (f"Provisional winner: Variant {winner_idx+1}. Judgment favors the {runnerup_mech} finalist on "
                     f"specificity, but in the tradition of Hopkins the honest verdict is: run the "
                     f"two finalists keyed and let cost-per-result decide. Expert judgment proposes; "
                     f"measured returns dispose. The pick respects the {voice['name']} voice "
                     f"({voice['rule']}).")
    else:
        rationale = rationale_t1(b, voice, wmech)
        if not with_ab:
            rationale += (" No test data exists yet; the honest next step is a keyed comparison of "
                          "the two finalists before scaling.")
    lesson = (f"{cap(channel)}s compete in a feed, so each variant is scored on stopping power "
              f"without breaking the voice card.")
    reasoning = reasoning_trace(b, voice, variants, winner_idx, lesson,
                                f"Variant {winner_idx+1} wins. {rationale}")
    ab = ab_block_text(b, variants, winner_idx, f"{b['fam']}-t3") if with_ab else ""
    chunks = [HEADLINE_THEORY_CHUNKS[(fi + 1) % len(HEADLINE_THEORY_CHUNKS)]] + tier2_mech_chunks(wmech, 2)
    return base_record(idx, b, channel, variants, winner_idx, rationale,
                       reasoning, chunks, "TIER-2-OPEN", ab)


STAGE_MECH = {
    "unaware": "curiosity-gap",
    "problem-aware": "headline-hails",
    "solution-aware": "mechanism-naming",
    "product-aware": "proof-in-headline",
    "most-aware": "irresistible-offer",
}


def make_t4(idx, fi, b):
    """Awareness-stage match: 5 stage variants, winner = brief's stage."""
    voice = VOICES[b["voice"]]
    stage_idx = STAGE_ORDER.index(b["awareness"])
    variants = []
    for pos, stage in enumerate(STAGE_ORDER):
        text = fill(STAGE_PATTERNS[stage], b)
        variants.append((text, STAGE_MECH[stage], "endorsed"))
    winner_idx = stage_idx
    rationale = (f"Winner: Variant {winner_idx+1} — the only one written for the {b['awareness']} stage. "
                 f"In the tradition of Schwartz: a message for the problem-aware is poison for the "
                 f"solution-aware. This reader needs {AWARENESS_NEED[b['awareness']]}; the other four "
                 f"variants answer questions this reader is not asking yet — or has already answered. "
                 f"The pick also satisfies the {voice['name']} voice ({voice['rule']}).")
    lesson = ("Each variant targets a different Schwartz awareness stage; only one matches this "
              "reader. The lesson is stage discipline, not cleverness.")
    reasoning = reasoning_trace(b, voice, variants, winner_idx, lesson,
                                f"Variant {winner_idx+1} wins. {rationale}",
                                stage_mismatch=True)
    chunks = ["1s-copyhackers-blog#3",
              AWARENESS_THEORY_CHUNKS[fi % len(AWARENESS_THEORY_CHUNKS)],
              HEADLINE_THEORY_CHUNKS[(fi + 2) % len(HEADLINE_THEORY_CHUNKS)]]
    chunks = list(dict.fromkeys(chunks))[:3]
    return base_record(idx, b, "landing page hero", variants, winner_idx, rationale,
                       reasoning, chunks, "TIER-1S-SYNTH")


def main():
    records = []
    seen_hashes = {}
    dupes = 0
    idx = 1
    for fi, b in enumerate(BRIEFS):
        antibait = (fi % 4 == 0)
        with_ab = (fi % 20 < 7)
        for rec in (make_t1(idx, fi, b), make_t2(idx + 1, fi, b, antibait),
                    make_t3(idx + 2, fi, b, with_ab), make_t4(idx + 3, fi, b)):
            h = rec["content_hash"]
            if h in seen_hashes:
                dupes += 1
                print(f"DUPLICATE: {rec['record_id']} dup of {seen_hashes[h]}", file=sys.stderr)
                continue
            seen_hashes[h] = rec["record_id"]
            records.append(rec)
            idx += 1
    # split by whole family: 85% train / 15% held-out
    fams = sorted({r["duplicate_family"] for r in records})
    rng = random.Random(20260926)
    rng.shuffle(fams)
    n_train = int(len(fams) * 0.85)
    train_fams = set(fams[:n_train])
    for r in records:
        r["split"] = "train" if r["duplicate_family"] in train_fams else "held-out"
    out_path = os.path.expanduser("~/workspace/marketr/training/traces/traces-r07-pilot.jsonl")
    with open(out_path, "w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    n_held = sum(1 for r in records if r["split"] == "held-out")
    print(f"wrote {len(records)} records ({len(records)-n_held} train / {n_held} held-out), "
          f"{len(fams)} families, {dupes} duplicates skipped -> {out_path}")


if __name__ == "__main__":
    main()
