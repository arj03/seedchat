// Headless smoke test: does chat still work on the kernel it depends on?
//
// Replays the boot path browser/chat-shell.js actually runs — the bootShell
// assembly + its implicit transport-author pin + consent-gated chat install +
// protocol dispatch — minus the browser-only WebRTC/DOM. Two shells link through
// injected ChannelFactory sinks (the shape RtcNetwork implements), a real
// chat-app-v1.wasm round-trips a message, and the offers app (a second boot bundle,
// browser/offers-app.js) round-trips an offer. Run it after a kernel update:
//
//   node scripts/smoke.mjs
//
// Fails loudly (non-zero exit) on any regression in the kernel surface chat
// consumes, so a kernel bump that breaks chat is caught headlessly instead of
// in the browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));

// sodium + the host resolve through seedkernel-wasm; loadCrypto (the Node entry's
// one crypto seam) readies core libsodium and mixes in ML-DSA-65, exactly what the
// browser shell's seedkernel-wasm/crypto-browser loadCrypto does. ML-KEM stays
// private to the signed transport bundle.
const { loadCrypto } = await import("seedkernel-wasm");
const sodium = await loadCrypto();
// bootShell is the assembly itself (§12.9): platform members defaulted, the transport
// bundle pinned to its own author, the adapter built from the transport options passed
// here. The shells' admit is then ONLY the consent gate.
const { bootShell } = await import("seedkernel-wasm/shell-core");
// `TRANSPORT_SERVICE` is emitted beside the blob it belongs to, not known to the loader:
// a replacement transport may spell its claim differently, and then THAT spelling is the
// one the host reaches. Chat runs the shipped one, so this is the id chat must agree with.
const { transportBundleBytes, TRANSPORT_SERVICE } = await import("seedkernel-wasm/transport-bundle");
const {
  hybridAuthorId, unpackBundle, verifyManifest, genesisHash,
  MANIFEST_FILE, GUEST_FILE, moduleFile,
} = await import("seedkernel-wasm/bundle");
const { signManifest, guestOpFraming, hybridAuthorKeysFromSeed, packBundle }
  = await import("seedkernel-wasm/bundle-author");
// The chat app shape the offline builder authors — same guest source, same authority set.
const { chatGuestSource, isChatApp, CHAT_APP_REQUIRES, CHAT_APP_CALLS, CHAT_PROTO, CHAT_OP_SEND, NET_PROTO } = await import("../browser/chat-app.js");
// The offers app shape — same guest source scripts/build-offers-bundle.mjs signs into
// bundle/offers.skb, read directly off disk below like chat-app-v1.wasm already is.
const { OFFER_PROTO, OFFERS_KEY_PREFIX } = await import("../browser/offers-app.js");
// The identity the page pins its offers boot bundle by, off the generated artifact the
// page itself reads — so `admit` below is the browser's gate, not a stand-in for it.
const { OFFERS_AUTHOR_HEX, OFFERS_APP } = await import("../browser/offers-bundle.js");
// `writeOp` frames an app's own local op; `OpArgs` writes the transport bundle's op
// arguments, which is what the host's own door into the network takes (`peersOf` below).
const { writeOp, OpArgs } = await import("seedkernel-wasm/op-frame");

// The exact transport bundle bytes the kernel embeds, reached through the export —
// so the smoke test touches no non-published surface and never reads the dependency's
// build directory off disk.
const TRANSPORT_BYTES = transportBundleBytes();

const toHex = (b) => Buffer.from(b).toString("hex");

// ── the chat-shell admit gate, in shape ────────────────────────────────────────
// ONE admission predicate (§12.5), and the one branch that is actually chat's: the
// consent gate. The transport author pin is the assembly's half (`bootShell` composes
// it from the blob itself), so the FORGED-transport check below exercises the pin the
// browser shell actually runs under rather than a copy of it.
const pendingApprovals = new Set();
function admit(v, ctx) {
  // A bundle reaching a privilege is not an app: it would BE the network, and who may
  // be the network is the pin bootShell ANDed onto this gate — the kernel-shipped
  // transport author, and no other. Deferring is safe in both directions: the pin
  // refuses a privilege it does not know rather than inheriting this `true`. Consent
  // is for apps.
  if (ctx.privileges.length > 0) return true;
  // The offers boot bundle is pinned to the exact author and app this build produced,
  // exactly as chat-shell.js pins it and as bootShell pins the transport: bytes the
  // deployment shipped, loaded before any dialog could run, so there is nothing for a
  // consent click to decide.
  if (toHex(v.author) === OFFERS_AUTHOR_HEX && v.manifest.app === OFFERS_APP) return true;
  const bytesHashHex = v.modules.length > 0 ? v.modules[0].mod.hash : "";
  if (!pendingApprovals.has(bytesHashHex)) return false;
  pendingApprovals.delete(bytesHashHex);
  return true;
}

