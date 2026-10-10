#!/usr/bin/env bash
# Builds the DWG reader in vendor/libredwg/ (GNU LibreDWG + the libredwg-web JavaScript bindings,
# compiled to WebAssembly with Emscripten) from pinned sources, so the binary Linework distributes
# has exactly known corresponding source (GPL-3.0). This is the one build recipe: the GitHub
# workflow .github/workflows/build-libredwg-wasm.yml runs it, and it runs the same way elsewhere.
#
#   tools/build_dwg_wasm.sh
#
# Needs Linux (or macOS / WSL) with bash, git, python3, make, autoconf, automake, libtool, pkg-config,
# texinfo and node, plus network access to github.com and the Emscripten SDK downloads.
#
# Output in $OUT (default .build-dwg/out): libredwg-web.js, libredwg-web.wasm, build-info.json
# (every pin and flag) and SHA256SUMS. Then tools/vendor_libredwg.mjs checks the build (no run-time
# code generation, memory limits, clean version string) and installs it into vendor/libredwg/ with
# a new README.md (INSTALL=0 skips that). After installing: set WASM_SIZE and bump READER_REV in
# src/formats/dwg.js together with READER_CACHE in sw.js, then run the unit and e2e tests.
set -euo pipefail
export LC_ALL=C TZ=UTC

# ------------------------------------------------------------------ pins (recorded in DWG.md)
EMSDK_VERSION="${EMSDK_VERSION:-3.1.74}"
EMSDK_COMMIT="${EMSDK_COMMIT:-3d6d8ee910466516a53e665b86458faa81dae9ba}"               # emsdk tag 3.1.74
LIBREDWG_WEB_REPO="${LIBREDWG_WEB_REPO:-https://github.com/mlightcad/libredwg-web.git}"
LIBREDWG_WEB_TAG="${LIBREDWG_WEB_TAG:-v0.7.16}"
LIBREDWG_WEB_COMMIT="${LIBREDWG_WEB_COMMIT:-0d4fd3fbe6eb1a451d7c5ce286d0785e4d65dd29}"   # that tag
JSMN_COMMIT="${JSMN_COMMIT:-85695f3d5903b1cd5b4030efe50db3b4f5f3c928}"                 # its jsmn submodule
LIBREDWG_BASE_TAG="${LIBREDWG_BASE_TAG:-0.13.4}"                                        # upstream release in its history
LIBREDWG_BASE_COMMIT="${LIBREDWG_BASE_COMMIT:-e3774bd4020fcfebb68150361db74b8b34d170fe}"

# ------------------------------------------------------------------ build flags
# Same as the npm package's build (bindings/javascript/package.json of libredwg-web) except: no
# --enable-debug (stable classes only; it would also drop -O2), -sDYNAMIC_EXECUTION=0 (no eval /
# new Function in the glue: the CSP allows only 'wasm-unsafe-eval'), 64 MiB initial memory instead
# of 1 GiB (phones and tablets), no --emit-tsd.
CONFIGURE_FLAGS="--enable-release --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json"
CFLAGS_WASM="-O2 -sUSE_ZLIB=1 -DNDEBUG"
LINK_FLAGS="-O2 -lembind -std=c++17 -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc -sEXPORT_ES6=1 -sMODULARIZE=1 -sEXPORT_NAME=createModule -sEXPORTED_RUNTIME_METHODS=FS,ENV,ccall,cwrap,UTF8ToString,stringToNewUTF8,setValue"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/.build-dwg}"   # outside version control (see .gitignore)
OUT="${OUT:-$WORK/out}"
SRC="$WORK/libredwg-web"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
step() { printf '\n==== %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }
mkdir -p "$WORK"

# ------------------------------------------------------------------ 1. Emscripten SDK, pinned
step "Emscripten SDK $EMSDK_VERSION (emsdk $EMSDK_COMMIT)"
[ -d "$WORK/emsdk/.git" ] || git clone -q https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
git -C "$WORK/emsdk" cat-file -e "$EMSDK_COMMIT^{commit}" 2>/dev/null || git -C "$WORK/emsdk" fetch -q origin
git -C "$WORK/emsdk" -c advice.detachedHead=false checkout -q --detach "$EMSDK_COMMIT"
(cd "$WORK/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
set +u
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh" >/dev/null 2>&1
set -u
EMCC_VERSION="$(emcc --version | head -n 1)"
echo "$EMCC_VERSION"
case "$EMCC_VERSION" in *" $EMSDK_VERSION "*) ;; *) fail "emcc is not $EMSDK_VERSION" ;; esac

