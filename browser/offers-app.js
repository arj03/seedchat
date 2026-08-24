// The offers app SHAPE, in the same spirit as chat-app.js: what the offers app's guest
// program is, and how much authority it holds. Both the browser shell (which loads the
// boot bundle built from it and reads its records) and scripts/build-offers-bundle.mjs
// (which signs it) read it here, so the guest source that gets SIGNED is written once.
//
// `offer/v1` carries a signed bundle from one browser to another, and the app that would
// handle it is the thing being offered — so until someone accepts an offer there is no app
// to route it to, and somebody already installed at boot has to own the name. That is this
// app's whole reason to exist: a keyspace and a claim, nothing else. It holds no network, no
// signing, no loader — accepting an offer, and installing what it names, stays the page's
// job. Composition is several small bundles, not one god shell: this one owns exactly the
// name a peer's offer arrives on and the fs keyspace its records live in.

/** The wire protocol a peer's offer travels under (§12.10) — an ordinary id, claimed by
 *  the boot bundle this shell builds from this file (scripts/build-offers-bundle.mjs).
 *  Ordinary, not a local service claim, because a PEER is exactly who reaches it: the
 *  whole point of an offer is that it arrives from another browser, before either end has
 *  an app installed that could otherwise receive it. */
export const OFFER_PROTO = "offer/v1";

/** This app's id, and its manifest's `app`. A literal, not a grammar like chat's
 *  (`chat-app.js` `APP_ID`): there is exactly one offers app, built once by this shell's
 *  own scripts/build-offers-bundle.mjs, never by a peer's bundle or a user's drag-and-drop. */
export const OFFERS_APP = "offers";

/** The whole authority the offers guest holds (§12.2): a keyspace, nothing more. No
 *  network, no signing, no loader — accepting what lands here and installing it is the
 *  page's job, never this guest's. The manifest declares the SERVICE, never its finer-
 *  grained methods: naming `fs` grants the guest `fs/get` and `fs/put` alike, and a
 *  manifest naming `fs/get` is refused at load (seedkernel §12.2). `crypto/blake2b-256`
 *  needs no entry here: a `crypto/*` name is ungated, not a grant (seedkernel §12.1), so
 *  it never appears in `requires`. */
export const OFFERS_REQUIRES = ["fs"];

/** The prefix every record this guest writes lives under, within its own fs scope
 *  (§12.2). Dot, not the `offers/` a directory reading would suggest: an fs key is a
 *  filename on both backends, and the charset (`isSafeFsKey`, seedkernel §16.1) is
 *  `[A-Za-z0-9._-]` — no path separator. The record itself is
 *  `${OFFERS_KEY_PREFIX}<hex>` = `[from 32][bundle …]`, keyed by the blake2b-256 hash of
 *  the offered blob — content-addressed, so the same bundle offered twice, by the same
 *  peer or two different ones, lands on the same key rather than piling up duplicates. */
export const OFFERS_KEY_PREFIX = "offers.";

/** The guest this shell signs into the boot bundle (scripts/build-offers-bundle.mjs). Its
 *  `handle` has exactly one caller: a peer's inbound `offer/v1` frame, `[from 32][blob …]`
 *  — the kernel's own attribution prepended to the bundle in transit. Nothing else reaches
 *  it: it declares no `timer` service, so it is never re-entered for a fired deadline, and
 *  nothing on this node calls it back as a loopback, so there is no host-op vocabulary to
 *  frame here and no `op-frame` import (contrast chat-app.js, whose guest also serves a
 *  local `send` op on the same `handle`).
 *
 *  It hashes the blob (`crypto/blake2b-256` — ungated, not a grant), and that hash is both
 *  the dedupe key and the guest's answer. It `fs/get`s the record first: an existing one
 *  means this exact blob already arrived, so it returns empty rather than writing a
 *  duplicate or re-announcing an offer already pending. A fresh blob is `fs/put` under
 *  `[from 32][blob]`, and the hash comes back as the answer — which is exactly what the
 *  page's `onInbound` receives (`LoadBundleOptions.onInbound`, seedkernel §12.10): a
 *  non-empty answer is a fresh offer's hash, telling the page to go read the record it
 *  just wrote; an empty one is silence, because there is nothing new to show. There is no
 *  push from a guest to its loader on any other seam, so the answer doubling as the
 *  notification is the whole mechanism. Every `host.call` is awaited, including the
 *  hash: seedkernel's seam is uniformly asynchronous even when a backend computes its
 *  answer inline. */
export function offersGuestSource() {
  return `
"use strict";

// Byte helpers only — no TextEncoder/TextDecoder in a zero-authority realm (mirrors the
// transport guest's own transport/src/util.js).
const HEX = "0123456789abcdef";
function toHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >>> 4] + HEX[b[i] & 15];
  return s;
}
function utf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
function writeU32BE(out, off, v) {
  out[off] = v >>> 24; out[off + 1] = (v >>> 16) & 0xff; out[off + 2] = (v >>> 8) & 0xff; out[off + 3] = v & 0xff;
}

// The kernel's inbound shape is handle([caller 32][body …]): attribution only. This
// guest has exactly one caller — a peer's offer/v1 frame — so unlike chat-app.js it never
// has to tell host/timer/peer apart: the whole body after the 32-byte prefix is the
// offered blob.
async function handle(arg) {
  const from = arg.subarray(0, 32);
  const blob = arg.subarray(32);
  const hash = await host.call("crypto/blake2b-256", blob);
  const key = ${JSON.stringify(OFFERS_KEY_PREFIX)} + toHex(hash);
  const keyBytes = utf8Encode(key);
  const existing = await host.call("fs/get", keyBytes);
  if (existing[0] === 1) return new Uint8Array(0); // already stored — dedupe, no notification
  const record = new Uint8Array(32 + blob.length);
  record.set(from, 0);
  record.set(blob, 32);
  const putArg = new Uint8Array(4 + keyBytes.length + record.length);
  writeU32BE(putArg, 0, keyBytes.length);
  putArg.set(keyBytes, 4);
  putArg.set(record, 4 + keyBytes.length);
  await host.call("fs/put", putArg);
  return hash;
}`;
}
