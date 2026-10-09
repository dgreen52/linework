#!/usr/bin/env node
// Lossless PNG re-encoder for the app icons (no dependencies): decodes 8-bit RGBA PNGs, clears
// the colour of fully transparent pixels (invisible), and re-deflates at maximum compression with
// the row filter that compresses best. Used by tools/make_icons.mjs; can also run on files:
//   node tools/optimize_png.mjs icons/icon-192.png icons/icon-512.png
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

export function optimizePng(png) {
  const b = Buffer.from(png);
  let o = 8, ihdr = null;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    if (type === 'IHDR') ihdr = b.subarray(o + 8, o + 8 + len);
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  if (!ihdr || ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) return b; // only 8-bit RGBA, not interlaced
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), bpp = 4, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const v = raw[line + x];
      px[y * stride + x] = (ft === 1 ? v + a : ft === 2 ? v + up : ft === 3 ? v + ((a + up) >> 1) : ft === 4 ? v + paeth(a, up, c) : v) & 255;
    }
  }
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 0) px[i] = px[i + 1] = px[i + 2] = 0;
  let best = null;
  for (const ft of [0, 2]) {
    const out = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) {
      out[y * (stride + 1)] = ft;
      for (let x = 0; x < stride; x++) out[y * (stride + 1) + 1 + x] = (px[y * stride + x] - (ft === 2 && y ? px[(y - 1) * stride + x] : 0)) & 255;
    }
    const z = zlib.deflateSync(out, { level: 9, memLevel: 9 });
    if (!best || z.length < best.length) best = z;
  }
  const res = Buffer.concat([b.subarray(0, 8), chunk('IHDR', Buffer.from(ihdr)), chunk('IDAT', best), chunk('IEND', Buffer.alloc(0))]);
  return res.length < b.length ? res : b;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2)) {
    const before = readFileSync(f);
    const after = optimizePng(before);
    writeFileSync(f, after);
    console.log(f, before.length, '->', after.length, 'bytes');
  }
}