# ------------------------------------------------------------------ 2. sources, pinned and verified
step "libredwg-web $LIBREDWG_WEB_TAG ($LIBREDWG_WEB_COMMIT)"
rm -rf "$SRC"
git init -q "$SRC"
cd "$SRC"
git remote add origin "$LIBREDWG_WEB_REPO"
git fetch -q --no-tags origin "$LIBREDWG_WEB_COMMIT"
git -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$LIBREDWG_WEB_COMMIT" ] || fail "fetched $(git rev-parse HEAD), not $LIBREDWG_WEB_COMMIT"
tagged="$(git ls-remote origin "refs/tags/$LIBREDWG_WEB_TAG" "refs/tags/$LIBREDWG_WEB_TAG^{}" | sort -k2 | tail -n 1 | cut -f1)"
[ "$tagged" = "$LIBREDWG_WEB_COMMIT" ] || echo "warning: tag $LIBREDWG_WEB_TAG now points at '$tagged'; building the pinned commit"
git submodule -q update --init --recursive
[ "$(git -C jsmn rev-parse HEAD)" = "$JSMN_COMMIT" ] || fail "jsmn is at $(git -C jsmn rev-parse HEAD), not $JSMN_COMMIT"
git merge-base --is-ancestor "$LIBREDWG_BASE_COMMIT" HEAD || fail "LibreDWG $LIBREDWG_BASE_TAG ($LIBREDWG_BASE_COMMIT) is not in the history"
# The version string compiled into the binary: LibreDWG's own git-version-gen on the clean checkout,
# with the upstream release as the only tag ("0.13.4.<commits since>_<abbreviated commit>"). It is
# fixed in .tarball-version before autoreconf, which regenerates tracked files (that is what made
# the npm package's binary report "_dirty").
git tag "$LIBREDWG_BASE_TAG" "$LIBREDWG_BASE_COMMIT"
VERSION="$(build-aux/git-version-gen .tarball-version)"
case "$VERSION" in "$LIBREDWG_BASE_TAG".*_*) ;; *) fail "unexpected version string '$VERSION'" ;; esac
case "$VERSION" in *dirty*) fail "source tree is not clean: $VERSION" ;; esac
printf '%s' "$VERSION" > .tarball-version
echo "LibreDWG $VERSION"

