#!/usr/bin/env node
// SYNTHETIC PDF fixtures (invented subjects only; no real drawing or manual is read or copied).
//   node tools/make_pdf_fixtures.mjs           hand-written PDFs (tools/pdf-writer.mjs) -> tests/fixtures/pdf-*.pdf
//   NODE_PATH=<dir with playwright> node tools/make_pdf_fixtures.mjs --print
//                                              also vector PDFs printed by Linework itself: the repo's
//                                              synthetic samples on its print sheet, saved as PDF by Chromium
// The hand-written files are deterministic (tests/unit/pdf.test.mjs regenerates and compares them);
// the printed ones carry Chromium's dates and are only regenerated on request.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, Content, MM } from './pdf-writer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const MMS = '2.834645669291339'; // points per millimetre, written in full: user unit = 1 mm exactly

/** A4 plan in millimetres (a CAD-style PDF: user space scaled to mm). Known geometry for the tests. */
export function plan() {
  const c = new Content();
  c.gray(1).rect(0, 0, 595.28, 841.89, 'f'); // the producer's white page background
  c.op(`${MMS} 0 0 ${MMS} 0 0 cm`);
  c.width(0.35).gray(0);
  c.line(20, 20, 120, 20); // 100 mm
  c.rect(20, 40, 50, 30); // 50 x 30 mm box
  c.circle(150, 60, 10); // circle r 10 mm
  c.arc(150, 60, 20, 30, 150); // arc r 20 mm, 30..150 degrees
  c.stroke(1, 0, 0).line(20, 100, 190, 100); // red
  c.stroke(0, 0, 1).dash([4, 2]).line(20, 110, 190, 110).dash([]); // blue, dashed 4 mm / 2 mm
  c.q().op('/CS0 CS 1 SCN').width(0.7).line(20, 120, 190, 120).Q(); // spot colour (PostScript tint transform)
  c.fill(0, 0.6, 0).rect(140, 140, 30, 20, 'f'); // green box (fill only)
  c.gray(0).circle(100, 160, 1.5, 'f'); // black dot
  c.poly([20, 150, 40, 170, 60, 150, 80, 170], false); // zigzag polyline
  c.q().cm(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 60, 200).form('Fm1').Q(); // 30 degrees
  c.gray(0).text('PLAN VIEW A', 20, 260, { size: 5 });
  c.text('PUMP-7 INLET', 20, 250, { size: 3.5 });
  c.text('\xd825 \xb10.1 50\xb0C', 20, 240, { size: 3.5 }); // Ø25 ±0.1 50°C (WinAnsi)
  c.text('ELEV +2.50', 195, 150, { size: 3.5, rot: 90 });
  c.fill(1, 0, 0).text('KEEP CLEAR', 140, 130, { size: 3.5 });
  return makePdf({
    title: 'Synthetic plan (Linework test)',
    pages: [{
      size: [595.28, 841.89], content: String(c), fonts: { F1: 'Helvetica' },
      colorSpaces: { CS0: { name: 'SpotRed', fn: '{ 0 0 }' } },
      forms: { Fm1: { bbox: [-1, -1, 41, 16], content: '0.35 w 0 0 20 10 re S BT /F1 3 Tf 1 0 0 1 2 3 Tm (FORM 30) Tj ET' } },
      annots: [{ rect: [400, 700, 500, 750], content: '1 0 0 RG 2 w 1 1 98 48 re S', text: 'Check this' }],
    }],
  });
}

