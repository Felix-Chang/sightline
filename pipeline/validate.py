"""Validation gate: compare combined scores with your hand labels, enable categories that agree.

    uv run python pipeline/validate.py --labels data/labels.csv   # import + evaluate
    uv run python pipeline/validate.py                            # evaluate existing corrections

labels.csv columns: filename,subclass_id,label   (label = absent | present | dominant)
    poster_01.jpg,line.jagged,dominant
    poster_01.jpg,value.high_key,absent

Agreement per subclass = AUC: the chance that a randomly picked image you labeled
present/dominant scores higher than one you labeled absent (0.5 = coin flip, 1.0 = perfect).
A category is enabled when the mean AUC of its evaluable subclasses >= --threshold.
"""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path

import combine
from db import chunked, client, fetch_all, taxonomy

MIN_LABELS = 6  # per subclass, with at least one positive and one negative


def import_labels(path: Path) -> int:
    by_name = {r["filename"]: r["id"] for r in fetch_all("images", "id,filename")}
    rows, missing = [], set()
    with path.open() as f:
        for r in csv.DictReader(f):
            iid = by_name.get(r["filename"].strip())
            if not iid:
                missing.add(r["filename"])
                continue
            rows.append({"image_id": iid, "subclass_id": r["subclass_id"].strip(),
                         "label": r["label"].strip().lower(), "origin": "handlabel"})
    for batch in chunked(rows):
        client().table("corrections").insert(batch).execute()
    if missing:
        print(f"skipped {len(missing)} filenames not in the database: {sorted(missing)[:5]} ...")
    return len(rows)


def auc(pos: list[float], neg: list[float]) -> float:
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=Path)
    ap.add_argument("--threshold", type=float, default=0.75)
    ap.add_argument("--dry-run", action="store_true", help="report only, don't change categories")
    args = ap.parse_args()

    if args.labels:
        print(f"imported {import_labels(args.labels)} labels")

    cats, subs = taxonomy()
    # Latest label wins when the same image/subclass was labeled more than once.
    latest: dict[tuple[str, str], str] = {}
    for c in sorted(fetch_all("corrections", "image_id,subclass_id,label,id"), key=lambda r: r["id"]):
        latest[(c["image_id"], c["subclass_id"])] = c["label"]
    scores = {(r["image_id"], r["subclass_id"]): r["value"]
              for r in fetch_all("scores", "image_id,subclass_id,value", source="combined")}

    per_sub: dict[str, float] = {}
    for s in subs:
        pos, neg = [], []
        for (iid, sid), label in latest.items():
            if sid != s.id or (iid, sid) not in scores:
                continue
            (neg if label == "absent" else pos).append(scores[(iid, sid)])
        if len(pos) + len(neg) >= MIN_LABELS and pos and neg:
            per_sub[s.id] = auc(pos, neg)

    print(f"\n{'category':<18}{'agreement':>10}  subclasses")
    for cat in cats:
        vals = {s.id: per_sub[s.id] for s in subs if s.category_id == cat["id"] and s.id in per_sub}
        if not vals:
            print(f"{cat['name']:<18}{'n/a':>10}  (not enough labels, left as is)")
            continue
        mean = sum(vals.values()) / len(vals)
        passed = mean >= args.threshold
        detail = ", ".join(f"{k.split('.')[1]} {v:.2f}" for k, v in vals.items())
        print(f"{cat['name']:<18}{mean:>10.2f}  {'PASS' if passed else 'fail'}  {detail}")
        if not args.dry_run:
            client().table("categories").update({"enabled": passed}).eq("id", cat["id"]).execute()

    if not args.dry_run:
        combine.run()  # refresh the "All" layout with the enabled set


if __name__ == "__main__":
    main()
