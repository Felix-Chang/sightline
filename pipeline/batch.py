"""Ingest a folder of images into SightLine.

    uv run python pipeline/batch.py data/images

Skips files already in the database (by SHA-256), then recomputes combined scores.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import combine
from db import seed_taxonomy
from score_image import Scorer

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    args = ap.parse_args()

    files = sorted(p for p in args.folder.rglob("*") if p.suffix.lower() in EXTS)
    print(f"{len(files)} image files in {args.folder}")
    seed_taxonomy()
    scorer = Scorer()

    added = skipped = failed = 0
    t0 = time.time()
    for i, path in enumerate(files, 1):
        try:
            if scorer.ingest(path):
                added += 1
                print(f"[{i}/{len(files)}] + {path.name}")
            else:
                skipped += 1
        except Exception as e:  # keep going; one bad file shouldn't stop a batch
            failed += 1
            print(f"[{i}/{len(files)}] ! {path.name}: {e}")
    print(f"added {added}, skipped {skipped}, failed {failed} in {time.time() - t0:.0f}s")

    if added:
        combine.run()


if __name__ == "__main__":
    main()
