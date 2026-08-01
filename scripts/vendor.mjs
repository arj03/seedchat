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

import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

console.log("vendored seedkernel-wasm -> browser/vendor/");
