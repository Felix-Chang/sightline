import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { forceCollide, forceLink, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import type { ImageNode } from "./data";
import { RING_RADIUS, type Anchor, type Target } from "./layout";
import { canvasHex, theme } from "./theme";

const THUMB = 64;

type Node = SimulationNodeDatum & { id: string; tx: number; ty: number; weights: number[] };
type Link = { source: string | Node; target: string | Node };

export type GraphLayout = { anchors: Anchor[]; targets: Map<string, Target>; links: [string, string][]; ring: boolean };

/** Imperative PixiJS + d3-force scene. React owns the UI around it; this owns the canvas. */
export class GraphEngine {
  private app = new Application();
  private world = new Container();
  private edgeLayer = new Graphics();
  private anchorLayer = new Container();
  private nodeLayer = new Container();
  private sprites = new Map<string, Container>();
  private pending = new Set<string>();
  private nodes = new Map<string, Node>();
  private sim: Simulation<Node, Link> | null = null;
  private layout: GraphLayout = { anchors: [], targets: new Map(), links: [], ring: false };
  private selected: string | null = null;
  private hovered: string | null = null;
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
    this.world.addChild(this.edgeLayer, this.anchorLayer, this.nodeLayer);
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
      const s = Math.min(4, Math.max(0.15, this.world.scale.x * Math.exp(-e.deltaY * 0.0015)));
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
        this.nodes.set(img.id, { id: img.id, x: (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 40, tx: 0, ty: 0, weights: [] });
        this.drawFrame(img.id);
      }),
    );
    this.applyLayout(this.layout, 0.9);
  }

  applyLayout(layout: GraphLayout, alpha = 0.8) {
    this.layout = layout;
    if (!this.ready) return;
    for (const node of this.nodes.values()) {
      const t = layout.targets.get(node.id);
      node.tx = t?.x ?? 0;
      node.ty = t?.y ?? 0;
      node.weights = t?.weights ?? [];
    }
    this.drawAnchors();
    const nodes = [...this.nodes.values()];
    const links: Link[] = layout.links
      .filter(([a, b]) => this.nodes.has(a) && this.nodes.has(b))
      .map(([source, target]) => ({ source, target }));
    this.sim?.stop();
    this.sim = forceSimulation<Node, Link>(nodes)
      .force("x", forceX<Node>((d) => d.tx).strength(0.09))
      .force("y", forceY<Node>((d) => d.ty).strength(0.09))
      .force("collide", forceCollide<Node>(THUMB * 0.56).strength(0.9))
      .force("link", forceLink<Node, Link>(links).id((d) => d.id).distance(THUMB * 1.4).strength(0.015))
      .alpha(alpha)
      .alphaDecay(0.025)
      .velocityDecay(0.35)
      .on("tick", () => this.tick(links));
  }

  private tick(links: Link[]) {
    for (const node of this.nodes.values()) {
      this.sprites.get(node.id)?.position.set(node.x ?? 0, node.y ?? 0);
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
        style: { fontFamily: "ui-monospace, SF Mono, Menlo, monospace", fontSize: 14, fill: theme.fg, letterSpacing: 1.6 },
        resolution: 2,
      });
      label.anchor.set(0.5);
      const pad = 10;
      const bg = new Graphics()
        .roundRect(-label.width / 2 - pad, -label.height / 2 - 6, label.width + pad * 2, label.height + 12, 999)
        .fill({ color: theme.surface })
        .stroke({ width: 1, color: theme.border });
      c.addChild(bg, label);
      // Push labels outward from the center so they sit outside the cluster.
      const len = Math.hypot(a.x, a.y) || 1;
      const push = anchors.length === 2 ? 70 : 90;
      c.position.set(a.x + (a.x / len) * push, a.y + (a.y / len) * push);
      this.anchorLayer.addChild(c);
    }
  }

  private setHover(id: string | null) {
    const prev = this.hovered;
    this.hovered = id;
    if (prev) this.drawFrame(prev);
    if (id) {
      const c = this.sprites.get(id);
      if (c) this.nodeLayer.setChildIndex(c, this.nodeLayer.children.length - 1);
      this.drawFrame(id);
    }
    this.onHover(id);
  }

  setSelected(id: string | null) {
    const prev = this.selected;
    this.selected = id;
    if (prev) this.drawFrame(prev);
    if (id) this.drawFrame(id);
  }

  private drawFrame(id: string) {
    const c = this.sprites.get(id);
    if (!c) return;
    const active = id === this.hovered || id === this.selected;
    c.scale.set(active ? 1.7 : 1);
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
