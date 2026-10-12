// Linework as a library: the readers, the scene builder, find, compare, wire tracing, sheet-set helpers
// (titles, search across sheets, sheet references), the writers and the vector (SVG) builder, for Node
// or any ES module host, without the browser app.
//
//   import { parseDrawingAsync, buildScene, findTexts, buildNetGraph, traceNet, buildSvg } from 'linework/core';
//
// This file is NOT part of the web app: nothing in src/ imports it, it is not precached by sw.js and
// make_dist.mjs does not deploy it (tests/unit/core.test.mjs checks all three). Every module it
// re-exports is plain ES and DOM-free at import time. In Node, pass the DWG reader's bytes yourself:
//   parseDrawingAsync(bytes, name, { wasmBytes: readFileSync(DWG_WASM_URL) })
import '../src/version.js';

export { detectFormat, parseDrawing, parseDrawingAsync } from '../src/formats/detect.js';
export { FG, FormatError, UNITS, unitsFromCode, unitsFromLabel, createModel, ensureLayer, flatEntities, modelSummary } from '../src/model.js';
export {
  buildScene, KIND, FLAG, TEXT_ID, MAX_EXPANDED, NS_COPIES, queryRect, primPoints, conicPoint, layoutMtext,
  packTexts, unpackTexts, sceneTransferables, DXF_LW, DGN_LW, weightPx,
} from '../src/scene.js';
export { entityItems, entityBBox, liveExtents } from '../src/edit/live-scene.js';
export { findTexts, findRegex, replaceChanges } from '../src/edit/find.js';
export { entityInfo, typeName, colorOf } from '../src/edit/attrs.js';
export { partAt, isText } from '../src/edit/ops.js';
export { describeScene, diffScenes, quantum, hashStr } from '../src/tools/compare.js';
export { measure, fmtNum } from '../src/tools/measure.js';
// wire tracing: buildNetGraph(scene, { tol }) once per drawing, then pickWire(G, x, y, r) and traceNet(G, wire, { crossings,
// throughPins }) — scene-local coordinates (add scene.origin for drawing coordinates)
export { ROLE, buildNetGraph, buildNetGraphAsync, pickWire, traceNet, endText, netText, textQuad } from '../src/tools/trace.js';
// sheet sets: text index of a sheet (title, own sheet number), search across sheets, sheet references
export {
  SHEET_EXTS, isSheetName, stemOf, naturalCmp, indexSheet, searchIndex, searchSheets, XREF_DEFAULT, compilePatterns, xrefContext,
  resolveRef, findXrefs,
} from '../src/tools/sheets.js';
export {
  TAU, bulgePolylineLength, bulgePolygonArea, polylineLength, polygonArea, signedArea, distToPolyline, nearestOnSeg,
  segSeg, bboxOf, pointInPolygon,
} from '../src/geom.js';
export { writeDxf } from '../src/formats/dxf-write.js';
export { writeDgn } from '../src/formats/dgn-write.js';
export { dwgVersion, parseDwg, MAX_DWG_BYTES, READER_REV } from '../src/formats/dwg.js';
export { buildSvg, printLayout, parseScale, ratioLabel, widthMm, unitMm, SHEETS } from '../src/app/print-svg.js';
export { cssColor, THEMES } from '../src/view/colors.js';
export { hashBytes } from '../src/worker.js';

/** Linework's version (src/version.js). */
export const VERSION = globalThis.LINEWORK_VERSION;
/** The DWG reader (GNU LibreDWG compiled to WebAssembly): read it and pass it as `wasmBytes`. */
export const DWG_WASM_URL = new URL('../vendor/libredwg/libredwg-web.wasm', import.meta.url);
