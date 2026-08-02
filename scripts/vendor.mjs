// Copy the kernel's built host into browser/vendor/ so a plain static server can
// serve chat with no bundler. The import map in chat-shell.html points at these
// files; nothing else in this repo reaches into node_modules.
//
// This is deliberately a dumb copy of `build-min` wholesale: shell-core.js and
// bundle.js import their siblings and the `core/` tree by relative path, so the
// whole tree has to arrive intact even though chat itself names only a handful
// of entry points. The minified tree is what seed store's p2p.html vendors too —
// same convention across both apps — with the readable `build/` as a fallback.
//
// libsodium ships alongside because libsodium-wrappers.mjs resolves both its core
// module and its .wasm relative to its own URL (`new URL('./libsodium.wasm',
// import.meta.url)`), so the three files must stay in one directory.
//
// The QuickJS realm engine (safe-js) is vendored too: the transport bundle chat
// admits runs as a confined guest program, and the realm factory lives in
// host/safe-js.js, which pulls quickjs-emscripten + the quickjs-ng wasm variants
// as bare specifiers. Same set and layout seed store's build-browser-demo.mjs
// stages, so one import map serves both apps.

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);

// Resolve the dependency through Node rather than assuming ../seedkernel — this
// works the same whether it is a file: link, a git dep, or a published tarball.
let pkgRoot;
try {
  pkgRoot = dirname(require.resolve("seedkernel-wasm/package.json"));
} catch {
  console.error(
    "cannot resolve seedkernel-wasm.\n" +
    "  npm install, and make sure the dependency points at a built checkout\n" +
    "  (in the checkout: cd WASM && npm install && npm run build)"
  );
  process.exit(2);
}

// The minified tree (build-min) is what the kernel's own browser deployment
// vendors too, and is ~half the size of the readable build; fall back to the
// readable build when only that exists (a `npm run build:host` alone).
const minDir = resolve(pkgRoot, "build-min");
const rawDir = resolve(pkgRoot, "build");
const hostSrc = existsSync(minDir) ? minDir : rawDir;
if (!existsSync(hostSrc)) {
  console.error(
    `seedkernel-wasm is present but not built (${minDir} missing).\n` +
    "  in the kernel checkout: cd WASM && npm run build"
  );
  process.exit(2);
}
if (hostSrc === rawDir) {
  console.warn("note: vendoring the unminified host — run `npm run build:host:min` in the kernel for the smaller build");
}

// ── staleness guard (same one seed store's build-browser-demo.mjs runs) ──────
// The browser runs the MINIFIED host; the kernel's own Node tests run build/.
// The two diverge silently when `build:host` (tsc) is re-run but `build:host:min`
// (minify) is not — a real trap after switching branches, because the kernel's tests
// stay green against the fresh build/ while chat vendors a stale build-min and runs
// old code. Catch it here, at the last step before the browser: if any compiled
// build/ .js is newer than the whole build-min tree, the minify step lagged.
// Scoped to the host/ and core/ subtrees — minify covers exactly those, and build/
// also holds asc fixture outputs (forwarder.*) that no tsc↔minify cycle touches.
function newestJsMtime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestJsMtime(p));
    else if (name.endsWith(".js")) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}
if (hostSrc === minDir && existsSync(rawDir)) {
  for (const sub of ["host", "core"]) {
    const rawDirSub = join(rawDir, sub), minDirSub = join(minDir, sub);
    if (!existsSync(rawDirSub) || !existsSync(minDirSub)) continue;
    const raw = newestJsMtime(rawDirSub), min = newestJsMtime(minDirSub);
    if (raw > min + 1000) { // 1s slack for filesystem mtime granularity
      console.error(
        `seedkernel build-min is STALE: build/${sub} is newer, so the minify step did not\n` +
        "re-run after the last compile. Chat would vendor and serve old kernel code.\n" +
        "  fix: in the kernel checkout, cd WASM && npm run build"
      );
      process.exit(2);
    }
  }
}

const vendor = resolve(root, "browser/vendor");
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

