import { Application, Assets, Container, Graphics, NineSliceSprite, Sprite, Text, Texture } from "pixi.js";
import { forceCollide, forceSimulation, forceX, forceY, type ForceCollide, type Simulation, type SimulationNodeDatum } from "d3-force";
import type { ImageNode } from "./data";
import type { ViewPoint } from "./ascii-pulse";
import { RING_RADIUS, type Anchor, type Target } from "./layout";
import { anchorColor, canvasHex, theme } from "./theme";

const THUMB = 64;
// Drop shadow: one blurred shape is drawn to a canvas once and shared by every thumbnail as a
// nine-slice sprite, so the blur is paid for a single time instead of once per sprite per frame.
const SHADOW_PAD = 10;    // how far the shadow reaches past the thumbnail, in px
const SHADOW_BLUR = 6;    // softness of the edge when the texture is drawn
const SHADOW_RADIUS = 3;  // corner radius of the shape inside the texture
const SHADOW_SLICE = SHADOW_PAD + 8; // nine-slice inset: the corner block that must not stretch
const SHADOW_ALPHA = 0.18;
const SHADOW_OFFSET = 2.5; // nudged down-right, as the old blurred Graphics was
// Skeleton tiles: a warm gray a step darker than the paper, gently pulsing until the photo loads.
const SKELETON_TINT = 0xdedbd2;
const SKELETON_PULSE_SPEED = 0.004; // radians per ms (~1.6 s per breath)
const THUMB_FADE_MS = 280;
const ACTIVE_SCALE = 1.7;
const COLLISION_RADIUS = THUMB * 0.56;

type Node = SimulationNodeDatum & {
  id: string;
  tx: number;
  ty: number;
  weights: number[];
  scale: number;
  targetScale: number;
  frameColorProgress: number;
};
type Link = { source: string | Node; target: string | Node };

export type GraphLayout = { anchors: Anchor[]; targets: Map<string, Target>; links: [string, string][]; ring: boolean; showLinks: boolean };

