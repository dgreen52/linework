// Tiny ASCII DXF writer used to generate SYNTHETIC sample drawings and test fixtures.
// Shared by tools/make_dxf_fixtures.mjs (Node) and the in-app stress-test sample (browser).

const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(Number(v.toFixed(9)));
};

export class DxfWriter {
  /**
   * opts: { version: 'AC1009' | 'AC1015' | ..., insunits, codepage, extents: [x0,y0,x1,y1],
   *         eol: '\n' | '\r\n', padCodes: bool, handles: bool, header: bool, tables: bool }
   */
  constructor(opts = {}) {
    this.o = { version: 'AC1015', insunits: 0, codepage: 'ANSI_1252', eol: '\n', padCodes: false, handles: true, header: true, tables: true, ...opts };
    this.layers = [];
    this.ltypes = [];
    this.styles = [];
    this.blocks = [];
    this.entities = [];
    this.target = this.entities;
    this.handle = 0x100;
    this.dimCount = 0;
    this.headerVars = [];
    this.extraTables = []; // [{ name, records: [[type, groups]] }] (written after STYLE)
    this.objects = []; // [[type, groups]]: an OBJECTS section when not empty
  }
  get r12() { return this.o.version === 'AC1009'; }
  nextHandle() { return (this.handle++).toString(16).toUpperCase(); }

  // ---------------------------------------------------------------- tables
  layer(name, color = 7, ltype = 'CONTINUOUS', { off = false, frozen = false, rgb = null, lw = null, handle = null } = {}) {
    this.layers.push({ name, color: off ? -Math.abs(color) : color, ltype, frozen, rgb, lw, handle });
    return this;
  }
  ltype(name, desc, pattern) { this.ltypes.push({ name, desc, pattern }); return this; }
  style(name, { height = 0, width = 1, oblique = 0, font = 'txt' } = {}) { this.styles.push({ name, height, width, oblique, font }); return this; }
  headerVar(name, code, value) { this.headerVars.push([name, code, value]); return this; }

  // ---------------------------------------------------------------- blocks
  block(name, base, fn, flags = 0) {
    const blk = { name, base, flags, entities: [] };
    const prev = this.target;
    this.target = blk.entities;
    fn(this);
    this.target = prev;
    this.blocks.push(blk);
    return this;
  }

  // ---------------------------------------------------------------- entities
  raw(type, groups, sub) { this.target.push({ type, groups, sub }); return this; }
  props(p = {}) {
    const g = [[8, p.layer ?? '0']];
    if (p.ltype) g.push([6, p.ltype]);
    if (p.color != null) g.push([62, p.color]);
    if (p.rgb != null) g.push([420, p.rgb]);
    if (p.lw != null) g.push([370, p.lw]); // lineweight, 1/100 mm
    if (p.invisible) g.push([60, 1]);
    if (p.paper) g.push([67, 1]);
    return g;
  }
  extrusion(p) { return p.extrusion ? [[210, p.extrusion[0]], [220, p.extrusion[1]], [230, p.extrusion[2]]] : []; }

