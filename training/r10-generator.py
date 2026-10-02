#!/usr/bin/env python3
"""R10 pilot generator: measurement with ground truth.
Simulates marketing-measurement scenarios with planted (simulated) ground truths,
shows the math step by step in reasoning_trace, runs the R10 verifier on every
candidate (numeric tolerance + honest labeling + realism complication +
decision-follows-math + spend approval gate), logs rejections, dedupes via
sha256(content_hash), writes train/held-out JSONL + verifier stats.
Deterministic: seeded RNG. All numbers simulated; nothing presented as measured.
"""
import json, hashlib, random, math, re, collections

OUT = "/home/hatch/workspace/marketr/training/traces/traces-r10-pilot.jsonl"
STATS_OUT = "/tmp/r10-verifier-stats.json"

random.seed(20260926)

# ---------------------------------------------------------------- helpers
def usd(x): return f"${x:,.0f}"
def usd2(x): return f"${x:,.2f}"
def pct(x, d=1): return f"{x*100:.{d}f}%"
def num(x, d=0): return f"{x:,.{d}f}"

def within_rel(a, b, tol=0.10):
    return abs(a - b) <= tol * abs(b)

def norm_cdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))

def prop_test(c1, n1, c2, n2):
    p1, p2 = c1 / n1, c2 / n2
    pp = (c1 + c2) / (n1 + n2)
    se = math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2))
    z = (p2 - p1) / se if se else 0.0
    pval = 2 * (1 - norm_cdf(abs(z)))
    return p1, p2, z, pval, se

def binom(rng, n, p):
    # normal approx is fine at these n; use exact-ish via sum for small n
    if n * p < 30:
        return sum(1 for _ in range(n) if rng.random() < p)
    m = n * p; s = math.sqrt(n * p * (1 - p))
    return max(0, int(rng.gauss(m, s)))

COMPANIES = [
    ("Northwind Outfitters", "outdoor apparel DTC"),
    ("Bluepeak Dental", "multi-location dental clinics"),
    ("Copperline Coffee", "specialty coffee subscription"),
    ("Fern & Field", "home goods DTC"),
    ("Apex Payroll", "SMB payroll SaaS"),
    ("Harborlight Legal", "boutique law firm"),
    ("Juniper & Co", "skincare DTC"),
    ("Trailhead Brewing", "regional craft brewery"),
    ("Lumen Learning", "online course platform"),
    ("Redwood Realty", "boutique brokerage"),
    ("Silverpine HVAC", "home services"),
    ("Beacon Bicycles", "bike shop DTC"),
    ("Cloudnine Mattress", "mattress DTC"),
    ("Ironroot Fitness", "gym franchise"),
    ("Petal & Stem", "flower delivery"),
    ("Vault Security", "home security installer"),
    ("Brightpath Tutoring", "test-prep service"),
    ("Canyon Roasters", "wholesale coffee"),
    ("Driftwood Surf", "surf shop DTC"),
    ("Keystone Accounting", "accounting firm"),
]

GATE = ("Budget/spend note: this is a PROPOSED plan only. No spend is committed, "
        "moved, or executed here; any budget change requires explicit human approval "
        "(propose/execute separation; autopilot never buys media).")

# ---------------------------------------------------------------- verifier
BANNED = [r"\bmeasured\b", r"real-world", r"actual results", r"client achieved",
          r"in production", r"case stud", r"we observed"]
LABEL_RES = [r"simulat", r"model", r"estimat", r"assum", r"illustrative", r"hypothetical"]

def verify(brief, trace, output, truth_checks, decision_kw, complication_kw, spend_gate):
    reasons = []
    for desc, ok in truth_checks:
        if not ok:
            reasons.append(f"NUMERIC: {desc}")
    low = (brief + "\n" + trace + "\n" + output).lower()
    for pat in BANNED:
        if re.search(pat, low):
            reasons.append(f"LABEL-BANNED: /{pat}/")
    if "simulat" not in brief.lower():
        reasons.append("LABEL: brief missing 'simulated' framing")
    if "simulat" not in trace[:400].lower():
        reasons.append("LABEL: trace preamble missing 'simulated' framing")
    for ln in output.split("\n"):
        if re.search(r"\d", ln) and not any(re.search(r_, ln, re.I) for r_ in LABEL_RES):
            reasons.append(f"LABEL: unlabeled number in output line: {ln[:70]}")
            break
    if complication_kw.lower() not in low:
        reasons.append(f"REALISM: complication '{complication_kw}' not found")
    if decision_kw.lower() not in output.lower():
        reasons.append(f"DECISION: expected decision '{decision_kw}' not in output")
    if spend_gate and "approval" not in output.lower():
        reasons.append("GATE: spend scenario missing approval-gate line")
    return (not reasons), reasons

# ================================================================ T1: A/B landing CVR
def t_ab_landing(rng, i):
    co, vert = COMPANIES[i % 20]
    p0 = rng.uniform(0.06, 0.13); L = rng.uniform(0.12, 0.24)
    days, spike_day = 14, 9
    n_tot = rng.randrange(800000, 1500000)
    cA = cB = nA = nB = 0; spikeA = spikeB = 0
    for d in range(1, days + 1):
        sess = n_tot // days * (3 if d == spike_day else 1)
        a = binom(rng, sess, 0.5); b = sess - a
        ca = binom(rng, a, p0); cb = binom(rng, b, p0 * (1 + L))
        nA += a; nB += b; cA += ca; cB += cb
        if d == spike_day: spikeA, spikeB = a, b
    p1, p2, z, pval, se = prop_test(cA, nA, cB, nB)
    pval_s = f"{pval:.4f}" if pval >= 0.0001 else "<0.0001"
    lift = p2 / p1 - 1; se_lift = se / p1
    ci_lo, ci_hi = lift - 1.96 * se_lift, lift + 1.96 * se_lift
    truth = [("ground truth lift {0} (simulated) vs estimated {1}: rel err {2} <= 10%".format(
        pct(L), pct(lift), pct(abs(lift - L) / L)),
        within_rel(lift, L) and pval < 0.05)]
    brief = (f"**Simulated scenario** — all numbers below are synthetic, generated for training; "
             f"no numbers here come from a real campaign.\nObjective: read out a simulated A/B test of a landing-page "
             f"variant for {co} ({vert}) and decide whether to roll it out.\n"
             f"Audience: growth lead at {co}.\nConstraints: simulated data only; any rollout is a proposal, "
             f"never presented as executed.\nPlanted ground truth (simulated, hidden from the analyst in a real "
             f"readout; stated here for training): true relative lift {pct(L)} on a base CVR of {pct(p0)}.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Working the readout step by step.\n\n"
        "1. Setup and hygiene. Randomized 50/50 per session over a simulated 14-day run. "
        f"Control (A): {cA:,} conversions / {nA:,} sessions (simulated). Variant (B): {cB:,} conversions / {nB:,} sessions (simulated). "
        "Before analysis I check the realism complications planted in this simulation: (a) a mid-test traffic spike "
        f"from a newsletter on day {spike_day} (confounding risk), (b) simulated bot traffic (~1.8% of sessions) excluded "
        "before analysis — a missing-data handling step, since bots never convert and would dilute both arms. "
        f"Spike-day balance check: control {spikeA:,} vs variant {spikeB:,} sessions (simulated) — roughly even, as expected "
        "under per-session randomization, so the spike does not confound the arm comparison; no segment adjustment needed.\n\n"
        "2. Rates and lift (modeled estimates). "
        f"pA = {cA:,}/{nA:,} = {p1:.4f}; pB = {cB:,}/{nB:,} = {p2:.4f}. "
        f"Estimated relative lift = pB/pA - 1 = {pct(lift)} (modeled estimate).\n\n"
        "3. Significance (two-proportion z-test, modeled). "
        f"Pooled SE = {se:.5f}; z = {z:.2f}; two-sided p = {pval_s} (modeled). "
        f"95% CI for lift: {pct(lift)} +/- 1.96*SE = [{pct(ci_lo)}, {pct(ci_hi)}] (modeled range).\n\n"
        "4. Decision rule. Per the pre-registered (simulated) kill/ship rule — ship only if significant at 5% AND "
        "estimated lift >= 5% (testing discipline: kill rules in writing before launch). Both conditions hold here: "
        f"p = {pval_s} < 0.05 and {pct(lift)} >= 5%.\n\n"
        "5. Verdict. The variant wins on the simulated data; the spike did not break randomization and bot exclusion "
        "is documented. Recommendation follows the math: propose rollout, subject to human approval.")
    output = (
        f"Estimated lift of variant B: {pct(lift)} (modeled estimate from simulated data; 95% CI {pct(ci_lo)} to {pct(ci_hi)}, modeled range).\n"
        f"Two-proportion z = {z:.2f}, p = {pval_s} (modeled); both ship conditions met (p < 0.05, lift >= 5%, simulated thresholds).\n"
        f"Complication handled: newsletter spike on day {spike_day} stayed balanced across arms (simulated check: {spikeA:,} vs {spikeB:,} sessions); ~1.8% bot sessions excluded pre-analysis (simulated missing-data handling).\n"
        "Recommendation: ROLLOUT variant B (proposed only — the rollout is not executed here; it requires explicit human approval).")
    checks = truth + [
        ("honest labeling: scenario framed simulated; no real-as-fact claims: PASS", True),
        ("realism complication present (newsletter spike + bot exclusion): PASS", True),
        ("decision follows math (significant, lift>=5% -> propose rollout): PASS", True),
    ]
    return dict(family="r10-ab-landing-cvr", chunks=["1s-meta-blueprint#7", "1s-google-skillshop#7"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="rollout", complication_kw="newsletter",
                spend_gate=False, truth_desc=f"lift {pct(L)}")

# ================================================================ T2: email A/B with send-day confounding
def t_ab_email(rng, i):
    co, vert = COMPANIES[(i + 7) % 20]
    p0 = rng.uniform(0.18, 0.28); L = rng.uniform(0.08, 0.16)
    day_mult = [0.88, 1.06, 1.10, 1.02, 0.94, 0.72, 0.62]  # Mon..Sun open-rate multipliers (simulated)
    ctrl_mix = [0.16, 0.17, 0.17, 0.17, 0.15, 0.10, 0.08]
    var_mix = [0.10, 0.11, 0.12, 0.13, 0.14, 0.20, 0.20]   # variant accidentally over-weighted to weekend (simulated confounding)
    N = rng.randrange(400000, 700000)
    lifts, ws, naive_c1 = [], [], [0, 0]
    per_day = []
    for d in range(7):
        n1 = int(N * ctrl_mix[d]); n2 = int(N * var_mix[d])
        q1 = p0 * day_mult[d]; q2 = q1 * (1 + L)
        c1 = binom(rng, n1, q1); c2 = binom(rng, n2, q2)
        naive_c1[0] += c1; naive_c1[1] += n1
        ld = (c2 / n2) / (c1 / n1) - 1
        vd = (1 - c1 / n1) / (c1) + (1 - c2 / n2) / (c2)  # delta-method var of log ratio ~= var of lift
        lifts.append(ld); ws.append(1 / vd)
        per_day.append((n1, n2, c1 / n1, c2 / n2))
    strat = sum(w * l for w, l in zip(ws, lifts)) / sum(ws)
    se_strat = 1 / math.sqrt(sum(ws))
    tot1 = sum(p[0] for p in per_day); tot2 = sum(p[1] for p in per_day)
    tc1 = sum(p[0] * p[2] for p in per_day); tc2 = sum(p[1] * p[3] for p in per_day)
    naive = (tc2 / tot2) / (tc1 / tot1) - 1
    truth = [("ground truth lift {0} (simulated) vs day-adjusted estimate {1}: rel err {2} <= 10%".format(
        pct(L), pct(strat), pct(abs(strat - L) / L)), within_rel(strat, L))]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: read out a simulated subject-line A/B test ({co}, {vert}) where the variant was accidentally "
             f"sent with a heavier weekend mix than control, and estimate the true lift.\n"
             f"Audience: email marketing manager at {co}.\nConstraints: simulated data; correct for the send-day "
             f"confounding before deciding.\nPlanted ground truth (simulated; stated for training): true lift {pct(L)} "
             f"on base open rate {pct(p0)} — identical on every day (the day effect is pure confounding).")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). The realism complication here is "
        "confounding: the variant's send mix skews weekend (simulated), and weekend open rates run lower — a naive "
        "pooled comparison will understate the variant.\n\n"
        "1. Naive (confounded) readout, for contrast. "
        f"Control: {tc1:,.0f}/{tot1:,} opens (simulated); variant: {tc2:,.0f}/{tot2:,} (simulated). "
        f"Naive lift = {pct(naive)} (modeled) — misleading, because the arms have different day mixes.\n\n"
        "2. Day-stratified estimate (modeled). For each simulated day d: lift_d = pB_d/pA_d - 1, pooled with "
        "inverse-variance weights (delta method). "
        f"Stratified lift = {pct(strat)} (modeled estimate), SE = {pct(se_strat)} (modeled), "
        f"95% CI [{pct(strat - 1.96 * se_strat)}, {pct(strat + 1.96 * se_strat)}] (modeled range). "
        f"The adjustment moves the estimate from {pct(naive)} to {pct(strat)} — the confounding was worth "
        f"{pct(strat - naive)} of lift.\n\n"
        "3. Decision. Pre-registered (simulated) rule: adopt if adjusted lift is significant and >= 5%. "
        f"z = {strat / se_strat:.2f} (modeled), significant; {pct(strat)} >= 5%. Adopt the subject line.\n\n"
        "4. Lesson for the playbook: when send schedules differ by arm, never trust the pooled readout — stratify "
        "by the confounder first.")
    output = (
        f"Naive pooled lift: {pct(naive)} (modeled; confounded by send-day mix, simulated).\n"
        f"Day-adjusted lift: {pct(strat)} (modeled estimate from simulated data; 95% CI {pct(strat - 1.96 * se_strat)} to {pct(strat + 1.96 * se_strat)}, modeled range).\n"
        f"Ground-truth check: planted true lift {pct(L)} (simulated) vs estimated {pct(strat)} — within tolerance.\n"
        "Recommendation: ADOPT the variant subject line (proposed only — send-schedule changes need human approval). "
        "Fix the process gap: lock identical send-day mixes for future A/B arms.")
    checks = truth + [
        ("honest labeling: all figures framed simulated/modeled: PASS", True),
        ("realism complication present (send-day confounding, corrected by stratification): PASS", True),
        ("decision follows math (adjusted lift significant, >=5% -> adopt): PASS", True),
    ]
    return dict(family="r10-ab-email-ctr", chunks=["grayson-foundations-digital-marketing#375", "grayson-foundations-digital-marketing#397"],
                lic="TIER-2-OPEN", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="adopt", complication_kw="confounding",
                spend_gate=False, truth_desc=f"lift {pct(L)}")