// ── an instrumented channel pair (mirrors the kernel's wirePair) ──────────────
function wirePair() {
  const mk = (name, remoteAddr) => ({
    name, remoteAddr, sent: [], dead: false, inFlight: 0, msg: null, cls: null, peer: null,
    // FRAMING.PLATFORM (socket-seam.ts): one send is one delivery, so the transport
    // bundle frames nothing — the same thing an RTCDataChannel says, which is what the
    // browser shell puts under the driver.
    framing: 0,
    send(bytes) {
      if (this.dead) return;
      this.sent.push(Buffer.from(bytes).toString("hex"));
      const seq = ++this.inFlight;
      queueMicrotask(() => { if (!this.peer.dead) this.peer.msg?.(bytes); });
    },
    onData(cb) { this.msg = cb; },
    onClose(cb) { this.cls = cb; },
    close() { if (this.dead) return; this.dead = true; queueMicrotask(() => this.peer.cls?.()); },
  });
  const a = mk("A", "10.0.0.1"), b = mk("B", "10.0.0.2");
  a.peer = b; b.peer = a;
  return [a, b];
}

// An accept-only ChannelFactory, matching RtcNetwork's side of the platform seam. The
// transport registers its sink during boot; a test then hands each end of wirePair to the
// appropriate host with the same metadata an RtcChannel carries.
class InjectedChannels {
  #onAccept = null;

  async listen(_tcp, _ws, onAccept) {
    this.#onAccept = onAccept;
    return { port: 0, wsPort: 0 };
  }

