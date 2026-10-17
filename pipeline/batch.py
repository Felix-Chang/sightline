"""Ingest a folder of images into SightLine.

    uv run python pipeline/batch.py data/images

Skips files already in the database (by SHA-256), then recomputes combined scores.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import combine
from db import client, seed_taxonomy, taxonomy
from score_image import Scorer

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"}


def needs_combine() -> bool:
    """True if some stored image has no combined scores yet (e.g. a run was interrupted
    before combine). The app only shows combined scores, so those images would be invisible."""
    db = client()
    n_images = db.table("images").select("id", count="exact").limit(1).execute().count or 0
    first_sub = taxonomy()[1][0].id
    n_combined = (db.table("scores").select("image_id", count="exact")
                  .eq("source", "combined").eq("subclass_id", first_sub).limit(1).execute().count or 0)
    return n_combined < n_images


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    ap.add_argument("--recombine", action="store_true", help="recompute combined scores even if nothing was added")
    args = ap.parse_args()

    if not args.folder.is_dir():
        raise SystemExit(f"Folder not found: {args.folder}  (run from the repo root, e.g. data/images)")
    # Skip hidden files, including macOS "._name.jpg" metadata files that aren't real images.
    files = sorted(p for p in args.folder.rglob("*")
                   if p.suffix.lower() in EXTS and p.is_file() and not p.name.startswith("."))
    print(f"{len(files)} image files in {args.folder}")
    seed_taxonomy()
    scorer = Scorer()

    added = skipped = failed = 0
    t0 = time.time()
    try:
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
    except KeyboardInterrupt:
        print("\ninterrupted; combining what was added so far (Ctrl+C again to skip)")
    print(f"added {added}, skipped {skipped}, failed {failed} in {time.time() - t0:.0f}s")

    if added or args.recombine or needs_combine():
        combine.run()


if __name__ == "__main__":
    main()
