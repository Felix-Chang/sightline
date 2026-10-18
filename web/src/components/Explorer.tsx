"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadDataset,
  type Category,
  type Dataset,
  type ImageNode,
  type Subclass,
} from "@/lib/data";
import { anchorsFor, knnLinks, targetsFor, umapTargets } from "@/lib/layout";
import type { GraphLayout } from "@/lib/graph-engine";
import { anchorHex } from "@/lib/theme";

const Graph = dynamic(() => import("./Graph"), { ssr: false });

const ALL = "__all";
const DEFAULT_FOCUS = 4.5; // Exact center of the slider range [1, 8]
const FOCUS_STORAGE_KEY = "sightline_focus";

export default function Explorer() {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [focus, setFocus] = useState(DEFAULT_FOCUS);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Restore cached slider position if the user previously changed it
  useEffect(() => {
    try {
      const cached = localStorage.getItem(FOCUS_STORAGE_KEY);
      if (cached !== null) {
        const val = Number(cached);
        if (!Number.isNaN(val) && val >= 1 && val <= 8) {
          setFocus(val);
        }
      }
    } catch {}
  }, []);

  const onFocusChange = useCallback((newFocus: number) => {
    setFocus(newFocus);
    try {
      localStorage.setItem(FOCUS_STORAGE_KEY, String(newFocus));
    } catch {}
  }, []);

  const selectCategory = useCallback((id: string) => {
    // Filter navigation ends a hover immediately, before the new layout's
    // effect runs, so its detail card cannot linger during the transition.
    setHoveredId(null);
    setCategoryId(id);
  }, []);

  useEffect(() => {
    loadDataset()
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const categories = useMemo(
    () => (data?.categories ?? []).filter((c) => c.enabled),
    [data],
  );
  const subsByCat = useMemo(() => {
    const m = new Map<string, Subclass[]>();
    for (const s of data?.subclasses ?? []) {
      if (!m.has(s.category_id)) m.set(s.category_id, []);
      m.get(s.category_id)!.push(s);
    }
    return m;
  }, [data]);

  const category = useMemo(
    () => categories.find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );
  // Stable reference: a new array here would rebuild the layout (and restart physics) on every hover.
  const subs = useMemo(
    () => (category ? (subsByCat.get(category.id) ?? []) : []),
    [category, subsByCat],
  );

  const layout: GraphLayout = useMemo(() => {
    const images = data?.images ?? [];
    if (!category) {
      const enabledSubs = categories.flatMap((c) =>
        (subsByCat.get(c.id) ?? []).map((s) => s.id),
      );
      return {
        anchors: [],
        targets: umapTargets(images),
        links: knnLinks(images, enabledSubs, 2),
        ring: false,
        showLinks: true,
      };
    }
    const anchors = anchorsFor(subs);
    return {
      anchors,
      targets: targetsFor(images, anchors, focus),
      links: knnLinks(
        images,
        subs.map((s) => s.id),
        3,
      ),
      ring: true,
      showLinks: false,
    };
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
        const next =
          (i + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length;
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
        <p className="font-serif text-2xl font-bold">
          Couldn&apos;t load references
        </p>
        <p className="mt-2 max-w-md font-label text-xs text-accent">{error}</p>
        <p className="mt-3 max-w-md text-sm text-muted">
          Check the anon key in{" "}
          <code className="font-mono text-fg">web/.env.local</code> and restart{" "}
          <code className="font-mono text-fg">npm run dev</code>. If it worked
          before, the Supabase project may be paused. See Troubleshooting in the
          README.
        </p>
      </Centered>
    );
  }
  if (!data)
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          {/* Masked rather than drawn: the SVG is solid black, so this tints it to match the text. */}
          <div
            aria-hidden
            className="h-14 w-14 bg-muted"
            style={{
              maskImage: "url(/sightlinelogo.svg)",
              WebkitMaskImage: "url(/sightlinelogo.svg)",
              maskSize: "contain",
              WebkitMaskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskPosition: "center",
            }}
          />
          <p className="font-label text-sm text-muted">Loading references…</p>
        </div>
      </Centered>
    );
  if (data.images.length === 0) {
    return (
      <Centered>
        <p className="font-serif text-2xl font-bold">No images yet</p>
        <p className="mt-2 text-sm text-muted">
          Run{" "}
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-fg">
            uv run python pipeline/batch.py data/images
          </code>{" "}
          to add some.
        </p>
      </Centered>
    );
  }

  return (
    <main className="relative h-dvh w-full select-none">
      <Graph
        images={data.images}
        layout={layout}
        selectedId={selectedId}
        onHover={onHover}
        onSelect={onSelect}
      />

      {/* Title + filter card */}
      <section className="pointer-events-none absolute left-4 top-4 max-h-[calc(100dvh-5rem)] w-[min(360px,calc(100vw-2rem))] space-y-3 overflow-y-auto">
        <div className={`pointer-events-auto ${CARD} p-5`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/sightlinelogo.svg" alt="" aria-hidden className="h-[37px] w-[37px] shrink-0" />
              <h1 className="font-serif text-[28px] font-bold leading-none tracking-tight">SightLine</h1>
            </div>
            <span className="font-label text-[11px] text-muted">{data.images.length} refs</span>
          </div>
          <p className="mt-2 text-xs text-muted">
            References sorted by visual language, not subject.
          </p>

          <Eyebrow className="mt-5">Filter</Eyebrow>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <FilterPill
              active={categoryId === ALL}
              onClick={() => selectCategory(ALL)}
            >
              None
            </FilterPill>
            {categories.map((c) => (
              <FilterPill
                key={c.id}
                active={c.id === categoryId}
                onClick={() => selectCategory(c.id)}
              >
                {c.name}
              </FilterPill>
            ))}
          </div>
        </div>

        {category && <CategoryCard category={category} subs={subs} />}
      </section>

      {/* Focus slider */}
      {category && (
        <div
          className={`absolute bottom-4 left-4 flex w-[min(360px,calc(100vw-2rem))] items-center gap-3 ${CARD} px-4 py-2.5 font-label text-[11px] text-muted`}
        >
          <label htmlFor="focus">Separate</label>
          <input
            id="focus"
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={9 - focus}
            onChange={(e) => onFocusChange(9 - Number(e.target.value))}
            className="min-w-0 flex-1 cursor-pointer accent-accent"
          />
          <span>Blend</span>
        </div>
      )}

      {/* Carded like the slider so the background texture never runs through the text. */}
      <p
        className={`absolute bottom-4 right-4 hidden w-[min(340px,calc(100vw-2rem))] justify-between gap-3 ${CARD} px-4 py-2.5 font-label text-[11px] text-muted md:flex`}
      >
        <span>Scroll to zoom</span>
        <span aria-hidden>|</span>
        <span>Drag to pan</span>
        <span aria-hidden>|</span>
        <span>← → Change filters</span>
      </p>

      {detail && (
        <DetailCard
          key={detail.id}
          image={detail}
          pinned={detail.id === selectedId}
          categories={category ? [category] : categories}
          filtered={!!category}
          subsByCat={subsByCat}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}

// Shared card look: white sheet, hairline border, soft paper shadow (like the reel's light frames).
const CARD =
  "rounded-2xl border border-border bg-surface/95 shadow-[0_1px_2px_rgba(28,28,26,0.06),0_8px_24px_rgba(28,28,26,0.06)] backdrop-blur";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center px-4 text-center">
      {children}
    </main>
  );
}

/** Monospace section label, e.g. "FILTER". */
function Eyebrow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`font-label text-[11px] uppercase tracking-[0.14em] text-accent ${className}`}
    >
      {children}
    </p>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-fg bg-fg text-surface"
          : "border-border bg-surface text-fg hover:border-fg/40"
      }`}
    >
      {children}
    </button>
  );
}

function CategoryCard({
  category,
  subs,
}: {
  category: Category;
  subs: Subclass[];
}) {
  return (
    <div className={`pointer-events-auto ${CARD} p-5`}>
      <h2 className="font-serif text-[26px] font-bold leading-tight">
        {category.name}
      </h2>
      {category.description && (
        <p className="mt-1 text-xs text-muted">{category.description}</p>
      )}
      <Eyebrow className="mt-5">Type</Eyebrow>
      <ul className="mt-2 divide-y divide-border border-t border-border">
        {subs.map((s, i) => (
          <li key={s.id} className="py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-4 shrink-0 font-label text-[10px] tabular-nums text-muted">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-medium uppercase tracking-[0.08em] text-fg">{s.name}</span>
            </div>
            <p className="mt-0.5 pl-6 text-muted">{s.definition}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailCard({ image, pinned, categories, filtered, subsByCat, onClose }: {
  image: ImageNode;
  pinned: boolean;
  categories: Category[];
  filtered: boolean;
  subsByCat: Map<string, Subclass[]>;
  onClose: () => void;
}) {
  return (
    <aside
      className={`absolute right-4 top-4 flex max-h-[calc(100dvh-2rem)] w-[min(340px,calc(100vw-2rem))] flex-col overflow-hidden ${CARD}`}
    >
      <div className="border-b border-border bg-canvas p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.fullUrl}
          alt={image.filename ?? "reference"}
          className="mx-auto max-h-60 object-contain shadow-sm"
        />
      </div>
      <div className="overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-mono text-[11px] text-muted">
            {image.filename}
          </p>
          {pinned && (
            <button
              onClick={onClose}
              className="text-xs text-muted hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>
        {categories.map((c) => (
          <div key={c.id} className="mt-5">
            <p className="font-serif text-base font-semibold">{c.name}</p>
            <ul className="mt-2 space-y-2">
              {(subsByCat.get(c.id) ?? []).map((s, i) => {
                const v = image.scores[s.id] ?? 0;
                return (
                  <li key={s.id}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-28 shrink-0 truncate font-serif">
                        {s.name}
                      </span>
                      <div className="h-1 flex-1 rounded-full bg-border">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.round(v * 100)}%`,
                            backgroundColor: filtered
                              ? anchorHex(i)
                              : anchorHex(0),
                          }}
                        />
                      </div>
                      <span className="w-8 text-right font-label text-[11px] tabular-nums text-muted">
                        {Math.round(v * 100)}
                      </span>
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