  give(channel, { weDialed = false, expectPeerId } = {}) {
    if (!this.#onAccept) throw new Error("channel factory has no transport sink");
    channel.weDialed = weDialed;
    if (expectPeerId) channel.expectPeerId = expectPeerId;
    this.#onAccept(channel);
  }

  close() { this.#onAccept = null; }
}

// The predicate is AWAITED: a promise object is truthy on the first tick, so an async
// one polled by value would return immediately and make the whole wait a silent no-op.
async function until(fn, ms = 4000, what = "condition") {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error("timeout waiting for " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The peers a node holds an authenticated link to. Asked of the transport GUEST, through
 *  the host's own door into a co-resident `services` claim (`Shell.call`, seedkernel
 *  §12.10) — the same call the kernel's CLI makes for a cohort, and the same one
 *  chat-shell.js's `linkedPeers` makes for its peer pill. The driver answers nothing
 *  peer-shaped: links are the guest's, so this is a round trip through its realm.
 *  `null` is "nothing claims that id" — a node with no transport standing. */
async function peersOf(shell) {
  const answer = shell.call(NET_PROTO, new OpArgs("peers").build());
  if (!answer) return [];
  const bytes = await answer;
  const out = [];
  for (let off = 0; off + 32 <= bytes.length; off += 32) out.push(toHex(bytes.slice(off, off + 32)));
  return out;
}
// The one string in the kernel's vocabulary chat spells by hand (chat-app.js keeps a
// no-imports shape) must be the transport bundle's own claim, or the guest calls
// nothing. The kernel reserves no name for it: the claim is an ordinary LOCAL service
// name (§12.10) — the transport's manifest declares it under `services`, never under
// `protocols`, so a peer frame naming it is refused by the routing — and the bundle
// itself is the ground truth.
const transportManifest = verifyManifest(sodium, unpackBundle(TRANSPORT_BYTES)[MANIFEST_FILE]).manifest;
assert((transportManifest.services ?? []).includes(NET_PROTO),
  `chat's net id ${JSON.stringify(NET_PROTO)} must be the transport bundle's services claim`);
assert(NET_PROTO === TRANSPORT_SERVICE,
  `chat's net id ${JSON.stringify(NET_PROTO)} must be the id the shipped transport publishes `
  + `(${JSON.stringify(TRANSPORT_SERVICE)}) — that is the one a host-side call reaches`);
assert(!Object.hasOwn(transportManifest.guest, "abi"),
  "the all-async guest seam has no manifest ABI field");
let failed = 0;
const ok = (name) => console.log(`  OK   ${name}`);
const fail = (name, err) => { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); };

const kpA = sodium.crypto_sign_keypair();
const identityA = { publicKey: kpA.publicKey, privateKey: kpA.privateKey };
const kpB = sodium.crypto_sign_keypair();
const identityB = { publicKey: kpB.publicKey, privateKey: kpB.privateKey };
// WHO each node is on the wire, derived here rather than read back off the adapter. A peer
// id is the node identity's public key in hex — the host folds exactly this into the
// transport's LOCAL config — and the adapter stopped carrying a copy when the address book
// moved into the transport guest's own realm (seedkernel §12.10). Nothing between that
// guest and a socket deals in peers any more, so the only thing still naming one is a test
// choosing a destination, and it can say it from the keypair it just made.
const peerA = toHex(identityA.publicKey);
const peerB = toHex(identityB.publicKey);
// A's AUTHOR key set, which is not its node identity: a manifest is signed by both an
// Ed25519 and an ML-DSA-65 key (seedkernel §12.4), and the author id is the hash over
// the pair. Through the kernel's own seed→key-set derivation, the same call the browser
// shell makes, so this test signs with the key set the shell would.
const authorA = hybridAuthorKeysFromSeed(sodium, identityA.privateKey.slice(0, 32));
const CONTACT = new Uint8Array(32).fill(7); // a "room secret" both ends share

// What B's own loaded slots answered, filled in by each load's onInbound (seedkernel
// §12.10) below — the shell itself serves no name any more, so there is no claims
// table to register a handler on; each load owns its own answer.
const inbound = { render: null };

// The adapter is bootShell's, exactly as chat-shell.js gets it: the factory exists first
// and is passed as `transport.channels`; boot loads the pinned transport and registers
// each factory's accept sink. `contactSecret` stays a live getter, re-read for each channel
// announcement (§12.6.3), which makes a room rotation a sever rather than a reload.
const channelsA = new InjectedChannels();
const channelsB = new InjectedChannels();
const { shell: A, transport: netA } = await bootShell({
  sodium, identity: identityA,
  transport: { get contactSecret() { return CONTACT; }, channels: channelsA }, admit,
});
// B keeps no handle on its adapter: the assertions below are about what a driver no
// longer carries, one node says that once, and everything B is actually asked for — its
// peer set — goes through its shell like A's does.
const { shell: B } = await bootShell({
  sodium, identity: identityB,
  transport: { get contactSecret() { return CONTACT; }, channels: channelsB }, admit,
});

// 1. transport bundle admitted by author pin; the socket driver standing
try {
  // The adapter carries the host's half of the network and nothing else: sockets and
  // listeners, three link events out, and NOTHING peer-shaped — no address book, no
  // cohort, no peer set, all of which are the transport guest's own (§12.10). `send` is
  // deliberately absent too: an app sends by calling the local service name the transport
  // serves, so asserting these absences is asserting the seam. Nor is the adapter on the
  // SHELL: it is the platform's, and the shell's whole part is having bound the raw-link
  // capability to the bundle just admitted.
  assert(A.transport === undefined, "the shell exposes no transport — the adapter is the platform's");
  assert(A.resolve(NET_PROTO) !== null, `the admitted bundle serves ${NET_PROTO}`);
  assert(netA.openLink === undefined, "the removed per-link injection seam stays absent");
  assert(netA.peerId === undefined, "the adapter names no peer — identity reaches the guest as LOCAL config");
  assert(netA.addPeerAddr === undefined && netA.addr === undefined,
    "the address book left the driver for the transport guest");
  assert(netA.linkedPeers === undefined && netA.ready === undefined,
    "cohorts and the peer set left the driver too — they are claim calls now");
  assert(netA.send === undefined, "the adapter has no request facade — sending is an app's");
  // What replaced all three: the host's own door into the claim the transport serves,
  // which is the call chat-shell.js's peer pill makes. Not yet linked to anyone, so the
  // answer is an empty peer set rather than a refusal.
  assert((await peersOf(A)).length === 0, `${NET_PROTO} answers a host-side call, with no peers yet`);
  assert(A.call("no.such.service", new OpArgs("peers").build()) === null,
    "a claim nothing serves answers null rather than a promise nobody settles");
  ok("transport bundle admitted by author pin; the channel adapter has a raw-link owner");
} catch (err) { fail("transport bundle admission", err); }

// 2. a FORGED bundle reaching the transport privileges must be refused
try {
  const forgedManifest = {
    app: "evil", version: 1, modules: [],
    // A bundle that would BE the network: it reaches the `link` privilege by naming
    // `link` — the whole of what makes a bundle a transport, inbound delivery being
    // that slot's own return convention rather than a second privilege to name (§12.5).
    // `node` is the one sign pair, scoped to this slot's network key; there is no
    // `link/sign` name anymore. Its `_net` claim is an ordinary local service name —
    // declare it under `services`, never `protocols`, which is what a peer reaches —
    // and even then it is refused purely because an author the transport pin does not
    // pin reached a privilege.
    services: ["_net"],
    guest: {
      hash: "00".repeat(32),
      requires: ["link", "node", "timer"],
    },
  };
  const env = signManifest(sodium, authorA, forgedManifest);
  const blob = packBundle({ [MANIFEST_FILE]: env, [GUEST_FILE]: new Uint8Array(0) });
  await A.loadBundleBlob(blob);
  throw new Error("forged transport bundle was admitted!");
} catch (err) {
  if (err.message === "forged transport bundle was admitted!") fail("forged transport refusal", err);
  else ok("forged transport bundle refused (author pin on link)");
}

// 3. build + install a real chat app bundle (the shape scripts/build-app-bundle.mjs
//    now authors offline; this test still assembles its own inline so it exercises
//    signManifest/packBundle directly rather than shelling out)
const chatWasm = new Uint8Array(readFileSync(resolve(here, "../build/chat-app-v1.wasm")));
let chatApp = null;
let chatKey = "";
try {
  // The ~5-line guest every chat app ships, from the same module the browser shell
  // authors from (browser/chat-app.js) — signed source is written once, so this test
  // exercises the bytes the shell would actually sign rather than a copy of them.
  const guestBytes = new TextEncoder().encode(chatGuestSource("chat", guestOpFraming));
  const manifest = {
    app: "chat",
    version: 1,
    // The claim (§12.10) — every chat app declares the one chat protocol, and the load
    // is what routes it. Same constant the browser shell signs into its bundles.
    protocols: [CHAT_PROTO],
    modules: [{ name: "chat", hash: toHex(genesisHash(sodium, chatWasm)) }],
    guest: {
      hash: toHex(genesisHash(sodium, guestBytes)),
      // The two signed reach lists (§12.2, §12.10): no host service at all, and one
      // co-resident guest — the network.
      requires: CHAT_APP_REQUIRES,
      calls: CHAT_APP_CALLS,
    },
  };
  const manifestEnv = signManifest(sodium, authorA, manifest);
  const chatBundle = packBundle({ [MANIFEST_FILE]: manifestEnv, [moduleFile("chat")]: chatWasm, [GUEST_FILE]: guestBytes });
  const moduleHash = toHex(genesisHash(sodium, chatWasm));
  pendingApprovals.add(moduleHash);            // auto-approve like addAppFromWasm
  chatApp = await A.loadBundleBlob(chatBundle);
  chatKey = chatApp.key;
  // The app's module is private to its slot, so there is no table to ask what landed:
  // a load builds every module or none (§12.4), and what the shell exposes is the claim.
  assert(A.resolve(CHAT_PROTO) === chatKey, `A routes "${CHAT_PROTO}" to the app it installed`);
  // The receiving peer installs its own app, and that is the whole of it: the manifest
  // claims "chat" and B's load routes it there (§12.10). Each peer's routing is its own
  // — B would answer the same frames with a different author's chat app, as long as it
  // claimed the same protocol.
  pendingApprovals.add(moduleHash);
  // B's view of what its own chat app answered for an inbound frame is this load's own
  // `onInbound` (seedkernel §12.10) — no second name for the guest to push through.
  await B.loadBundleBlob(chatBundle, {
    onInbound: (claim, from, answer) => { if (answer.length > 0) inbound.render = new Uint8Array(answer); },
  });
  assert(B.resolve(CHAT_PROTO) === chatKey, `B routes "${CHAT_PROTO}" to the app it installed`);
  ok(`chat app installed on both shells under ${chatKey.slice(0, 24)}…`);
} catch (err) { fail("chat app install", err); }

// 4. link A and B through the ChannelFactory sinks registered during boot
try {
  const [chA, chB] = wirePair();
  channelsA.give(chA, { weDialed: true, expectPeerId: peerB });
  channelsB.give(chB);
  await until(async () => {
    const [aPeers, bPeers] = await Promise.all([peersOf(A), peersOf(B)]);
    return aPeers.includes(peerB) && bPeers.includes(peerA);
  }, 4000, "handshake");
  ok("two transport ends authenticated over the channel seam");
} catch (err) { fail("transport handshake", err); }

// 5. dispatch: A's chat app sends a message, B renders it via its bound app's guest
try {
  const body = new TextEncoder().encode("hi there");
  const chatBytes = new Uint8Array(1 + body.length);
  chatBytes[0] = 0x00;
  chatBytes.set(body, 1);
  // The send leaves through A's chat app, because that is the only thing that can send:
  // its guest's `handle` frames the transport's op wire and calls `_net`, on the local
  // `send` op. Same argument shape the browser shell builds (`sendFrame` in chat-shell.js).
  const proto = new TextEncoder().encode(CHAT_PROTO);
  const arg = new Uint8Array(32 + 1 + proto.length + chatBytes.length);
  arg.set(identityB.publicKey, 0);
  arg[32] = proto.length;
  arg.set(proto, 33);
  arg.set(chatBytes, 33 + proto.length);
  await chatApp.invoke(writeOp(CHAT_OP_SEND, arg));
  // B's view of the answer is its own load's onInbound (seedkernel §12.10): the render
  // bytes B's chat app's guest returned for the inbound frame ARE this call's answer,
  // handed to the loader that mounted it — no second claim, no relay.
  await until(() => inbound.render !== null, 4000, "rendered message");
  const delivered = inbound.render;
  // chat v1 render: [type 1][pk_len 1][pk 32][body]
  assert(delivered[0] === 0x00, "render type");
  assert(delivered[1] === 32, "render pk_len");
  assert(toHex(delivered.slice(2, 34)) === toHex(identityA.publicKey), "render sender pk = A's key");
  assert(new TextDecoder().decode(delivered.slice(34)) === "hi there", "render body");
  ok(`dispatch round-trip: A's app → _net → B's shell → B's chat app's guest → onInbound → ${delivered.length} render bytes`);
} catch (err) { fail("chat dispatch round-trip", err); }

// 6. the offers app: a second boot bundle on both shells (browser/offers-app.js), and
//    a real offer/v1 frame end to end. A's chat app sends an opaque blob under
//    offer/v1 — the offers app's own claim, never the chat app's — B's offers app
//    hashes it, stores `[from 32][blob]` under its own fs key, and answers with the
//    hash; B's view of "a fresh offer arrived" is that answer, delivered through
//    onInbound exactly like a chat render, with no shell-level claims table anywhere.
const offersSkbBytes = new Uint8Array(readFileSync(resolve(here, "../bundle/offers.skb")));
let bOffers = null;
try {
  // No consent entry for either load: the offers bundle is admitted by the author+app
  // pin in `admit` above, which is the whole difference between a boot bundle and an
  // app a user installs.
  const aOffers = await A.loadBundleBlob(offersSkbBytes);
  const offersInbound = { hash: null };
  bOffers = await B.loadBundleBlob(offersSkbBytes, {
    onInbound: (claim, from, answer) => { if (answer.length > 0) offersInbound.hash = new Uint8Array(answer); },
  });
  assert(A.resolve(OFFER_PROTO) === aOffers.key, `A routes "${OFFER_PROTO}" to the offers app`);
  assert(B.resolve(OFFER_PROTO) === bOffers.key, `B routes "${OFFER_PROTO}" to the offers app`);

  const offeredBlob = new TextEncoder().encode("a bundle blob, opaque to the offers app");
  const offerProtoBytes = new TextEncoder().encode(OFFER_PROTO);
  const offerArg = new Uint8Array(32 + 1 + offerProtoBytes.length + offeredBlob.length);
  offerArg.set(identityB.publicKey, 0);
  offerArg[32] = offerProtoBytes.length;
  offerArg.set(offerProtoBytes, 33);
  offerArg.set(offeredBlob, 33 + offerProtoBytes.length);
  // Sent through A's CHAT app's guest, same as offerApp() in chat-shell.js: only a
  // guest can call `_net` (§12.10), and offer/v1 is the offers bundle's claim now, not
  // the sender's — the chat app is just the guest already holding the network.
  await chatApp.invoke(writeOp(CHAT_OP_SEND, offerArg));

  await until(() => offersInbound.hash !== null, 4000, "offer notification");
  const hex = toHex(offersInbound.hash);
  assert(toHex(sodium.crypto_generichash(32, offeredBlob)) === hex,
    "the offer notification is the blake2b-256 hash of the blob");
  const record = await bOffers.fs.get(OFFERS_KEY_PREFIX + hex);
  assert(record !== null, `B's offers slot holds ${OFFERS_KEY_PREFIX}${hex.slice(0, 12)}…`);
  assert(toHex(record.slice(0, 32)) === toHex(identityA.publicKey), "the record's sender is A's key");
  assert(toHex(record.slice(32)) === toHex(offeredBlob), "the record's blob is the exact bytes A sent");
  ok(`offer end-to-end: A's chat app → offer/v1 → B's offers app's guest → fs record ${OFFERS_KEY_PREFIX}${hex.slice(0, 12)}…`);
} catch (err) { fail("offer end-to-end", err); }

// 7. the appKey derivation chat uses for its registry. It leads with the AUTHOR ID —
// the hash over the signing key set, not A's node key — which is what the app actually
// landed under above.
try {
  const authorId = hybridAuthorId(sodium, authorA.ed.publicKey, authorA.mlDsa.publicKey);
  // The app key the load bound under is `<author hex>:<app>` (§5.1) — the shape the
  // handle carries, which this test pins rather than re-derives.
  const key = toHex(authorId) + ":chat";
  assert(key === chatKey, "the handle's key is the load's own derivation");
  assert(chatKey.startsWith(toHex(authorId).slice(0, 8)), "appKey shape");
  ok("app key shape");
} catch (err) { fail("app key", err); }

// 8. the shape gate an Offer passes through (peekMeta → isChatApp). A peer's bundle
// is installed on one click of a row showing a name and an author, so the reach it
// declares is the whole of what that click grants — and a chat app's is exactly one
// local name, `_net`: the network it must reach to be a chat app at all, and no host
// service whatsoever. Two signed lists now, so the gate is checked on both.
try {
  const chatManifest = (requires, calls, modules, protocols) => ({
    app: "chat", version: 1,
    protocols: protocols ?? [CHAT_PROTO],
    modules: modules ?? [{ name: "chat", hash: "aa" }],
    guest: { hash: "bb", requires, ...(calls === undefined ? {} : { calls }) },
  });
  const shape = (over = {}) => chatManifest(
    over.requires ?? CHAT_APP_REQUIRES, over.calls ?? CHAT_APP_CALLS, over.modules, over.protocols);
  assert(isChatApp(shape()), "the shell's own app shape is accepted");
  assert(!isChatApp(shape({ requires: ["fs"] })), "an offered app claiming fs beside the network is refused");
  assert(!isChatApp(shape({ requires: ["node"] })), "an offered app claiming a signing oracle is refused");
  assert(!isChatApp(shape({ requires: ["link"] })), "an offered app reaching for sockets is refused");
  assert(!isChatApp(shape({ calls: [] })), "an app that cannot reach the network is refused");
  // `calls` absent ≡ none (§12.10), which is the same refusal as an empty list — the
  // gate must not read a missing field as "whatever the default is".
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, undefined)), "an app declaring no calls at all is refused");
  assert(!isChatApp(shape({ calls: [...CHAT_APP_CALLS, "_store"] })), "an app calling a second guest beside the network is refused");
  assert(!isChatApp(shape({ modules: [] })), "a no-module app is refused");
  // The claim is part of what one click grants (§12.10): installing an offered
  // bundle routes every id it claims to it, so a bundle claiming something other than
  // the chat protocol — or nothing, or extra ids beside it — is not a chat app.
  assert(!isChatApp(shape({ protocols: [] })), "an app claiming no protocol is refused");
  assert(!isChatApp(shape({ protocols: ["seedstore"] })), "an app claiming another protocol is refused");
  assert(!isChatApp(shape({ protocols: [CHAT_PROTO, "seedstore"] })), "an app claiming an extra protocol is refused");
  ok("the offer shape gate admits only network-only chat apps claiming the chat protocol");
} catch (err) { fail("offer shape gate", err); }

try { B.close(); } catch {}
try { A.close(); } catch {}

if (failed > 0) {
  console.error(`\nsmoke: ${failed} FAILED`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
