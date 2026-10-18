"use client";

import { useEffect, useRef } from "react";
import { AsciiPulse } from "@/lib/ascii-pulse";
import type { ImageNode } from "@/lib/data";
import { GraphEngine, type GraphLayout } from "@/lib/graph-engine";
import { asciiInkHex } from "@/lib/theme";

declare global {
  interface Window {
    /** Testing hooks for the background ASCII effects; see Graph's mount effect. */
    sightline?: { shimmer: () => string; pulse: () => string };
  }
}

type Props = {
  images: ImageNode[];
  layout: GraphLayout;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  /** Called once the canvas is up and the first nodes (as skeleton tiles) are on screen. */
  onReady?: () => void;
};

export default function Graph({ images, layout, selectedId, onHover, onSelect, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pulseCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const pulseRef = useRef<AsciiPulse | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  // Which filter's anchors are on screen; the pulse fires only when this changes.
  const anchorKeyRef = useRef<string | null>(null);
  // Latest callbacks for the engine, which is created once; refreshed after each render.
  const handlers = useRef({ onHover, onSelect });
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    handlers.current = { onHover, onSelect };
    onReadyRef.current = onReady;
  }, [onHover, onSelect, onReady]);

  useEffect(() => {
    const engine = new GraphEngine(
      hostRef.current!,
      (id) => handlers.current.onHover(id),
      (id) => handlers.current.onSelect(id),
    );
    engineRef.current = engine;
    readyRef.current = engine.init().then(() => {
      if (engineRef.current !== engine || !pulseCanvasRef.current) return; // unmounted while Pixi was starting
      // The pulse reads where thumbnails, anchors and labels are so the ring passes behind them.
      const pulse = new AsciiPulse(pulseCanvasRef.current, asciiInkHex);
      pulseRef.current = pulse;
      engine.onView((points, width, height) => pulse.update(points, width, height));
      // Console hooks for testing the effects: `sightline.shimmer()` / `sightline.pulse()`.
      const report = (started: boolean, name: string) =>
        started ? `${name} started` : `${name} can't run: ${pulse.blockedReason()}`;
      window.sightline = {
        shimmer: () => report(pulse.shimmer(), "shimmer"),
        pulse: () => {
          const c = engine.centerOnScreen();
          return report(pulse.pulse(c.x, c.y), "pulse");
        },
      };
    });
    return () => {
      delete window.sightline;
      engine.onView(null);
      engine.destroy();
      pulseRef.current?.destroy();
      pulseRef.current = null;
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    readyRef.current?.then(() => {
      const engine = engineRef.current;
      if (!engine) return;
      void engine.setImages(images); // adds every node at once; photos stream in afterwards
      if (images.length) onReadyRef.current?.();
    });
  }, [images]);

  useEffect(() => {
    readyRef.current?.then(() => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.applyLayout(layout);
      // The layout also changes while the Separate/Blend slider drags, so key the pulse on the
      // anchor set (it changes exactly when the filter does) and skip the very first layout.
      const key = layout.anchors.map((a) => a.id).join("|");
      if (anchorKeyRef.current !== null && anchorKeyRef.current !== key) {
        const c = engine.centerOnScreen();
        pulseRef.current?.pulse(c.x, c.y);
      }
      anchorKeyRef.current = key;
    });
  }, [layout]);

  useEffect(() => {
    readyRef.current?.then(() => engineRef.current?.setSelected(selectedId));
  }, [selectedId]);

  return (
    // The pulse canvas floats over Pixi's opaque canvas (which Pixi appends here) and multiplies
    // into it: gray glyphs only darken the paper, so lines and thumbnails look exactly as without it.
    // `isolate` keeps the blend inside this box, so it never touches the panels above.
    <div ref={hostRef} className="absolute inset-0 isolate">
      <canvas
        ref={pulseCanvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 h-full w-full opacity-70 mix-blend-multiply"
      />
    </div>
  );
}
