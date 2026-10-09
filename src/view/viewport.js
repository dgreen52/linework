// View transform: scene-local units <-> CSS pixels. Y is up in the drawing, down on screen.
export class Viewport {
  constructor() {
    this.cx = 0; // scene-local coordinates of the screen centre
    this.cy = 0;
    this.scale = 1; // CSS px per drawing unit
    this.w = 1; // CSS px
    this.h = 1;
    this.minScale = 1e-12;
    this.maxScale = 1e12;
  }
  setSize(w, h) { this.w = Math.max(1, w); this.h = Math.max(1, h); }
  toScreen(x, y) { return [this.w / 2 + (x - this.cx) * this.scale, this.h / 2 - (y - this.cy) * this.scale]; }
  toWorld(sx, sy) { return [this.cx + (sx - this.w / 2) / this.scale, this.cy - (sy - this.h / 2) / this.scale]; }
  /** Canvas transform for ctx.setTransform (device pixels). */
  matrix(dpr = 1) {
    const s = this.scale * dpr;
    return [s, 0, 0, -s, (this.w / 2 - this.cx * this.scale) * dpr, (this.h / 2 + this.cy * this.scale) * dpr];
  }
  /** Visible scene-local rectangle [x0, y0, x1, y1] (with an optional margin in px). */
  visibleRect(marginPx = 0) {
    const [x0, y1] = this.toWorld(-marginPx, -marginPx);
    const [x1, y0] = this.toWorld(this.w + marginPx, this.h + marginPx);
    return [x0, y0, x1, y1];
  }
  setLimits(extents) {
    const size = Math.max(extents[2] - extents[0], extents[3] - extents[1], 1e-9);
    this.minScale = 20 / (size * 1000); // can zoom out until the drawing is ~20 px / 1000
    this.maxScale = Math.max(1e7 / size, 1e-3) * 1000; // deep zoom (local origin keeps precision)
  }
  clampScale(s) { return Math.min(this.maxScale, Math.max(this.minScale, s)); }
  fit(b, padPx = 24) {
    const bw = Math.max(b[2] - b[0], 1e-9), bh = Math.max(b[3] - b[1], 1e-9);
    const sx = (this.w - 2 * padPx) / bw, sy = (this.h - 2 * padPx) / bh;
    this.scale = this.clampScale(Math.max(1e-12, Math.min(sx, sy)));
    this.cx = (b[0] + b[2]) / 2;
    this.cy = (b[1] + b[3]) / 2;
  }
  /** Zoom by `factor` keeping the drawing point under (sx, sy) fixed. */
  zoomAt(sx, sy, factor) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = this.clampScale(this.scale * factor);
    this.cx = wx - (sx - this.w / 2) / this.scale;
    this.cy = wy + (sy - this.h / 2) / this.scale;
  }
  panBy(dxPx, dyPx) {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
  }
  snapshot() { return { cx: this.cx, cy: this.cy, scale: this.scale, w: this.w, h: this.h }; }
  restore(s) { Object.assign(this, s); }
  equals(s) { return s && s.cx === this.cx && s.cy === this.cy && s.scale === this.scale && s.w === this.w && s.h === this.h; }
}

/** CSS transform that maps a canvas rendered with view `a` onto view `b` (cheap preview while interacting). */
export function cssTransformBetween(a, b) {
  const k = b.scale / a.scale;
  // screen point under a: p = w/2 + (x - a.cx) * a.s ; under b: q = w/2 + (x - b.cx) * b.s
  const tx = (b.w / 2) - k * (a.w / 2) + (a.cx - b.cx) * b.scale;
  const ty = (b.h / 2) - k * (a.h / 2) - (a.cy - b.cy) * b.scale;
  return `translate(${tx}px, ${ty}px) scale(${k})`;
}
