"""Supabase client + taxonomy helpers shared by every pipeline script."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml
from dotenv import load_dotenv
from supabase import Client, create_client

ROOT = Path(__file__).resolve().parent.parent
BUCKET = "images"

load_dotenv(ROOT / ".env")


@lru_cache
def client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # pipeline writes bypass RLS
    return create_client(url, key)


@dataclass(frozen=True)
class Subclass:
    id: str                 # 'line.jagged'
    category_id: str
    name: str
    definition: str
    prompts: tuple[str, ...]
    anchor_order: int
    pixel: str | None       # metric key from pixel.analyze()
    weight: float           # pixel share of the combined score


@lru_cache
def taxonomy() -> tuple[list[dict], list[Subclass]]:
    data = yaml.safe_load((ROOT / "seed" / "taxonomy.yaml").read_text())
    cats, subs = [], []
    for ci, cat in enumerate(data["categories"]):
        cats.append({"id": cat["id"], "name": cat["name"], "kind": cat["kind"],
                     "description": cat.get("description"), "sort": ci})
        for si, s in enumerate(cat["subclasses"]):
            pixel = s.get("pixel")
            subs.append(Subclass(
                id=f"{cat['id']}.{s['id']}", category_id=cat["id"], name=s["name"],
                definition=s["definition"], prompts=tuple(s.get("prompts", [])),
                anchor_order=si, pixel=pixel,
                weight=float(s.get("weight", 0.5)) if pixel else 0.0,
            ))
    return cats, subs


def seed_taxonomy() -> None:
    """Upsert categories/subclasses from taxonomy.yaml. Keeps each category's `enabled` flag."""
    cats, subs = taxonomy()
    db = client()
    db.table("categories").upsert(cats, on_conflict="id").execute()
    db.table("subclasses").upsert([
        {"id": s.id, "category_id": s.category_id, "name": s.name, "definition": s.definition,
         "prompts": list(s.prompts), "anchor_order": s.anchor_order, "pixel_weight": s.weight}
        for s in subs
    ], on_conflict="id").execute()


def fetch_all(table: str, columns: str = "*", page: int = 1000, **eq) -> list[dict]:
    """Read every row, paging past PostgREST's row limit."""
    rows, start = [], 0
    while True:
        q = client().table(table).select(columns)
        for k, v in eq.items():
            q = q.eq(k, v)
        batch = q.range(start, start + page - 1).execute().data
        rows.extend(batch)
        if len(batch) < page:
            return rows
        start += page


def chunked(items: list, n: int = 500):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def vec(v) -> str:
    """pgvector literal for PostgREST."""
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"