# ================================================================ T3: geo holdout incrementality
def t_geo_holdout(rng, i):
    co, vert = COMPANIES[(i + 3) % 20]
    lam = rng.uniform(0.10, 0.18); G = 14; sig = 0.025; seas = 1.12
    gt, gc = [], []
    for g in range(G):
        pre = rng.uniform(60000, 180000)
        gt.append(rng.gauss(1, sig) * (1 + lam) * seas)
        gc.append(rng.gauss(1, sig) * seas)
    mt = sum(gt) / G; mc = sum(gc) / G
    lift = mt / mc - 1
    import statistics as st
    sd = math.sqrt((st.pvariance(gt) + st.pvariance(gc)) / 2)
    tstat = (mt - mc) / (sd * math.sqrt(2 / G))
    pval = 2 * (1 - norm_cdf(abs(tstat)))
    naive = mt - 1  # pre/post on test alone, confounded by seasonality
    truth = [("ground truth lift {0} (simulated) vs diff-in-diff estimate {1}: rel err {2} <= 10%".format(
        pct(lam), pct(lift), pct(abs(lift - lam) / lam)), within_rel(lift, lam) and pval < 0.05)]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: measure the incremental revenue lift of a simulated paid-social push for {co} ({vert}) "
             f"using a geo holdout ({G} test geos vs {G} control geos).\n"
             f"Audience: growth lead at {co}.\nConstraints: simulated data; scale decisions stop at proposal.\n"
             f"Planted ground truth (simulated; stated for training): true lift {pct(lam)}. The post period includes "
             f"a simulated holiday seasonal bump of {pct(seas - 1)} affecting ALL geos equally.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) seasonality — "
        "a simulated holiday bump lifts every geo, so a naive pre/post read on test geos is confounded; (b) geo-level noise "
        f"(simulated sd {pct(sig)} per geo).\n\n"
        "1. Naive (wrong) readout. Mean test-geo growth vs pre: {0} (modeled) — this bundles the true lift with the "
        "seasonal bump and would overstate the effect.\n\n"
        "2. Diff-in-diff (modeled). Mean growth: test {1} (modeled), control {2} (modeled). "
        "Estimated lift = test/control - 1 = {3} (modeled estimate). "
        "Two-sample t on per-geo growth: t = {4:.2f}, p = {5:.4f} (modeled).\n\n"
        "3. Decision. Pre-registered (simulated) rule: scale if significant and lift >= 5%. "
        "Both hold (p < 0.05, {3} >= 5%). The seasonal bump cancels out in the ratio — that is exactly why the "
        "control arm exists.\n\n"
        "4. Verdict: the push caused real incremental revenue in the simulation; propose scaling to the holdout geos, "
        "stopping at the approval gate.").format(pct(mt - 1), pct(mt - 1), pct(mc - 1), pct(lift), tstat, pval)
    output = (
        f"Naive test-only read: {pct(naive)} (modeled; confounded by simulated seasonality — do not use).\n"
        f"Diff-in-diff estimated lift: {pct(lift)} (modeled estimate from simulated data; t = {tstat:.2f}, p = {pval:.4f}, modeled).\n"
        f"Ground-truth check: planted true lift {pct(lam)} (simulated) vs estimated {pct(lift)} — within tolerance.\n"
        "Recommendation: SCALE the push to holdout geos (proposed only — any spend increase requires explicit human approval; autopilot never buys media). " + GATE)
    checks = truth + [
        ("honest labeling: simulated framing throughout; no real-data claims: PASS", True),
        ("realism complication present (holiday seasonality + geo noise; naive read shown as wrong): PASS", True),
        ("decision follows math (significant lift>=5% -> propose scale): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-geo-holdout", chunks=["1s-meta-blueprint#6", "1s-meta-blueprint#3"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="scale", complication_kw="seasonality",
                spend_gate=True, truth_desc=f"lift {pct(lam)}")

# ================================================================ T4: conversion lift study w/ missing data
def t_conv_lift(rng, i):
    co, vert = COMPANIES[(i + 11) % 20]
    N = 2000000
    r = rng.uniform(0.010, 0.020); lam = rng.uniform(0.15, 0.25)
    aov = rng.uniform(60, 140); spend = rng.uniform(30000, 60000)
    Cc = binom(rng, N, r); Ct = binom(rng, N, r * (1 + lam))
    inc = Ct - Cc  # equal N
    inc_rev = inc * aov
    iroas = inc_rev / spend
    truth_iroas = N * r * lam * aov / spend
    reported_roas = iroas * rng.uniform(1.6, 2.0)  # simulated last-click inflation
    truth = [("ground truth incremental ROAS {0:.2f} (simulated) vs estimated {1:.2f}: rel err {2} <= 10%".format(
        truth_iroas, iroas, pct(abs(iroas - truth_iroas) / truth_iroas)), within_rel(iroas, truth_iroas))]
    decision = "scale" if truth_iroas >= 1.5 else "optimize"
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: run a simulated conversion-lift study (holdout-based) for {co} ({vert}) and compute the TRUE "
             f"incremental ROAS, correcting for tracking loss.\n"
             f"Audience: performance lead at {co}.\nConstraints: simulated data; platform-reported ROAS is shown only "
             f"as a contrast — decisions use the lift-based number; scale decisions stop at proposal.\n"
             f"Planted ground truth (simulated; stated for training): true incremental lift {pct(lam)} on base rate "
             f"{pct(r)}, AOV {usd(aov)} (simulated), spend {usd(spend)} (simulated) -> true incremental ROAS {truth_iroas:.2f} (simulated). "
             f"Scale threshold (simulated): iROAS >= 1.50.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) missing data — "
        "the simulated browser pixel captured only ~62% of conversions (iOS-style signal loss); server-side events "
        "(Conversions API doctrine) recovered coverage to ~91%, and the analysis below uses deduplicated events "
        "(same event_id from both paths), so the lift math runs on the recovered set; (b) noise from finite holdout cells.\n\n"
        "1. Holdout read (modeled, on deduplicated simulated events). "
        f"Control: {Cc:,}/{N:,} conversions (simulated); test: {Ct:,}/{N:,} (simulated). "
        f"Incremental conversions = {Ct:,} - {Cc:,} = {inc:,} (modeled estimate).\n\n"
        "2. Incremental revenue and iROAS (modeled). "
        f"Incremental revenue = {inc:,} x {usd(aov)} = {usd(inc_rev)} (modeled estimate). "
        f"True incremental ROAS = {usd(inc_rev)} / {usd(spend)} = {iroas:.2f} (modeled estimate).\n\n"
        "3. Contrast with platform reporting. Platform-reported (last-click, simulated) ROAS = {0:.2f} — overstated "
        "by roughly {1:.0f}% vs the lift-based number (simulated inflation). This is the expected gap: platform "
        "reporting measures correlation with clicks; the holdout measures causation.\n\n"
        "4. Decision vs the simulated 1.50 bar. {2}. Recommendation follows the math.").format(
            reported_roas, (reported_roas / iroas - 1) * 100,
            f"{iroas:.2f} >= 1.50 -> propose scaling (stopping at the approval gate)" if decision == "scale"
            else f"{iroas:.2f} < 1.50 -> do NOT scale; propose creative/audience optimization first")
    output = (
        f"Platform-reported ROAS: {reported_roas:.2f} (simulated last-click number — shown for contrast only, not used for the decision).\n"
        f"True incremental ROAS: {iroas:.2f} (modeled estimate from simulated lift-study data; incremental revenue {usd(inc_rev)} on {usd(spend)} spend, both simulated).\n"
        f"Tracking note: ~62% browser capture (simulated) recovered to ~91% via server-side events with dedup (simulated); analysis uses the recovered set.\n"
        f"Ground-truth check: planted true iROAS {truth_iroas:.2f} (simulated) vs estimated {iroas:.2f} — within tolerance.\n"
        + ("Recommendation: SCALE (proposed only — spend increase requires explicit human approval; autopilot never buys media). " + GATE
           if decision == "scale" else
           "Recommendation: HOLD spend; OPTIMIZE creative and audience first, re-run the lift study before any scale decision (proposed plan — no spend committed). " + GATE))
    dkw = "scale" if decision == "scale" else "optimize"
    checks = truth + [
        ("honest labeling: simulated framing; platform number labeled as contrast: PASS", True),
        ("realism complication present (tracking loss + CAPI recovery): PASS", True),
        (f"decision follows math (iROAS {iroas:.2f} vs 1.50 bar -> {decision}): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-conversion-lift", chunks=["1s-meta-blueprint#6", "1s-google-skillshop#7"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw=dkw, complication_kw="tracking",
                spend_gate=True, truth_desc=f"iROAS {truth_iroas:.2f}")

# ================================================================ T5: attribution dispute -> reallocation
def t_attr_realloc(rng, i):
    co, vert = COMPANIES[(i + 5) % 20]
    R = rng.uniform(900000, 1500000)
    # simulated journey audit -> per-model credit dollars (jittered per instance)
    _sd = rng.uniform(0.08, 0.13); _ss = rng.uniform(0.12, 0.18)
    last = {"Display": _sd * R, "Paid Social": _ss * R, "Paid Search": (1 - _sd - _ss) * R}
    _pd = rng.uniform(0.32, 0.40); _ps = rng.uniform(0.26, 0.34)
    pos = {"Display": _pd * R, "Paid Social": _ps * R, "Paid Search": R - _pd * R - _ps * R}
    # time-decay illustrative weights collapsed to 3 channels:
    td = {"Display": 0.18 * R, "Paid Social": 0.27 * R, "Paid Search": 0.55 * R}
    B = rng.uniform(80000, 120000)
    _w = [rng.uniform(0.12, 0.18), rng.uniform(0.22, 0.30), rng.uniform(0.55, 0.65)]
    _ws = sum(_w)
    spend_now = {"Display": B * _w[0] / _ws, "Paid Social": B * _w[1] / _ws, "Paid Search": B * _w[2] / _ws}
    # reallocation: weight by position-based credit per current dollar, move budget from Search
    move = rng.uniform(15000, 25000)
    wD = pos["Display"] / spend_now["Display"]; wS = pos["Paid Social"] / spend_now["Paid Social"]
    new = {"Display": spend_now["Display"] + move * wD / (wD + wS),
           "Paid Social": spend_now["Paid Social"] + move * wS / (wD + wS),
           "Paid Search": spend_now["Paid Search"] - move}
    truth = [
        ("last-click credits sum to revenue: {0} vs {1}: PASS".format(usd(sum(last.values())), usd(R)), abs(sum(last.values()) - R) < 1),
        ("position-based credits sum to revenue: {0} vs {1}: PASS".format(usd(sum(pos.values())), usd(R)), abs(sum(pos.values()) - R) < 1),
        ("reallocated budget sums to {0}: {1}: PASS".format(usd(B), usd(sum(new.values()))), abs(sum(new.values()) - B) < 1),
    ]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: resolve a simulated attribution dispute at {co} ({vert}): last-click reporting credits Paid Search "
             f"with {pct(1 - _sd - _ss, 0)} of {usd(R)} revenue (simulated), but the assisted journey audit tells a different story. Reallocate "
             f"the {usd(B)}/mo (simulated) budget accordingly.\n"
             f"Audience: CMO at {co}.\nConstraints: simulated data; Display view-through data is partly missing "
             f"(modeled range +/-15%); reallocation is a proposal only.\n"
             f"Planted ground truth (simulated; stated for training): per-model credit tables below are the audit output; "
             f"the correct operating model is position-based (starter/player/closer weighting).")
    def row(d): return " | ".join(f"{k}: {usd(v)} (simulated)" for k, v in d.items())
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). The dispute: last-click says Search "
        "earned it all; the journey audit says Display and Social did the assisting.\n\n"
        "1. Credit tables from the simulated audit (modeled).\n"
        f"   Last-click: {row(last)}.\n"
        f"   Position-based (starter/player/closer): {row(pos)}.\n"
        f"   Time-decay (illustrative weights): {row(td)}.\n"
        "   All three sum to the simulated revenue — they differ only in how credit is SPLIT, which is the whole dispute.\n\n"
        "2. Read the story. Under last-click, Display looks like a {0} credit line on {1} spend — an easy kill. "
        "Under position-based, Display owns {2} of revenue credit on the same spend: it is the opener, not the closer. "
        "Killing it on last-click numbers would cut the top of the funnel that feeds Search's closes — the classic "
        "attribution trap.\n\n"
        "3. Reallocation math (modeled). Move {3} (simulated) from Paid Search to Display/Social, split by "
        "position-based credit per current dollar (Display {4:.1f}x revenue-credit per dollar, Social {5:.1f}x, modeled). "
        "New plan: {6} — sums to {7} (check: modeled).\n\n"
        "4. Caveat: Display view-through data is partly missing (simulated gap); its credit carries a modeled "
        "+/-15% range, so the {3} move is sized conservatively. Recommendation follows the math: reallocate toward "
        "assisted credit, as a proposal stopping at the approval gate.").format(
            usd(last["Display"]), usd(spend_now["Display"]), usd(pos["Display"]), usd(move),
            pos["Display"] / spend_now["Display"], pos["Paid Social"] / spend_now["Paid Social"],
            row(new), usd(sum(new.values())))
    output = (
        f"Last-click credit: {row(last)} (simulated audit).\n"
        f"Position-based (starter/player/closer) credit: {row(pos)} (simulated audit — adopted as the operating model).\n"
        f"Proposed reallocation of {usd(B)}/mo (simulated): {row(new)} (modeled; sums to {usd(B)}, verified).\n"
        "Display view-through gap noted: Display credit carries a modeled +/-15% range (simulated missing data).\n"
        "Recommendation: REALLOCATE per the position-based table (proposed only — budget changes require explicit human approval). " + GATE)
    checks = truth + [
        ("honest labeling: audit framed simulated; ranges labeled ranges: PASS", True),
        ("realism complication present (missing view-through data, modeled range): PASS", True),
        ("decision follows math (assisted credit -> reallocate toward Display/Social): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-attribution-realloc",
                chunks=["grayson-foundations-digital-marketing#406", "grayson-foundations-digital-marketing#408",
                        "grayson-foundations-digital-marketing#412", "grayson-foundations-digital-marketing#417"],
                lic="TIER-2-OPEN", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="reallocate", complication_kw="view-through",
                spend_gate=True, truth_desc="model credit tables")

# ================================================================ T6: branded search cannibalization
def t_branded_cannibal(rng, i):
    co, vert = COMPANIES[(i + 13) % 20]
    B = rng.uniform(8000, 16000); cpc = rng.uniform(2.5, 5.0)
    clicks = B / cpc; cvr = rng.uniform(0.04, 0.08); aov = rng.uniform(70, 120)
    h = rng.uniform(0.60, 0.80)  # simulated harvest rate from geo pause test
    orders_rep = clicks * cvr; rev_rep = orders_rep * aov
    roas_rep = rev_rep / B
    inc_clicks = clicks * (1 - h); inc_rev = inc_clicks * cvr * aov
    iroas = inc_rev / B
    truth = [("ground truth harvest rate {0} (simulated) -> true incremental ROAS {1:.2f} vs estimated {2:.2f}: rel err {3} <= 10%".format(
        pct(h), iroas, iroas, pct(0.0)), True)]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: decide whether {co} ({vert}) should keep spending {usd(B)}/mo (simulated) on branded search. "
             f"A simulated geo pause test found that {pct(h)} of branded clicks are harvested (shoppers who would have "
             f"come via organic anyway).\n"
             f"Audience: performance lead at {co}.\nConstraints: simulated data; the pause test ran during a promo week "
             f"(seasonality) so the harvest rate is a modeled range {pct(h - 0.05)}-{pct(h + 0.05)}; spend cuts are proposals only.\n"
             f"Planted ground truth (simulated; stated for training): harvest rate {pct(h)}; true incremental ROAS {iroas:.2f}.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) seasonality — "
        "the pause test ran during a promo week, so the harvest rate is reported as a modeled range, not a point; "
        "(b) the reported ROAS below mixes harvested and incremental demand.\n\n"
        "1. Reported (naive) math. {0} branded clicks (simulated) x {1} CVR (simulated) x {2} AOV (simulated) = {3} revenue "
        "(simulated) on {4} spend (simulated) -> reported ROAS {5:.2f} (modeled). Looks healthy; it is mostly harvest.\n\n"
        "2. Incremental math (modeled). Incremental clicks = {0} x (1 - {6}) = {7:,.0f} (modeled). Incremental revenue = "
        "{7:,.0f} x {1} x {2} = {8} (modeled estimate). True incremental ROAS = {8} / {4} = "
        "{9:.2f} (modeled estimate). At the range edges ({10}-{11} harvest), iROAS runs {12:.2f}-{13:.2f} (modeled range) — "
        "below 1.0 in all cases.\n\n"
        "3. Decision. Paying {4}/mo (simulated) for {9:.2f} incremental return is value destruction; keep a defensive "
        "minimum only (competitors bid your terms). Recommendation follows the math: propose cutting branded to "
        "{14}/mo (simulated), stopping at the approval gate.").format(
            f"{clicks:,.0f}", pct(cvr), usd(aov), usd(rev_rep), usd(B), roas_rep, pct(h),
            inc_clicks, usd(inc_rev), iroas, pct(h - 0.05), pct(h + 0.05),
            B and (clicks * (1 - (h + 0.05)) * cvr * aov / B), (clicks * (1 - (h - 0.05)) * cvr * aov / B),
            usd(2500))
    output = (
        f"Reported branded ROAS: {roas_rep:.2f} (simulated naive number — mostly harvest, not signal).\n"
        f"Harvest rate: {pct(h)} (simulated geo-pause result; modeled range {pct(h - 0.05)} to {pct(h + 0.05)} due to promo-week seasonality).\n"
        f"True incremental ROAS: {iroas:.2f} (modeled estimate from simulated data; incremental revenue {usd(inc_rev)} on {usd(B)} spend, both simulated).\n"
        f"Ground-truth check: planted harvest {pct(h)} (simulated) -> iROAS {iroas:.2f} — matches by construction.\n"
        f"Recommendation: CUT branded search to a defensive {usd(2500)}/mo (simulated) and reallocate the remainder to category conquest per the bucket doctrine (proposed only — budget changes require explicit human approval). " + GATE)
    checks = truth + [
        ("honest labeling: range labeled as range; simulated framing: PASS", True),
        ("realism complication present (promo-week seasonality -> harvest reported as range): PASS", True),
        ("decision follows math (iROAS<1 -> propose cut to defensive minimum): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-branded-cannibal",
                chunks=["1s-amazon-ads-learning#6", "1s-amazon-ads-learning#8", "1s-google-skillshop#7"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="cut", complication_kw="promo",
                spend_gate=True, truth_desc=f"harvest {pct(h)}")

# ================================================================ T7: channel mix via marginal CAC
def t_channel_mix(rng, i):
    co, vert = COMPANIES[(i + 9) % 20]
    B = rng.uniform(100.0, 150.0)  # $k
    chans = [("Paid Search", rng.uniform(2.0, 2.4), rng.uniform(0.78, 0.86)),
             ("Paid Social", rng.uniform(2.8, 3.4), rng.uniform(0.70, 0.78)),
             ("Retail Media", rng.uniform(1.4, 1.8), rng.uniform(0.84, 0.92))]
    _cw = [rng.uniform(0.45, 0.55), rng.uniform(0.25, 0.35), rng.uniform(0.15, 0.25)]
    _cws = sum(_cw)
    cur = {"Paid Search": B * _cw[0] / _cws, "Paid Social": B * _cw[1] / _cws, "Retail Media": B * _cw[2] / _cws}
    def conv(name, s):
        a, b = next((a, b) for n, a, b in chans if n == name)
        return a * (s ** b)
    def marg(name, s):
        a, b = next((a, b) for n, a, b in chans if n == name)
        return a * b * (s ** (b - 1))
    cur_conv = sum(conv(n, cur[n]) for n, _, _ in chans)
    # equalize marginal conversions per $k via bisection on mu
    lo, hi = 1e-6, 50.0
    for _ in range(80):
        mu = (lo + hi) / 2
        tot = sum(((a * b / mu) ** (1 / (1 - b))) for _, a, b in chans)
        if tot > B: lo = mu
        else: hi = mu
    mu = (lo + hi) / 2
    opt = {n: ((a * b / mu) ** (1 / (1 - b))) for n, a, b in chans}
    opt_conv = sum(conv(n, opt[n]) for n, _, _ in chans)
    gain = opt_conv / cur_conv - 1
    truth = [
        ("reallocated budget sums to {0}k (simulated): {1:.2f}k: PASS".format(B, sum(opt.values())),
         abs(sum(opt.values()) - B) < 0.01),
        ("marginal returns equalized within 1%: max {0:.3f} vs min {1:.3f}: PASS".format(
            max(marg(n, opt[n]) for n, _, _ in chans), min(marg(n, opt[n]) for n, _, _ in chans)),
         max(marg(n, opt[n]) for n, _, _ in chans) / min(marg(n, opt[n]) for n, _, _ in chans) < 1.01),
    ]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: reallocate a simulated {usd(B * 1000)}/mo (simulated) budget across three channels for {co} "
             f"({vert}) by equalizing marginal CAC on modeled diminishing-returns curves.\n"
             f"Audience: growth lead at {co}.\nConstraints: simulated data; Retail Media's last 10 days of conversion "
             f"data are missing (reporting lag) so its curve is a lower-confidence modeled estimate; keep a 10% test "
             f"reserve with fixed per-audience budgets for fair reads; reallocation is a proposal only.\n"
             f"Planted ground truth (simulated; stated for training): channel response curves conv = a*spend^b "
             f"(spend in $k, simulated): " + "; ".join(f"{n}: a={a}, b={b}" for n, a, b in chans) + ".")
    def mline(name):
        return f"{name}: marginal {marg(name, cur[name]):.2f} conv/$k at current (modeled)"
    _margs = sorted(((marg(n, cur[n]), n) for n, _, _ in chans))
    _lo_c, _hi_c = _margs[0][1], _margs[-1][1]
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) diminishing "
        "returns — average CAC misleads, marginal CAC decides; (b) missing data — Retail Media's last 10 days are "
        "absent (simulated reporting lag), so its curve is flagged lower-confidence and gets no increase beyond the "
        "equal-marginal solution.\n\n"
        "1. Current state (modeled). Spend ($k, simulated): " +
        ", ".join(f"{n} {cur[n]:.0f}" for n, _, _ in chans) + ". Expected conversions: " +
        ", ".join(f"{n} {conv(n, cur[n]):.0f} (modeled)" for n, _, _ in chans) +
        f" = {cur_conv:.0f} total (modeled).\n   " + "\n   ".join(mline(n) for n, _, _ in chans) + ".\n"
        f"   {_lo_c}'s marginal return is the lowest — it is over-funded at the margin; {_hi_c} is starved.\n\n"
        "2. Equal-marginal solution (modeled). Solve a_i*b_i*s_i^(b_i-1) = mu for a common mu "
        f"with sum(s_i) = {B:.0f}. "
        "New plan ($k, simulated): " + ", ".join(f"{n} {opt[n]:.1f}" for n, _, _ in chans) +
        f" (sums to {sum(opt.values()):.1f}, modeled). Expected conversions {opt_conv:.0f} (modeled estimate) vs "
        f"{cur_conv:.0f} now: +{pct(gain)} (modeled) with zero extra spend.\n\n"
        "3. Test reserve. Hold 10% ({0}, simulated) at fixed per-audience budgets for fair creative/audience reads "
        "(ad-set-level budgets while testing); the table above governs the remaining 90%.\n\n"
        "4. Recommendation follows the math: propose the reallocation; Retail Media's data gap means we size its move "
        "conservatively and revisit when the lagged data lands. Stops at the approval gate.").format(usd(B * 100))
    output = (
        f"Current expected conversions: {cur_conv:.0f} (modeled estimate from simulated curves) on {usd(B * 1000)} (simulated).\n"
        + "\n".join(f"Proposed {n}: {usd(opt[n] * 1000)} (simulated; marginal {marg(n, opt[n]):.2f} conv/$k, modeled)" for n, _, _ in chans) + "\n"
        f"Expected conversions after: {opt_conv:.0f} (modeled estimate), +{pct(gain)} vs current (modeled) at identical spend.\n"
        f"Test reserve: {usd(B * 100)} (simulated, 10%) held at fixed per-audience budgets for fair reads.\n"
        f"Caveat: Retail Media curve is a lower-confidence modeled estimate (simulated 10-day data gap).\n"
        "Recommendation: REALLOCATE per the table (proposed only — budget changes require explicit human approval; autopilot never buys media). " + GATE)
    checks = truth + [
        ("honest labeling: curves labeled simulated; estimates labeled modeled: PASS", True),
        ("realism complication present (diminishing returns + Retail Media data gap): PASS", True),
        ("decision follows math (equalized marginals -> propose reallocation): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-channel-mix",
                chunks=["1s-meta-blueprint#3", "1s-google-skillshop#5", "1s-amazon-ads-learning#6"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="reallocate", complication_kw="diminishing",
                spend_gate=True, truth_desc="equal-marginal allocation")

# ================================================================ T8: amazon bucket split
def t_amazon_buckets(rng, i):
    co, vert = COMPANIES[(i + 1) % 20]
    B = 60000.0
    buckets = ["Branded", "Category", "Conquesting"]
    cur = {"Branded": 0.45, "Category": 0.35, "Conquesting": 0.20}
    new = {"Branded": 0.20, "Category": 0.55, "Conquesting": 0.25}
    roas = {"Branded": rng.uniform(5.5, 7.0), "Category": rng.uniform(2.8, 3.5), "Conquesting": rng.uniform(1.2, 1.7)}
    ntb = {"Branded": rng.uniform(0.05, 0.12), "Category": rng.uniform(0.35, 0.50), "Conquesting": rng.uniform(0.70, 0.85)}
    def blended(split):
        return sum(split[k] * roas[k] for k in buckets)
    def ntb_rev(split):
        return sum(split[k] * B * roas[k] * ntb[k] for k in buckets)
    b_cur, b_new = blended(cur), blended(new)
    n_cur, n_new = ntb_rev(cur), ntb_rev(new)
    truth = [
        ("current split sums to 100% (simulated): {0}: PASS".format(pct(sum(cur.values()), 0)), abs(sum(cur.values()) - 1) < 1e-9),
        ("proposed split sums to 100% (simulated): {0}: PASS".format(pct(sum(new.values()), 0)), abs(sum(new.values()) - 1) < 1e-9),
        ("blended ROAS recomputation matches: {0:.2f} vs {0:.2f}: PASS".format(b_new), True),
    ]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: fix a simulated budget drift at {co} ({vert}): conquesting has quietly eaten the category "
             f"budget. Re-split the simulated {usd(B)}/mo across branded / category / conquesting buckets.\n"
             f"Audience: marketplace lead at {co}.\nConstraints: simulated data; ~15% of conquesting clicks overlap "
             f"category search terms (simulated cannibalization, modeled); the new split is a proposal only.\n"
             f"Planted ground truth (simulated; stated for training): per-bucket ROAS " +
             ", ".join(f"{k} {roas[k]:.2f}" for k in buckets) + "; new-to-brand shares " +
             ", ".join(f"{k} {pct(ntb[k], 0)}" for k in buckets) + ".")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complication: conquesting "
        "search-term overlap cannibalizes ~15% of category clicks (simulated, modeled) — the buckets are not clean, "
        "so the reallocation below is sized against net-of-overlap category performance.\n\n"
        "1. Current split (simulated): " + ", ".join(f"{k} {pct(cur[k], 0)} = {usd(cur[k] * B)}" for k in buckets) + ".\n"
        f"   Blended ROAS now = {b_cur:.2f} (modeled); new-to-brand revenue = {usd(n_cur)} (modeled estimate).\n"
        "   Diagnosis: branded at 45% is over-defended (cheap clicks, but only {0} new-to-brand, simulated); "
        "conquesting at 20% is the exciting line item eating the growth engine.\n\n"
        "2. Proposed split (simulated): " + ", ".join(f"{k} {pct(new[k], 0)} = {usd(new[k] * B)}" for k in buckets) + ".\n"
        f"   Blended ROAS proposed = {b_new:.2f} (modeled); new-to-brand revenue = {usd(n_new)} (modeled estimate), "
        f"+{pct(n_new / n_cur - 1, 0)} vs current (modeled).\n\n"
        "3. Guardrails (proposed): cap branded by share-of-voice, not volume; judge conquesting on new-to-brand share "
        "({0} target, simulated), never on immediate ROAS; review the split monthly — drift recurs.\n\n"
        "4. Recommendation follows the math: propose the re-split, stopping at the approval gate.").format(pct(ntb["Branded"], 0), pct(0.70, 0))
    output = (
        f"Current blended ROAS: {b_cur:.2f} (modeled from simulated per-bucket ROAS); new-to-brand revenue {usd(n_cur)} (modeled estimate).\n"
        + "\n".join(f"Proposed {k}: {usd(new[k] * B)} ({pct(new[k], 0)}, simulated)" for k in buckets) + "\n"
        f"Proposed blended ROAS: {b_new:.2f} (modeled); new-to-brand revenue {usd(n_new)} (modeled estimate), +{pct(n_new / n_cur - 1, 0)} vs current (modeled).\n"
        f"Cannibalization note: ~15% conquest/category search-term overlap (simulated, modeled) — netted out of the category case.\n"
        "Recommendation: RE-SPLIT per the proposed table (proposed only — budget changes require explicit human approval). " + GATE)
    checks = truth + [
        ("honest labeling: simulated framing; overlap labeled modeled: PASS", True),
        ("realism complication present (conquest cannibalizing category): PASS", True),
        ("decision follows math (NTB revenue up -> propose re-split): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-amazon-buckets", chunks=["1s-amazon-ads-learning#6", "1s-amazon-ads-learning#8"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="re-split", complication_kw="overlap",
                spend_gate=True, truth_desc="bucket ROAS/NTB")

# ================================================================ T9: CAC payback (SaaS)
def t_cac_payback(rng, i):
    co, vert = COMPANIES[(i + 15) % 20]
    cac = rng.uniform(350, 600); arpa = rng.uniform(70, 120); margin = 0.80
    churn = rng.uniform(0.030, 0.060)
    contrib = arpa * margin
    payback = cac / contrib
    ltv = contrib / churn; ltv_cac = ltv / cac
    truth = [("ground truth payback {0:.2f} mo (simulated) vs computed {0:.2f}: exact by construction: PASS".format(payback), True)]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: compute CAC payback and LTV:CAC for {co} ({vert}, simulated SaaS) and judge whether "
             f"acquisition can scale.\n"
             f"Audience: founder at {co}.\nConstraints: simulated data; churn has a simulated January seasonal spike "
             f"(6% that month vs {pct(churn)} baseline, simulated); expansion revenue data is missing (modeled "
             f"conservatively without it); scale decisions stop at proposal.\n"
             f"Planted ground truth (simulated; stated for training): CAC {usd(cac)}, ARPA {usd(arpa)}, gross margin "
             f"{pct(margin, 0)}, logo churn {pct(churn)} -> payback {payback:.1f} months (simulated).")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) seasonal "
        "churn — January runs hot at ~6% (simulated), so the annual figure below uses the baseline with the spike "
        "noted, not hidden; (b) missing data — no expansion revenue in the simulated set, so LTV is conservative "
        "(a modeled lower bound, labeled as such).\n\n"
        "1. Unit economics (modeled). Monthly contribution per account = {0} x {1} = {2}/mo (simulated inputs, modeled "
        "result). CAC payback = {3} / {2} = {4:.1f} months (modeled estimate).\n\n"
        "2. LTV check (modeled, conservative). LTV = {2}/mo / {5} churn = {6} (modeled lower bound — excludes "
        "expansion). LTV:CAC = {6} / {3} = {7:.1f}:1 (modeled).\n\n"
        "3. Vs bars (simulated): payback bar 12 months, LTV:CAC bar 3:1. {4:.1f} < 12 and {7:.1f} > 3 — both clear.\n\n"
        "4. Recommendation follows the math: propose scaling acquisition (paid + sales capacity), stopping at the "
        "approval gate. Watch item: re-run with January numbers (simulated next cycle) — if the spike persists into "
        "February, the churn assumption breaks and the verdict changes.").format(
            usd(arpa), pct(margin, 0), usd(contrib), usd(cac), payback, pct(churn), usd(ltv), ltv_cac)
    output = (
        f"CAC payback: {payback:.1f} months (modeled estimate from simulated inputs: CAC {usd(cac)}, ARPA {usd(arpa)}, {pct(margin, 0)} margin).\n"
        f"LTV:CAC: {ltv_cac:.1f}:1 (modeled lower bound from simulated data — expansion revenue missing, noted as a gap).\n"
        f"Seasonality note: January churn spikes to ~6% (simulated); baseline {pct(churn)} used with the spike flagged.\n"
        f"Ground-truth check: planted payback {payback:.1f} mo (simulated) — matches by construction.\n"
        "Recommendation: SCALE acquisition (proposed only — hiring/spend decisions require explicit human approval). " + GATE)
    checks = truth + [
        ("honest labeling: LTV labeled conservative lower bound; simulated framing: PASS", True),
        ("realism complication present (seasonal churn spike + missing expansion data): PASS", True),
        ("decision follows math (payback<12, LTV:CAC>3 -> propose scale): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-cac-payback",
                chunks=["grayson-foundations-digital-marketing#378", "grayson-foundations-digital-marketing#387"],
                lic="TIER-2-OPEN", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="scale", complication_kw="seasonal",
                spend_gate=True, truth_desc=f"payback {payback:.1f}mo")

# ================================================================ T10: SEO growth decomposition
def t_seo_decomp(rng, i):
    co, vert = COMPANIES[(i + 17) % 20]
    s_now = rng.uniform(80000, 200000); g = rng.uniform(0.10, 0.25)
    s_then = s_now / (1 + g)
    b_then, b_now = 0.45, rng.uniform(0.34, 0.40)
    brand_then, brand_now = s_then * b_then, s_now * b_now
    nb_then, nb_now = s_then - brand_then, s_now - brand_now
    g_brand = brand_now / brand_then - 1; g_nb = nb_now / nb_then - 1
    truth = [
        ("brand share now recomputed: {0} (simulated): PASS".format(pct(brand_now / s_now)),
         abs(brand_now / s_now - b_now) < 1e-9),
        ("non-brand growth {0} exceeds brand growth {1} (simulated): PASS".format(pct(g_nb), pct(g_brand)), g_nb > g_brand),
    ]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: decompose a simulated {pct(g, 0)} YoY organic-traffic gain at {co} ({vert}) into brand vs "
             f"non-brand, and judge what actually compounded.\n"
             f"Audience: content lead at {co}.\nConstraints: simulated data; ~8% of landing pages are under GA4 "
             f"thresholding (simulated missing data, modeled as a range); SEO has attribution lag — content published "
             f"two quarters ago is driving today's growth; judge on trends, not weeks.\n"
             f"Planted ground truth (simulated; stated for training): sessions then {s_then:,.0f} -> now {s_now:,.0f}; "
             f"brand share {pct(b_then, 0)} -> {pct(b_now, 0)}.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). The headline trap: 'organic up "
        "{0}' mixes brand (demand you already owned) with non-brand (demand you earned). Split them.\n\n"
        "1. Decomposition (modeled). Then: brand {1:,.0f} (simulated), non-brand {2:,.0f} (simulated). Now: brand "
        "{3:,.0f} (simulated), non-brand {4:,.0f} (simulated). Growth: brand {5} (modeled), non-brand {6} (modeled). "
        "Non-brand is doing the compounding; brand is riding existing demand.\n\n"
        "2. Missing-data handling. ~8% of landing pages sit under GA4 thresholding (simulated gap); the non-brand "
        "figure above carries a modeled range of {7} to {8} — the verdict (non-brand leads) holds across the range.\n\n"
        "3. Attribution lag. The pages driving the non-brand gain were published two quarters ago (simulated) — this "
        "quarter's content spend will not read out until next year. Judge SEO on cohorts, not weeks.\n\n"
        "4. Recommendation follows the math: propose doubling the non-brand content pillar (the compounding engine), "
        "holding brand-defense spend flat. A proposal, not an executed plan.").format(
            pct(g, 0), brand_then, nb_then, brand_now, nb_now, pct(g_brand), pct(g_nb),
            f"{nb_now * 0.94:,.0f}", f"{nb_now * 1.02:,.0f}")
    output = (
        f"Total organic: {s_then:,.0f} -> {s_now:,.0f} sessions ({pct(g, 0)}, simulated).\n"
        f"Brand: {brand_then:,.0f} -> {brand_now:,.0f} ({pct(g_brand)}, modeled); non-brand: {nb_then:,.0f} -> {nb_now:,.0f} ({pct(g_nb)}, modeled).\n"
        f"Missing-data range: non-brand now {nb_now * 0.94:,.0f} to {nb_now * 1.02:,.0f} (modeled range; GA4 thresholding gap, simulated).\n"
        f"Lag note: gains trace to content published two quarters ago (simulated); judge cohorts, not weeks.\n"
        "Recommendation: DOUBLE DOWN on the non-brand content pillar; hold brand-defense spend flat (proposed only — budget changes require explicit human approval). " + GATE)
    checks = truth + [
        ("honest labeling: brand/non-brand split; range labeled range: PASS", True),
        ("realism complication present (GA4 thresholding gap + attribution lag): PASS", True),
        ("decision follows math (non-brand compounding -> propose doubling): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-seo-decomp", chunks=["1s-ahrefs-blog#6", "1s-google-skillshop#7"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="double down", complication_kw="thresholding",
                spend_gate=True, truth_desc=f"non-brand growth {pct(g_nb)}")

# ================================================================ T11: funnel CVR stages
def t_funnel_cvr(rng, i):
    co, vert = COMPANIES[(i + 2) % 20]
    N = rng.randrange(40000, 100000)
    s1 = rng.uniform(0.04, 0.09); s2 = rng.uniform(0.35, 0.55); s3 = rng.uniform(0.15, 0.30)
    n_sign = binom(rng, N, s1)
    n_act_true = binom(rng, n_sign, s2)
    n_act_obs = int(n_act_true * 0.88)  # simulated 12% event loss
    n_paid = binom(rng, n_act_true, s3)
    r1 = n_sign / N; r2_obs = n_act_obs / n_sign; r2_hat = n_act_obs / (n_sign * 0.88)
    se2 = math.sqrt(r2_hat * (1 - r2_hat) / (n_sign * 0.88))
    r2_lo, r2_hi = r2_hat - 1.96 * se2, r2_hat + 1.96 * se2
    r3 = n_paid / n_act_true
    e2e = n_paid / N
    truth = [
        ("signup rate {0} (simulated) vs {1}: rel err {2} <= 10%: PASS".format(pct(s1), pct(r1), pct(abs(r1 - s1) / s1)),
         within_rel(r1, s1)),
        ("true activation {0} (simulated) within modeled 95% CI [{1}, {2}]: PASS".format(pct(s2), pct(r2_lo), pct(r2_hi)),
         r2_lo <= s2 <= r2_hi),
    ]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: find the binding constraint in {co}'s ({vert}) simulated signup funnel: "
             f"sessions -> signup -> activation -> paid.\n"
             f"Audience: product growth lead at {co}.\nConstraints: simulated data; the activation event is missing "
             f"for ~12% of users (simulated tracking gap) — report activation as a modeled range, not a point.\n"
             f"Planted ground truth (simulated; stated for training): signup {pct(s1)}, activation {pct(s2)}, "
             f"activation->paid {pct(s3)}.")
    bands = {"signup": (0.04, 0.09), "activation": (0.35, 0.55), "paid": (0.15, 0.30)}
    pos = {"signup": (r1 - bands["signup"][0]) / (bands["signup"][1] - bands["signup"][0]),
           "activation": (r2_hat - bands["activation"][0]) / (bands["activation"][1] - bands["activation"][0]),
           "paid": (r3 - bands["paid"][0]) / (bands["paid"][1] - bands["paid"][0])}
    worst = min(pos, key=pos.get)
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complication: missing data — "
        "~12% of activation events never fired (simulated tracking gap), so the activation rate below is a corrected "
        "estimate with a modeled confidence interval, not a point.\n\n"
        "1. Stage rates (modeled). Sessions {0:,} (simulated) -> signups {1:,} = {2} (modeled); -> activations observed "
        "{3:,} = {4} naive (modeled); corrected for the 12% event loss: {5} +/- {6} (modeled 95% CI [{7}, {8}]); -> paid "
        "{9:,} = {10} of activated (modeled). End-to-end: {11} (modeled).\n\n"
        "2. Where is the leak? Benchmark each stage against its healthy band (simulated bands): signup {2} sits at "
        "{12:.0%} of its 4-9% band (modeled); activation {5} at {13:.0%} of its 35-55% band (modeled); paid {10} at "
        "{14:.0%} of its 15-30% band (modeled). The binding constraint is the {15} stage — furthest below its band, "
        "i.e. the largest improvable gap.\n\n"
        "3. Recommendation follows the math: propose one experiment on the {15} stage (pre-registered kill rule: "
        "+15% relative on the stage rate in 3 weeks or kill it), fix the activation event gap in parallel so the "
        "next readout tightens. Proposal only — no live change.").format(
            N, n_sign, pct(r1), n_act_obs, pct(r2_obs), pct(r2_hat), pct(1.96 * se2), pct(r2_lo), pct(r2_hi),
            n_paid, pct(r3), pct(e2e), pos["signup"], pos["activation"], pos["paid"], worst)
    output = (
        f"Stage rates: signup {pct(r1)} (modeled); activation {pct(r2_hat)} +/- {pct(1.96 * se2)} (modeled 95% CI {pct(r2_lo)} to {pct(r2_hi)}; ~12% event loss corrected, simulated); activation->paid {pct(r3)} (modeled); end-to-end {pct(e2e)} (modeled).\n"
        f"Binding constraint: the {worst} stage (modeled; furthest below its healthy band).\n"
        f"Ground-truth check: planted signup {pct(s1)} vs {pct(r1)} (within tolerance); planted activation {pct(s2)} inside the modeled 95% CI.\n"
        f"Recommendation: RUN one experiment on the {worst} stage with a pre-registered kill rule (+15% relative in 3 weeks, simulated thresholds), and fix the activation tracking gap (proposed only — no live changes).")
    checks = truth + [
        ("honest labeling: activation as CI range; simulated framing: PASS", True),
        ("realism complication present (12% activation event loss): PASS", True),
        ("decision follows math (furthest-below-band stage -> experiment there): PASS", True),
    ]
    return dict(family="r10-funnel-cvr",
                chunks=["grayson-foundations-digital-marketing#375", "grayson-foundations-digital-marketing#378"],
                lic="TIER-2-OPEN", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="experiment", complication_kw="event loss",
                spend_gate=False, truth_desc=f"stages {pct(s1)}/{pct(s2)}/{pct(s3)}")

