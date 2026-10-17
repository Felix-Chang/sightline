"""Turn raw pixel/SigLIP scores into comparable 0..1 'combined' scores, plus the UMAP layout.

Raw scores live on different scales (luminance vs. cosine similarity), so each
(subclass, source) is converted to a percentile across the whole collection, then the
two sources are blended with the subclass weight from taxonomy.yaml. Rerun after every
ingest: percentiles depend on the collection.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np

from db import chunked, client, fetch_all, taxonomy


def percentiles(values: dict[str, float]) -> dict[str, float]:
    ids = list(values)
    if len(ids) == 1:
        return {ids[0]: 0.5}
    arr = np.array([values[i] for i in ids])
    order = arr.argsort(kind="stable")
    ranks = np.empty(len(arr))
    ranks[order] = np.arange(len(arr))
    # Average ranks for ties so identical raw values get identical percentiles.
    for v in np.unique(arr):
        idx = arr == v
        if idx.sum() > 1:
            ranks[idx] = ranks[idx].mean()
    pct = ranks / (len(arr) - 1)
    return {i: round(float(p), 4) for i, p in zip(ids, pct)}


def layout(image_ids: list[str], combined: dict[str, dict[str, float]], enabled_subs: list[str]):
    """2D 'All' view: UMAP over enabled combined scores (PCA when the collection is tiny)."""
    X = np.array([[combined[i].get(s, 0.5) for s in enabled_subs] for i in image_ids])
    if len(image_ids) < 3:
        return np.zeros((len(image_ids), 2))
    if len(image_ids) >= 15:
        import umap

        xy = umap.UMAP(n_neighbors=min(15, len(image_ids) - 1), min_dist=0.25,
                       random_state=7).fit_transform(X)
    else:
        Xc = X - X.mean(axis=0)
        _, _, vt = np.linalg.svd(Xc, full_matrices=False)
        xy = Xc @ vt[:2].T
    xy = xy - xy.mean(axis=0)
    return xy / (np.abs(xy).max() + 1e-9)


def run() -> None:
    _, subs = taxonomy()
    db = client()
    raw = fetch_all("scores", "image_id,subclass_id,source,value")
    by_key: dict[tuple[str, str], dict[str, float]] = defaultdict(dict)
    for r in raw:
        if r["source"] in ("pixel", "siglip"):
            by_key[(r["subclass_id"], r["source"])][r["image_id"]] = r["value"]

    pct = {k: percentiles(v) for k, v in by_key.items()}
    image_ids = sorted({r["image_id"] for r in raw})
    combined: dict[str, dict[str, float]] = defaultdict(dict)
    rows = []
    for s in subs:
        px, sl = pct.get((s.id, "pixel"), {}), pct.get((s.id, "siglip"), {})
        for iid in image_ids:
            parts = []
            if iid in px:
                parts.append((px[iid], s.weight))
            if iid in sl:
                parts.append((sl[iid], 1.0 - s.weight if iid in px else 1.0))
            if not parts:
                continue
            value = sum(v * w for v, w in parts) / (sum(w for _, w in parts) or 1.0)
            combined[iid][s.id] = round(value, 4)
            rows.append({"image_id": iid, "subclass_id": s.id, "source": "combined", "value": value})

    for batch in chunked(rows):
        db.table("scores").upsert(batch, on_conflict="image_id,subclass_id,source").execute()

    enabled_cats = {c["id"] for c in fetch_all("categories", "id,enabled") if c["enabled"]}
    enabled_subs = [s.id for s in subs if s.category_id in enabled_cats]
    if image_ids and enabled_subs:
        xy = layout(image_ids, combined, enabled_subs)
        for iid, (x, y) in zip(image_ids, xy):
            db.table("images").update({"umap_x": float(x), "umap_y": float(y)}).eq("id", iid).execute()
    print(f"combined {len(rows)} scores for {len(image_ids)} images")


if __name__ == "__main__":
    run()
