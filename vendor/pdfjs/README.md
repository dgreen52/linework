# pdf.js — vendored

Used by `src/formats/pdf.js` to read PDF files. Loaded only when a PDF is opened, then cached for
offline use in its own cache (`PDF_READER_CACHE` in `sw.js`). Installed unchanged by
`tools/vendor_pdfjs.mjs` (which also wrote this file). Nothing is patched.

| | |
|---|---|
| Library | Mozilla pdf.js — https://github.com/mozilla/pdf.js |
| Package | npm `pdfjs-dist@6.3.289` (https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz) |
| Integrity | `sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==` (checked before anything is installed) |
| Licence | Apache-2.0 (pdf.js, `LICENSE`); the legacy build bundles core-js (MIT); `openjpeg.wasm`: OpenJPEG (BSD-2-Clause, `LICENSE_OPENJPEG`) with pdf.js glue (`LICENSE_PDFJS_OPENJPEG`); `jbig2.wasm`: PDFium's JBIG2 / CCITT decoders (BSD-3-Clause and Apache-2.0, `LICENSE_JBIG2`) with pdf.js glue (`LICENSE_PDFJS_JBIG2`). See `NOTICE`. |
| Build | the package's **legacy** build (`legacy/build/`): runs on older Safari / iPadOS and Chromium too |

How Linework runs it: `pdf.worker.min.mjs` is imported into Linework's own parse worker and pdf.js
runs there in-thread (`globalThis.pdfjsWorker`), so no worker of its own is started; fonts are
never installed (`disableFontFace`), nothing is fetched except the WebAssembly decoders below from
this folder (`wasmUrl`), and pdf.js 6 compiles PostScript functions to WebAssembly rather than
JavaScript, so the Content-Security-Policy needs only `'wasm-unsafe-eval'`. The only run-time
code site in these files is core-js's global-object lookup (`...||function(){return this}()||
Function("return this")()`), whose last fallback runs only where `globalThis`, `window`, `self`
and `global` are all missing — never in a browser that runs module workers; the vendoring script
allows exactly that pattern and refuses any other `eval` / `new Function`.

| File | Bytes | SHA-256 |
|---|---|---|
| pdf.min.mjs | 518555 | `f401927e692efc7735e0cd528c490d0dd31b7f0972c122b7040df805be45cce4` |
| pdf.worker.min.mjs | 1317034 | `a33cfe728c584fdba4fcc1fd54bcdc2f9f2f13889ddbb5b2bd1d0f8cbe49b84e` |
| openjpeg.wasm | 252032 | `004a0e62db930ba9ff2a22212f4554d0bb57a0635a8287caf70f98117cee14ba` |
| jbig2.wasm | 104852 | `e6bee67724a7b5436fe8162638e3708cfc8d52b6342db69a49715e30ff27cfdc` |

Not vendored (not needed to read drawings): `cmaps/` (character maps for CJK text whose PDF does
not embed them), `standard_fonts/` (outlines of non-embedded fonts, used only when a scanned page
is drawn as a picture), `qcms_bg.wasm` (ICC colour management; pdf.js falls back to the
alternate colour space), `quickjs-eval` (form scripts) and the no-WebAssembly fallbacks.

**Updating:** change `PIN` in `tools/vendor_pdfjs.mjs` (version, tarball, the registry's
integrity), run `node tools/vendor_pdfjs.mjs`, then bump `PDF_READER_REV` in
`src/formats/pdf.js` together with `PDF_READER_CACHE` in `sw.js`, and run the unit and e2e
tests. See PDF.md.
