// Build a signed app bundle from an app's source directory: its guest, its view, its
// modules and a signed manifest declaring what it claims and reaches — the .skb the shell
// installs. This script is the offline producer holding the author key;
// browser/shell.js never signs, it only verifies and unpacks what this produces.
//
//   node scripts/build-app-bundle.mjs <app-dir> <skb-out>
//
//   node scripts/build-app-bundle.mjs assembly/chat-app-v1 bundle/chat-app-v1.skb
//   node scripts/build-app-bundle.mjs assembly/chat-app-v2 bundle/chat-app-v2.skb
//
// The directory's `app.json` is the only source of what the bundle is (scripts/
// app-source.mjs reads it). A module it names is a built .wasm, so an app with one compiles
// it first: the `build:chat-app-v*` npm scripts run `asc` ahead of this.
//
// Output: <skb-out> — the signed manifest + guest + modules packed into one blob
// (seedkernel §12.4).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrypto } from "seedkernel-wasm";
import { authorBundle, guestOpFraming, hybridAuthorKeysFromSeed } from "seedkernel-wasm/bundle-author";
import { readAppSource } from "./app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const [, , appDirArg, skbOutArg] = process.argv;
if (!appDirArg || !skbOutArg) {
  console.error("usage: node scripts/build-app-bundle.mjs <app-dir> <skb-out>");
  process.exit(2);
}
const skbOutPath = join(root, skbOutArg);

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

const sodium = await loadCrypto();

const source = readAppSource(join(root, appDirArg), guestOpFraming);

// Author identity: the key every build here is signed with. An author is a key set, not a
// program, so one signs every app and every version of each. A deployment's policy would
// list this public key as an allowed author.
const keyPath = join(root, "chat-author.key");
let sk, pk, mintedKey = false;
if (existsSync(keyPath)) {
  sk = fromHex(readFileSync(keyPath, "utf8").trim());
  pk = sk.slice(32);
} else {
  const kp = sodium.crypto_sign_keypair();
  sk = kp.privateKey; pk = kp.publicKey;
  writeFileSync(keyPath, toHex(sk), { mode: 0o600 });
  mintedKey = true;
  console.log(`  minted author key → ${keyPath}`);
}

// Freshness: a monotonic high-water mark per app LABEL, because the runtime's freshness
// store keys on (author, app). chat-app-v1 and chat-app-v2 are the same app ("chat"), so
// they share one lineage and the later build is the newer version. It is persisted NEXT TO
// THE AUTHOR KEY (not derived from bundle/, which is gitignored and gets wiped) so it
// survives a `git clean` or a build on a second machine — mirrors seedstore's
// build-bundle.mjs. shell.js does not itself gate installs on this (installs are
// consent-gated, not freshness-gated, §12.4) but the offline author still keeps one true
// count rather than resetting to 1 on every run.
const versionPath = join(root, `${source.app}-author.version`);
let prevVersion = 0;
if (existsSync(versionPath)) {
  const v = Number(readFileSync(versionPath, "utf8").trim());
  if (Number.isInteger(v) && v > 0) prevVersion = v;
} else if (!mintedKey) {
  // The dangerous case: a persisted key (an established namespace) but no record of
  // how far its version has been published. Warn loudly rather than quietly restart
  // at 1.
  console.warn(
    `  ⚠ author key exists but no version high-water mark (${versionPath}) — ` +
    `restarting version at 1.\n` +
    `    If you have already shipped bundles under this author, put the real ` +
    `last-shipped version number in ${versionPath} and re-run.`);
}
const version = prevVersion + 1;

const keys = hybridAuthorKeysFromSeed(sodium, sk.slice(0, 32));

const { blob, manifest, author } = authorBundle(sodium, keys, { ...source, version });

// Record the new high-water mark beside the key, so the next build counts on from
// here even if bundle/ is wiped.
writeFileSync(versionPath, `${version}\n`);

mkdirSync(dirname(skbOutPath), { recursive: true });
writeFileSync(skbOutPath, blob);

// The pinned id is the derived author id (the key-set hash, §12.4) — a manifest is
// signed by both halves of the key set, so the Ed25519 key alone is not what an
// allow-list would pin. It is carried on the authorBundle value, not re-derived here.
const { name, version: label } = manifest.guest.config.shell;
console.log(`  author ${toHex(author)} (hybrid 0x02)`);
console.log(`  wrote ${skbOutArg} (app ${manifest.app} v${manifest.version}, ${name} ${label})`.trimEnd());
