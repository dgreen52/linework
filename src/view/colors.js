// Theme-aware colour resolution for drawing colours.
import { FG } from '../model.js';

export const THEMES = {
  dark: { bg: '#0f1216', fg: 0xffffff, name: 'Dark' },
  paper: { bg: '#ffffff', fg: 0x000000, name: 'Paper' },
};

const cache = { dark: new Map(), paper: new Map() };

function lum(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const hex = (v) => '#' + (v & 0xffffff).toString(16).padStart(6, '0');

/**
 * Resolve a scene colour (0xRRGGBB or FG) to a CSS colour for the theme. Foreground (ACI 7)
 * swaps white/black; colours with too little contrast against the background are nudged so
 * every line stays visible (yellow on paper becomes dark gold, dark grey on black lightens).
 */
export function cssColor(c, theme) {
  const t = THEMES[theme] ? theme : 'dark';
  if (c === FG || c === undefined) return hex(THEMES[t].fg);
  const m = cache[t];
  let s = m.get(c);
  if (s) return s;
  let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const L = lum(r, g, b);
  if (t === 'paper') {
    if (L > 0.98) { r = g = b = 0; } // white on paper -> black (common for "white" layers)
    else if (L > 0.45) { const k = Math.sqrt(0.38 / L) * 0.85; r *= k; g *= k; b *= k; }
  } else if (L < 0.06) {
    if (L < 0.0005) { r = g = b = 255; } // black on dark -> white
    else { const k = 0.35; r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
  }
  s = hex((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b));
  m.set(c, s);
  return s;
}
