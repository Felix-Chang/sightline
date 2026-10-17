import type { ImageNode, Subclass } from "./data";

export const RING_RADIUS = 420;

export type Anchor = { id: string; name: string; x: number; y: number };
export type Target = { x: number; y: number; weights: number[] };

/** Anchor points for a category: a horizontal axis for 2 subclasses, a ring otherwise. */
export function anchorsFor(subs: Subclass[]): Anchor[] {
  const n = subs.length;
  if (n === 2) {
    return subs.map((s, i) => ({ id: s.id, name: s.name, x: (i === 0 ? -1 : 1) * RING_RADIUS * 1.15, y: 0 }));
  }
  return subs.map((s, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return { id: s.id, name: s.name, x: Math.cos(a) * RING_RADIUS, y: Math.sin(a) * RING_RADIUS };
  });
}

/**
 * RadViz-style placement: each image is pulled toward every anchor in proportion to its
 * (sharpened) score, so pure examples sit on an anchor and mixed ones land between them.
 * `focus` > 1 exaggerates the strongest quality; 1 is a plain weighted average.
 */
export function targetsFor(images: ImageNode[], anchors: Anchor[], focus: number): Map<string, Target> {
  const out = new Map<string, Target>();
  for (const img of images) {
    const raw = anchors.map((a) => Math.pow(Math.max(img.scores[a.id] ?? 0, 1e-4), focus));
    const sum = raw.reduce((p, v) => p + v, 0) || 1;
    const weights = raw.map((v) => v / sum);
    let x = 0;
    let y = 0;
    anchors.forEach((a, i) => {
      x += a.x * weights[i];
      y += a.y * weights[i];
    });
    if (anchors.length === 2) {
      // Spread a spectrum vertically by how strongly the image has either quality,
      // so the axis reads as a band instead of a single line of thumbnails.
      const strength = Math.max(...anchors.map((a) => img.scores[a.id] ?? 0));
      y = (0.5 - strength) * RING_RADIUS * 0.9;
    }
    out.set(img.id, { x, y, weights });
  }
  return out;
}

export function umapTargets(images: ImageNode[]): Map<string, Target> {
  return new Map(images.map((img) => [img.id, { x: img.umap[0] * RING_RADIUS, y: img.umap[1] * RING_RADIUS, weights: [] }]));
}

/** k nearest neighbors in the score space of the given subclasses (all subclasses when empty). */
export function knnLinks(images: ImageNode[], subIds: string[], k = 3): [string, string][] {
  const vecs = images.map((img) => subIds.map((s) => img.scores[s] ?? 0.5));
  const seen = new Set<string>();
  const links: [string, string][] = [];
  for (let i = 0; i < images.length; i++) {
    const d = images.map((_, j) => {
      if (i === j) return [Infinity, j];
      let s = 0;
      for (let t = 0; t < subIds.length; t++) s += (vecs[i][t] - vecs[j][t]) ** 2;
      return [s, j];
    });
    d.sort((a, b) => a[0] - b[0]);
    for (const [, j] of d.slice(0, k)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push([images[i].id, images[j as number].id]);
      }
    }
  }
  return links;
}