  line(a, b, p = {}) {
    return this.raw('LINE', [...this.props(p), [10, a[0]], [20, a[1]], [30, 0], [11, b[0]], [21, b[1]], [31, 0]], 'AcDbLine');
  }
  point(a, p = {}) { return this.raw('POINT', [...this.props(p), [10, a[0]], [20, a[1]], [30, 0]], 'AcDbPoint'); }
  circle(c, r, p = {}) {
    return this.raw('CIRCLE', [...this.props(p), [10, c[0]], [20, c[1]], [30, 0], [40, r], ...this.extrusion(p)], 'AcDbCircle');
  }
  arc(c, r, a0, a1, p = {}) { // degrees
    return this.raw('ARC', [...this.props(p), [10, c[0]], [20, c[1]], [30, 0], [40, r], ...this.extrusion(p), [100, 'AcDbArc'], [50, a0], [51, a1]], 'AcDbCircle');
  }
  ellipse(c, major, ratio, t0 = 0, t1 = Math.PI * 2, p = {}) {
    return this.raw('ELLIPSE', [...this.props(p), [10, c[0]], [20, c[1]], [30, 0], [11, major[0]], [21, major[1]], [31, 0], ...this.extrusion(p), [40, ratio], [41, t0], [42, t1]], 'AcDbEllipse');
  }
  /** verts: [[x, y, bulge?], ...] */
  lwpolyline(verts, closed = false, p = {}) {
    if (this.r12) return this.polyline(verts, closed, p);
    const g = [...this.props(p), [90, verts.length], [70, closed ? 1 : 0]];
    if (p.elevation) g.push([38, p.elevation]);
    for (const v of verts) { g.push([10, v[0]], [20, v[1]]); if (v[2]) g.push([42, v[2]]); }
    g.push(...this.extrusion(p));
    return this.raw('LWPOLYLINE', g, 'AcDbPolyline');
  }
  /** Old-style POLYLINE / VERTEX / SEQEND (2D, with bulges). */
  polyline(verts, closed = false, p = {}) {
    this.raw('POLYLINE', [...this.props(p), [66, 1], [10, 0], [20, 0], [30, 0], [70, closed ? 1 : 0], ...this.extrusion(p)], 'AcDb2dPolyline');
    for (const v of verts) {
      const g = [[8, p.layer ?? '0'], [10, v[0]], [20, v[1]], [30, 0]];
      if (v[2]) g.push([42, v[2]]);
      this.raw('VERTEX', g, 'AcDb2dVertex');
    }
    return this.raw('SEQEND', [[8, p.layer ?? '0']]);
  }
  spline(ctrl, degree = 3, p = {}) {
    const n = ctrl.length;
    const knots = [];
    for (let i = 0; i <= n + degree; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
    const g = [...this.props(p), [70, 8], [71, degree], [72, knots.length], [73, n], [74, 0]];
    for (const k of knots) g.push([40, k]);
    for (const c of ctrl) g.push([10, c[0]], [20, c[1]], [30, 0]);
    return this.raw('SPLINE', g, 'AcDbSpline');
  }
  /** TEXT. opts: { h, rot (deg), halign, valign, style, width, oblique, mirror (71 flags) } */
  text(s, at, o = {}, p = {}) {
    const g = [...this.props(p), [10, at[0]], [20, at[1]], [30, 0], [40, o.h ?? 2.5], [1, s]];
    if (o.rot) g.push([50, o.rot]);
    if (o.width && o.width !== 1) g.push([41, o.width]);
    if (o.oblique) g.push([51, o.oblique]);
    if (o.style) g.push([7, o.style]);
    if (o.mirror) g.push([71, o.mirror]);
    if (o.halign) g.push([72, o.halign]);
    if (o.halign || o.valign) g.push([11, (o.at2 || at)[0]], [21, (o.at2 || at)[1]], [31, 0]);
    g.push(...this.extrusion(p));
    if (o.valign) { g.push([100, 'AcDbText'], [73, o.valign]); }
    return this.raw('TEXT', g, 'AcDbText');
  }
  mtext(s, at, o = {}, p = {}) {
    const g = [...this.props(p), [10, at[0]], [20, at[1]], [30, 0], [40, o.h ?? 2.5], [41, o.width ?? 0], [71, o.attach ?? 1], [72, 1]];
    let rest = s;
    while (rest.length > 250) { g.push([3, rest.slice(0, 250)]); rest = rest.slice(250); }
    g.push([1, rest]);
    if (o.rot) g.push([50, (o.rot * Math.PI) / 180]);
    if (o.style) g.push([7, o.style]);
    return this.raw('MTEXT', g, 'AcDbMText');
  }
  /** INSERT. o: { sx, sy, rot (deg), cols, rows, dc, dr, attribs: [{tag, value, at, h, rot, invisible}] } */
  insert(name, at, o = {}, p = {}) {
    const g = [...this.props(p)];
    if (o.attribs && o.attribs.length) g.push([66, 1]);
    g.push([2, name], [10, at[0]], [20, at[1]], [30, 0]);
    if (o.sx != null && o.sx !== 1) g.push([41, o.sx]);
    if (o.sy != null && o.sy !== 1) g.push([42, o.sy]);
    if (o.rot) g.push([50, o.rot]);
    if (o.cols > 1) g.push([70, o.cols], [44, o.dc || 0]);
    if (o.rows > 1) g.push([71, o.rows], [45, o.dr || 0]);
    g.push(...this.extrusion(p));
    this.raw('INSERT', g, 'AcDbBlockReference');
    if (o.attribs && o.attribs.length) {
      for (const a of o.attribs) {
        const ag = [[8, a.layer ?? p.layer ?? '0'], [10, a.at[0]], [20, a.at[1]], [30, 0], [40, a.h ?? 2.5], [1, a.value], [2, a.tag], [70, a.invisible ? 1 : 0]];
        if (a.rot) ag.push([50, a.rot]);
        if (a.halign) ag.push([72, a.halign], [11, a.at[0]], [21, a.at[1]], [31, 0]);
        if (a.valign) ag.push([74, a.valign]);
        this.raw('ATTRIB', ag, 'AcDbAttribute');
      }
      this.raw('SEQEND', [[8, p.layer ?? '0']]);
    }
    return this;
  }
  attdef(tag, prompt, def, at, o = {}, p = {}) {
    const g = [...this.props(p), [10, at[0]], [20, at[1]], [30, 0], [40, o.h ?? 2.5], [1, def], [3, prompt], [2, tag], [70, o.constant ? 2 : 0]];
    if (o.halign) g.push([72, o.halign], [11, at[0]], [21, at[1]], [31, 0]);
    if (o.valign) g.push([74, o.valign]);
    return this.raw('ATTDEF', g, 'AcDbAttributeDefinition');
  }
  solid(pts, p = {}) { // pts: 3 or 4 points, DXF order (1,2,3,4 -> drawn 1-2-4-3)
    const q = pts.length === 3 ? [...pts, pts[2]] : pts;
    return this.raw('SOLID', [...this.props(p), [10, q[0][0]], [20, q[0][1]], [30, 0], [11, q[1][0]], [21, q[1][1]], [31, 0], [12, q[2][0]], [22, q[2][1]], [32, 0], [13, q[3][0]], [23, q[3][1]], [33, 0]], 'AcDbTrace');
  }
  /** Polyline-boundary hatch. loops: [[[x,y,bulge?],...], ...] */
  hatch(loops, { solid = false, pattern = 'ANSI31' } = {}, p = {}) {
    const g = [...this.props(p), [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, solid ? 'SOLID' : pattern], [70, solid ? 1 : 0], [71, 0], [91, loops.length]];
    for (const L of loops) {
      const hasB = L.some((v) => v[2]);
      g.push([92, 2 | 1], [72, hasB ? 1 : 0], [73, 1], [93, L.length]);
      for (const v of L) { g.push([10, v[0]], [20, v[1]]); if (hasB) g.push([42, v[2] || 0]); }
      g.push([97, 0]);
    }
    g.push([75, 1], [76, 1]);
    if (!solid) g.push([52, 0], [41, 1], [77, 0], [78, 1], [53, 45], [43, 0], [44, 0], [45, -0.088388], [46, 0.088388], [79, 0]);
    g.push([98, 0]);
    return this.raw('HATCH', g, 'AcDbHatch');
  }
  /** Hatch whose boundary is made of edges (line + arc) to exercise the edge parser. */
  hatchEdges(edges, { solid = true } = {}, p = {}) {
    const g = [...this.props(p), [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, solid ? 'SOLID' : 'ANSI31'], [70, solid ? 1 : 0], [71, 0], [91, 1], [92, 1], [93, edges.length]];
    for (const e of edges) {
      if (e.type === 'line') g.push([72, 1], [10, e.a[0]], [20, e.a[1]], [11, e.b[0]], [21, e.b[1]]);
      else g.push([72, 2], [10, e.c[0]], [20, e.c[1]], [40, e.r], [50, e.a0], [51, e.a1], [73, 1]);
    }
    g.push([97, 0], [75, 1], [76, 1], [98, 0]);
    return this.raw('HATCH', g, 'AcDbHatch');
  }
  leader(pts, p = {}) {
    const g = [...this.props(p), [3, 'STANDARD'], [71, 1], [72, 0], [73, 3], [76, pts.length]];
    for (const v of pts) g.push([10, v[0]], [20, v[1]], [30, 0]);
    return this.raw('LEADER', g, 'AcDbLeader');
  }
  /**
   * Linear (rotated) dimension between p1 and p2 with the dimension line through `dimPt`,
   * angle in degrees (0 = horizontal). Builds the anonymous *D block like CAD programs do.
   */
  linearDim(p1, p2, dimPt, angle = 0, o = {}, p = {}) {
    const name = `*D${++this.dimCount}`;
    const a = (angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const proj = (q) => { const t = (q[0] - dimPt[0]) * ux + (q[1] - dimPt[1]) * uy; return [dimPt[0] + ux * t, dimPt[1] + uy * t]; };
    const d1 = proj(p1), d2 = proj(p2);
    const L = Math.hypot(d2[0] - d1[0], d2[1] - d1[1]);
    const asz = o.arrow ?? 2.5, th = o.h ?? 2.5, dec = o.decimals ?? 0;
    const txt = o.text ?? (o.prefix || '') + L.toFixed(dec) + (o.suffix || '');
    const mid = [(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2];
    const nx = -uy, ny = ux; // text offset side
    const tp = [mid[0] + nx * th * 0.8, mid[1] + ny * th * 0.8];
    const dir = [(d2[0] - d1[0]) / (L || 1), (d2[1] - d1[1]) / (L || 1)];
    let rot = Math.atan2(dir[1], dir[0]) * 180 / Math.PI;
    if (rot > 90.0001 || rot <= -90) rot += 180;
    const blockProps = { layer: '0', color: 0 };
    this.block(name, [0, 0], (w) => {
      const ext = (q, d) => {
        const vx = d[0] - q[0], vy = d[1] - q[1], l = Math.hypot(vx, vy) || 1;
        w.line([q[0] + (vx / l) * 0.6 * asz, q[1] + (vy / l) * 0.6 * asz], [d[0] + (vx / l) * asz * 0.6, d[1] + (vy / l) * asz * 0.6], blockProps);
      };
      ext(p1, d1); ext(p2, d2);
      w.line(d1, d2, blockProps);
      const arrow = (tip, s) => {
        const bx = tip[0] + dir[0] * asz * s, by = tip[1] + dir[1] * asz * s, hw = asz / 6;
        w.solid([[tip[0], tip[1]], [bx + nx * hw, by + ny * hw], [bx - nx * hw, by - ny * hw]], blockProps);
      };
      arrow(d1, 1); arrow(d2, -1);
      w.mtext(txt, tp, { h: th, attach: 8, rot }, blockProps);
      w.point(p1, { layer: 'DEFPOINTS' }); w.point(p2, { layer: 'DEFPOINTS' });
    }, 1);
    const g = [...this.props(p), [2, name], [10, d2[0]], [20, d2[1]], [30, 0], [11, tp[0]], [21, tp[1]], [31, 0], [70, 32], [1, o.text ? o.text : '']];
    g.push([100, 'AcDbAlignedDimension'], [13, p1[0]], [23, p1[1]], [33, 0], [14, p2[0]], [24, p2[1]], [34, 0], [50, angle]);
    g.push([42, L]);
    return this.raw('DIMENSION', g, 'AcDbDimension');
  }

  // ---------------------------------------------------------------- output
  toString() {
    const out = [];
    const eol = this.o.eol;
    const pad = this.o.padCodes;
    const P = (c, v) => { out.push(pad ? String(c).padStart(3, ' ') : String(c), fmt(v)); };
    const r12 = this.r12;
    const ent = (e) => {
      P(0, e.type);
      if (!r12 && this.o.handles) P(5, this.nextHandle());
      if (!r12 && e.sub) P(100, 'AcDbEntity');
      let wroteSub = false;
      for (const [c, v] of e.groups) {
        if (!r12 && e.sub && !wroteSub && c !== 8 && c !== 6 && c !== 62 && c !== 420 && c !== 60 && c !== 67) { P(100, e.sub); wroteSub = true; }
        if (r12 && c === 100) continue;
        P(c, v);
      }
    };
    if (this.o.header) {
      P(0, 'SECTION'); P(2, 'HEADER');
      P(9, '$ACADVER'); P(1, this.o.version);
      if (this.o.codepage) { P(9, '$DWGCODEPAGE'); P(3, this.o.codepage); }
      if (this.o.insunits != null) { P(9, '$INSUNITS'); P(70, this.o.insunits); }
      if (this.o.extents) {
        const e = this.o.extents;
        P(9, '$EXTMIN'); P(10, e[0]); P(20, e[1]); P(30, 0);
        P(9, '$EXTMAX'); P(10, e[2]); P(20, e[3]); P(30, 0);
      }
      for (const [n, c, v] of this.headerVars) { P(9, n); P(c, v); }
      P(0, 'ENDSEC');
    }
    if (this.o.tables) {
      P(0, 'SECTION'); P(2, 'TABLES');
      P(0, 'TABLE'); P(2, 'LTYPE'); P(70, this.ltypes.length + 1);
      P(0, 'LTYPE'); P(2, 'CONTINUOUS'); P(70, 0); P(3, 'Solid line'); P(72, 65); P(73, 0); P(40, 0);
      for (const lt of this.ltypes) {
        P(0, 'LTYPE'); P(2, lt.name); P(70, 0); P(3, lt.desc); P(72, 65); P(73, lt.pattern.length);
        P(40, lt.pattern.reduce((s, v) => s + Math.abs(v), 0));
        for (const v of lt.pattern) { P(49, v); if (!r12) P(74, 0); }
      }
      P(0, 'ENDTAB');
      P(0, 'TABLE'); P(2, 'LAYER'); P(70, this.layers.length);
      for (const l of this.layers) {
        P(0, 'LAYER'); if (l.handle && !r12) P(5, l.handle); if (!r12) { P(100, 'AcDbSymbolTableRecord'); P(100, 'AcDbLayerTableRecord'); }
        P(2, l.name); P(70, l.frozen ? 1 : 0); P(62, l.color); P(6, l.ltype);
        if (l.rgb != null && !r12) P(420, l.rgb);
        if (l.lw != null && !r12) P(370, l.lw);
      }
      P(0, 'ENDTAB');
      P(0, 'TABLE'); P(2, 'STYLE'); P(70, this.styles.length + 1);
      P(0, 'STYLE'); P(2, 'STANDARD'); P(70, 0); P(40, 0); P(41, 1); P(50, 0); P(71, 0); P(42, 2.5); P(3, 'txt'); P(4, '');
      for (const s of this.styles) { P(0, 'STYLE'); P(2, s.name); P(70, 0); P(40, s.height); P(41, s.width); P(50, s.oblique); P(71, 0); P(42, 2.5); P(3, s.font); P(4, ''); }
      P(0, 'ENDTAB');
      for (const t of this.extraTables) {
        P(0, 'TABLE'); P(2, t.name); P(70, t.records.length);
        for (const [type, groups] of t.records) { P(0, type); for (const [c, v] of groups) P(c, v); }
        P(0, 'ENDTAB');
      }
      P(0, 'ENDSEC');
    }
    P(0, 'SECTION'); P(2, 'BLOCKS');
    for (const b of this.blocks) {
      P(0, 'BLOCK'); if (!r12 && this.o.handles) P(5, this.nextHandle());
      if (!r12) { P(100, 'AcDbEntity'); } P(8, '0'); if (!r12) P(100, 'AcDbBlockBegin');
      P(2, b.name); P(70, b.flags); P(10, b.base[0]); P(20, b.base[1]); P(30, 0); P(3, b.name); P(1, '');
      for (const e of b.entities) ent(e);
      P(0, 'ENDBLK'); if (!r12 && this.o.handles) P(5, this.nextHandle()); if (!r12) { P(100, 'AcDbEntity'); } P(8, '0'); if (!r12) P(100, 'AcDbBlockEnd');
    }
    P(0, 'ENDSEC');
    P(0, 'SECTION'); P(2, 'ENTITIES');
    for (const e of this.entities) ent(e);
    P(0, 'ENDSEC');
    if (this.objects.length) {
      P(0, 'SECTION'); P(2, 'OBJECTS');
      for (const [type, groups] of this.objects) { P(0, type); for (const [c, v] of groups) P(c, v); }
      P(0, 'ENDSEC');
    }
    P(0, 'EOF');
    return out.join(eol) + eol;
  }
}