/** Tabloid (17 x 11 in) wiring diagram: lots of text, layers (one off by default), junction dots. */
export function schematic() {
  const c = new Content();
  const wires = [], labels = [], notes = [];
  c.width(1).gray(0);
  c.rect(18, 18, 1188, 756); // border
  // title block
  c.rect(900, 18, 306, 90);
  c.poly([900, 63, 1206, 63]);
  c.text('WIRING DIAGRAM - PUMP SKID', 910, 80, { size: 12 });
  c.text('SHEET 3 OF 9', 910, 40, { size: 9 });
  c.text('DWG NO 00-000-TEST', 1040, 40, { size: 9 });
  c.fill(1, 0, 0).text('CAUTION: DE-ENERGIZE BEFORE SERVICE', 40, 740, { size: 12 }).gray(0);
  c.text('\xd810 STUD  \xb10.5  85\xb0C MAX', 40, 720, { size: 9 });
  // connectors J1..J12 (4 columns x 3 rows), 6 pins each
  const pin = (j, p) => { const col = (j - 1) % 4, row = Math.floor((j - 1) / 4); return [120 + col * 260 + (col % 2 ? 0 : 60), 600 - row * 190 - p * 20]; };
  for (let j = 1; j <= 12; j++) {
    const [x, y] = pin(j, 0);
    c.rect(x - 8, y - 130, 60, 140);
    c.text(`J${j}`, x, y + 16, { size: 11 });
    for (let p = 1; p <= 6; p++) c.text(String(p), x + 4, pin(j, p)[1] - 3, { size: 8 });
  }
  // wires: pin p of Jj to pin p of J(j+1) on each row
  let w = 101;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const j = row * 4 + col + 1;
      for (let p = 1; p <= 5; p++) {
        const a = pin(j, p), b = pin(j + 1, p);
        const x0 = a[0] + 52, x1 = b[0] - 8, xm = (x0 + x1) / 2 + (p - 3) * 6;
        wires.push([x0, a[1], xm, a[1], xm, b[1], x1, b[1]]);
        labels.push([`W${w++}`, x0 + 6, a[1] + 3]);
      }
    }
  }
  c.layer('ocW', (k) => { k.stroke(0, 0, 0.8).width(1.2); for (const pts of wires) k.poly(pts); });
  c.layer('ocL', (k) => { k.fill(0, 0, 0.8); for (const [s, x, y] of labels) k.text(s, x, y, { size: 7 }); });
  // junction dots (filled circles) where a wire branches
  c.gray(0);
  for (let i = 0; i < 8; i++) { const p = wires[i * 5]; c.circle(p[2], p[3], 3, 'f'); }
  notes.push('NOTE 1: ALL WIRE 22 AWG UNLESS NOTED', 'NOTE 2: SHIELDS GROUNDED AT ONE END', 'NOTE 3: SEE SHEET 4 FOR PANEL LAYOUT');
  c.layer('ocN', (k) => { k.gray(0); notes.forEach((s, i) => k.text(s, 40, 160 - i * 14, { size: 9 })); });
  return makePdf({
    title: 'Synthetic wiring diagram (Linework test)',
    layers: [{ name: 'Wires' }, { name: 'Wire numbers' }, { name: 'Notes', on: false }],
    pages: [{ size: [1224, 792], content: String(c), fonts: { F1: 'Helvetica' }, props: { ocW: 0, ocL: 1, ocN: 2 } }],
  });
}

/** Three pages: Letter (inches), A4 landscape with an offset media box (mm), Letter turned by /Rotate 90. */
export function multipage() {
  const p1 = new Content().width(1).gray(0).line(72, 72, 216, 72).text('PAGE ONE', 72, 720, { size: 24 });
  const p2 = new Content().width(1).gray(0).line(150, 150, 150 + 50 * MM, 150).text('PAGE TWO', 200, 600, { size: 24 });
  // an L: the long leg up the page, the short leg to the right (user space), and a label
  const p3 = new Content().width(1).gray(0).poly([100, 300, 100, 100, 200, 100]).text('PAGE THREE', 100, 400, { size: 24 });
  return makePdf({
    title: 'Synthetic pages (Linework test)',
    labels: [0, { S: '/r' }, 1, { S: '/D', St: 1 }], // i, 1, 2
    pages: [
      { size: [612, 792], content: String(p1), fonts: { F1: 'Helvetica' } },
      { mediaBox: [100, 100, 100 + 842, 100 + 595], content: String(p2), fonts: { F1: 'Helvetica' } },
      { size: [612, 792], rotate: 90, content: String(p3), fonts: { F1: 'Helvetica' } },
    ],
  });
}

