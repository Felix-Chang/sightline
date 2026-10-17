"""Score + store one image. Used by batch.py now and by the upload endpoint later."""

from __future__ import annotations

import hashlib
import io
import mimetypes
from pathlib import Path

from PIL import Image

import pixel
from db import BUCKET, chunked, client, taxonomy, vec
from models import DINO, PromptBank, SigLIP

THUMB_SIZE = 256


class Scorer:
    """Loads models once; call `ingest(path)` per image."""

    def __init__(self):
        _, self.subs = taxonomy()
        print("loading SigLIP 2 ...")
        self.siglip = SigLIP()
        print("loading DINOv2 ...")
        self.dino = DINO()
        self.prompts = PromptBank(self.siglip, {s.id: list(s.prompts) for s in self.subs})

    def exists(self, sha: str) -> bool:
        return bool(client().table("images").select("id").eq("sha256", sha).execute().data)

    def ingest(self, path: Path, source_url: str | None = None) -> str | None:
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if self.exists(sha):
            return None

        img = pixel.load_rgb(str(path))
        metrics = pixel.analyze(img)
        sig = self.siglip.embed_images([img])[0]
        dino = self.dino.embed_images([img])[0]
        sig_scores = self.prompts.score(sig)

        # Store the original and a thumbnail in Supabase Storage.
        ext = path.suffix.lower() or ".jpg"
        orig_path = f"originals/{sha[:2]}/{sha}{ext}"
        thumb_path = f"thumbs/{sha}.webp"
        thumb = img.copy()
        thumb.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
        buf = io.BytesIO()
        thumb.save(buf, "WEBP", quality=85)
        store = client().storage.from_(BUCKET)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        store.upload(orig_path, data, {"content-type": ctype, "upsert": "true"})
        store.upload(thumb_path, buf.getvalue(), {"content-type": "image/webp", "upsert": "true"})

        row = client().table("images").insert({
            "sha256": sha, "storage_path": orig_path, "thumb_path": thumb_path,
            "filename": path.name, "source_url": source_url,
            "width": img.width, "height": img.height, "metrics": metrics,
            "siglip": vec(sig), "dino": vec(dino),
        }).execute().data[0]

        scores = []
        for s in self.subs:
            if s.pixel:
                scores.append({"image_id": row["id"], "subclass_id": s.id,
                               "source": "pixel", "value": metrics[s.pixel]})
            if s.id in sig_scores:
                scores.append({"image_id": row["id"], "subclass_id": s.id,
                               "source": "siglip", "value": sig_scores[s.id]})
        for batch in chunked(scores):
            client().table("scores").insert(batch).execute()
        return row["id"]
