// Format detection by content (never trust the extension alone) and a single parse entry point.
import { FormatError } from '../model.js';
import { parseDxf, isBinaryDxf } from './dxf.js';
import { parseDgn, isDgnV7, isOleCompound } from './dgn.js';

/** Returns 'dxf' | 'dxf-binary' | 'dgn' | 'dgn-v8' | 'dwg' | 'pdf' | 'unknown'. */
export function detectFormat(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ext = String(name).toLowerCase().split('.').pop();
  if (isDgnV7(b)) return 'dgn';
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  if (head.startsWith('%PDF-')) return 'pdf';
  if (isOleCompound(b)) return ext === 'dgn' ? 'dgn-v8' : 'unknown';
  if (isBinaryDxf(b)) return 'dxf-binary';
  // DWG files start with the ASCII version magic "AC10xx" / "AC1.40" etc.
  if (b.length >= 6 && b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x31 && (b[3] === 0x30 || b[3] === 0x2e) && ext !== 'dxf') return 'dwg';
  if (looksLikeAsciiDxf(b)) return 'dxf';
  if (head.includes('%PDF-')) return 'pdf'; // a PDF with a few bytes before its header
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'dgn') return 'dgn';
  return 'unknown';
}

function looksLikeAsciiDxf(b) {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 4096));
  return /^\s*(?:999\s*\r?\n[^\n]*\r?\n\s*)?0\s*\r?\n\s*SECTION/i.test(head.replace(/^﻿|^ï»¿/, '')) || /\n\s*0\s*\r?\n\s*SECTION\s*\r?\n/.test(head);
}

/** Parse any supported drawing. Throws FormatError with a friendly message for unsupported input. */
export function parseDrawing(bytes, name = '', opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!b.length) throw new FormatError('empty', 'The file is empty.');
  const fmt = detectFormat(b, name);
  switch (fmt) {
    case 'dxf': return parseDxf(b, opts);
    case 'dgn': return parseDgn(b, opts);
    case 'dxf-binary':
      throw new FormatError('binary-dxf', 'Binary DXF is not supported yet. Please save the drawing as an ASCII DXF and open that instead.');
    case 'dwg': case 'pdf':
      throw new FormatError(fmt + '-async', 'Use parseDrawingAsync for DWG and PDF.');
    case 'dgn-v8':
      throw new FormatError('dgn-v8', 'This looks like a DGN v8 file. Only DGN v7 is supported in this version. Save it as DGN v7 or export to DXF.');
    default:
      throw new FormatError('unknown', `"${name || 'This file'}" is not a drawing this app can open. Supported: DXF (ASCII), DWG (R13 to 2018), DGN v7 and PDF.`);
  }
}

/** Async version: a DWG or PDF loads its reader on first use. */
export async function parseDrawingAsync(bytes, name = '', opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const f = b.length ? detectFormat(b, name) : '';
  return f === 'dwg' ? (await import('./dwg.js')).parseDwg(b, opts) : f === 'pdf' ? (await import('./pdf.js')).parsePdf(b, opts) : parseDrawing(b, name, opts);
}