/** A scanned page: one greyscale picture covering the page, with invisible text (as OCR leaves it). */
export function scan() {
  const W = 425, H = 550; // 50 dpi on Letter
  const img = Buffer.alloc(W * H, 250);
  const dot = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) img[(y | 0) * W + (x | 0)] = 25; };
  const line = (x0, y0, x1, y1) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)); for (let k = 0; k <= n; k++) { dot(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n); dot(x0 + ((x1 - x0) * k) / n + 1, y0 + ((y1 - y0) * k) / n); } };
  const box = (x, y, w, h) => { line(x, y, x + w, y); line(x + w, y, x + w, y + h); line(x + w, y + h, x, y + h); line(x, y + h, x, y); };
  box(12, 12, W - 24, H - 24); // border (image rows run top to bottom)
  box(250, 470, 163, 68); // title block
  for (let a = 0; a < 360; a += 0.5) dot(150 + 60 * Math.cos((a * Math.PI) / 180), 200 + 60 * Math.sin((a * Math.PI) / 180));
  line(90, 200, 300, 200); line(150, 100, 150, 330);
  for (let i = 0; i < 8; i++) box(60 + i * 40, 380, 30, 12); // "text" blocks
  const c = new Content().image('Im1', 0, 0, 612, 792);
  c.gray(0).text('PUMP-7 INLET', 72, 230, { size: 14, mode: 3 }); // OCR text: invisible
  return makePdf({ title: 'Synthetic scan (Linework test)', pages: [{ size: [612, 792], content: String(c), fonts: { F1: 'Helvetica' }, images: { Im1: { w: W, h: H, data: img } } }] });
}

const tiny = (s) => ({ size: [595.28, 841.89], content: String(new Content().width(1).gray(0).line(100, 100, 300, 100).text(s, 100, 120, { size: 20 })), fonts: { F1: 'Helvetica' } });
/** Opening needs a password (RC4, user password "secret"). */
export const password = () => makePdf({ pages: [tiny('SECRET')], encrypt: { user: 'secret', owner: 'owner-secret' } });
/** Encrypted with an owner password only (anyone may open it, as many PDFs are). */
export const ownerOnly = () => makePdf({ pages: [tiny('OWNER ONLY')], encrypt: { user: '', owner: 'owner-secret' } });
/** A damaged file: a PDF header, then the start of an object and noise (no pages, no cross-references). */
export function broken() {
  let x = 7;
  const noise = Buffer.alloc(3000);
  for (let i = 0; i < noise.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; noise[i] = 32 + (x % 90); }
  return Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R', 'latin1'), noise]);
}

export const FIXTURES = {
  'pdf-plan.pdf': plan,
  'pdf-schematic.pdf': schematic,
  'pdf-multipage.pdf': multipage,
  'pdf-scan.pdf': scan,
  'pdf-password.pdf': password,
  'pdf-owner.pdf': ownerOnly,
  'pdf-broken.pdf': broken,
};
/** Vector PDFs printed by Linework (Chromium): [sample, sheet, scale, orientation, file]. */
export const PRINTS = [
  ['house-plan.dxf', 'a3', '1:100', 'landscape', 'pdf-print-house-plan.pdf'],
  ['schematic.dxf', 'letter', 'Fit', 'landscape', 'pdf-print-schematic.pdf'],
];

async function prints() {
  const { startServer } = await import('./serve.mjs');
  const { launch } = await import('../tests/e2e/browser.mjs');
  const server = await startServer(0);
  const browser = await launch();
  try {
    for (const [sample, sheet, scale, orient, file] of PRINTS) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/?nosw`);
      await page.waitForFunction(() => !!window.__linework);
      await page.evaluate((k) => window.__linework.openSample(k), 'samples/' + sample);
      await page.waitForFunction((n) => window.__linework.doc && window.__linework.doc.name === n && !window.__linework.loading, sample);
      await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
      await page.click('#btn-print');
      await page.waitForFunction(() => document.querySelector('#pr-info').textContent.length > 0);
      await page.selectOption('#pr-sheet', sheet);
      await page.check(`input[name="orient"][value="${orient}"]`);
      await page.check('input[name="area"][value="all"]');
      await page.fill('#pr-scale', scale);
      await page.click('#btn-do-print');
      await page.waitForFunction(() => window.__printed);
      await page.emulateMedia({ media: 'print' });
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      writeFileSync(join(FIX, file), pdf);
      console.log('wrote', `tests/fixtures/${file}`, `${(pdf.length / 1024).toFixed(1)} KB`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(FIX, { recursive: true });
  for (const [name, make] of Object.entries(FIXTURES)) {
    const b = make();
    writeFileSync(join(FIX, name), b);
    console.log('wrote', `tests/fixtures/${name}`, `${(b.length / 1024).toFixed(1)} KB`);
  }
  if (process.argv.includes('--print')) await prints();
}
