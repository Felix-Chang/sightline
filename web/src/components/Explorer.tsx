"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadDataset, saveCorrection, type Category, type Dataset, type ImageNode, type Label, type Subclass } from "@/lib/data";
import { anchorsFor, knnLinks, targetsFor, umapTargets } from "@/lib/layout";
import type { GraphLayout } from "@/lib/graph-engine";

const Graph = dynamic(() => import("./Graph"), { ssr: false });

const ALL = "__all";

export default function Explorer() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [focus, setFocus] = useState(3);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    loadDataset().then(setData).catch((e) => setError(String(e.message ?? e)));
  }, []);

  const categories = useMemo(() => (data?.categories ?? []).filter((c) => c.enabled), [data]);
  const subsByCat = useMemo(() => {
    const m = new Map<string, Subclass[]>();
    for (const s of data?.subclasses ?? []) {
      if (!m.has(s.category_id)) m.set(s.category_id, []);
      m.get(s.category_id)!.push(s);
    }
    return m;
  }, [data]);

  const category = useMemo(() => categories.find((c) => c.id === categoryId) ?? null, [categories, categoryId]);
  // Stable reference: a new array here would rebuild the layout (and restart physics) on every hover.
  const subs = useMemo(() => (category ? subsByCat.get(category.id) ?? [] : []), [category, subsByCat]);

  const layout: GraphLayout = useMemo(() => {
    const images = data?.images ?? [];
    if (!category) {
      const enabledSubs = categories.flatMap((c) => (subsByCat.get(c.id) ?? []).map((s) => s.id));
      return { anchors: [], targets: umapTargets(images), links: knnLinks(images, enabledSubs, 2), ring: false };
    }
    const anchors = anchorsFor(subs);
    return { anchors, targets: targetsFor(images, anchors, focus), links: knnLinks(images, subs.map((s) => s.id), 3), ring: true };
  }, [data, category, categories, subs, subsByCat, focus]);

  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);
  const onHover = useCallback((id: string | null) => setHoveredId(id), []);

  // Keyboard: left/right cycles filters, Escape clears the selection.
  useEffect(() => {
    const ids = [ALL, ...categories.map((c) => c.id)];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const i = ids.indexOf(categoryId);
        const next = (i + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length;
        setCategoryId(ids[next]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [categories, categoryId]);

  const detailId = selectedId ?? hoveredId;
  const detail = data?.images.find((i) => i.id === detailId) ?? null;

  if (error) {
    return (
      <Centered>
        <p className="font-mono text-sm text-accent">Couldn&apos;t load data</p>
        <p className="mt-2 max-w-md text-sm text-muted">{error}</p>
        <p className="mt-2 text-xs text-muted">Is Supabase running? (`supabase start` in the project folder)</p>
      </Centered>
    );
  }
  if (!data) return <Centered><p className="font-mono text-sm text-muted">Loading references…</p></Centered>;
  if (data.images.length === 0) {
    return (
      <Centered>
        <p className="font-mono text-sm">No images yet</p>
        <p className="mt-2 text-sm text-muted">Run <code className="text-paper">uv run python pipeline/batch.py data/images</code> to add some.</p>
      </Centered>
    );
  }

  return (
    <main className="relative h-dvh w-full select-none">
      <Graph images={data.images} layout={layout} selectedId={selectedId} onHover={onHover} onSelect={onSelect} />

      {/* Title + filter card */}
      <section className="pointer-events-none absolute left-4 top-4 w-[min(360px,calc(100vw-2rem))] space-y-3">
        <div className="pointer-events-auto rounded-xl border border-line bg-panel/90 p-4 backdrop-blur">
          <div className="flex items-baseline justify-between">
            <h1 className="text-xl font-semibold tracking-tight">SightLine</h1>
            <span className="font-mono text-xs text-muted">{data.images.length} references</span>
          </div>
          <p className="mt-1 text-xs text-muted">Sorted by visual language, not subject.</p>

          <div className="mt-4 flex flex-wrap gap-1.5">
            <FilterPill active={categoryId === ALL} onClick={() => setCategoryId(ALL)}>All</FilterPill>
            {categories.map((c) => (
              <FilterPill key={c.id} active={c.id === categoryId} onClick={() => setCategoryId(c.id)}>{c.name}</FilterPill>
            ))}
          </div>
        </div>

        {category && <CategoryCard category={category} subs={subs} />}
      </section>

      {/* Focus slider */}
      {category && (
        <div className="absolute bottom-4 left-4 flex items-center gap-3 rounded-lg border border-line bg-panel/90 px-3 py-2 font-mono text-xs text-muted backdrop-blur">
          <label htmlFor="focus">Blend</label>
          <input id="focus" type="range" min={1} max={8} step={0.5} value={focus} onChange={(e) => setFocus(Number(e.target.value))} className="w-28 accent-[#e0484f]" />
          <span>Separate</span>
        </div>
      )}

      <p className="absolute bottom-4 right-4 hidden font-mono text-[11px] text-muted md:block">
        scroll to zoom · drag to pan · ← → filters
      </p>

      {detail && (
        <DetailCard
          key={detail.id}
          image={detail}
          pinned={detail.id === selectedId}
          categories={category ? [category] : categories}
          subsByCat={subsByCat}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex h-dvh flex-col items-center justify-center px-4 text-center">{children}</main>;
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active ? "border-accent bg-accent/15 text-paper" : "border-line text-muted hover:border-muted hover:text-paper"
      }`}
    >
      {children}
    </button>
  );
}

function CategoryCard({ category, subs }: { category: Category; subs: Subclass[] }) {
  return (
    <div className="pointer-events-auto rounded-xl border border-line bg-panel/90 p-4 backdrop-blur">
      <p className="font-mono text-[11px] tracking-widest text-accent">FILTER · {category.kind === "spectrum" ? "SPECTRUM" : "QUALITIES"}</p>
      <h2 className="mt-1 text-lg font-medium">{category.name}</h2>
      {category.description && <p className="mt-1 text-xs text-muted">{category.description}</p>}
      <ul className="mt-3 space-y-2">
        {subs.map((s) => (
          <li key={s.id} className="text-xs">
            <span className="font-medium text-paper">{s.name}</span>
            <MethodBadge sub={s} />
            <p className="text-muted">{s.definition}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MethodBadge({ sub }: { sub: Subclass }) {
  const measured = sub.pixel_weight > 0;
  return (
    <span
      title={measured ? `${Math.round(sub.pixel_weight * 100)}% pixel math, rest SigLIP` : "Scored by SigLIP only"}
      className={`ml-2 rounded px-1.5 py-px font-mono text-[10px] ${measured ? "bg-paper/10 text-paper" : "bg-accent/15 text-accent"}`}
    >
      {measured ? "measured" : "perceived"}
    </span>
  );
}

function DetailCard({ image, pinned, categories, subsByCat, onClose }: {
  image: ImageNode;
  pinned: boolean;
  categories: Category[];
  subsByCat: Map<string, Subclass[]>;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<Record<string, Label>>({});
  const [err, setErr] = useState<string | null>(null);

  const correct = async (sid: string, label: Label) => {
    try {
      await saveCorrection(image.id, sid, label);
      setSaved((s) => ({ ...s, [sid]: label }));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <aside className="absolute right-4 top-4 flex max-h-[calc(100dvh-2rem)] w-[min(340px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-panel/95 backdrop-blur">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.fullUrl} alt={image.filename ?? "reference"} className="max-h-64 w-full bg-ink object-contain" />
      <div className="overflow-y-auto p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-mono text-xs text-muted">{image.filename}</p>
          {pinned && <button onClick={onClose} className="text-xs text-muted hover:text-paper" aria-label="Close">✕</button>}
        </div>
        {!pinned && <p className="mt-1 text-[11px] text-muted">Click the image to pin it and correct scores.</p>}

        {categories.map((c) => (
          <div key={c.id} className="mt-4">
            <p className="font-mono text-[11px] tracking-widest text-muted">{c.name.toUpperCase()}</p>
            <ul className="mt-1.5 space-y-1.5">
              {(subsByCat.get(c.id) ?? []).map((s) => {
                const v = image.scores[s.id] ?? 0;
                return (
                  <li key={s.id}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-28 shrink-0 truncate">{s.name}</span>
                      <div className="h-1.5 flex-1 rounded-full bg-line">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(v * 100)}%` }} />
                      </div>
                      <span className="w-8 text-right font-mono text-[11px] text-muted">{Math.round(v * 100)}</span>
                    </div>
                    {pinned && (
                      <div className="mt-1 flex gap-1 pl-[7.5rem]">
                        {(["absent", "present", "dominant"] as Label[]).map((l) => (
                          <button
                            key={l}
                            onClick={() => correct(s.id, l)}
                            className={`rounded border px-1.5 py-px font-mono text-[10px] ${
                              saved[s.id] === l ? "border-accent text-accent" : "border-line text-muted hover:text-paper"
                            }`}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {err && <p className="mt-3 text-xs text-accent">{err}</p>}
      </div>
    </aside>
  );
}
