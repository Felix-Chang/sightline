import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { forceCollide, forceLink, forceSimulation, forceX, forceY, type ForceCollide, type Simulation, type SimulationNodeDatum } from "d3-force";
import type { ImageNode } from "./data";
import { RING_RADIUS, type Anchor, type Target } from "./layout";
import { canvasHex, theme } from "./theme";

const THUMB = 64;
const ACTIVE_SCALE = 1.7;
const COLLISION_RADIUS = THUMB * 0.56;

type Node = SimulationNodeDatum & {
  id: string;
  tx: number;
  ty: number;
  weights: number[];
  scale: number;
  targetScale: number;
};
type Link = { source: string | Node; target: string | Node };

export type GraphLayout = { anchors: Anchor[]; targets: Map<string, Target>; links: [string, string][]; ring: boolean };

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
  private pending = new Set<string>();
  private nodes = new Map<string, Node>();
  private sim: Simulation<Node, Link> | null = null;
  private collide: ForceCollide<Node> | null = null;
  private layout: GraphLayout = { anchors: [], targets: new Map(), links: [], ring: false };
  private selected: string | null = null;
  private hovered: string | null = null;
  private layoutTransition = false;
  private destroyed = false;
  private dragMoved = false;
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
    this.ready = true;
  }

  /** Fit the ring into the space right of the filter panel (full width on narrow screens). */
  private fit() {
    const { width, height } = this.app.screen;
    const inset = width >= 760 ? 380 : 0;
    const usable = width - inset;
    this.world.scale.set(Math.min(usable, height) / (RING_RADIUS * 2 + 340));
    this.world.position.set(inset + usable / 2, height / 2);
  }

  private enablePanZoom() {
    const canvas = this.app.canvas;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const before = { x: (px - this.world.x) / this.world.scale.x, y: (py - this.world.y) / this.world.scale.y };
      const s = Math.min(4, Math.max(0.2, this.world.scale.x * Math.exp(-e.deltaY * 0.0015)));
      this.world.scale.set(s);
      this.world.position.set(px - before.x * s, py - before.y * s);
    };
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, wx: this.world.x, wy: this.world.y };
      this.dragMoved = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
      this.world.position.set(drag.wx + dx, drag.wy + dy);
    };
    const onUp = () => {
      drag = null;
    };
    // Taps on empty canvas clear the selection; Pixi only targets the stage when no thumbnail was hit.
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointertap", (e) => {
      if (e.target === this.app.stage && !this.dragMoved) this.onSelect(null);
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const onResize = () => this.fit();
    this.app.renderer.on("resize", onResize);
    this.cleanup.push(() => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    });
  }

  /** Add any images not yet on the canvas (initial load or new uploads). */
  async setImages(images: ImageNode[]) {
    if (!this.ready) return;
    // Claim ids synchronously so overlapping calls (React effects, realtime) never double-add.
    const fresh = images.filter((img) => !this.sprites.has(img.id) && !this.pending.has(img.id));
    fresh.forEach((img) => this.pending.add(img.id));
    await Promise.all(
      fresh.map(async (img) => {
        let tex: Texture;
        try {
          tex = await Assets.load<Texture>({ src: img.thumbUrl, parser: "loadTextures" });
        } catch {
          tex = Texture.WHITE;
        }
        if (this.destroyed) return;
        const c = new Container();
        const sprite = new Sprite(tex);
        const s = THUMB / Math.max(tex.width, tex.height);
        sprite.scale.set(s);
        sprite.anchor.set(0.5);
        const frame = new Graphics();
        c.addChild(frame, sprite);
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
        });
        this.drawFrame(img.id);
      }),
    );
    this.applyLayout(this.layout, 0.9);
  }

  applyLayout(layout: GraphLayout, alpha = 0.8) {
    this.layout = layout;
    if (!this.ready) return;
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
    const links: Link[] = layout.links
      .filter(([a, b]) => this.nodes.has(a) && this.nodes.has(b))
      .map(([source, target]) => ({ source, target }));
    this.sim?.stop();
    const collide = forceCollide<Node>()
      .radius((d) => COLLISION_RADIUS * d.scale)
      .strength(1)
      .iterations(3);
    this.collide = collide;
    this.sim = forceSimulation<Node, Link>(nodes)
      .force("x", forceX<Node>((d) => d.tx).strength(0.09))
      .force("y", forceY<Node>((d) => d.ty).strength(0.09))
      .force("collide", collide)
      .force("link", forceLink<Node, Link>(links).id((d) => d.id).distance(THUMB * 1.4).strength(0.003))
      .alpha(alpha)
      .alphaDecay(0.03)
      .velocityDecay(0.38)
      .on("tick", () => this.tick(links));
    this.updateInteraction();
  }

  private tick(links: Link[]) {
    let resized = false;
    for (const node of this.nodes.values()) {
      const delta = node.targetScale - node.scale;
      if (Math.abs(delta) > 0.001) {
        node.scale += delta * 0.08;
        resized = true;
      } else {
        node.scale = node.targetScale;
      }
      const sprite = this.sprites.get(node.id);
      sprite?.position.set(node.x ?? 0, node.y ?? 0);
      sprite?.scale.set(node.scale);
    }
    // d3 caches collision radii, so refresh them while thumbnails animate their size.
    if (resized) this.collide?.radius((d) => COLLISION_RADIUS * Math.max(d.scale, d.targetScale));
    if (this.layoutTransition && (this.sim?.alpha() ?? 1) < 0.04) {
      this.layoutTransition = false;
      this.lockActiveNodes();
    }
    const g = this.edgeLayer;
    g.clear();
    // Neighbor web: faint curves between images with similar scores.
    for (const l of links) {
      const a = l.source as Node;
      const b = l.target as Node;
      if (a.x == null || b.x == null) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y! + b.y!) / 2;
      g.moveTo(a.x, a.y!).quadraticCurveTo(mx * 0.9, my * 0.9, b.x, b.y!);
    }
    g.stroke({ width: 1, color: theme.muted, alpha: 0.28 });
    // Anchor threads: accent curves from each anchor to images that strongly have that quality.
    const { anchors } = this.layout;
    anchors.forEach((anchor, i) => {
      for (const node of this.nodes.values()) {
        const w = node.weights[i] ?? 0;
        if (w < 0.4 || node.x == null) continue;
        g.moveTo(anchor.x, anchor.y).quadraticCurveTo((anchor.x + node.x) * 0.35, (anchor.y + node.y!) * 0.35, node.x, node.y!);
        g.stroke({ width: 1.2, color: theme.accent, alpha: Math.min(0.7, 0.15 + (w - 0.4) * 1.4) });
      }
    });
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
    for (const a of anchors) {
      // Node where the threads start: white disc with a red ring and center dot.
      const node = new Graphics()
        .circle(a.x, a.y, 11)
        .fill({ color: theme.surface })
        .stroke({ width: 1.5, color: theme.accent })
        .circle(a.x, a.y, 3.5)
        .fill({ color: theme.accent });
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
        .stroke({ width: 1, color: theme.accent });
      c.addChild(bg, label);
      // Push labels outward from the center so they sit outside the cluster.
      const len = Math.hypot(a.x, a.y) || 1;
      const push = anchors.length === 2 ? 70 : 90;
      c.position.set(a.x + (a.x / len) * push, a.y + (a.y / len) * push);
      this.labelLayer.addChild(c);
    }
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

    if (!this.layoutTransition) this.lockActiveNodes();
    // Reserve the final size immediately, so neighbors are already moving before growth is visible.
    this.collide?.radius((d) => COLLISION_RADIUS * Math.max(d.scale, d.targetScale));
    this.sim?.alpha(Math.max(this.sim.alpha(), 0.55)).restart();
  }

  private lockActiveNodes() {
    const hovered = this.hovered ? this.nodes.get(this.hovered) : null;
    if (hovered && hovered.id !== this.selected) this.nudgeHoveredPastPinned(hovered);

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

  /** A new hover yields only when it would overlap an already pinned thumbnail. */
  private nudgeHoveredPastPinned(hovered: Node) {
    const pinned = this.selected ? this.nodes.get(this.selected) : null;
    if (!pinned || pinned.id === hovered.id) return;

    let dx = (hovered.x ?? 0) - (pinned.x ?? 0);
    let dy = (hovered.y ?? 0) - (pinned.y ?? 0);
    let distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      // A stable direction avoids a random jump if two nodes share a center.
      dx = hovered.id < pinned.id ? -1 : 1;
      dy = 0;
      distance = 1;
    }
    const clearance = COLLISION_RADIUS * (hovered.targetScale + pinned.targetScale) + 2;
    if (distance >= clearance) return;
    const x = (pinned.x ?? 0) + (dx / distance) * clearance;
    const y = (pinned.y ?? 0) + (dy / distance) * clearance;
    hovered.x = x;
    hovered.y = y;
    hovered.vx = 0;
    hovered.vy = 0;
  }

  private drawFrame(id: string) {
    const c = this.sprites.get(id);
    if (!c) return;
    const active = id === this.hovered || id === this.selected;
    const sprite = c.children[1] as Sprite;
    const frame = c.children[0] as Graphics;
    const w = sprite.width;
    const h = sprite.height;
    frame.clear();
    // Soft paper shadow under every thumbnail so white posters still read on the light canvas.
    frame.rect(-w / 2 + 1, -h / 2 + 2.5, w, h).fill({ color: theme.fg, alpha: 0.12 });
    if (active) {
      const pad = id === this.selected ? 3 : 2;
      frame.rect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2).fill({ color: id === this.selected ? theme.accent : theme.fg });
    } else {
      frame.rect(-w / 2 - 0.5, -h / 2 - 0.5, w + 1, h + 1).stroke({ width: 1, color: theme.border });
    }
  }

  destroy() {
    this.destroyed = true;
    this.sim?.stop();
    this.cleanup.forEach((f) => f());
    if (this.ready) this.app.destroy(true, { children: true });
  }
}
