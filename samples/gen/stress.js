// Synthetic 50k+ entity "warehouse floor" drawing for performance testing. Deterministic.
import { DxfWriter } from './dxf-writer.js';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns { text, entities } — ~58 top-level entities per bay; 30 x 30 bays = 52,200. */
export function makeStressDxf({ bays = 30 } = {}) {
  const R = rng(42);
  const w = new DxfWriter({ version: 'AC1015', insunits: 4, handles: false });
  w.layer('BAY', 8).layer('COLUMNS', 7).layer('RACKS', 4).layer('AISLE', 2, 'DASHED').layer('TEXT', 3)
    .layer('MACHINES', 6).layer('POINTS', 1).layer('CONVEYOR', 30);
  w.ltype('DASHED', 'Dashed __ __ __', [600, -300]);
  w.block('MACHINE', [0, 0], (b) => {
    b.lwpolyline([[-900, -600], [900, -600], [900, 600], [-900, 600]], true, { layer: '0', color: 256 });
    b.circle([0, 0], 350, { layer: '0' });
    b.circle([0, 0], 120, { layer: '0' });
    for (let k = 0; k < 4; k++) b.line([-900 + k * 600, -600], [-900 + k * 600 + 300, -900], { layer: '0' });
    b.arc([900, 0], 300, -90, 90, { layer: '0' });
    b.line([-700, 400], [700, 400], { layer: '0' });
    b.text('M', [0, -60], { h: 200, halign: 1, valign: 2 }, { layer: '0' });
    b.point([0, 0], { layer: '0' });
  });
  const S = 10000;
  let count = 0;
  for (let by = 0; by < bays; by++) {
    for (let bx = 0; bx < bays; bx++) {
      const x0 = bx * S, y0 = by * S;
      w.line([x0, y0], [x0 + S, y0], { layer: 'BAY' });
      w.line([x0 + S, y0], [x0 + S, y0 + S], { layer: 'BAY' });
      w.line([x0 + S, y0 + S], [x0, y0 + S], { layer: 'BAY' });
      w.line([x0, y0 + S], [x0, y0], { layer: 'BAY' });
      w.circle([x0, y0], 250, { layer: 'COLUMNS' });
      w.lwpolyline([[x0 - 300, y0 - 300], [x0 + 300, y0 - 300], [x0 + 300, y0 + 300], [x0 - 300, y0 + 300]], true, { layer: 'COLUMNS' });
      for (let r = 0; r < 6; r++) {
        const rx = x0 + 800 + r * 1450, ry = y0 + 1200;
        const rw = 900, rh = 5200;
        w.lwpolyline([[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]], true, { layer: 'RACKS' });
        for (let k = 1; k <= 5; k++) w.line([rx, ry + (k * rh) / 6], [rx + rw, ry + (k * rh) / 6], { layer: 'RACKS' });
      }
      for (let k = 0; k < 4; k++) {
        const cx = x0 + 1500 + k * 2200, cy = y0 + 7600 + R() * 400;
        w.arc([cx, cy], 600 + R() * 200, 0, 180, { layer: 'CONVEYOR' });
      }
      w.text(`BAY ${String.fromCharCode(65 + (by % 26))}${bx + 1}`, [x0 + 300, y0 + 9300], { h: 350 }, { layer: 'TEXT' });
      for (let r = 0; r < 6; r++) w.text(`R${r + 1}`, [x0 + 800 + r * 1450 + 450, y0 + 900], { h: 180, halign: 1 }, { layer: 'TEXT' });
      w.text(`${(R() * 100).toFixed(1)}%`, [x0 + 9500, y0 + 300], { h: 150, halign: 2 }, { layer: 'TEXT' });
      w.text('AISLE', [x0 + 5000, y0 + 6900], { h: 200, halign: 1, valign: 2 }, { layer: 'AISLE' });
      w.insert('MACHINE', [x0 + 5000, y0 + 8700], { rot: Math.floor(R() * 4) * 90 }, { layer: 'MACHINES' });
      w.point([x0 + 5000, y0 + 5000], { layer: 'POINTS' });
      w.point([x0 + 2500, y0 + 5000], { layer: 'POINTS' });
      w.line([x0 + 200, y0 + 6600], [x0 + S - 200, y0 + 6600], { layer: 'AISLE' });
      count += 58;
    }
  }
  return { text: w.toString(), entities: count };
}