// The whole minified tree: host/ and core/ (host modules import ../core/* by
// relative path) plus the top-level ws/forwarder entry files, unused by chat but
// part of the same tree. libsodium and mldsa65.wasm live in the kernel's
// browser/ dir and are copied separately, below.
cpSync(hostSrc, vendor, { recursive: true });

for (const f of ["libsodium-wrappers.mjs", "libsodium-core.mjs", "libsodium.wasm"]) {
  const src = resolve(pkgRoot, "browser", f);
  if (!existsSync(src)) {
    console.error(`missing ${f} — in the kernel checkout: cd WASM && npm run build:browser-sodium`);
    process.exit(2);
  }
  cpSync(src, resolve(vendor, f));
}

// ML-DSA-65 for manifest suite 0x02 (§12.4). The same artifact Node reads and the Go
// loader embeds, so chat admits exactly the bundles they admit; the shell fetches it
// by URL rather than importing it, so it does not need to sit beside a JS module.
{
  const src = resolve(pkgRoot, "browser/mldsa65.wasm");
  if (!existsSync(src)) {
    console.error("missing mldsa65.wasm — in the kernel checkout: cd WASM && npm run build:pq");
    process.exit(2);
  }
  cpSync(src, resolve(vendor, "mldsa65.wasm"));
}

// ── vendor the QuickJS realm engine so chat runs offline ────────────────────
// safe-js.js pulls quickjs-emscripten (chunked/code-split dist) and the two
// quickjs-ng wasm variants, each a multi-file ESM package with bare-specifier
// imports and a .wasm resolved via `new URL("emscripten-module.wasm",
// import.meta.url)` — so each package's runtime files must land in one vendored
// dir, and every bare specifier in their graph gets an import-map entry in
// chat-shell.html. Source from seedkernel's node_modules (safe-js is its dep).
// Same layout seed store's build-browser-demo.mjs stages.
const nodeModules = resolve(pkgRoot, "node_modules");
function pkgDist(pkg, sub) {
  const d = join(nodeModules, ...pkg.split("/"), sub);
  if (existsSync(d)) return d;
  throw new Error(`vendor: ${pkg}/${sub} not found — in the kernel checkout: cd WASM && npm install`);
}
// [package, dist subdir, dest under vendor/, explicit files, copy EVERY .mjs in the dir?]
// The umbrella + core packages are chunked/code-split with hashed names
// (chunk-*.mjs, module-*.mjs), so copy every .mjs from their dist; the leaf
// packages need only their named entry (+ the emscripten .wasm sibling).
const VENDOR = [
  ["quickjs-emscripten",      "dist", "quickjs-emscripten",      ["index.mjs"], true],
  ["quickjs-emscripten-core", "dist", "quickjs-emscripten-core", ["index.mjs"], true],
  ["@jitl/quickjs-ffi-types", "dist", "quickjs-ffi-types",       ["index.mjs"], false],
  ["@jitl/quickjs-ng-wasmfile-release-asyncify", "dist", "qjs-async",
    ["index.mjs", "ffi.mjs", "emscripten-module.browser.mjs", "emscripten-module.wasm"], false],
  ["@jitl/quickjs-ng-wasmfile-release-sync", "dist", "qjs-sync",
    ["index.mjs", "ffi.mjs", "emscripten-module.browser.mjs", "emscripten-module.wasm"], false],
];
for (const [pkg, sub, dest, files, allMjs] of VENDOR) {
  const src = pkgDist(pkg, sub);
  const dstDir = resolve(vendor, dest);
  mkdirSync(dstDir, { recursive: true });
  const names = new Set(files);
  if (allMjs) for (const n of readdirSync(src)) if (n.endsWith(".mjs")) names.add(n);
  for (const n of names) copyFileSync(join(src, n), join(dstDir, n));
}

console.log("vendored seedkernel-wasm -> browser/vendor/");
console.log("serve it:   npm run serve        (re-vendors + http-server with caching OFF)");
console.log("  ── DO NOT use a plain `http-server` without -c-1: its default max-age=3600 makes");
console.log("     the browser keep a STALE vendor/host after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/chat-shell.html");