/** Imperative PixiJS + d3-force scene. React owns the UI around it; this owns the canvas. */
export class GraphEngine {
  private app = new Application();
  private world = new Container();
  private edgeLayer = new Graphics();
  private anchorLayer = new Container();
  private nodeLayer = new Container();
  private labelLayer = new Container();
  private overlayLayer = new Container();
  private sprites = new Map<string, Container>();
  private shadowTexture: Texture | null = null;
  private pending = new Set<string>();
  // Skeleton tiles still waiting for their thumbnail (value: pulse phase) and photos fading in.
  private skeletons = new Map<Sprite, number>();
  private fading = new Map<Sprite, number>();
  private skeletonTicking = false;
  private reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private nodes = new Map<string, Node>();
  private sim: Simulation<Node, Link> | null = null;
  private collide: ForceCollide<Node> | null = null;
  private layout: GraphLayout = { anchors: [], targets: new Map(), links: [], ring: false, showLinks: false };
  private selected: string | null = null;
  private hovered: string | null = null;
  private autoPanTarget: { x: number; y: number } | null = null;
  private cameraTransition: {
    startX: number;
    startY: number;
    startScale: number;
    targetX: number;
    targetY: number;
    targetScale: number;
    startTime: number;
    duration: number;
  } | null = null;
  private layoutTransition = false;
  private destroyed = false;
  private dragMoved = false;
  private viewListener: ((points: ViewPoint[], width: number, height: number) => void) | null = null;
  private ready = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private el: HTMLElement,
    private onHover: (id: string | null) => void,
    private onSelect: (id: string | null) => void,
  ) {}

  async init() {
    await this.app.init({
      resizeTo: this.el,
      // Opaque on purpose: a transparent canvas changes how the faint neighbour lines blend.
      // The ASCII texture sits on top instead (see Graph.tsx).
      background: canvasHex,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.el.appendChild(this.app.canvas);
    // labelLayer last: anchor names stay readable over thumbnails that drift onto them.
    this.world.addChild(this.edgeLayer, this.anchorLayer, this.nodeLayer, this.labelLayer, this.overlayLayer);
    this.app.stage.addChild(this.world);
    this.fit();
    this.enablePanZoom();
    this.app.ticker.add(this.advanceAutoPan);
    this.app.ticker.add(this.advanceCameraTransition);
    this.cleanup.push(() => {
      this.app.ticker.remove(this.advanceAutoPan);
      this.app.ticker.remove(this.advanceCameraTransition);
    });
    this.ready = true;
  }

  /** Fit the ring into the space right of the filter panel (full width on narrow screens). */
  private fit(smooth = false) {
    const { width, height } = this.app.screen;
    const inset = width >= 760 ? 380 : 0;
    const usable = width - inset;
    const targetScale = Math.min(usable, height) / (RING_RADIUS * 2 + 340);
    const targetX = inset + usable / 2;
    const targetY = height / 2;

    if (!smooth) {
      this.cameraTransition = null;
      this.autoPanTarget = null;
      this.world.scale.set(targetScale);
      this.world.position.set(targetX, targetY);
      return;
    }

    this.autoPanTarget = null;
    this.cameraTransition = {
      startX: this.world.x,
      startY: this.world.y,
      startScale: this.world.scale.x,
      targetX,
      targetY,
      targetScale,
      startTime: performance.now(),
      duration: 420,
    };
  }

  private enablePanZoom() {
    const canvas = this.app.canvas;
    canvas.style.cursor = "grab";

    const onWheel = (e: WheelEvent) => {
      this.cameraTransition = null;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const before = { x: (px - this.world.x) / this.world.scale.x, y: (py - this.world.y) / this.world.scale.y };
      const { width, height } = this.app.screen;
      const usable = width - (width >= 760 ? 380 : 0);
      const minScale = (Math.min(usable, height) * (2 / 3)) / (RING_RADIUS * 2 + 340);
      const s = Math.min(4, Math.max(minScale, this.world.scale.x * Math.exp(-e.deltaY * 0.0015)));
      this.world.scale.set(s);
      this.world.position.set(px - before.x * s, py - before.y * s);
      this.beginAutoPanToCluster();
      this.emitView();
    };
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    const onDown = (e: PointerEvent) => {
      this.cameraTransition = null;
      this.autoPanTarget = null;
      drag = { x: e.clientX, y: e.clientY, wx: this.world.x, wy: this.world.y };
      this.dragMoved = false;
      canvas.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
        const position = this.applyRubberBandPan(drag.wx + dx, drag.wy + dy);
        this.world.position.set(position.x, position.y);
        this.emitView();
        return;
      }

      // Fast cursor sweep protection: verify pointer is still within the hovered node's boundary
      if (this.hovered) {
        const rect = canvas.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          this.setHover(null);
          return;
        }

        const node = this.nodes.get(this.hovered);
        if (node && node.x != null && node.y != null) {
          const s = this.world.scale.x;
          const screenX = rect.left + this.world.x + node.x * s;
          const screenY = rect.top + this.world.y + node.y * s;
          const bounds = this.thumbnailScreenBounds(node, s);
          // 1.5x margin gives a slight buffer for micro-jitters, but fast exits clear immediately
          if (
            Math.abs(e.clientX - screenX) > bounds.x * 1.5 ||
            Math.abs(e.clientY - screenY) > bounds.y * 1.5
          ) {
            this.setHover(null);
          }
        }
      }
    };
    const onUp = () => {
      drag = null;
      canvas.style.cursor = "grab";
      this.beginAutoPanToCluster();
    };
    const onCanvasLeave = () => {
      if (!drag) {
        this.setHover(null);
      }
    };
    const onDblClick = () => {
      this.fit(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "f" || e.key === "F" || e.key === "0") {
        this.fit(true);
      }
    };
    // Taps on empty canvas clear the selection; Pixi only targets the stage when no thumbnail was hit.
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointertap", (e) => {
      if (e.target === this.app.stage && !this.dragMoved) this.onSelect(null);
    });
    this.app.stage.on("pointermove", (e) => {
      if (e.target === this.app.stage && this.hovered) {
        this.setHover(null);
      }
    });
    this.app.stage.on("pointerover", (e) => {
      if (e.target === this.app.stage && this.hovered) {
        this.setHover(null);
      }
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerleave", onCanvasLeave);
    canvas.addEventListener("dblclick", onDblClick);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    const onResize = () => {
      this.fit();
      this.emitView();
    };
    this.app.renderer.on("resize", onResize);
    this.cleanup.push(() => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerleave", onCanvasLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    });
  }

  /**
   * Calculate camera limits so that at least a couple of images remain visible
   * along the viewport edges when panning. Scales dynamically with zoom level.
   */
  private getClusterPanLimits() {
    const { width, height } = this.app.screen;
    const zoom = this.world.scale.x;
    const inset = width >= 760 ? 380 : 0;
    const usable = width - inset;

    const fitScale = Math.min(usable, height) / (RING_RADIUS * 2 + 340);
    const zoomRatio = Math.max(0.6, zoom / (fitScale || 1));

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let hasNodes = false;

    for (const node of this.nodes.values()) {
      if (node.x == null || node.y == null) continue;
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
      hasNodes = true;
    }

    if (!hasNodes) {
      minX = -RING_RADIUS;
      maxX = RING_RADIUS;
      minY = -RING_RADIUS;
      maxY = RING_RADIUS;
    }

    // When zoomed in, the physical size of thumbnails is larger (THUMB * zoom).
    // Dynamically scale edgeMargin so a rich view of images is ALWAYS visible
    // and the camera stays attracted to the image network:
    const thumbScreenSize = THUMB * zoom;
    const baseMarginX = Math.max(260, thumbScreenSize * 2.2);
    const baseMarginY = Math.max(220, thumbScreenSize * 1.9);

    const edgeMarginX = Math.min(usable * 0.45, baseMarginX);
    const edgeMarginY = Math.min(height * 0.45, baseMarginY);

    const minWorldX = inset + edgeMarginX - maxX * zoom;
    const maxWorldX = width - edgeMarginX - minX * zoom;
    const minWorldY = edgeMarginY - maxY * zoom;
    const maxWorldY = height - edgeMarginY - minY * zoom;

    return {
      minWorldX: Math.min(minWorldX, maxWorldX),
      maxWorldX: Math.max(minWorldX, maxWorldX),
      minWorldY: Math.min(minWorldY, maxWorldY),
      maxWorldY: Math.max(minWorldY, maxWorldY),
      zoomRatio,
    };
  }

  /**
   * Smooth rubber-band damping when pulling far into empty space.
   * Damping increases with zoom level so the image system feels strongly tethered.
   */
  private applyRubberBandPan(rawX: number, rawY: number) {
    const limits = this.getClusterPanLimits();
    let x = rawX;
    let y = rawY;

    // As zoom level rises, increase the magnetic drag resistance so the user
    // physically feels the tension keeping them anchored to the images:
    const damping = Math.max(0.24, 0.55 - Math.max(0, limits.zoomRatio - 1) * 0.12);

    if (x < limits.minWorldX) {
      const overflow = limits.minWorldX - x;
      x = limits.minWorldX - overflow * damping;
    } else if (x > limits.maxWorldX) {
      const overflow = x - limits.maxWorldX;
      x = limits.maxWorldX + overflow * damping;
    }

    if (y < limits.minWorldY) {
      const overflow = limits.minWorldY - y;
      y = limits.minWorldY - overflow * damping;
    } else if (y > limits.maxWorldY) {
      const overflow = y - limits.maxWorldY;
      y = limits.maxWorldY + overflow * damping;
    }

    return { x, y };
  }

  /**
   * When dragging ends or zoom completes, if the camera was pulled away into empty space,
   * initiate a soft magnetic pull back so at least a couple of images remain visible.
   */
  private beginAutoPanToCluster() {
    const limits = this.getClusterPanLimits();
    const currentX = this.world.x;
    const currentY = this.world.y;

    let targetX = currentX;
    let targetY = currentY;

    if (currentX < limits.minWorldX) {
      targetX = limits.minWorldX;
    } else if (currentX > limits.maxWorldX) {
      targetX = limits.maxWorldX;
    }

    if (currentY < limits.minWorldY) {
      targetY = limits.minWorldY;
    } else if (currentY > limits.maxWorldY) {
      targetY = limits.maxWorldY;
    }

    if (Math.abs(targetX - currentX) > 1 || Math.abs(targetY - currentY) > 1) {
      this.autoPanTarget = { x: targetX, y: targetY };
    } else {
      this.autoPanTarget = null;
    }
  }

  /** Slowly and smoothly ease toward the target camera position near the mind map. */
  private advanceAutoPan = () => {
    if (this.cameraTransition) return;
    const target = this.autoPanTarget;
    if (!target) return;
    const dx = target.x - this.world.x;
    const dy = target.y - this.world.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.5) {
      this.world.position.set(target.x, target.y);
      this.autoPanTarget = null;
      this.emitView();
      return;
    }

    const { width, height } = this.app.screen;
    const inset = width >= 760 ? 380 : 0;
    const usable = width - inset;
    const fitScale = Math.min(usable, height) / (RING_RADIUS * 2 + 340);
    const zoomRatio = Math.max(0.6, this.world.scale.x / (fitScale || 1));

    // When really zoomed in, the magnetic pull becomes noticeably stronger and snappier
    // to keep the viewer locked onto the image system:
    const zoomBoost = Math.min(2.2, 1 + Math.max(0, zoomRatio - 1) * 0.55);
    const speed = Math.min(0.16, 0.085 * zoomBoost);
    const maxStep = Math.min(58, 36 * zoomBoost);

    const step = Math.min(maxStep, Math.max(0.4, distance * speed));
    this.world.position.set(this.world.x + (dx / distance) * step, this.world.y + (dy / distance) * step);
    this.emitView();
  };

  /** Smoothly glide camera position and zoom to the target fit state. */
  private advanceCameraTransition = () => {
    const anim = this.cameraTransition;
    if (!anim) return;
    const elapsed = performance.now() - anim.startTime;
    const t = Math.min(1, Math.max(0, elapsed / anim.duration));
    // Quartic ease-out: brisk start that gently cushions to a stop
    const ease = 1 - Math.pow(1 - t, 4);

    const currentX = anim.startX + (anim.targetX - anim.startX) * ease;
    const currentY = anim.startY + (anim.targetY - anim.startY) * ease;
    const currentScale = anim.startScale + (anim.targetScale - anim.startScale) * ease;

    this.world.scale.set(currentScale);
    this.world.position.set(currentX, currentY);
    this.emitView();

    if (t >= 1) {
      this.cameraTransition = null;
    }
  };

  /**
   * The shared shadow, drawn once into a canvas. White so `tint` can colour it, and soft-edged
   * via the 2D context's own shadow, which every browser supports.
   */
  private ensureShadowTexture(): Texture | null {
    if (this.shadowTexture) return this.shadowTexture;
    const size = THUMB + SHADOW_PAD * 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "#fff";
    ctx.shadowBlur = SHADOW_BLUR;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(SHADOW_PAD, SHADOW_PAD, THUMB, THUMB, SHADOW_RADIUS);
    else ctx.rect(SHADOW_PAD, SHADOW_PAD, THUMB, THUMB);
    ctx.fill();
    this.shadowTexture = Texture.from(canvas);
    return this.shadowTexture;
  }

  private thumbnailScreenBounds(node: Node, zoom: number) {
    const container = this.sprites.get(node.id);
    const sprite = container?.children[2] as Sprite | undefined;
    const pad = node.id === this.selected ? 3 : node.id === this.hovered ? 2 : 0.5;
    return {
      x: ((sprite?.width ?? THUMB) / 2 + pad) * node.scale * zoom,
      y: ((sprite?.height ?? THUMB) / 2 + pad) * node.scale * zoom,
    };
  }

  /** Add any images not yet on the canvas (initial load or new uploads). */
  async setImages(images: ImageNode[]) {
    if (!this.ready) return;
    // Claim ids synchronously so overlapping calls (React effects, realtime) never double-add.
    const fresh = images.filter((img) => !this.sprites.has(img.id) && !this.pending.has(img.id));
    fresh.forEach((img) => this.pending.add(img.id));
    // Every node goes on screen right away as a skeleton (a pulsing gray tile at the image's real
    // aspect ratio), so the layout settles at once; each photo then fades in over its skeleton
    // when its thumbnail arrives. No tile changes size when that happens, so nothing jumps.
    for (const img of fresh) {
      if (this.destroyed) return;
      const c = new Container();
      const sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0.5);
      const aspect = img.width && img.height ? img.width / img.height : 1;
      sprite.width = aspect >= 1 ? THUMB : THUMB * aspect;
      sprite.height = aspect >= 1 ? THUMB / aspect : THUMB;
      sprite.tint = SKELETON_TINT;
      const shadowTexture = this.ensureShadowTexture();
      const shadow = new NineSliceSprite({
        texture: shadowTexture ?? Texture.EMPTY,
        // Corners keep their shape; only the flat middle stretches to the thumbnail's size.
        leftWidth: SHADOW_SLICE,
        rightWidth: SHADOW_SLICE,
        topHeight: SHADOW_SLICE,
        bottomHeight: SHADOW_SLICE,
      });
      shadow.tint = theme.fg;
      shadow.alpha = SHADOW_ALPHA;
      const frame = new Graphics();
      c.addChild(shadow, frame, sprite);
      c.label = img.id;
      c.eventMode = "static";
      c.cursor = "pointer";
      c.on("pointerover", () => this.setHover(img.id));
      c.on("pointerout", () => this.setHover(null));
      c.on("pointertap", () => {
        if (!this.dragMoved) this.onSelect(img.id);
      });
      this.nodeLayer.addChild(c);
      this.sprites.set(img.id, c);
      this.pending.delete(img.id);
      // New images fly in from the center.
      this.nodes.set(img.id, {
        id: img.id,
        x: (Math.random() - 0.5) * 40,
        y: (Math.random() - 0.5) * 40,
        tx: 0,
        ty: 0,
        weights: [],
        scale: 1,
        targetScale: 1,
        frameColorProgress: 0,
      });
      this.drawFrame(img.id);
      this.skeletons.set(sprite, Math.random() * Math.PI * 2); // own phase, so tiles don't pulse in lockstep
      void this.loadThumbnail(img, sprite);
    }
    this.ensureSkeletonTicker();
    this.applyLayout(this.layout, 0.9);
  }

  /** Swaps a skeleton for its thumbnail once loaded, fading the photo in at the same size. */
  private async loadThumbnail(img: ImageNode, sprite: Sprite) {
    let tex: Texture | null = null;
    try {
      tex = await Assets.load<Texture>({ src: img.thumbUrl, parser: "loadTextures" });
    } catch {
      tex = null; // keep a calm gray tile rather than a stark white box
    }
    if (this.destroyed || sprite.destroyed) return;
    this.skeletons.delete(sprite);
    if (!tex) {
      sprite.alpha = 1;
      this.ensureSkeletonTicker();
      return;
    }
    const w = sprite.width; // keep the skeleton's footprint so neighbours and frames don't shift
    const h = sprite.height;
    sprite.texture = tex;
    sprite.tint = 0xffffff;
    sprite.width = w;
    sprite.height = h;
    sprite.alpha = 0;
    this.fading.set(sprite, performance.now());
    this.ensureSkeletonTicker();
  }

  /** Pulses skeleton tiles and fades in loaded photos; runs only while either is happening. */
  private skeletonTick = () => {
    const now = performance.now();
    for (const [sprite, phase] of this.skeletons) {
      if (sprite.destroyed) this.skeletons.delete(sprite);
      else sprite.alpha = this.reducedMotion ? 0.8 : 0.7 + 0.3 * Math.sin(now * SKELETON_PULSE_SPEED + phase);
    }
    for (const [sprite, start] of this.fading) {
      const t = Math.min(1, (now - start) / THUMB_FADE_MS);
      if (sprite.destroyed || t >= 1) {
        if (!sprite.destroyed) sprite.alpha = 1;
        this.fading.delete(sprite);
      } else {
        sprite.alpha = t * t * (3 - 2 * t); // smoothstep
      }
    }
    this.ensureSkeletonTicker();
  };

  private ensureSkeletonTicker() {
    const busy = this.skeletons.size > 0 || this.fading.size > 0;
    if (busy && !this.skeletonTicking) {
      this.app.ticker.add(this.skeletonTick);
      this.skeletonTicking = true;
    } else if (!busy && this.skeletonTicking) {
      this.app.ticker.remove(this.skeletonTick);
      this.skeletonTicking = false;
    }
  }

  applyLayout(layout: GraphLayout, alpha = 0.8) {
    this.layout = layout;
    if (!this.ready) return;
    // A filter represents a new layout context, not a continuation of the
    // pointer interaction. Release the hovered node before it can be pinned
    // into the transition.
    this.clearHover();
    // A selected image remains selected, but must travel when the filter changes.
    this.layoutTransition = true;
    for (const node of this.nodes.values()) {
      const t = layout.targets.get(node.id);
      node.tx = t?.x ?? 0;
      node.ty = t?.y ?? 0;
      node.weights = t?.weights ?? [];
      node.fx = undefined;
      node.fy = undefined;
    }
    this.drawAnchors();
    const nodes = [...this.nodes.values()];
    // Resolve to live nodes here: the simulation no longer runs forceLink, which used to be
    // what swapped these ids for node objects, and tick() reads .x/.y straight off them.
    const links: Link[] = layout.links
      .filter(([a, b]) => this.nodes.has(a) && this.nodes.has(b))
      .map(([source, target]) => ({ source: this.nodes.get(source)!, target: this.nodes.get(target)! }));
    this.sim?.stop();
    const collide = forceCollide<Node>()
      .radius((d) => COLLISION_RADIUS * d.scale)
      .strength(0.8)
      .iterations(1);
    this.collide = collide;
    this.sim = forceSimulation<Node, Link>(nodes)
      .force("x", forceX<Node>((d) => d.tx).strength(0.09))
      .force("y", forceY<Node>((d) => d.ty).strength(0.09))
      .force("collide", collide)
      .alpha(alpha)
      .alphaDecay(0.02)
      .velocityDecay(0.5)
      .on("tick", () => this.tick(links));
    this.updateInteraction();
  }

  private tick(links: Link[]) {
    let resized = false;
    for (const node of this.nodes.values()) {
      const delta = node.targetScale - node.scale;
      if (Math.abs(delta) > 0.001) {
        node.scale += delta * 0.05;
        resized = true;
      } else {
        node.scale = node.targetScale;
      }
      const colorTarget = node.id === this.selected ? 1 : 0;
      const colorDelta = colorTarget - node.frameColorProgress;
      node.frameColorProgress = Math.abs(colorDelta) > 0.001
        ? node.frameColorProgress + colorDelta * 0.12
        : colorTarget;
    }
    // A hovered neighbor yields only once its growing frame reaches a pinned
    // thumbnail. Moving it in tiny steps keeps the selected image anchored and
    // avoids the old one-frame clearance jump.
    this.resolveHoveredPinnedContact();
    for (const node of this.nodes.values()) {
      const container = this.sprites.get(node.id);
      container?.position.set(node.x ?? 0, node.y ?? 0);
      container?.scale.set(node.scale);
      if (node.id === this.hovered || node.id === this.selected) this.drawFrame(node.id);
    }
    // d3 caches collision radii, so refresh them while thumbnails animate their size.
    if (resized) this.collide?.radius((d) => COLLISION_RADIUS * d.scale);
    if (this.layoutTransition && (this.sim?.alpha() ?? 1) < 0.04) {
      this.layoutTransition = false;
      this.lockActiveNodes();
    }
    const g = this.edgeLayer;
    g.clear();
    // Neighbor web: faint curves between images with similar scores. Unfiltered view only -
    // with a category picked the anchor threads carry the story and these just add noise.
    if (this.layout.showLinks) {
      for (const l of links) {
        const a = l.source as Node;
        const b = l.target as Node;
        if (a.x == null || b.x == null) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y! + b.y!) / 2;
        g.moveTo(a.x, a.y!).quadraticCurveTo(mx * 0.9, my * 0.9, b.x, b.y!);
      }
      g.stroke({ width: 1, color: theme.muted, alpha: 0.28 });
    }
    // Anchor threads: accent curves from each anchor to images that strongly have that quality.
    const { anchors } = this.layout;
    anchors.forEach((anchor, i) => {
      for (const node of this.nodes.values()) {
        const w = node.weights[i] ?? 0;
        if (w < 0.4 || node.x == null) continue;
        g.moveTo(anchor.x, anchor.y).quadraticCurveTo((anchor.x + node.x) * 0.35, (anchor.y + node.y!) * 0.35, node.x, node.y!);
        g.stroke({ width: 1.2, color: anchorColor(i), alpha: Math.min(0.7, 0.15 + (w - 0.4) * 1.4) });
      }
    });
    this.emitView();
  }

  /** Where thumbnails, anchors and labels sit on screen right now (CSS px), for effects drawn around the graph. */
  onView(listener: ((points: ViewPoint[], width: number, height: number) => void) | null) {
    this.viewListener = listener;
    this.emitView();
  }

  private emitView() {
    if (!this.viewListener || !this.ready) return;
    const s = this.world.scale.x;
    const toScreen = (x: number, y: number, r: number): ViewPoint => ({ x: this.world.x + x * s, y: this.world.y + y * s, r: r * s });
    const points: ViewPoint[] = [];
    for (const node of this.nodes.values()) {
      if (node.x == null || node.y == null) continue;
      points.push(toScreen(node.x, node.y, (THUMB / 2) * node.scale));
    }
    // Subclass anchors and their name labels get open space too.
    for (const a of this.layout.anchors) points.push(toScreen(a.x, a.y, 14));
    for (const label of this.labelLayer.children) points.push(toScreen(label.x, label.y, label.width / 2));
    this.viewListener(points, this.app.screen.width, this.app.screen.height);
  }

  /** The ring's center on screen, e.g. to start a background pulse when the filter changes. */
  centerOnScreen() {
    return { x: this.world.x, y: this.world.y };
  }

  private drawAnchors() {
    this.anchorLayer.removeChildren().forEach((c) => c.destroy());
    this.labelLayer.removeChildren().forEach((c) => c.destroy());
    const { anchors, ring } = this.layout;
    if (ring && anchors.length > 2) {
      const r = new Graphics().circle(0, 0, RING_RADIUS).stroke({ width: 1, color: theme.fg, alpha: 0.1 });
      this.anchorLayer.addChild(r);
    } else if (anchors.length === 2) {
      const axis = new Graphics()
        .moveTo(anchors[0].x, 0)
        .lineTo(anchors[1].x, 0)
        .stroke({ width: 1, color: theme.fg, alpha: 0.15 });
      this.anchorLayer.addChild(axis);
    }
    anchors.forEach((a, i) => {
      const color = anchorColor(i);
      // Node where the threads start: white disc with a coloured ring and center dot.
      const node = new Graphics()
        .circle(a.x, a.y, 11)
        .fill({ color: theme.surface })
        .stroke({ width: 1.5, color })
        .circle(a.x, a.y, 3.5)
        .fill({ color });
      this.anchorLayer.addChild(node);

      const c = new Container();
      const label = new Text({
        text: a.name.toUpperCase(),
        style: { fontFamily: "Trebuchet MS, Lucida Grande, Lucida Sans Unicode, Segoe UI, sans-serif", fontSize: 14, fill: theme.fg, letterSpacing: 1.6 },
        resolution: 2,
      });
      label.anchor.set(0.5);
      const pad = 10;
      const bg = new Graphics()
        .roundRect(-label.width / 2 - pad, -label.height / 2 - 6, label.width + pad * 2, label.height + 12, 999)
        .fill({ color: theme.surface })
        .stroke({ width: 1, color });
      c.addChild(bg, label);
      // Push labels outward from the center so they sit outside the cluster.
      const len = Math.hypot(a.x, a.y) || 1;
      const push = anchors.length === 2 ? 70 : 90;
      c.position.set(a.x + (a.x / len) * push, a.y + (a.y / len) * push);
      this.labelLayer.addChild(c);
    });
  }

  /** Hovered and selected thumbnails ride in overlayLayer, clear of the anchor labels. */
  private promote(id: string) {
    const c = this.sprites.get(id);
    if (c) this.overlayLayer.addChild(c);
  }

  /** Drop back under the labels, unless the sprite is still hovered or selected. */
  private demote(id: string) {
    if (id === this.hovered || id === this.selected) return;
    const c = this.sprites.get(id);
    if (c) this.nodeLayer.addChild(c);
  }

  private setHover(id: string | null) {
    if (id == null) {
      this.clearHover();
      return;
    }
    const prev = this.hovered;
    this.hovered = id;
    if (prev) {
      this.demote(prev);
      this.drawFrame(prev);
    }
    if (id) {
      this.promote(id);
      this.drawFrame(id);
    }
    this.updateInteraction();
    this.onHover(id);
  }

  private clearHover() {
    const prev = this.hovered;
    if (!prev) return;
    this.hovered = null;
    this.demote(prev);
    this.drawFrame(prev);
    this.updateInteraction();
    this.onHover(null);
  }

  setSelected(id: string | null) {
    const prev = this.selected;
    this.selected = id;
    if (prev && prev !== id) {
      this.demote(prev);
      this.drawFrame(prev);
    }
    if (id) {
      this.promote(id);
      this.drawFrame(id);
    }
    this.updateInteraction();
  }

  /** Enlarged thumbnails stay put while their neighbors make room around them. */
  private updateInteraction() {
    for (const node of this.nodes.values()) {
      const active = node.id === this.selected || node.id === this.hovered;
      node.targetScale = active ? ACTIVE_SCALE : 1;
    }

    // During a filter transition a pre-existing selection still travels to its
    // new data position. A new hover, however, must lock at its current spot.
    if (!this.layoutTransition || this.hovered) this.lockActiveNodes();
    // Collision grows with the visible thumbnail, so only physical contact displaces a neighbor.
    this.collide?.radius((d) => COLLISION_RADIUS * d.scale);
    // Scaling needs a few ticks, not a wholesale reheat of the filtered layout.
    this.sim?.alpha(Math.max(this.sim.alpha(), 0.08)).restart();
  }

  private lockActiveNodes() {
    for (const node of this.nodes.values()) {
      const active = node.id === this.selected || node.id === this.hovered;
      if (active) {
        // Preserve the visual position at the moment the thumbnail becomes active.
        if (node.fx == null || node.fy == null) {
          node.fx = node.x ?? 0;
          node.fy = node.y ?? 0;
        }
      } else {
        node.fx = undefined;
        node.fy = undefined;
      }
    }
  }

  /** Let a hovered node ease just far enough away from a selected node on contact. */
  private resolveHoveredPinnedContact() {
    const hovered = this.hovered ? this.nodes.get(this.hovered) : null;
    const pinned = this.selected ? this.nodes.get(this.selected) : null;
    if (!hovered || !pinned || pinned.id === hovered.id) return;

    let dx = (hovered.x ?? 0) - (pinned.x ?? 0);
    let dy = (hovered.y ?? 0) - (pinned.y ?? 0);
    let distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      // A stable direction avoids a random jump if two nodes share a center.
      dx = hovered.id < pinned.id ? -1 : 1;
      dy = 0;
      distance = 1;
    }
    const clearance = COLLISION_RADIUS * (hovered.scale + pinned.scale);
    if (distance >= clearance) return;
    const move = Math.min(clearance - distance, 1.5);
    hovered.x = (hovered.x ?? 0) + (dx / distance) * move;
    hovered.y = (hovered.y ?? 0) + (dy / distance) * move;
    hovered.fx = hovered.x;
    hovered.fy = hovered.y;
    hovered.vx = 0;
    hovered.vy = 0;
  }

  private drawFrame(id: string) {
    const c = this.sprites.get(id);
    if (!c) return;
    const active = id === this.hovered || id === this.selected;
    const shadow = c.children[0] as NineSliceSprite;
    const frame = c.children[1] as Graphics;
    const sprite = c.children[2] as Sprite;
    const w = sprite.width;
    const h = sprite.height;
    const scaleProgress = Math.max(0, Math.min(1, ((this.nodes.get(id)?.scale ?? 1) - 1) / (ACTIVE_SCALE - 1)));
    const pad = active ? 3 * scaleProgress : 0;
    frame.clear();
    const reach = pad + SHADOW_PAD;
    shadow.width = w + reach * 2;
    shadow.height = h + reach * 2;
    shadow.position.set(-shadow.width / 2 + SHADOW_OFFSET, -shadow.height / 2 + SHADOW_OFFSET);
    if (active) {
      const selectionProgress = this.nodes.get(id)?.frameColorProgress ?? 0;
      // Finish the white-to-dark hover transition early in the size animation.
      const hoverColor = this.blendColor(theme.surface, theme.fg, Math.min(1, scaleProgress * 3));
      const color = this.blendColor(hoverColor, theme.accent, selectionProgress);
      frame.rect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2).fill({ color });
    } else {
      frame.rect(-w / 2 - 0.5, -h / 2 - 0.5, w + 1, h + 1).stroke({ width: 1, color: theme.surface });
    }
  }

  private blendColor(from: number, to: number, amount: number) {
    const mix = (shift: number) => {
      const start = (from >> shift) & 0xff;
      const end = (to >> shift) & 0xff;
      return Math.round(start + (end - start) * amount);
    };
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  }

  destroy() {
    this.destroyed = true;
    this.sim?.stop();
    this.cleanup.forEach((f) => f());
    if (this.ready) this.app.destroy(true, { children: true });
  }
}
