// SYNTHETIC sample drawings (invented subjects only). Used by tools/make_fixtures.mjs to write
// samples/*.dxf. Every drawing here is made up from scratch; none is derived from a real drawing.
import { DxfWriter } from './dxf-writer.js';

/** Single-storey house floor plan, millimetres, R2013 (UTF-8). */
export function housePlan() {
  const w = new DxfWriter({ version: 'AC1027', insunits: 4, codepage: 'ANSI_1252', extents: [-1500, -2500, 13500, 9500] });
  w.layer('WALLS', 7).layer('DOORS', 1).layer('WINDOWS', 4).layer('FURNITURE', 8).layer('TEXT', 2)
    .layer('DIMS', 3).layer('GRID', 9, 'DASHED').layer('DEFPOINTS', 7, 'CONTINUOUS', { off: true });
  w.ltype('DASHED', 'Dashed __ __ __', [400, -200]);

  w.block('DOOR', [0, 0], (b) => {
    b.line([0, 0], [0, 900], { layer: '0' });
    b.arc([0, 0], 900, 0, 90, { layer: '0' });
  });
  w.block('WINDOW', [0, 0], (b) => {
    b.lwpolyline([[0, 0], [1200, 0], [1200, 200], [0, 200]], true, { layer: '0' });
    b.line([0, 80], [1200, 80], { layer: '0' });
    b.line([0, 120], [1200, 120], { layer: '0' });
  });
  w.block('CHAIR', [0, 0], (b) => {
    b.lwpolyline([[-220, -200], [220, -200], [220, 200], [-220, 200]], true, { layer: '0' });
    b.lwpolyline([[-220, 200], [220, 200], [220, 260], [-220, 260]], true, { layer: '0' });
  });
  w.block('NORTH', [0, 0], (b) => {
    b.circle([0, 0], 400, { layer: '0' });
    b.solid([[0, 380], [-160, -250], [0, -120], [160, -250]], { layer: '0' });
    b.text('N', [0, 520], { h: 220, halign: 1 }, { layer: '0' });
  });

  // walls: outer ring + interior partitions (closed polylines)
  w.lwpolyline([[0, 0], [12000, 0], [12000, 8000], [0, 8000]], true, { layer: 'WALLS' });
  w.lwpolyline([[200, 200], [11800, 200], [11800, 7800], [200, 7800]], true, { layer: 'WALLS' });
  const wall = (x0, y0, x1, y1) => w.lwpolyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, { layer: 'WALLS' });
  wall(5000, 200, 5100, 2600); wall(5000, 3500, 5100, 7800);      // living | lounge (door gap)
  wall(5100, 4000, 6000, 4100); wall(6900, 4000, 8500, 4100);      // lounge | hall (door gap)
  wall(8500, 200, 8600, 1800); wall(8500, 2700, 8600, 4100);       // lounge | kitchen (door gap)
  wall(8500, 5000, 8600, 7800);                                    // hall | bath (door gap below)
  wall(8600, 4000, 11800, 4100);                                   // kitchen | bath
  wall(200, 4000, 3900, 4100); wall(4800, 4000, 5000, 4100);       // living | bedroom (door gap)
  // corner columns (solid hatch)
  for (const [x, y] of [[0, 0], [12000, 0], [12000, 8000], [0, 8000]]) {
    w.hatch([[[x - 150, y - 150], [x + 150, y - 150], [x + 150, y + 150], [x - 150, y + 150]]], { solid: true }, { layer: 'WALLS' });
  }

  // doors (leaf drawn open, arc to the closed position), every one swinging into a room:
  // plain, rotated, mirrored in X or Y, and mirrored + rotated
  w.insert('DOOR', [3900, 4100], {}, { layer: 'DOORS' });                     // living -> bedroom
  w.insert('DOOR', [5000, 2600], { rot: 90 }, { layer: 'DOORS' });           // lounge -> living
  w.insert('DOOR', [6000, 4000], { sy: -1 }, { layer: 'DOORS' });            // hall -> lounge
  w.insert('DOOR', [8600, 1800], { rot: 270, sx: -1 }, { layer: 'DOORS' });  // lounge -> kitchen
  w.insert('DOOR', [8600, 4100], { rot: 90, sy: -1 }, { layer: 'DOORS' });   // hall -> bath
  w.insert('DOOR', [5300, 7800], { rot: 180, sx: -1 }, { layer: 'DOORS' });  // front door
  w.insert('DOOR', [2000, 200], { sx: -1 }, { layer: 'DOORS' });            // back door

  // windows
  w.insert('WINDOW', [1200, 7800], {}, { layer: 'WINDOWS' });
  w.insert('WINDOW', [3200, 7800], {}, { layer: 'WINDOWS' });
  w.insert('WINDOW', [6200, 7800], { sx: 1.5 }, { layer: 'WINDOWS' });
  w.insert('WINDOW', [12000, 1500], { rot: 90 }, { layer: 'WINDOWS' });
  w.insert('WINDOW', [12000, 5200], { rot: 90 }, { layer: 'WINDOWS' });
  w.insert('WINDOW', [200, 2000], { rot: 90 }, { layer: 'WINDOWS' });
  w.insert('WINDOW', [9400, 0], {}, { layer: 'WINDOWS' });

  // furniture
  const F = { layer: 'FURNITURE' };
  w.lwpolyline([[1000, 5200], [3600, 5200], [3600, 7400], [1000, 7400]], true, F); // bed
  w.lwpolyline([[1200, 6800], [2200, 6800], [2200, 7300], [1200, 7300]], true, F);
  w.lwpolyline([[2400, 6800], [3400, 6800], [3400, 7300], [2400, 7300]], true, F);
  w.line([1000, 6600], [3600, 6600], F);
  w.circle([2700, 1700], 600, F); // dining table
  w.insert('CHAIR', [2700, 850], {}, F);
  w.insert('CHAIR', [2700, 2550], { rot: 180 }, F);
  w.insert('CHAIR', [1850, 1700], { rot: 270 }, F);
  w.insert('CHAIR', [3550, 1700], { rot: 90 }, F);
  // sofa with rounded corners (bulges)
  w.lwpolyline([[5600, 600, 0], [7600, 600, 0.41421356], [7800, 800, 0], [7800, 1500, 0.41421356], [7600, 1700, 0],
    [5600, 1700, 0.41421356], [5400, 1500, 0], [5400, 800, 0.41421356]], true, F);
  w.lwpolyline([[5600, 1350], [7600, 1350]], false, F);
  // bath
  w.lwpolyline([[9900, 6000], [11600, 6000], [11600, 7600], [9900, 7600]], true, F);
  w.ellipse([10750, 6800], [700, 0], 0.55, 0, Math.PI * 2, F);
  w.circle([10750, 6300], 40, F);
  // kitchen counter (L) + sink
  w.lwpolyline([[8700, 300], [11700, 300], [11700, 3900], [11100, 3900], [11100, 900], [8700, 900]], true, F);
  w.lwpolyline([[11200, 2000], [11600, 2000], [11600, 2700], [11200, 2700]], true, F);
  w.circle([11400, 2350], 50, F);

  // room labels (middle-centre aligned) and areas
  const T = { layer: 'TEXT' };
  const room = (name, x, y, area) => {
    w.text(name, [x, y], { h: 250, halign: 1, valign: 2 }, T);
    w.text(`${area} m²`, [x, y - 400], { h: 180, halign: 1, valign: 2 }, T);
  };
  room('LIVING / DINING', 2600, 3500, '31.4');
  room('BEDROOM', 2300, 4750, '13.9');
  room('LOUNGE', 6600, 2500, '12.2');
  room('HALL', 6500, 6000, '12.9');
  room('KITCHEN', 10200, 2000, '10.4');
  room('BATH', 10400, 5200, '9.6');
  w.mtext('GROUND FLOOR PLAN\\PScale 1:100 — all dimensions in millimetres', [0, -1300], { h: 300, width: 9000, attach: 1 }, T);
  w.insert('NORTH', [12900, 8800], { rot: 0 }, T);

  // grid lines + dimensions
  w.line([-700, 4000], [12700, 4000], { layer: 'GRID' });
  w.linearDim([0, 0], [12000, 0], [0, -700], 0, { h: 250, arrow: 200 }, { layer: 'DIMS' });
  w.linearDim([12000, 0], [12000, 8000], [12700, 0], 90, { h: 250, arrow: 200 }, { layer: 'DIMS' });
  w.linearDim([0, 8000], [5000, 8000], [0, 8600], 0, { h: 250, arrow: 200 }, { layer: 'DIMS' });
  return w.toString();
}

