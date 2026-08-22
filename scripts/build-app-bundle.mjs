// Build a signed seedchat app bundle: the WASM handler module + the ~5-line
// forwarding guest (browser/chat-app.js) + a signed manifest declaring the required
// caps — the .skb the shell installs. This script is the offline producer holding
// the author key; browser/chat-shell.js never signs anymore, it only verifies and
// unpacks what this produces.
//
//   node scripts/build-app-bundle.mjs <wasm-in> <skb-out>
//
//   node scripts/build-app-bundle.mjs build/chat-app-v1.wasm bundle/chat-app-v1.skb
//   node scripts/build-app-bundle.mjs build/chat-app-v2.wasm bundle/chat-app-v2.skb
//
// The wasm's `app_meta` custom section (scripts/embed-meta.mjs) is the only source
// of the app id/name/version — the same field the (deleted) in-browser
// buildAppBundle used to read. There is no interactive prompt fallback here: this is
// a build script, not a browser, so a meta-less wasm is a build error.
//
// Output: <skb-out> — the signed manifest + wasm module + guest packed into one blob
// (seedkernel §12.4).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrypto } from "seedkernel-wasm";
import { authorBundle, hybridAuthorKeysFromSeed } from "seedkernel-wasm/bundle";
import { assertAppId, chatGuestSource, CHAT_PROTO, CHAT_APP_REQUIRES } from "../browser/chat-app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const [, , wasmInArg, skbOutArg] = process.argv;
if (!wasmInArg || !skbOutArg) {
  console.error("usage: node scripts/build-app-bundle.mjs <wasm-in> <skb-out>");
  process.exit(2);
}
const wasmInPath = join(root, wasmInArg);
const skbOutPath = join(root, skbOutArg);

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

const sodium = await loadCrypto();

const wasmBytes = new Uint8Array(readFileSync(wasmInPath));
// id/name/version live in the wasm's own app_meta custom section — read it the same
// way chat-shell.js's readWasmSections does. No import needed: WebAssembly is a Node
// global.
const mod = await WebAssembly.compile(wasmBytes);
const metaSections = WebAssembly.Module.customSections(mod, "app_meta");
if (metaSections.length === 0)
  throw new Error(`${wasmInArg} has no app_meta custom section — run embed-meta.mjs first`);
let meta;
try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(metaSections[0]))); }
catch (err) { throw new Error(`${wasmInArg}'s app_meta section is not valid JSON: ${err.message}`); }
if (!meta.id) throw new Error(`${wasmInArg}'s app_meta has no "id"`);
// The id is embedded text, about to be interpolated into JS this key signs — checked
// against the §12.4 name grammar HERE, before the template (chat-app.js chatGuestSource).
assertAppId(meta.id);

// Author identity: the key every chat-app build is signed with. Shared across
// chat-app-v1 and chat-app-v2 — both are the SAME app ("chat") under the SAME
// author, so they share one freshness lineage (the version bookkeeping below). A
// deployment's policy would list this public key as an allowed author.
const keyPath = join(root, "chat-author.key");
const versionPath = join(root, "chat-author.version");
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

// Freshness: a monotonic high-water mark, persisted NEXT TO THE AUTHOR KEY (not
// derived from bundle/, which is gitignored and gets wiped) so it survives a `git
// clean` or a build on a second machine — mirrors seedstore's build-bundle.mjs.
// chat-shell.js does not itself gate installs on this (installs are consent-gated,
// not freshness-gated, §12.4) but the offline author still keeps one true count
// rather than resetting to 1 on every run.
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

const guestSource = chatGuestSource(meta.id);
const { blob, manifest, author } = authorBundle(sodium, keys, {
  app: meta.id,
  version,
  // Every chat app claims the one chat protocol — that is what lets two peers
  // running different authors' chat apps interoperate, and claiming it is what
  // routes it: installing this bundle makes it this node's `chat` app.
  protocols: [CHAT_PROTO],
  modules: [{ name: meta.id, wasm: wasmBytes }],
  guestSource,
  guestRequires: CHAT_APP_REQUIRES,
});

// Record the new high-water mark beside the key, so the next build counts on from
// here even if bundle/ is wiped.
writeFileSync(versionPath, `${version}\n`);

mkdirSync(dirname(skbOutPath), { recursive: true });
writeFileSync(skbOutPath, blob);

// The pinned id is the derived author id (the key-set hash, §12.4) — a manifest is
// signed by both halves of the key set, so the Ed25519 key alone is not what an
// allow-list would pin. It is carried on the authorBundle value, not re-derived here.
console.log(`  author ${toHex(author)} (hybrid 0x02)`);
console.log(`  wrote ${skbOutArg} (app ${manifest.app} v${manifest.version}, `
  + `${meta.name || meta.id} ${meta.version || ""})`.trimEnd());
