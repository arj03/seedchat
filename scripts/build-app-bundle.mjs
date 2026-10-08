// Build a signed app bundle from an app's source directory: its guest, its view, its
// modules and a signed manifest declaring what it claims and reaches — the .skb the shell
// installs. This script is the offline producer holding the author key;
// browser/shell.js never signs, it only verifies and unpacks what this produces.
//
//   node scripts/build-app-bundle.mjs <app-dir> <skb-out>
//
//   node scripts/build-app-bundle.mjs assembly/chat-app bundle/chat.skb
//   node scripts/build-app-bundle.mjs assembly/jam-app bundle/jam.skb
//
// The directory's `app.json` is the only source of what the bundle is (scripts/
// app-source.mjs reads it). A module it names is a built .wasm, so an app with one compiles
// it first: the `build:chat-app` npm script runs `asc` ahead of this.
//
// Output: <skb-out> — the signed manifest + guest + modules packed into one blob
// (seedkernel §12.4).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrypto } from "seedkernel-wasm";
import { authorBundle, guestOpFraming } from "seedkernel-wasm/bundle-author";
import { readAppSource } from "./app-source.mjs";
import { authorKeys, nextVersion, saveVersion } from "./author.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const [, , appDirArg, skbOutArg] = process.argv;
if (!appDirArg || !skbOutArg) {
  console.error("usage: node scripts/build-app-bundle.mjs <app-dir> <skb-out>");
  process.exit(2);
}
const skbOutPath = join(root, skbOutArg);

const toHex = (b) => Buffer.from(b).toString("hex");

const sodium = await loadCrypto();

const source = readAppSource(join(root, appDirArg), guestOpFraming);

// The author key and the app's version are scripts/author.mjs's. Every build of an app is
// one lineage under its label, and the later build is the newer version. shell.js does not
// itself gate installs on it (installs are consent-gated, not freshness-gated, §12.4), but
// the offline author still keeps one true count rather than resetting to 1 on every run.
const keys = authorKeys(sodium);
const version = nextVersion(source.app);

const { blob, manifest, author } = authorBundle(sodium, keys, { ...source, version });

saveVersion(source.app, version);

mkdirSync(dirname(skbOutPath), { recursive: true });
writeFileSync(skbOutPath, blob);

// The pinned id is the derived author id (the key-set hash, §12.4) — a manifest is
// signed by both halves of the key set, so the Ed25519 key alone is not what an
// allow-list would pin. It is carried on the authorBundle value, not re-derived here.
const { name, version: label } = manifest.guest.config.shell;
console.log(`  author ${toHex(author)} (hybrid 0x02)`);
console.log(`  wrote ${skbOutArg} (app ${manifest.app} v${manifest.version}, ${name} ${label})`.trimEnd());
