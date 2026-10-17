import { isGlyphFieldSupported, mountGlyphField, type GlyphField } from "asciify-engine/field";

/** Something on the graph the effects must not print over: a thumbnail, an anchor or a label (CSS px). */
export type ViewPoint = { x: number; y: number; r: number };

// Character cell size in CSS px (cells are square: cellAspect 1). The density map uses exactly one
// texel per cell, so every character reads one tone and the dither pattern lands one value per glyph.
const CELL = 13;
const DOWNSAMPLE = CELL;
const CHARSET = " .:-=+*#"; // empty to dense; each step visibly different at small sizes
// Keep-out zone around each item: its own half-size times CLEAR_SCALE, plus CLEAR_PAD CSS px.
const CLEAR_SCALE = 1.3;
const CLEAR_PAD = 18;

// Filter-change ring: how long it takes to cross the screen and fade out.
const RING_MS = 2800;
// Half-width of the ring band, in CSS px.
const RING_HALF_WIDTH = 70;
// Tone at the ring's crest when it starts (0 = blank glyph, 1 = densest); fades as it travels.
const RING_PEAK = 0.55;

// Ambient shimmer: a diagonal wave from the bottom-left corner to the top-right one.
const SHIMMER_MS = 3500;
const SHIMMER_EVERY_MS = 45_000;
// Half-width of the wave band, as a fraction of the corner-to-corner sweep.
const SHIMMER_HALF_WIDTH = 0.17;
const SHIMMER_PEAK = 0.45;
// Characters glint inside the band: how fast (radians per ms) and how deep (0 = steady, 1 = full).
const TWINKLE_SPEED = 0.004;
const TWINKLE_DEPTH = 0.4;

// 8×8 Bayer matrix: ordered-dither thresholds, so smooth tones become even mixes of neighbouring
// glyphs instead of stepped bands (the charset only has a few levels).
const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const DITHER_STEP = 255 / (CHARSET.length - 1); // one glyph level, in 0–255 tone units

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

/**
 * Two short ASCII effects drawn by one GPU glyph field. Between effects the field is blank and idle
 * (it only redraws when its source changes).
 *
 *   ring(x, y)  ── filter change: a soft ring ripples out from the graph's center
 *   shimmer()   ── every 45 s: a twinkling diagonal band sweeps bottom-left → top-right
 *        └─▶ one requestAnimationFrame loop while either runs; each frame paints both (bright =
 *            dense glyphs) on black into a small hidden canvas, then blacks out the area around
 *            every thumbnail, anchor and label so the effects pass behind the graph
 *              └─▶ field.setSource(density) ──▶ glyph field redraws
 *
 * The canvas sits above the (opaque) Pixi canvas with `mix-blend-mode: multiply`, so gray glyphs
 * only darken the paper and never wash out the graph's lines. Without GPU WebGL2, or when the
 * viewer prefers reduced motion, nothing runs.
 */
export class AsciiPulse {
  private field: GlyphField | null = null;
  private density = document.createElement("canvas");
  private ctx = this.density.getContext("2d", { willReadFrequently: true });
  private latest: { points: ViewPoint[]; width: number; height: number } | null = null;
  private ringStart: number | null = null;
  private ringCenter = { x: 0, y: 0 };
  private shimmerStart: number | null = null;
  private phases: Float32Array | null = null; // per-texel twinkle phase, stable across frames
  private raf = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  constructor(canvas: HTMLCanvasElement, ink: string) {
    if (!this.ctx || !isGlyphFieldSupported()) {
      console.info("SightLine: ASCII effects are off (they need hardware-accelerated WebGL2).");
      return;
    }
    this.density.width = 2;
    this.density.height = 2; // starts black: a blank field
    try {
      this.field = mountGlyphField(canvas, {
        source: this.density,
        charset: CHARSET,
        cellSize: CELL,
        cellAspect: 1,
        ink,
        background: "transparent",
        color: "ink",
        shade: 0.7,
        levels: "none", // tones must mean the same thing frame to frame, or the effects flicker
        fit: "cover",
        drift: 0,
        hover: "none",
        respectReducedMotion: true,
        label: "Decorative ASCII effects",
        onError: () => this.destroy(),
      });
    } catch (e) {
      this.field = null; // GPU blocked: the graph works the same without the effects
      console.info("SightLine: ASCII effects are off (WebGL2 failed to start).", e);
      return;
    }
    // Ambient shimmer. Skipped while the tab is hidden, so returning to it doesn't replay a backlog.
    this.interval = setInterval(() => {
      if (document.visibilityState === "visible") this.shimmer();
    }, SHIMMER_EVERY_MS);
  }

  /** Why an effect can't run right now, or null when it can. */
  blockedReason(): string | null {
    if (this.destroyed || !this.field) return "the ASCII field isn't running (no GPU WebGL2?)";
    if (this.reducedMotion?.matches) return "your system has 'reduce motion' turned on";
    return null;
  }

  /** Latest positions of thumbnails, anchors and labels; read by the next animation frame. */
  update(points: ViewPoint[], width: number, height: number) {
    this.latest = { points, width, height };
  }

  /** Starts a ring rippling out from (x, y) in CSS px, restarting one already running. */
  pulse(x: number, y: number): boolean {
    if (this.blockedReason()) return false;
    this.ringCenter = { x, y };
    this.ringStart = performance.now();
    this.run();
    return true;
  }

