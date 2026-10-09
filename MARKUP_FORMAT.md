# Markup sidecar format (`.markup.json`), version 1

Markups are never written into the drawing. They live in a small JSON file saved next to it,
named `<drawing file name>.markup.json` (for example `house-plan.dxf.markup.json`). The file is
plain JSON, UTF-8, and can be read by any tool.

All coordinates are **drawing (world) coordinates** in the drawing's own units, exactly as the
drawing file stores them (DXF WCS; DGN master units after the global origin). They do not depend
on the screen, zoom level or device, so a markup stays attached to the same spot of the drawing
everywhere. Numbers are written with full double precision.

## Top level

| Field      | Type   | Meaning |
|------------|--------|---------|
| `schema`   | string | Always `"linework-markup"`. Files without it are rejected. |
| `version`  | int    | Format version. This document describes `1`. Readers must reject versions newer than they know. |
| `app`      | object | `{ "name", "version" }` of the app that saved the file (informational). |
| `drawing`  | object | `{ "name", "size", "format", "units" }` of the drawing the markups belong to. Used to warn when markups are loaded onto a different drawing; never required to match. |
| `created`  | string | ISO 8601 time the markup set was first created. |
| `saved`    | string | ISO 8601 time of this save. |
| `markups`  | array  | The markups, in drawing order (later ones draw on top). |

## One markup

| Field      | Type     | Meaning |
|------------|----------|---------|
| `id`       | string   | Unique within the file. |
| `type`     | string   | One of `pen`, `line`, `arrow`, `rect`, `ellipse`, `cloud`, `callout`, `highlight`. |
| `pts`      | number[] | Flat list `[x0, y0, x1, y1, ...]` in drawing units (see below). At least two points. |
| `color`    | string   | `#rrggbb`. |
| `width`    | number   | Stroke width in **screen pixels** (0.5 – 64). Strokes stay crisp at any zoom. |
| `opacity`  | number   | Optional, `highlight` only (0.05 – 1, default 0.35). |
| `text`     | string   | `callout` only. `\n` separates lines. |
| `size`     | number   | `callout` only: text height in drawing units (text scales with the drawing, like a note on paper). |
| `arc`      | number   | `cloud` only: scallop chord length in drawing units. |
| `author`   | string   | Name entered in the Markup tab ("" if none). |
| `created`  | string   | ISO 8601 creation time. |
| `modified` | string   | ISO 8601 time of the last change (move, restyle, text edit). |

### Meaning of `pts` per type

| Type        | Points |
|-------------|--------|
| `pen`       | The smoothed freehand path. |
| `highlight` | Freehand path drawn with a wide translucent stroke. |
| `line`      | Start, end. |
| `arrow`     | Tail, tip (the arrowhead is drawn at the second point). |
| `rect`      | Four corners, counter-clockwise. |
| `ellipse`   | Two opposite corners of the bounding box. |
| `cloud`     | Polygon vertices (closed implicitly). Scallops are generated along the edges with chord length `arc`, always bulging outward. |
| `callout`   | Arrow tip (the thing being pointed at), then the point where the leader meets the text box. The box extends to the right of that point if it is right of the tip, otherwise to the left. |

## Example

```json
{
  "schema": "linework-markup",
  "version": 1,
  "app": { "name": "Linework", "version": "0.1.0" },
  "drawing": { "name": "house-plan.dxf", "size": 15123, "format": "DXF", "units": "mm" },
  "created": "2026-10-08T14:03:11.000Z",
  "saved": "2026-10-08T14:05:42.000Z",
  "markups": [
    {
      "id": "mk1",
      "type": "cloud",
      "pts": [9900, 6000, 11600, 6000, 11600, 7600, 9900, 7600],
      "color": "#e5262b",
      "width": 2,
      "arc": 250,
      "author": "J. Smith",
      "created": "2026-10-08T14:03:11.000Z",
      "modified": "2026-10-08T14:03:11.000Z"
    },
    {
      "id": "mk2",
      "type": "callout",
      "pts": [10750, 6800, 12500, 7400],
      "color": "#e5262b",
      "width": 2,
      "text": "Check tub clearance\nagainst window",
      "size": 220,
      "author": "J. Smith",
      "created": "2026-10-08T14:04:02.000Z",
      "modified": "2026-10-08T14:04:02.000Z"
    }
  ]
}
```

## Reading rules (what the app does)

* Invalid JSON, a missing/foreign `schema`, or a `version` newer than supported: the file is
  rejected with a message; nothing is changed.
* Unknown markup types, or markups with non-numeric/odd-length `pts`: skipped with a warning; the
  rest load.
* Bad colours fall back to red, widths are clamped, unreadable dates become "now".
* Markups whose `id` already exists in the open drawing are not loaded twice.
* Loading is one undoable step.

## Compatibility promise

Version 1 readers ignore unknown fields, so later versions may add optional fields without a
version bump. A breaking change (new meaning of an existing field) increments `version`, and the
app will migrate older versions when reading.
