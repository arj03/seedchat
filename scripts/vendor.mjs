// Copy the kernel's built host into browser/vendor/ so a plain static server can
// serve chat with no bundler. The import map in chat-shell.html points at these
// files; nothing else in this repo reaches into node_modules.
//
// This is deliberately a dumb copy of `build/host` wholesale: shell-core.js and
// bundle.js import their siblings by relative path, so the tree has to arrive
// intact even though chat itself names only four entry points.
//
// libsodium ships alongside because libsodium-wrappers.mjs resolves both its core
// module and its .wasm relative to its own URL (`new URL('./libsodium.wasm',
// import.meta.url)`), so the three files must stay in one directory.

import { cpSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
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

const hostMin = resolve(pkgRoot, "build/host-min");
const hostRaw = resolve(pkgRoot, "build/host");

// Prefer host-min, which is what seed store's p2p.html vendors too — same
// convention across both apps, and ~117 KB instead of ~203 KB. Fall back to the
// readable build when only that exists, since it is what `npm run build:host`
// alone produces and the module graph is identical either way.
const hostSrc = existsSync(hostMin) ? hostMin : hostRaw;
if (!existsSync(hostSrc)) {
  console.error(
    `seedkernel-wasm is present but not built (${hostMin} missing).\n` +
    "  in the kernel checkout: cd WASM && npm run build"
  );
  process.exit(2);
}
if (hostSrc === hostRaw) {
  console.warn("note: vendoring the unminified host — run `npm run build:host:min` in the kernel for the smaller build");
}

// ── staleness guard (same one seed store's build-browser-demo.mjs runs) ──────
// The browser runs the MINIFIED host; the kernel's own Node tests run build/host.
// The two diverge silently when `build:host` (tsc) is re-run but `build:host:min`
// is not — a real trap after switching branches, because the kernel's tests stay
// green against the fresh build/host while chat vendors a stale host-min and runs
// old code. Catch it here, at the last step before the browser: if any compiled
// build/host .js is newer than the whole host-min tree, the minify step lagged.
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
if (hostSrc === hostMin && existsSync(hostRaw)) {
  const raw = newestJsMtime(hostRaw), min = newestJsMtime(hostMin);
  if (raw > min + 1000) { // 1s slack for filesystem mtime granularity
    console.error(
      "seedkernel build/host-min is STALE: build/host is newer, so the minify step did not\n" +
      "re-run after the last compile. Chat would vendor and serve old kernel code.\n" +
      "  fix: in the kernel checkout, cd WASM && npm run build:host && npm run build:host:min"
    );
    process.exit(2);
  }
}

const vendor = resolve(root, "browser/vendor");
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

cpSync(hostSrc, resolve(vendor, "host"), { recursive: true });

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

console.log("vendored seedkernel-wasm -> browser/vendor/");
console.log("serve it:   npm run serve        (re-vendors + http-server with caching OFF)");
console.log("  ── DO NOT use a plain `http-server` without -c-1: its default max-age=3600 makes");
console.log("     the browser keep a STALE vendor/host after a rebuild → confusing errors.");
console.log("  relay + shell:  npm run relay  →  http://localhost:3000/chat-shell.html");
