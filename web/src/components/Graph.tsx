"use client";

import { useEffect, useRef } from "react";
import type { ImageNode } from "@/lib/data";
import { GraphEngine, type GraphLayout } from "@/lib/graph-engine";

type Props = {
  images: ImageNode[];
  layout: GraphLayout;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
};

export default function Graph({ images, layout, selectedId, onHover, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const handlers = useRef({ onHover, onSelect });
  handlers.current = { onHover, onSelect };

  useEffect(() => {
    const engine = new GraphEngine(
      hostRef.current!,
      (id) => handlers.current.onHover(id),
      (id) => handlers.current.onSelect(id),
    );
    engineRef.current = engine;
    readyRef.current = engine.init();
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    readyRef.current?.then(() => engineRef.current?.setImages(images));
  }, [images]);

  useEffect(() => {
    readyRef.current?.then(() => engineRef.current?.applyLayout(layout));
  }, [layout]);

  useEffect(() => {
    readyRef.current?.then(() => engineRef.current?.setSelected(selectedId));
  }, [selectedId]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
