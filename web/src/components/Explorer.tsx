"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadDataset, type Category, type Dataset, type ImageNode, type Subclass } from "@/lib/data";
import { anchorsFor, knnLinks, targetsFor, umapTargets } from "@/lib/layout";
import type { GraphLayout } from "@/lib/graph-engine";

const Graph = dynamic(() => import("./Graph"), { ssr: false });

const ALL = "__all";
const DEFAULT_FOCUS = 4.5; // Exact center of the slider range [1, 8]

export default function Explorer() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [focus, setFocus] = useState(DEFAULT_FOCUS);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectCategory = useCallback((id: string) => {
    setCategoryId(id);
    setFocus(DEFAULT_FOCUS);
  }, []);

  useEffect(() => {
    setFocus(DEFAULT_FOCUS);
  }, [categoryId]);

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
        selectCategory(ids[next]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [categories, categoryId, selectCategory]);

  const detailId = selectedId ?? hoveredId;
  const detail = data?.images.find((i) => i.id === detailId) ?? null;

  if (error) {
    return (
      <Centered>
        <p className="font-serif text-2xl">Couldn&apos;t load references</p>
        <p className="mt-2 max-w-md font-mono text-xs text-accent">{error}</p>
        <p className="mt-3 max-w-md text-sm text-muted">
          Check the anon key in <code className="font-mono text-fg">web/.env.local</code> and restart <code className="font-mono text-fg">npm run dev</code>.
          If it worked before, the Supabase project may be paused. See Troubleshooting in the README.
        </p>
      </Centered>
    );
  }
  if (!data) return <Centered><p className="font-mono text-sm text-muted">Loading references…</p></Centered>;
  if (data.images.length === 0) {
    return (
      <Centered>
        <p className="font-serif text-2xl">No images yet</p>
        <p className="mt-2 text-sm text-muted">Run <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-fg">uv run python pipeline/batch.py data/images</code> to add some.</p>
      </Centered>
    );
  }

  return (
    <main className="relative h-dvh w-full select-none">
      <Graph images={data.images} layout={layout} selectedId={selectedId} onHover={onHover} onSelect={onSelect} />

      {/* Title + filter card */}
      <section className="pointer-events-none absolute left-4 top-4 max-h-[calc(100dvh-5rem)] w-[min(360px,calc(100vw-2rem))] space-y-3 overflow-y-auto">
        <div className={`pointer-events-auto ${CARD} p-5`}>
          <div className="flex items-baseline justify-between">
            <h1 className="font-serif text-[28px] leading-none tracking-tight">SightLine</h1>
            <span className="font-mono text-[11px] text-muted">{data.images.length} refs</span>
          </div>
          <p className="mt-2 text-xs text-muted">References sorted by visual language, not subject.</p>

          <Eyebrow n="01" className="mt-5">Filter</Eyebrow>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <FilterPill active={categoryId === ALL} onClick={() => selectCategory(ALL)}>All</FilterPill>
            {categories.map((c) => (
              <FilterPill key={c.id} active={c.id === categoryId} onClick={() => selectCategory(c.id)}>{c.name}</FilterPill>
            ))}
          </div>
        </div>

        {category && <CategoryCard category={category} subs={subs} />}
      </section>

      {/* Focus slider */}
      {category && (
        <div className={`absolute bottom-4 left-4 flex items-center gap-3 ${CARD} px-4 py-2.5 font-mono text-[11px] text-muted`}>
          <label htmlFor="focus">Separate</label>
          <input
            id="focus"
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={9 - focus}
            onChange={(e) => setFocus(9 - Number(e.target.value))}
            className="w-28 cursor-pointer accent-accent"
          />
          <span>Blend</span>
        </div>
      )}

      <p className="absolute bottom-5 right-5 hidden font-mono text-[11px] text-muted md:block">
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

// Shared card look: white sheet, hairline border, soft paper shadow (like the reel's light frames).
const CARD = "rounded-2xl border border-border bg-surface/95 shadow-[0_1px_2px_rgba(28,28,26,0.06),0_8px_24px_rgba(28,28,26,0.06)] backdrop-blur";

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex h-dvh flex-col items-center justify-center px-4 text-center">{children}</main>;
}

/** Numbered monospace label, e.g. "01  FILTER". */
function Eyebrow({ n, children, className = "" }: { n: string; children: React.ReactNode; className?: string }) {
  return (
    <p className={`font-mono text-[11px] uppercase tracking-[0.14em] text-muted ${className}`}>
      <span className="text-accent">{n}</span>
      <span className="ml-2">{children}</span>
    </p>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active ? "border-fg bg-fg text-surface" : "border-border bg-surface text-fg hover:border-fg/40"
      }`}
    >
      {children}
    </button>
  );
}

function CategoryCard({ category, subs }: { category: Category; subs: Subclass[] }) {
  return (
    <div className={`pointer-events-auto ${CARD} p-5`}>
      <Eyebrow n="02">{category.kind === "spectrum" ? "Spectrum" : "Qualities"}</Eyebrow>
      <h2 className="mt-1.5 font-serif text-[26px] leading-tight">{category.name}</h2>
      {category.description && <p className="mt-1 text-xs text-muted">{category.description}</p>}
      <ul className="mt-4 divide-y divide-border border-t border-border">
        {subs.map((s, i) => (
          <li key={s.id} className="py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-medium text-fg">{s.name}</span>
              <MethodBadge sub={s} />
            </div>
            <p className="mt-0.5 pl-6 text-muted">{s.definition}</p>
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
      className={`ml-auto rounded-full border px-2 py-px font-mono text-[10px] ${
        measured ? "border-border text-muted" : "border-accent/40 text-accent"
      }`}
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
  return (
    <aside className={`absolute right-4 top-4 flex max-h-[calc(100dvh-2rem)] w-[min(340px,calc(100vw-2rem))] flex-col overflow-hidden ${CARD}`}>
      <div className="border-b border-border bg-canvas p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.fullUrl} alt={image.filename ?? "reference"} className="mx-auto max-h-60 object-contain shadow-sm" />
      </div>
      <div className="overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-mono text-[11px] text-muted">{image.filename}</p>
          {pinned && <button onClick={onClose} className="text-xs text-muted hover:text-fg" aria-label="Close">✕</button>}
        </div>
        {categories.map((c) => (
          <div key={c.id} className="mt-5">
            <p className="font-serif text-base">{c.name}</p>
            <ul className="mt-2 space-y-2">
              {(subsByCat.get(c.id) ?? []).map((s) => {
                const v = image.scores[s.id] ?? 0;
                return (
                  <li key={s.id}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-28 shrink-0 truncate">{s.name}</span>
                      <div className="h-1 flex-1 rounded-full bg-border">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(v * 100)}%` }} />
                      </div>
                      <span className="w-8 text-right font-mono text-[11px] text-muted">{Math.round(v * 100)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  );
}
