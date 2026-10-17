import { isGlyphFieldSupported, mountGlyphField, type GlyphField } from "asciify-engine/field";

/** Something on the graph the pulse must not print over: a thumbnail, an anchor or a label (CSS px). */
export type ViewPoint = { x: number; y: number; r: number };

// Density map resolution: one texel per DOWNSAMPLE CSS pixels. The field samples it per cell,
// so it only needs to be about as fine as the character grid.
const DOWNSAMPLE = 8;
// How long one ripple takes to cross the screen and fade out.
const DURATION_MS = 2800;
// Half-width of the ring band, in CSS px.
const RING_HALF_WIDTH = 70;
// Tone at the ring's crest when it starts (0 = blank glyph, 1 = densest); fades to 0 as it travels.
const PEAK = 0.55;
// Keep-out zone around each item: its own half-size times CLEAR_SCALE, plus CLEAR_PAD CSS px.
const CLEAR_SCALE = 1.3;
const CLEAR_PAD = 18;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * A ring of ASCII characters that ripples out from the graph when the filter changes.
 * Between pulses the field is blank and idle (it only redraws when its source changes).
 *
 *   pulse(x, y) ──▶ requestAnimationFrame loop for DURATION_MS
 *        └─▶ each frame: paint a soft bright ring (bright = dense glyphs) on black into a small
 *            hidden canvas at radius easeOut(t)·maxR, fading as it grows, then black out the
 *            area around every thumbnail, anchor and label so the ring passes behind the graph
 *              └─▶ field.setSource(density) ──▶ GPU glyph field draws the ripple
 *
 * The canvas sits above the (opaque) Pixi canvas with `mix-blend-mode: multiply`, so gray glyphs
 * only darken the paper and never wash out the graph's lines. Without GPU WebGL2, or when the
 * viewer prefers reduced motion, it does nothing.
 */
export class AsciiPulse {
  private field: GlyphField | null = null;
  private density = document.createElement("canvas");
  private ctx = this.density.getContext("2d");
  private latest: { points: ViewPoint[]; width: number; height: number } | null = null;
  private pulseStart = 0;
  private center = { x: 0, y: 0 };
  private raf = 0;
  private uploading = false;
  private destroyed = false;
  private reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  constructor(canvas: HTMLCanvasElement, ink: string) {
    if (!this.ctx || !isGlyphFieldSupported()) {
      console.info("SightLine: ASCII pulse is off (it needs hardware-accelerated WebGL2).");
      return;
    }
    this.density.width = 2;
    this.density.height = 2; // starts black: a blank field
    try {
      this.field = mountGlyphField(canvas, {
        source: this.density,
        charset: " .:-=+*#", // each step visibly different at small sizes
        cellSize: 13,
        ink,
        background: "transparent",
        color: "ink",
        shade: 0.7,
        levels: "none", // tones must mean the same thing frame to frame, or the ring flickers
        fit: "cover",
        drift: 0,
        hover: "none",
        respectReducedMotion: true,
        label: "Decorative ASCII pulse",
        onError: () => this.destroy(),
      });
    } catch (e) {
      this.field = null; // GPU blocked: the graph works the same without the effect
      console.info("SightLine: ASCII pulse is off (WebGL2 failed to start).", e);
    }
  }

  /** Latest positions of thumbnails, anchors and labels; read by the next animation frame. */
  update(points: ViewPoint[], width: number, height: number) {
    this.latest = { points, width, height };
  }

  /** Starts a ripple from (x, y) in CSS px, restarting any ripple already running. */
  pulse(x: number, y: number) {
    if (!this.field || this.destroyed || this.reducedMotion?.matches) return;
    this.center = { x, y };
    this.pulseStart = performance.now();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.field || !this.ctx || !this.latest || this.destroyed) return;
    const t = (now - this.pulseStart) / DURATION_MS;
    const done = t >= 1;
    // Skip a frame while the previous texture upload is in flight, except the final blank one.
    if (!this.uploading || done) {
      this.paint(done ? null : t);
      this.uploading = true;
      this.field
        .setSource(this.density)
        .catch(() => {})
        .finally(() => {
          this.uploading = false;
        });
    }
    if (!done) this.raf = requestAnimationFrame(this.frame);
  };

  /** Paints the ring at progress `t` (0–1), or an all-black (blank) map when `t` is null. */
  private paint(t: number | null) {
    const ctx = this.ctx!;
    const { points, width, height } = this.latest!;
    const w = Math.max(2, Math.ceil(width / DOWNSAMPLE));
    const h = Math.max(2, Math.ceil(height / DOWNSAMPLE));
    if (this.density.width !== w || this.density.height !== h) {
      this.density.width = w;
      this.density.height = h;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (t === null) return;

    // The ring travels from the center to just past the farthest screen corner.
    const { x, y } = this.center;
    const maxR = Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y)) + RING_HALF_WIDTH;
    const radius = easeOutCubic(t) * maxR;
    const tone = Math.round(PEAK * (1 - t) ** 1.2 * 255);
    const cx = x / DOWNSAMPLE;
    const cy = y / DOWNSAMPLE;
    const inner = Math.max(0, radius - RING_HALF_WIDTH) / DOWNSAMPLE;
    const outer = (radius + RING_HALF_WIDTH) / DOWNSAMPLE;
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, "rgb(0,0,0)");
    g.addColorStop(0.5, `rgb(${tone},${tone},${tone})`);
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h); // the gradient pads with black outside the band

    // Keep-out zones: the ring passes behind the graph instead of printing over it.
    for (const p of points) {
      const px = p.x / DOWNSAMPLE;
      const py = p.y / DOWNSAMPLE;
      const r = Math.max(2, (p.r * CLEAR_SCALE + CLEAR_PAD) / DOWNSAMPLE);
      if (px < -r || py < -r || px > w + r || py > h + r) continue; // off screen
      const z = ctx.createRadialGradient(px, py, 0, px, py, r);
      z.addColorStop(0, "rgba(0,0,0,1)");
      z.addColorStop(0.7, "rgba(0,0,0,1)");
      z.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = z;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.field?.destroy();
    this.field = null;
  }
}
