# -*- coding: utf-8 -*-
"""Build the constitution pilot JSONL: verify, dedupe, split, emit."""
import json, sys, hashlib, importlib
from pathlib import Path
from collections import Counter
sys.path.insert(0, str(Path(__file__).parent))
from cx_lib import verify, build_record, canonical, assign_splits

BASE = Path('/home/hatch/workspace/marketr')
TRAINING = BASE/'training'
OUT = TRAINING/'traces'/'traces-constitution-pilot.jsonl'
LOGDIR = TRAINING/'hidden_build_logs'

def load_chunk_ids():
    ids = {}
    for name in ('main', 'by-sa'):
        p = BASE/'data'/'corpus'/name/'chunks.jsonl'
        n = 0
        with open(p, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line: continue
                n += 1
                try: ids[json.loads(line)['id']] = name
                except Exception: pass
        print(f'corpus {name}: {n} lines read')
    return ids

def main():
    chunk_ids = load_chunk_ids()
    read_log = BASE/'data'/'corpus'/'chunk_read_log.jsonl'
    read_ids = set()
    if read_log.exists():
        with open(read_log) as f:
            for line in f:
                try: read_ids.add(json.loads(line)['chunk_id'])
                except Exception: pass
        print(f'read log entries: {len(read_ids)}')
    else:
        print('NOTE: no chunk_read_log.jsonl yet — will generate after verification by reading cited chunks')

    cands = []
    for m in ('cx_strategy','cx_mission','cx_playbook','cx_content','cx_content_b'):
        mod = importlib.import_module(m)
        for t in mod.TRACES:
            t = dict(t); t['role_mod'] = m
            cands.append(t)
    print(f'candidates: {len(cands)}')

    missing, unread = [], []
    for t in cands:
        for c in t['corpus_chunk_ids']:
            if c not in chunk_ids: missing.append((t['family'], c))
            elif read_ids and c not in read_ids: unread.append((t['family'], c))
    if missing:
        print('MISSING CHUNKS:', missing); sys.exit(1)
    print(f'unread (not in read log): {len(unread)}')

    passed, rejected = [], []
    for t in cands:
        ok, reasons, checks = verify(t)
        t['checks'] = checks
        (passed if ok else rejected).append(t)
        if not ok: t['reject_reasons'] = reasons
    print(f'pass: {len(passed)}, reject: {len(rejected)}')

    LOGDIR.mkdir(exist_ok=True, parents=True)
    with open(LOGDIR/'rejections.jsonl','w') as f:
        for r in rejected:
            f.write(json.dumps({'family': r['family'], 'module': r['role_mod'],
                                'section': r['section'], 'reasons': r['reject_reasons']})+'\n')
    rc = Counter()
    for r in rejected:
        for e in r['reject_reasons']: rc[e.split(':')[0]] += 1
    print('top rejection reasons:', rc.most_common(12))
    for r in rejected:
        print('REJECT', r['family'], '|', '; '.join(r['reject_reasons'][:3]))

    seen, deduped, dupes = {}, [], []
    for r in passed:
        h = hashlib.sha256(canonical(r)).hexdigest()
        if h in seen: dupes.append((r['family'], seen[h])); continue
        seen[h] = r['family']; deduped.append(r)
    print(f'deduped: {len(deduped)}, dupes: {len(dupes)}', dupes)

    held = assign_splits(deduped, seed=7)
    splits = {t['family']: t['split'] for t in deduped}
    sc = Counter(splits.values()); print('split counts (families):', dict(sc))
    neg_fams = {t['family'] for t in deduped if t.get('negative')}
    print('negative families train/held-out:',
          sum(1 for f in neg_fams if splits[f]=='train'), '/',
          sum(1 for f in neg_fams if splits[f]=='held-out'))

    OUT.parent.mkdir(exist_ok=True, parents=True)
    ordered = sorted(deduped, key=lambda r: r['family'])
    role_counts, split_counts, neg_n = Counter(), Counter(), 0
    with open(OUT,'w') as f:
        for i, r in enumerate(ordered, 1):
            rec = build_record(r, i)
            f.write(json.dumps(rec, ensure_ascii=False)+'\n')
            role_counts[r['section']] += 1; split_counts[r['split']] += 1
            if r.get('negative'): neg_n += 1
    print(f'wrote {OUT}: {len(ordered)} records')
    print('roles:', dict(role_counts))
    print('splits (records):', dict(split_counts))
    print('negatives:', neg_n)
    with open(LOGDIR/'build_summary.json','w') as f:
        json.dump({'candidates': len(cands), 'passed': len(passed), 'rejected': len(rejected),
                   'dupes': len(dupes), 'emitted': len(ordered),
                   'roles': dict(role_counts), 'splits': dict(split_counts),
                   'negatives': neg_n, 'rejection_reasons': dict(rc),
                   'unread_chunk_uses': len(unread)}, f, indent=2)

if __name__ == '__main__':
    main()