  /** Starts the diagonal shimmer wave, restarting one already running. */
  shimmer(): boolean {
    if (this.blockedReason()) return false;
    this.shimmerStart = performance.now();
    this.run();
    return true;
  }

  private run() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.field || !this.ctx || this.destroyed) return;
    if (!this.latest) {
      this.raf = requestAnimationFrame(this.frame); // graph hasn't reported its layout yet
      return;
    }
    const ringT = this.ringStart === null ? null : (now - this.ringStart) / RING_MS;
    const shimmerT = this.shimmerStart === null ? null : (now - this.shimmerStart) / SHIMMER_MS;
    if (ringT !== null && ringT >= 1) this.ringStart = null;
    if (shimmerT !== null && shimmerT >= 1) this.shimmerStart = null;
    const active = this.ringStart !== null || this.shimmerStart !== null;
    // Every frame (no skipping): setSource with a canvas resolves at once and the field discards
    // any older pending call, so back-to-back updates are safe and keep the motion smooth.
    this.paint(now, this.ringStart === null ? null : ringT, this.shimmerStart === null ? null : shimmerT);
    this.field.setSource(this.density).catch(() => {});
    if (active) this.raf = requestAnimationFrame(this.frame);
  };

  /** Paints whichever effects are running at their progress (0–1); both null paints a blank map. */
  private paint(now: number, ringT: number | null, shimmerT: number | null) {
    const ctx = this.ctx!;
    const { points, width, height } = this.latest!;
    const w = Math.max(2, Math.ceil(width / DOWNSAMPLE));
    const h = Math.max(2, Math.ceil(height / DOWNSAMPLE));
    if (this.density.width !== w || this.density.height !== h) {
      this.density.width = w;
      this.density.height = h;
      this.phases = null;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (ringT !== null) this.paintRing(ringT, width, height);
    if (shimmerT !== null) this.paintShimmer(now, shimmerT, w, h);
    if (ringT === null && shimmerT === null) return;

    // Keep-out zones: the effects pass behind the graph instead of printing over it.
    ctx.globalCompositeOperation = "source-over";
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
    this.dither(w, h);
  }

  /**
   * Ordered dithering: nudge each lit cell's tone by its Bayer threshold (±half a glyph level) so
   * gradients resolve into fine glyph mixes. Blank cells stay blank, so the paper stays clean.
   */
  private dither(w: number, h: number) {
    const ctx = this.ctx!;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        if (d[i] < 3) continue;
        const threshold = (BAYER_8[(row & 7) * 8 + (col & 7)] + 0.5) / 64 - 0.5;
        const v = Math.max(0, Math.min(255, d[i] + threshold * DITHER_STEP));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** A soft ring from the stored center out to just past the farthest corner, fading as it grows. */
  private paintRing(t: number, width: number, height: number) {
    const ctx = this.ctx!;
    const { x, y } = this.ringCenter;
    const maxR = Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y)) + RING_HALF_WIDTH;
    const radius = easeOutCubic(t) * maxR;
    const tone = Math.round(RING_PEAK * (1 - t) ** 1.2 * 255);
    const inner = Math.max(0, radius - RING_HALF_WIDTH) / DOWNSAMPLE;
    const outer = (radius + RING_HALF_WIDTH) / DOWNSAMPLE;
    const g = ctx.createRadialGradient(x / DOWNSAMPLE, y / DOWNSAMPLE, inner, x / DOWNSAMPLE, y / DOWNSAMPLE, outer);
    g.addColorStop(0, "rgb(0,0,0)");
    g.addColorStop(0.5, `rgb(${tone},${tone},${tone})`);
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.globalCompositeOperation = "lighter"; // adds onto black, and onto the shimmer if both run
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.density.width, this.density.height); // pads with black outside the band
  }

  /**
   * A diagonal band from bottom-left to top-right. Each texel's tone is the band's profile times its
   * own slow sine twinkle (a fixed random phase per texel), so characters glint independently.
   */
  private paintShimmer(now: number, t: number, w: number, h: number) {
    const ctx = this.ctx!;
    if (!this.phases || this.phases.length !== w * h) {
      this.phases = new Float32Array(w * h);
      for (let i = 0; i < this.phases.length; i++) this.phases[i] = Math.random() * Math.PI * 2;
    }
    const phases = this.phases;
    // Band center travels from just before the bottom-left corner to just past the top-right one.
    const center = -SHIMMER_HALF_WIDTH + easeInOutSine(t) * (1 + 2 * SHIMMER_HALF_WIDTH);
    const envelope = Math.min(1, t * 6, (1 - t) * 6); // soft start and finish
    const span = w + h - 2 || 1;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const s = (col + (h - 1 - row)) / span; // 0 at bottom-left, 1 at top-right
        const off = (s - center) / SHIMMER_HALF_WIDTH;
        if (off < -2.4 || off > 2.4) continue; // outside the band: stays as is
        const k = row * w + col;
        const twinkle = 1 - TWINKLE_DEPTH * (0.5 + 0.5 * Math.sin(phases[k] + now * TWINKLE_SPEED));
        const tone = SHIMMER_PEAK * Math.exp(-off * off * 1.6) * twinkle * envelope * 255;
        const i = k * 4;
        const v = Math.min(255, d[i] + tone);
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.interval) clearInterval(this.interval);
    this.raf = 0;
    this.interval = null;
    this.field?.destroy();
    this.field = null;
  }
}
