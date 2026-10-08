// The author every bundle here is signed by, and how far each app's version has counted.
// scripts/build-app-bundle.mjs and scripts/build-boot-bundles.mjs both sign through this
// file, so whichever runs first mints the key.
//
// An author is a key set, not a program: one signs every app and every version of each, and
// a deployment's policy would list its public key as an allowed author. An app's version is
// a count of its own, since the runtime's freshness store keys on (author, app). Both are
// kept in the repo's root, NEXT TO each other and not in bundle/, which is gitignored and
// gets wiped: a count there would restart at 1 on a `git clean` or a second machine.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hybridAuthorKeysFromSeed } from "seedkernel-wasm/bundle-author";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(root, "chat-author.key");
/** Whether this run minted the key, so that no version count is expected beside it. */
let minted = false;

/** The author's key set, from the key beside the repo's sources, minted if there is none. */
export function authorKeys(sodium) {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, Buffer.from(sodium.crypto_sign_keypair().privateKey).toString("hex"), { mode: 0o600 });
    minted = true;
    console.log(`  minted author key → ${keyPath}`);
  }
  const sk = Uint8Array.from(Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex"));
  return hybridAuthorKeysFromSeed(sodium, sk.slice(0, 32));
}

const versionPath = (app) => join(root, `${app}-author.version`);

/** The version the next build of `app` is signed as: one past its high-water mark. */
export function nextVersion(app) {
  const path = versionPath(app);
  if (existsSync(path)) {
    const v = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(v) && v > 0) return v + 1;
  } else if (!minted) {
    // The dangerous case: a persisted key (an established namespace) but no record of how
    // far its version has been published. Warn loudly rather than quietly restart at 1.
    console.warn(
      `  ⚠ author key exists but no version high-water mark (${path}) — ` +
      `restarting version at 1.\n` +
      `    If you have already shipped bundles under this author, put the real ` +
      `last-shipped version number in ${path} and re-run.`);
  }
  return 1;
}

/** Record that `version` of `app` was built, so the next build counts on from it. */
export function saveVersion(app, version) {
  writeFileSync(versionPath(app), `${version}\n`);
}