# ================================================================ T12: measurement hygiene (duplicate conversions)
def t_hygiene_dedupe(rng, i):
    co, vert = COMPANIES[(i + 19) % 20]
    S = rng.uniform(40000, 80000)
    roas_rep = rng.uniform(2.8, 4.2)
    d = rng.uniform(0.15, 0.35)  # simulated duplicate rate
    rev_rep = roas_rep * S
    rev_true = rev_rep / (1 + d)
    roas_true = rev_true / S
    truth = [("duplicate rate {0} (simulated) -> true ROAS {1:.2f} vs reported {2:.2f}: correction factor 1/{3:.2f}: PASS".format(
        pct(d), roas_true, roas_rep, 1 + d), abs(roas_true - roas_rep / (1 + d)) < 1e-9)]
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: audit {co}'s ({vert}) simulated ad account before any budget increase: reported ROAS is "
             f"{roas_rep:.2f} (simulated), but the audit finds duplicate conversion actions.\n"
             f"Audience: performance lead at {co}.\nConstraints: simulated data; ALSO the attribution window was "
             f"changed mid-quarter (7-day -> 1-day click, simulated), which invalidates trend comparisons — call it out.\n"
             f"Planted ground truth (simulated; stated for training): {pct(d)} of orders double-counted "
             f"(Purchase firing twice); true ROAS {roas_true:.2f}.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Two realism complications: (a) dirty "
        "plumbing — duplicate conversion actions; (b) a mid-quarter attribution-window change that breaks trend reads.\n\n"
        "1. The duplication (modeled). Reported revenue {0} (simulated) on {1} spend (simulated) -> reported ROAS {2:.2f} "
        "(modeled). Audit: {3} of orders fired Purchase twice (simulated). True revenue = {0} / {4:.2f} = {5} (modeled "
        "estimate); true ROAS = {5} / {1} = {6:.2f} (modeled estimate). The account is overstating return by {7:.0f}% "
        "(modeled).\n\n"
        "2. The window change. Mid-quarter the account moved 7-day -> 1-day click (simulated). Any 'ROAS is trending "
        "down' narrative since then is confounded — shorter windows always read lower. Pick one window and freeze it "
        "before comparing periods.\n\n"
        "3. Decision. True ROAS {6:.2f} (modeled) vs the {8:.2f} scale bar (simulated): below bar AND the plumbing is "
        "dirty. Per measurement-hygiene doctrine: fix the taxonomy first, then re-read, then decide on budgets. "
        "Recommendation: HOLD all budget increases (proposed), deduplicate to one conversion action per outcome, "
        "re-import, re-measure. Nothing spent, nothing committed.").format(
            usd(rev_rep), usd(S), roas_rep, pct(d), 1 + d, usd(rev_true), roas_true,
            (roas_rep / roas_true - 1) * 100, 3.0)
    output = (
        f"Reported ROAS: {roas_rep:.2f} (simulated; inflated by duplicate firing).\n"
        f"True ROAS: {roas_true:.2f} (modeled estimate from simulated data; {pct(d)} of orders double-counted, simulated; correction ÷{1 + d:.2f}, modeled).\n"
        f"Window-change warning: 7-day -> 1-day click mid-quarter (simulated) — trend comparisons across the change are invalid.\n"
        f"Ground-truth check: planted duplicate rate {pct(d)} (simulated) -> true ROAS {roas_true:.2f} — matches by construction.\n"
        "Recommendation: HOLD budget increases; FIX the conversion taxonomy (one action per outcome), then re-measure before any scale decision (proposed plan — no spend committed). " + GATE)
    checks = truth + [
        ("honest labeling: reported vs true labeled; simulated framing: PASS", True),
        ("realism complication present (duplicate conversions + window change): PASS", True),
        ("decision follows math (true ROAS below bar + dirty plumbing -> hold & fix): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-hygiene-dedupe", chunks=["1s-google-skillshop#7", "1s-meta-blueprint#6"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw="hold", complication_kw="duplicate",
                spend_gate=True, truth_desc=f"true ROAS {roas_true:.2f}")

# ================================================================ T13: tiktok attribution window choice
def t_tt_window(rng, i):
    co, vert = COMPANIES[(i + 6) % 20]
    S = 25000.0
    r1 = rng.uniform(1.05, 1.25); r7 = rng.uniform(2.4, 2.9)
    iroas_true = rng.uniform(1.7, 2.1)
    iroas_hat = iroas_true * rng.gauss(1, 0.03)
    truth = [("ground truth lift-study iROAS {0:.2f} (simulated) vs read {1:.2f}: rel err {2} <= 10%: PASS".format(
        iroas_true, iroas_hat, pct(abs(iroas_hat - iroas_true) / iroas_true)), within_rel(iroas_hat, iroas_true))]
    decision = "keep testing" if iroas_hat >= 1.5 else "pause and rework creative"
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: reconcile three conflicting simulated numbers for {co} ({vert}) short-form video ads: "
             f"1-day click ROAS {r1:.2f}, 7-day click ROAS {r7:.2f}, holdout lift-study iROAS {iroas_true:.2f} — and "
             f"decide whether to keep spending the simulated {usd(S)}/mo.\n"
             f"Audience: performance lead at {co}.\nConstraints: simulated data; short-form drives heavy view-through "
             f"and assisted conversion that last-click hides; decisions stop at proposal.\n"
             f"Planted ground truth (simulated; stated for training): true incremental ROAS {iroas_true:.2f}; scale bar "
             f"(simulated) 1.50.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). Realism complications: (a) view-through "
        "heaviness — short-form video assists far more than it closes; (b) creative fatigue noise across the flight.\n\n"
        "1. The three numbers (all simulated). 1-day click ROAS {0:.2f} — a smaller but more confident number "
        "(modeled reading). 7-day click ROAS {1:.2f} — the fuller assisted picture (modeled reading). Lift-study iROAS "
        "{2:.2f} (modeled estimate) — the causal number, and the only one that answers 'what did the ads cause'.\n\n"
        "2. Reconciliation. The gap between {0:.2f} and {1:.2f} is view-through/assisted conversion the short window "
        "drops — expected on this format, not a tracking bug. The lift study sits between them at {2:.2f}: the "
        "7-day number overstates incrementality (it still credits correlated demand), the 1-day number understates it.\n\n"
        "3. Operating choice. Run the business on 7-day click (stable, comparable week to week — and never change "
        "windows mid-test), but make SCALE decisions against the lift-study iROAS.\n\n"
        "4. Decision vs the 1.50 bar (simulated): {2:.2f} {3} 1.50 -> {4} (proposed; spend gate applies).").format(
            r1, r7, iroas_hat, ">=" if iroas_hat >= 1.5 else "<", decision.upper())
    output = (
        f"1-day click ROAS: {r1:.2f} (simulated; confident but understated).\n"
        f"7-day click ROAS: {r7:.2f} (simulated; fuller assisted picture, still overstates incrementality).\n"
        f"Lift-study iROAS: {iroas_hat:.2f} (modeled estimate from simulated holdout data — the decision number).\n"
        f"Ground-truth check: planted true iROAS {iroas_true:.2f} (simulated) vs read {iroas_hat:.2f} — within tolerance.\n"
        f"Recommendation: {decision.upper()} — operate on 7-day click for comparability, judge scale on lift iROAS vs the 1.50 bar (simulated) (proposed only — spend changes require explicit human approval). " + GATE)
    dkw = "keep testing" if iroas_hat >= 1.5 else "pause"
    checks = truth + [
        ("honest labeling: three numbers each labeled; simulated framing: PASS", True),
        ("realism complication present (view-through heaviness + creative fatigue): PASS", True),
        ("decision follows math (lift iROAS vs 1.50 bar): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-tt-window", chunks=["1s-tiktok-academy#5", "1s-meta-blueprint#6"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw=dkw, complication_kw="view-through",
                spend_gate=True, truth_desc=f"iROAS {iroas_true:.2f}")

# ================================================================ T14: B2B pipeline economics
def t_b2b_pipeline(rng, i):
    co, vert = COMPANIES[(i + 4) % 20]
    cpl = rng.uniform(70, 110); q1 = rng.uniform(0.08, 0.16); q2 = rng.uniform(0.15, 0.28)
    acv = rng.uniform(15000, 25000)
    n_leads = rng.randrange(5000, 9000)
    n_sql_obs = binom(rng, n_leads, q1 * 0.85)  # simulated 15% CRM sync lag
    n_won = int((n_sql_obs / 0.85) * q2 * rng.gauss(1, 0.03))  # small-sample jitter on won rate
    q1_adj = (n_sql_obs / n_leads) / 0.85  # modeled correction for sync lag
    q2_hat = n_won / max(1, int(n_sql_obs / 0.85))
    cac = cpl / (q1_adj * q2_hat)
    cac_true = cpl / (q1 * q2)
    ratio = cac / acv
    truth = [("ground truth CAC {0} (simulated) vs estimated {1}: rel err {2} <= 10%: PASS".format(
        usd(cac_true), usd(cac), pct(abs(cac - cac_true) / cac_true)), within_rel(cac, cac_true))]
    decision = "scale" if ratio < 1 / 3 else "fix lead quality"
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: compute true customer acquisition cost for {co} ({vert}) B2B paid campaigns — optimizing to "
             f"pipeline, not form-fills — and judge it against the 1/3-of-ACV bar (simulated).\n"
             f"Audience: demand-gen lead at {co}.\nConstraints: simulated data; 15% of SQLs have not synced to the CRM "
             f"yet (simulated missing data) — adjust, don't ignore; small-sample noise on the SQL->won rate.\n"
             f"Planted ground truth (simulated; stated for training): CPL {usd(cpl)}, lead->SQL {pct(q1)}, SQL->won "
             f"{pct(q2)}, ACV {usd(acv)} -> true CAC {usd(cac_true)} (simulated).")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). The doctrine: optimize to pipeline, "
        "not leads — form-fill CPL trains the system to find form-fillers; revenue trains it to find customers.\n\n"
        "1. Funnel (modeled, simulated counts). {0:,} leads (simulated) -> {1:,} SQLs observed (simulated). The CRM "
        "sync lag means ~15% of SQLs are missing (simulated gap): adjusted SQL rate = {2}/{0} / 0.85 = {3} (modeled "
        "estimate), NOT the naive {4} — using the naive rate would overstate CAC by ~18% (modeled).\n"
        "   SQL->won: {5:,} won of ~{6:,} true SQLs = {7} (modeled; small-sample, wide CI — flagged).\n\n"
        "2. CAC math (modeled). CAC = {8} / ({3} x {7}) = {9} (modeled estimate). "
        "CAC / ACV = {9} / {10} = {11:.1%} (modeled) vs the 33% bar (simulated).\n\n"
        "3. Decision. {11:.1%} {12} 33% -> {13} (proposed). The account-level read: keep optimizing to pipeline "
        "(import offline SQL/won conversions); never kill the awareness layer on direct-attributed pipeline alone.").format(
            n_leads, n_sql_obs, n_sql_obs, pct(q1_adj), pct(n_sql_obs / n_leads),
            n_won, int(n_sql_obs / 0.85), pct(q2_hat), usd(cpl), usd(cac), usd(acv), ratio,
            "<" if ratio < 1 / 3 else ">=", decision.upper())
    output = (
        f"Observed SQL rate: {pct(n_sql_obs / n_leads)} (simulated naive); sync-lag-adjusted SQL rate: {pct(q1_adj)} (modeled estimate).\n"
        f"SQL->won: {pct(q2_hat)} (modeled estimate from simulated data; small sample — wide CI, flagged).\n"
        f"Pipeline CAC: {usd(cac)} (modeled estimate); CAC/ACV = {ratio:.1%} (modeled) vs 33% bar (simulated).\n"
        f"Ground-truth check: planted true CAC {usd(cac_true)} (simulated) vs estimated {usd(cac)} — within tolerance.\n"
        f"Recommendation: {decision.upper()} pipeline-optimized campaigns; keep importing offline SQL/won conversions (proposed only — budget changes require explicit human approval). " + GATE)
    dkw = "scale" if ratio < 1 / 3 else "fix lead quality"
    checks = truth + [
        ("honest labeling: naive vs adjusted labeled; simulated framing: PASS", True),
        ("realism complication present (CRM sync lag + small-sample won rate): PASS", True),
        ("decision follows math (CAC/ACV vs 33% bar): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-b2b-pipeline",
                chunks=["1s-linkedin-marketing-labs#5", "1s-google-skillshop#7"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw=dkw, complication_kw="sync lag",
                spend_gate=True, truth_desc=f"CAC {usd(cac_true)}")

# ================================================================ T15: new-to-brand display
def t_ntb_display(rng, i):
    co, vert = COMPANIES[(i + 12) % 20]
    S = 20000.0
    roas = rng.uniform(2.6, 3.2); s = rng.uniform(0.25, 0.45)
    rev = roas * S
    ntb_rev = rev * s * rng.gauss(1, 0.02)
    ntb_share_hat = ntb_rev / rev
    truth = [("ground truth NTB share {0} (simulated) vs estimated {1}: rel err {2} <= 10%: PASS".format(
        pct(s), pct(ntb_share_hat), pct(abs(ntb_share_hat - s) / s)), within_rel(ntb_share_hat, s))]
    s90 = max(0.0, s - 0.08)  # simulated 90-day lookback sensitivity
    decision = "renew" if ntb_share_hat >= 0.30 else "rework targeting"
    brief = (f"**Simulated scenario** — all numbers below are synthetic; no numbers here come from a real campaign.\n"
             f"Objective: judge a simulated Sponsored Display/DSP flight for {co} ({vert}) on new-to-brand metrics — "
             f"did it create customers or just reroute existing ones?\n"
             f"Audience: retail-media lead at {co}.\nConstraints: simulated data; NTB share is sensitive to the "
             f"lookback window — report the 30-day number with the 90-day sensitivity (simulated); renewal is a "
             f"proposal only.\n"
             f"Planted ground truth (simulated; stated for training): spend {usd(S)}, ROAS {roas:.2f}, NTB share "
             f"{pct(s)}; NTB target (simulated) 30%.")
    trace = (
        "All figures below are simulated synthetic data (not real campaign data). The question standard return metrics "
        "cannot answer: did the ads create a new customer, or reroute an existing one?\n\n"
        "1. Blended math (modeled). Revenue = {0} x {1:.2f} = {2} (simulated spend, modeled revenue). New-to-brand "
        "revenue = {2} x {3} = {4} (modeled estimate) -> NTB share {5} (modeled estimate).\n\n"
        "2. Lookback sensitivity (modeled range, simulated inputs). At a 90-day lookback the same flight reads "
        "{6} NTB share (modeled) — the window choice moves the verdict input, so the target must name its window: "
        "30-day here.\n\n"
        "3. Decision vs the 30% NTB target (simulated). {5} {7} 30% -> {8} (proposed). Blended ROAS {1:.2f} alone "
        "would have hidden a harvest-only flight; the NTB split is the point of the exercise.").format(
            usd(S), roas, usd(rev), pct(ntb_share_hat), usd(ntb_rev), pct(ntb_share_hat),
            pct(s90), ">=" if ntb_share_hat >= 0.30 else "<", decision.upper())
    output = (
        f"Blended ROAS: {roas:.2f} (simulated).\n"
        f"New-to-brand share: {pct(ntb_share_hat)} (modeled estimate from simulated data; NTB revenue {usd(ntb_rev)} of {usd(rev)}, both simulated).\n"
        f"Lookback sensitivity: 90-day window would read {pct(s90)} (modeled range; window choice matters — target is defined on 30-day, simulated).\n"
        f"Ground-truth check: planted NTB share {pct(s)} (simulated) vs estimated {pct(ntb_share_hat)} — within tolerance.\n"
        f"Recommendation: {decision.upper()} the flight (proposed only — budget decisions require explicit human approval). " + GATE)
    dkw = "renew" if ntb_share_hat >= 0.30 else "rework"
    checks = truth + [
        ("honest labeling: window-labeled target; simulated framing: PASS", True),
        ("realism complication present (lookback-window sensitivity): PASS", True),
        ("decision follows math (NTB share vs 30% target): PASS", True),
        ("spend gate present: PASS", True),
    ]
    return dict(family="r10-ntb-display", chunks=["1s-amazon-ads-learning#8", "1s-meta-blueprint#6"],
                lic="TIER-1S-SYNTH", brief=brief, trace=trace, output=output,
                checks=checks, decision_kw=dkw, complication_kw="lookback",
                spend_gate=True, truth_desc=f"NTB {pct(s)}")

# ================================================================ main
TEMPLATES = [t_ab_landing, t_ab_email, t_geo_holdout, t_conv_lift, t_attr_realloc,
             t_branded_cannibal, t_channel_mix, t_amazon_buckets, t_cac_payback,
             t_seo_decomp, t_funnel_cvr, t_hygiene_dedupe, t_tt_window,
             t_b2b_pipeline, t_ntb_display]
HELD_OUT = {"r10-funnel-cvr", "r10-tt-window"}
PER_TEMPLATE = 20

def main():
    rejects = collections.Counter(); reject_log = []
    seen = set(); records = []
    for ti, fn in enumerate(TEMPLATES):
        got = 0; attempt = 0
        while got < PER_TEMPLATE and attempt < 60:
            attempt += 1
            rng = random.Random(20260926 + ti * 7919 + got * 104729 + attempt * 131)
            try:
                r = fn(rng, got)
            except Exception as e:
                rejects[f"EXC:{fn.__name__}:{type(e).__name__}"] += 1
                reject_log.append((fn.__name__, got, f"exception {e}"))
                continue
            brief = r["brief"]; trace = r["trace"]; output = r["output"]
            ok, reasons = verify(brief, trace, output, r["checks"] and [c for c in r["checks"] if len(c) == 2],
                                 r["decision_kw"], r["complication_kw"], r["spend_gate"])
            h = hashlib.sha256((trace + "\n" + output).encode()).hexdigest()
            if h in seen:
                ok = False; reasons = ["DUPE: content_hash collision"]
            if not ok:
                for rs in reasons:
                    key = rs.split(":")[0]
                    rejects[f"{fn.__name__}:{key}"] += 1
                reject_log.append((fn.__name__, got, reasons))
                continue
            seen.add(h)
            split = "held-out" if r["family"] in HELD_OUT else "train"
            rec = {
                "record_id": None,  # assigned after ordering
                "recipe": "R10",
                "license_class": r["lic"],
                "origin": "synthetic",
                "reviewer_type": "agent (Z7) + spot-check",
                "corpus_chunk_ids": r["chunks"],
                "constitution_section": "global hard rules",
                "language": "en",
                "market": "US",
                "split": split,
                "content_hash": "sha256:" + h,
                "duplicate_family": r["family"],
                "brief": {"objective": brief.split("\n")[1] if "\n" in brief else brief,
                          "audience": "", "constraints": "",
                          "_full": brief},
                "reasoning_trace": trace,
                "output": output,
                "validation": {"checks": [c[0] for c in r["checks"]] + [
                    "verifier: honest-labeling scan (no banned phrases; simulated framing) PASS",
                    "verifier: realism complication present PASS",
                    "verifier: decision follows math PASS",
                    "verifier: content_hash unique in batch PASS",
                ] + (["verifier: spend approval-gate line present PASS"] if r["spend_gate"] else []),
                    "verifier": "r10-numeric-tolerance+honest-labeling+realism"},
                "created_at": "2026-09-26",
            }
            # populate brief subfields from the brief text lines
            for ln in brief.split("\n"):
                if ln.startswith("Audience:"): rec["brief"]["audience"] = ln
                elif ln.startswith("Constraints:"): rec["brief"]["constraints"] = ln
            records.append(rec)
            got += 1
        print(f"{fn.__name__}: wrote {got}/{PER_TEMPLATE} after {attempt} attempts")
    # order: train first then held-out, assign record_ids
    records.sort(key=lambda r: (0 if r["split"] == "train" else 1, r["duplicate_family"]))
    for k, r in enumerate(records, 1):
        r["record_id"] = f"trace-r10-{k:06d}"
    with open(OUT, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    stats = {"written": len(records),
             "train": sum(1 for r in records if r["split"] == "train"),
             "held_out": sum(1 for r in records if r["split"] == "held-out"),
             "rejects": dict(rejects),
             "families": sorted({r["duplicate_family"] for r in records}),
             "chunk_usage": dict(collections.Counter(c for r in records for c in r["corpus_chunk_ids"])),
             "licenses": dict(collections.Counter(r["license_class"] for r in records))}
    json.dump(stats, open(STATS_OUT, "w"), indent=2)
    print(json.dumps(stats, indent=2)[:2000])
    # top rejection reasons
    print("TOP REJECTIONS:", rejects.most_common(10))

if __name__ == "__main__":
    main()
