"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CARD } from "@/lib/ui";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; added: number; skipped: number; failed: number; perFile: string[] }
  | { kind: "error"; title: string; detail?: string };

/** Dragging files anywhere over the window dims the whole app until they are dropped or taken away. */
export default function DropUpload({ onIngested }: { onIngested: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // dragenter/dragleave fire for every element crossed, so count them instead of toggling.
  const depth = useRef(0);

  const send = useCallback(
    async (files: File[]) => {
      setStatus({ kind: "working" });
      const body = new FormData();
      for (const file of files) body.append("files", file);
      try {
        const res = await fetch("/api/ingest", { method: "POST", body });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
          setStatus({
            kind: "error",
            title: json?.title ?? `Upload failed (${res.status})`,
            detail: json?.detail,
          });
          return;
        }
        setStatus({ kind: "done", added: json.added, skipped: json.skipped, failed: json.failed, perFile: json.perFile ?? [] });
        if (json.added > 0) onIngested();
      } catch (e) {
        setStatus({
          kind: "error",
          title: "Couldn't reach the local pipeline",
          detail: `${e}. Is \`npm run dev\` still running?`,
        });
      }
    },
    [onIngested],
  );

  useEffect(() => {
    // Only react to files: dragging text or a graph thumbnail should not dim the app.
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    // Both of these must preventDefault, or the browser opens the file instead of dropping it here.
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void send(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [send]);

  return (
    <>
      {dragging && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-canvas/85 backdrop-blur-sm">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="h-20 w-20 text-accent"
          >
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <p className="font-label text-[11px] uppercase tracking-[0.14em] text-muted">Drop to add references</p>
        </div>
      )}

      {status.kind !== "idle" && (
        <div
          role="status"
          className={`pointer-events-auto absolute left-1/2 top-4 z-40 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 ${CARD} px-4 py-3 text-xs`}
        >
          {status.kind === "working" && (
            <p className="text-muted">
              <span className="font-medium text-fg">Scoring…</span> the pipeline loads SigLIP 2 and DINOv2 first, so this
              takes a moment — and several minutes the very first time, while the models download.
            </p>
          )}

          {status.kind === "done" && (
            <div className="flex items-start gap-3">
              <p className="flex-1 text-muted">
                <span className="font-medium text-fg">
                  {status.added > 0 ? `Added ${status.added}` : "Nothing new to add"}
                </span>
                {status.skipped > 0 && ` · ${status.skipped} already in the collection`}
                {status.failed > 0 && ` · ${status.failed} failed`}
                {status.perFile.length > 0 && (
                  <span className="mt-1 block text-accent">{status.perFile.join(" · ")}</span>
                )}
              </p>
              <Dismiss onClick={() => setStatus({ kind: "idle" })} />
            </div>
          )}

          {status.kind === "error" && (
            <div className="flex items-start gap-3">
              <p className="flex-1 text-muted">
                <span className="font-medium text-accent">{status.title}</span>
                {status.detail && <span className="mt-1 block whitespace-pre-wrap font-mono text-[11px]">{status.detail}</span>}
              </p>
              <Dismiss onClick={() => setStatus({ kind: "idle" })} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="Dismiss" className="shrink-0 text-muted hover:text-fg">
      ✕
    </button>
  );
}
