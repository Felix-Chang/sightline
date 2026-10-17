"""Learned models: SigLIP 2 (image <-> text similarity) and DINOv2 (structure embeddings).

No text is generated anywhere. SigLIP compares an image embedding with embeddings of
the prompt sentences in taxonomy.yaml and returns cosine similarities (numbers).
"""

from __future__ import annotations

import os

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel, AutoProcessor

SIGLIP_MODEL = os.getenv("SIGLIP_MODEL", "google/siglip2-so400m-patch14-384")
DINO_MODEL = os.getenv("DINO_MODEL", "facebook/dinov2-base")


def _device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _as_tensor(out) -> torch.Tensor:
    """transformers 5 may wrap feature outputs; unwrap to the pooled tensor."""
    if isinstance(out, torch.Tensor):
        return out
    for attr in ("pooler_output", "image_embeds", "text_embeds"):
        t = getattr(out, attr, None)
        if isinstance(t, torch.Tensor):
            return t
    raise TypeError(f"Unexpected model output: {type(out)}")


def _normalize(x: torch.Tensor) -> np.ndarray:
    x = torch.nn.functional.normalize(x.float(), dim=-1)
    return x.cpu().numpy()


class SigLIP:
    def __init__(self, name: str = SIGLIP_MODEL):
        self.device = _device()
        self.model = AutoModel.from_pretrained(name).to(self.device).eval()
        self.processor = AutoProcessor.from_pretrained(name)

    @torch.no_grad()
    def embed_images(self, images: list[Image.Image]) -> np.ndarray:
        inputs = self.processor(images=images, return_tensors="pt").to(self.device)
        return _normalize(_as_tensor(self.model.get_image_features(**inputs)))

    @torch.no_grad()
    def embed_texts(self, texts: list[str]) -> np.ndarray:
        # SigLIP was trained on lowercase text padded to 64 tokens.
        inputs = self.processor(text=[t.lower() for t in texts], padding="max_length",
                                max_length=64, truncation=True, return_tensors="pt").to(self.device)
        return _normalize(_as_tensor(self.model.get_text_features(**inputs)))


class DINO:
    def __init__(self, name: str = DINO_MODEL):
        self.device = _device()
        self.model = AutoModel.from_pretrained(name).to(self.device).eval()
        self.processor = AutoImageProcessor.from_pretrained(name)

    @torch.no_grad()
    def embed_images(self, images: list[Image.Image]) -> np.ndarray:
        inputs = self.processor(images=images, return_tensors="pt").to(self.device)
        cls = self.model(**inputs).last_hidden_state[:, 0]
        return _normalize(cls)


class PromptBank:
    """Precomputed prompt embeddings per subclass; scores = mean cosine over the ensemble."""

    def __init__(self, siglip: SigLIP, prompts: dict[str, list[str]]):
        self.ids = [sid for sid, p in prompts.items() if p]
        self.means = np.stack([siglip.embed_texts(prompts[sid]).mean(axis=0) for sid in self.ids])

    def score(self, image_embedding: np.ndarray) -> dict[str, float]:
        sims = self.means @ image_embedding
        return {sid: round(float(s), 6) for sid, s in zip(self.ids, sims)}