/** Machined angle bracket with two views, dimensions, hatching and a title block. mm, R2000. */
export function bracket() {
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('OUTLINE', 7).layer('HIDDEN', 6, 'HIDDEN').layer('CENTER', 1, 'CENTER').layer('DIMS', 3)
    .layer('HATCH', 8).layer('TEXT', 2).layer('TITLE', 7).layer('HARDWARE', 5).layer('DEFPOINTS', 7);
  w.ltype('HIDDEN', 'Hidden __ __ __', [6, -3]).ltype('CENTER', 'Center ____ _ ____', [18, -3, 3, -3]);
  w.style('ISO', { width: 0.9 });

  w.block('WASHER', [0, 0], (b) => {
    b.circle([0, 0], 9, { layer: '0' });
    b.circle([0, 0], 5.5, { layer: '0' });
  });
  w.block('BOLT', [0, 0], (b) => {
    const hex = [];
    for (let k = 0; k < 6; k++) hex.push([8 * Math.cos((k * Math.PI) / 3), 8 * Math.sin((k * Math.PI) / 3)]);
    b.lwpolyline(hex, true, { layer: '0' });
    b.insert('WASHER', [0, 0], {}, { layer: '0' });
    b.line([-3, 0], [3, 0], { layer: '0' });
  });
  w.block('TITLEBLOCK', [0, 0], (b) => {
    const L = { layer: '0' };
    b.lwpolyline([[0, 0], [180, 0], [180, 40], [0, 40]], true, L);
    b.line([0, 20], [180, 20], L); b.line([110, 0], [110, 40], L); b.line([145, 0], [145, 20], L);
    b.text('EXAMPLE WORKS (FICTITIOUS)', [4, 30], { h: 5 }, L);
    b.attdef('TITLE', 'Drawing title', 'TITLE', [4, 8], { h: 6 }, L);
    b.attdef('DWGNO', 'Drawing number', '0000', [114, 30], { h: 4 }, L);
    b.attdef('SCALE', 'Scale', '1:1', [114, 8], { h: 4 }, L);
    b.attdef('REV', 'Revision', 'A', [150, 8], { h: 4 }, L);
    b.attdef('SECRET', 'Hidden note', 'x', [150, 30], { h: 4, constant: false }, L);
  });

  const O = { layer: 'OUTLINE' };
  // FRONT VIEW: L-profile with an inside fillet (bulge) at (20,10)->(10,20)
  w.lwpolyline([[0, 0], [120, 0], [120, 10], [20, 10, -0.41421356], [10, 20], [10, 80], [0, 80]], true, O);
  w.hatch([[[0, 0], [120, 0], [120, 10], [20, 10, -0.41421356], [10, 20], [10, 80], [0, 80]]], { solid: false, pattern: 'ANSI31' }, { layer: 'HATCH' });
  w.line([40, -6], [40, 16], { layer: 'CENTER' });
  w.line([95, -6], [95, 16], { layer: 'CENTER' });
  for (const x of [35, 45, 90, 100]) w.line([x, 0], [x, 10], { layer: 'HIDDEN' });
  w.line([-6, 55], [16, 55], { layer: 'CENTER' });
  for (const y of [49, 61]) w.line([0, y], [10, y], { layer: 'HIDDEN' });

  // TOP VIEW: plate 120 x 60 with two holes and a slot
  const ty = 120;
  w.lwpolyline([[0, ty], [120, ty], [120, ty + 60], [0, ty + 60]], true, O);
  w.line([10, ty], [10, ty + 60], { layer: 'HIDDEN' });
  w.circle([40, ty + 30], 5, O);
  w.circle([95, ty + 30], 5, O);
  for (const cx of [40, 95]) {
    w.line([cx - 9, ty + 30], [cx + 9, ty + 30], { layer: 'CENTER' });
    w.line([cx, ty + 21], [cx, ty + 39], { layer: 'CENTER' });
  }
  // slot: 10 wide, 10 between centres -> perimeter 20 + 10*pi, area 100 + 25*pi
  w.lwpolyline([[62.5, ty + 5, 0], [72.5, ty + 5, 1], [72.5, ty + 15, 0], [62.5, ty + 15, 1]], true, O);
  w.insert('BOLT', [40, ty + 30], { rot: 30 }, { layer: 'HARDWARE' });
  w.insert('BOLT', [95, ty + 30], { rot: 30 }, { layer: 'HARDWARE' });

  // SIDE VIEW (isometric-ish hole as an ellipse) and a spline break line
  const sx = 170;
  w.lwpolyline([[sx, 0], [sx + 60, 0], [sx + 60, 80], [sx, 80]], true, O);
  w.line([sx, 10], [sx + 60, 10], { layer: 'HIDDEN' });
  w.ellipse([sx + 30, 55], [6, 0], 0.5, 0, Math.PI * 2, O);
  w.ellipse([sx + 30, 30], [0, 8], 0.5, 0, Math.PI, O);
  w.spline([[sx - 5, 90], [sx + 10, 96], [sx + 25, 86], [sx + 40, 96], [sx + 55, 86], [sx + 65, 92]], 3, O);

  // DETAIL A: mirrored + scaled nested block (exercise transforms)
  w.insert('BOLT', [300, 140], { sx: -2, sy: 2, rot: 15 }, { layer: 'HARDWARE' });
  w.text('DETAIL A (2:1, MIRRORED)', [300, 112], { h: 4, halign: 1 }, { layer: 'TEXT' });

  // dimensions
  const D = { layer: 'DIMS' };
  w.linearDim([0, 0], [120, 0], [0, -14], 0, { h: 3.5, arrow: 3 }, D);
  w.linearDim([0, 0], [0, 80], [-14, 0], 90, { h: 3.5, arrow: 3 }, D);
  w.linearDim([40, ty + 30], [95, ty + 30], [0, ty + 70], 0, { h: 3.5, arrow: 3 }, D);
  w.linearDim([sx, 80], [sx + 60, 80], [0, 104], 0, { h: 3.5, arrow: 3 }, D);
  w.leader([[17, 13], [30, 30], [40, 30]], D);
  w.text('R10', [41, 29], { h: 3.5 }, { layer: 'TEXT' });
  w.leader([[77.5, ty + 10], [88, ty + 2], [104, ty + 2]], D);
  w.text('SLOT 10 WIDE', [105, ty + 1], { h: 3 }, { layer: 'TEXT' });
  w.text('2 x %%c10 THRU', [40, ty + 44], { h: 3.5, halign: 1 }, { layer: 'TEXT' });

  w.text('FRONT VIEW', [60, -30], { h: 5, halign: 1, style: 'ISO' }, { layer: 'TEXT' });
  w.text('TOP VIEW', [60, ty + 85], { h: 5, halign: 1, style: 'ISO' }, { layer: 'TEXT' });
  w.text('SIDE VIEW', [sx + 30, -30], { h: 5, halign: 1, style: 'ISO' }, { layer: 'TEXT' });
  w.mtext('NOTES:\\P1. ALL DIMENSIONS IN MILLIMETRES.\\P2. BREAK SHARP EDGES 0.5 MAX.\\P3. MATERIAL: ALUMINIUM ALLOY, 10 THICK.\\P4. TOLERANCE %%p0.2 UNLESS STATED.',
    [250, 70], { h: 3.5, width: 120, attach: 1 }, { layer: 'TEXT' });
  w.insert('TITLEBLOCK', [250, -60], {
    attribs: [
      { tag: 'TITLE', value: 'ANGLE BRACKET', at: [254, -52], h: 6 },
      { tag: 'DWGNO', value: 'LW-0001', at: [364, -30], h: 4 },
      { tag: 'SCALE', value: '1:1', at: [364, -52], h: 4 },
      { tag: 'REV', value: 'B', at: [400, -52], h: 4 },
      { tag: 'SECRET', value: 'INVISIBLE', at: [400, -30], h: 4, invisible: true },
    ],
  }, { layer: 'TITLE' });
  return w.toString();
}

