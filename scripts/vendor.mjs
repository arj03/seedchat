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
// host/safe-js.js, which names the kernel's in-repo engine and
// quickjs-emscripten-core as bare specifiers. Same set and layout seed store's
// build-browser-demo.mjs stages, so one import map serves both apps.

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const relayRoot = resolve(root, "..", "seedrelay");

if (!existsSync(resolve(relayRoot, "client.js"))) {
  console.error(
    `seedrelay not found at ${relayRoot}.\n` +
    "  check it out beside seedchat and seedkernel, then run npm install"
  );
  process.exit(2);
}

// The kernel is a sibling checkout by declaration: package.json pins
// `file:../seedkernel/WASM`, and the kernel is `private: true` and never published.
// So name that path, the same way seed store's build-browser-demo.mjs does. Resolving
// it through Node instead would defend against install shapes the dependency spec has
// already ruled out, and would do it by reaching for `seedkernel-wasm/package.json` —
// a subpath that resolves only while the kernel's `exports` map carries an entry
// nothing else needs.
const pkgRoot = resolve(root, "..", "seedkernel", "WASM");
if (!existsSync(pkgRoot)) {
  console.error(
    `seedkernel-wasm not found at ${pkgRoot}.\n` +
    "  check it out beside this repo, then: cd WASM && npm install && npm run build"
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

// The relay protocol is deployment infrastructure, not kernel surface. Vendor its
// one browser module from the sibling package declared in package.json; the server
// half is reached through that package's `seedrelay` CLI by `npm run relay`.
{
  const dstDir = resolve(vendor, "seedrelay");
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(resolve(relayRoot, "client.js"), resolve(dstDir, "client.js"));
}

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

// ML-KEM-768 is private content of the signed transport bundle now; no loose
// browser artifact is needed here.

// ── vendor the QuickJS realm engine so chat runs offline ────────────────────
// Two pieces, because that is how the kernel splits them: the ENGINE is the
// kernel's own in-repo quickjs-ng 0.16.1 build (WASM/quickjs/dist — the same
// blob its node tests and, at the same pin, the Go loader run), and the JS API
// layer around it is the npm package quickjs-emscripten-core. safe-js.js names
// both as bare specifiers ("seedkernel-wasm/quickjs" and
// "quickjs-emscripten-core"), so each lands in its own vendored dir with an
// import-map entry in chat-shell.html.
//
// Within a dir the files find each other: variant.mjs pulls ./ffi.mjs and
// ./emscripten-module.mjs relatively, and the emscripten glue fetches
// `new URL("emscripten-module.wasm", import.meta.url)` — so the engine's four
// files must stay together, the same rule libsodium's three follow above.
// Nothing here is node-only: the glue is built for `web,node` and picks the
// browser's fetch path at runtime. Same layout seed store's
// build-browser-demo.mjs stages.
const nodeModules = resolve(pkgRoot, "node_modules");

// The engine, from the kernel checkout itself — dist/ is checked in there, so
// this needs no install, only the sibling checkout the guard above proved.
{
  const src = resolve(pkgRoot, "quickjs", "dist");
  const dstDir = resolve(vendor, "quickjs");
  mkdirSync(dstDir, { recursive: true });
  for (const f of ["variant.mjs", "ffi.mjs", "emscripten-module.mjs", "emscripten-module.wasm"]) {
    if (!existsSync(join(src, f))) {
      console.error(`missing quickjs/dist/${f} in the kernel checkout — see WASM/quickjs/README.md`);
      process.exit(2);
    }
    copyFileSync(join(src, f), join(dstDir, f));
  }
}

// The JS API layer. quickjs-emscripten-core is chunked/code-split with hashed
// names (chunk-*.mjs, module-*.mjs), so copy every .mjs from its dist;
// @jitl/quickjs-ffi-types, which it imports by name, needs only its entry.
// [package, dist subdir, dest under vendor/, explicit files, copy EVERY .mjs?]
const VENDOR = [
  ["quickjs-emscripten-core", "dist", "quickjs-emscripten-core", ["index.mjs"], true],
  ["@jitl/quickjs-ffi-types", "dist", "quickjs-ffi-types",       ["index.mjs"], false],
];
for (const [pkg, sub, dest, files, allMjs] of VENDOR) {
  const src = join(nodeModules, ...pkg.split("/"), sub);
  if (!existsSync(src)) {
    console.error(`vendor: ${pkg}/${sub} not found — in the kernel checkout: cd WASM && npm install`);
    process.exit(2);
  }
  const dstDir = resolve(vendor, dest);
  mkdirSync(dstDir, { recursive: true });
  const names = new Set(files);
  if (allMjs) for (const n of readdirSync(src)) if (n.endsWith(".mjs")) names.add(n);
  for (const n of names) copyFileSync(join(src, n), join(dstDir, n));
}

console.log("vendored seedkernel-wasm + seedrelay -> browser/vendor/");
console.log("serve it:   npm run serve        (re-vendors + http-server with caching OFF)");
console.log("  ── DO NOT use a plain `http-server` without -c-1: its default max-age=3600 makes");
console.log("     the browser keep a STALE vendor/host after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/chat-shell.html");