# ------------------------------------------------------------------ 3. configure + compile LibreDWG
step "configure + compile LibreDWG"
autoreconf -f --install --symlink -I m4   # what autogen.sh does, without its tag fetch and version reset
mkdir build-wasm
cd build-wasm
# shellcheck disable=SC2086
emconfigure ../configure CC=emcc CFLAGS="$CFLAGS_WASM" $CONFIGURE_FLAGS || { sed -n "/checking for suffix of executables/,/Cache variables/p" config.log | head -n 80; fail "configure failed"; }
grep -q "^#define PACKAGE_VERSION \"$VERSION\"" src/config.h || fail "configure did not take the version string"
emmake make -j"$JOBS" -C src
ls src/*.o > /dev/null 2>&1 || fail "no objects in build-wasm/src"
echo "$(ls src/*.o | wc -l | tr -d ' ') objects"

# ------------------------------------------------------------------ 4. link the bindings
step "link"
# shellcheck disable=SC2086
emcc ../bindings/javascript/embind/*.cpp src/*.o -Isrc -I../src -I../include $LINK_FLAGS -o libredwg-web.js

# ------------------------------------------------------------------ 5. output, record, check, install
step "output"
mkdir -p "$OUT"
rm -f "$OUT/libredwg-web.js" "$OUT/libredwg-web.wasm" "$OUT/build-info.json" "$OUT/SHA256SUMS"
{
  printf '// LibreDWG for Linework: built by tools/build_dwg_wasm.sh from libredwg-web %s (commit %s) with Emscripten %s. Emscripten runtime: MIT licence.\n' \
    "$LIBREDWG_WEB_TAG" "$LIBREDWG_WEB_COMMIT" "$EMSDK_VERSION"
  cat libredwg-web.js
} > "$OUT/libredwg-web.js"
cp libredwg-web.wasm "$OUT/libredwg-web.wasm"

RUN_URL="" RUN_COMMIT="" RUN_IMAGE=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/$GITHUB_RUN_ID"
  RUN_COMMIT="${GITHUB_SHA:-}"
  RUN_IMAGE="${ImageOS:-} ${ImageVersion:-}"
fi
AUTOTOOLS="$(autoconf --version | head -n 1); $(automake --version | head -n 1); $(libtoolize --version | head -n 1)"
export EMSDK_VERSION EMSDK_COMMIT LIBREDWG_WEB_REPO LIBREDWG_WEB_TAG LIBREDWG_WEB_COMMIT JSMN_COMMIT LIBREDWG_BASE_TAG \
  LIBREDWG_BASE_COMMIT VERSION EMCC_VERSION AUTOTOOLS CONFIGURE_FLAGS CFLAGS_WASM LINK_FLAGS RUN_URL RUN_COMMIT RUN_IMAGE
node - "$OUT/build-info.json" <<'JS'
const e = process.env;
const info = {
  builtBy: 'tools/build_dwg_wasm.sh',
  libredwgWeb: { repo: e.LIBREDWG_WEB_REPO, tag: e.LIBREDWG_WEB_TAG, commit: e.LIBREDWG_WEB_COMMIT },
  jsmn: { commit: e.JSMN_COMMIT },
  libredwgBase: { tag: e.LIBREDWG_BASE_TAG, commit: e.LIBREDWG_BASE_COMMIT },
  version: e.VERSION,
  emsdk: { version: e.EMSDK_VERSION, commit: e.EMSDK_COMMIT },
  emcc: e.EMCC_VERSION,
  autotools: e.AUTOTOOLS,
  configure: e.CONFIGURE_FLAGS,
  cflags: e.CFLAGS_WASM,
  link: e.LINK_FLAGS,
  run: e.RUN_URL ? { url: e.RUN_URL, commit: e.RUN_COMMIT, image: e.RUN_IMAGE.trim() } : null,
};
require('node:fs').writeFileSync(process.argv[2], JSON.stringify(info, null, 2) + '\n');
JS

cd "$OUT"
if command -v sha256sum > /dev/null; then sha256sum libredwg-web.js libredwg-web.wasm build-info.json > SHA256SUMS
else shasum -a 256 libredwg-web.js libredwg-web.wasm build-info.json > SHA256SUMS; fi
cat SHA256SUMS
wc -c libredwg-web.js libredwg-web.wasm
if grep -aqF -e "$WORK" -e "$HOME" libredwg-web.js libredwg-web.wasm; then
  echo "warning: a local path appears in the output (the build would differ elsewhere)"
else
  echo "no local paths in the output"
fi

if [ "${INSTALL:-1}" != 0 ]; then
  node "$ROOT/tools/vendor_libredwg.mjs" "$OUT" > /dev/null
  echo "checked and installed into vendor/libredwg/ (README.md rewritten)"
fi