/** Wiring-diagram-like schematic. R12 (POLYLINE/VERTEX, no subclass markers), unitless. */
export function schematic() {
  const w = new DxfWriter({ version: 'AC1009', insunits: null, codepage: 'ANSI_1252', padCodes: true, handles: false });
  w.layer('WIRES', 3).layer('SYMBOLS', 7).layer('LABELS', 2).layer('TERMINALS', 1).layer('BORDER', 8).layer('NOTES', 4);
  w.block('RES', [0, 0], (b) => {
    const z = [[0, 0], [0.2, 0], [0.25, 0.1], [0.35, -0.1], [0.45, 0.1], [0.55, -0.1], [0.65, 0.1], [0.75, -0.1], [0.8, 0], [1, 0]];
    b.polyline(z, false, { layer: '0' });
  });
  w.block('CAP', [0, 0], (b) => {
    b.line([0, 0], [0.45, 0], { layer: '0' }); b.line([0.55, 0], [1, 0], { layer: '0' });
    b.line([0.45, -0.18], [0.45, 0.18], { layer: '0' }); b.line([0.55, -0.18], [0.55, 0.18], { layer: '0' });
  });
  w.block('GND', [0, 0], (b) => {
    b.line([0, 0], [0, -0.2], { layer: '0' });
    b.line([-0.2, -0.2], [0.2, -0.2], { layer: '0' }); b.line([-0.13, -0.27], [0.13, -0.27], { layer: '0' }); b.line([-0.06, -0.34], [0.06, -0.34], { layer: '0' });
  });
  w.block('TERM', [0, 0], (b) => {
    b.circle([0, 0], 0.08, { layer: '0' });
    b.line([-0.06, -0.06], [0.06, 0.06], { layer: '0' });
    b.attdef('TAG', 'Terminal', 'X', [0, 0.15], { h: 0.1, halign: 1 }, { layer: '0' });
  });
  w.block('LED', [0, 0], (b) => {
    b.line([0, 0], [0.35, 0], { layer: '0' }); b.line([0.65, 0], [1, 0], { layer: '0' });
    b.solid([[0.35, 0.15], [0.35, -0.15], [0.62, 0]], { layer: '0' });
    b.line([0.65, -0.15], [0.65, 0.15], { layer: '0' });
    b.polyline([[0.5, 0.2], [0.65, 0.35]], false, { layer: '0' }); b.polyline([[0.6, 0.2], [0.75, 0.35]], false, { layer: '0' });
  });
  w.block('RELAY', [0, 0], (b) => {
    b.polyline([[0, -0.25], [0.6, -0.25], [0.6, 0.25], [0, 0.25]], true, { layer: '0' });
    b.line([0, 0.25], [0.6, -0.25], { layer: '0' });
  });
  w.block('SWITCH', [0, 0], (b) => {
    b.line([0, 0], [0.3, 0], { layer: '0' }); b.line([0.3, 0], [0.7, 0.2], { layer: '0' }); b.line([0.7, 0], [1, 0], { layer: '0' });
    b.circle([0.3, 0], 0.03, { layer: '0' }); b.circle([0.7, 0], 0.03, { layer: '0' });
  });

  const S = { layer: 'SYMBOLS' }, W = { layer: 'WIRES' }, L = { layer: 'LABELS' };
  // border + title
  w.polyline([[0, 0], [17, 0], [17, 11], [0, 11]], true, { layer: 'BORDER' });
  w.polyline([[11, 0], [17, 0], [17, 1.5], [11, 1.5]], true, { layer: 'BORDER' });
  w.text('PUMP CONTROL - EXAMPLE', [11.2, 0.9], { h: 0.22 }, { layer: 'BORDER' });
  w.text('SHEET 1 OF 1   SYNTHETIC SAMPLE', [11.2, 0.35], { h: 0.14 }, { layer: 'BORDER' });

  // supply rails
  w.line([1, 9.5], [15, 9.5], W); w.line([1, 2], [15, 2], W);
  w.text('+24V', [0.9, 9.5], { h: 0.18, halign: 2, valign: 2 }, L);
  w.text('0V', [0.9, 2], { h: 0.18, halign: 2, valign: 2 }, L);
  // three branches
  for (let k = 0; k < 3; k++) {
    const x = 3 + k * 4;
    w.insert('TERM', [x, 9.5], { attribs: [{ tag: 'TAG', value: `X${k + 1}`, at: [x, 9.65], h: 0.1, halign: 1 }] }, { layer: 'TERMINALS' });
    w.line([x, 9.5], [x, 8.5], W);
    w.insert('SWITCH', [x, 8.5], { rot: 270 }, S);
    w.text(`S${k + 1}`, [x + 0.25, 8], { h: 0.15, valign: 2 }, L);
    w.line([x, 7.5], [x, 6.5], W);
    w.insert('RES', [x, 6.5], { rot: 270 }, S);
    w.text(`R${k + 1} 4k7`, [x - 0.2, 6], { h: 0.15, rot: 90, halign: 1 }, L);
    w.line([x, 5.5], [x, 5], W);
    w.insert('LED', [x, 5], { rot: 270 }, S);
    w.text(`D${k + 1}`, [x + 0.25, 4.5], { h: 0.15, valign: 2 }, L);
    w.line([x, 4], [x, 3.5], W);
    w.insert('RELAY', [x - 0.3, 3.2], {}, S);
    w.line([x, 2.95], [x, 2], W);
    w.text(`K${k + 1}`, [x + 0.45, 3.2], { h: 0.15, valign: 2 }, L);
    w.circle([x, 2], 0.05, W);
    w.solid([[x - 0.04, 2], [x, 2.04], [x, 1.96], [x + 0.04, 2]], W);
    w.text(`W${101 + k}`, [x + 0.08, 9.0], { h: 0.12, rot: 270 }, L);
  }
  w.insert('CAP', [14, 9.5], { rot: 270 }, S);
  w.line([14, 8.5], [14, 2], W);
  w.text('C1 100n', [14.25, 9], { h: 0.15, valign: 2 }, L);
  w.insert('GND', [15, 2], {}, S);
  w.text('UPSIDE', [16, 6], { h: 0.2, rot: 180, halign: 1 }, L);

  // text alignment grid: every halign x valign combo with a marker at the alignment point
  const N = { layer: 'NOTES' };
  const names = ['L', 'C', 'R'], vnames = ['BASE', 'BOT', 'MID', 'TOP'];
  for (let v = 0; v < 4; v++) {
    for (let h = 0; h < 3; h++) {
      const px = 1 + h * 1.5, py = 0.35 + v * 0.3;
      w.line([px - 0.04, py], [px + 0.04, py], { layer: 'TERMINALS' });
      w.line([px, py - 0.04], [px, py + 0.04], { layer: 'TERMINALS' });
      w.text(`${names[h]}-${vnames[v]}`, [px, py], { h: 0.1, halign: h, valign: v }, N);
    }
  }
  w.text('TEXT ALIGNMENT KEY', [1, 1.6], { h: 0.14 }, N);
  return w.toString();
}
