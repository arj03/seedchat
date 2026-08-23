// Headless smoke test: does chat still work on the kernel it depends on?
//
// Replays the boot path browser/chat-shell.js actually runs — the bootShell
// assembly + its implicit transport-author pin + consent-gated chat install +
// protocol dispatch — minus the browser-only WebRTC/DOM. Two shells link over
// the transport's openLink seam (the shape RtcNetwork hands it), and a real
// chat-app-v1.wasm round-trips a message. Run it after a kernel update:
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
// one crypto seam) readies libsodium AND mixes in ML-DSA-65 + ML-KEM-768, exactly
// what the browser shell's seedkernel-wasm/crypto-browser loadCrypto does.
const { loadCrypto } = await import("seedkernel-wasm");
const sodium = await loadCrypto();
// bootShell is the assembly itself (§12.9): platform members defaulted, the
// transport bundle pinned to its own author, the adapter taken as the instance
// below. The shells' admit is then ONLY the consent gate.
const { bootShell } = await import("seedkernel-wasm/shell-core");
const { TransportHost } = await import("seedkernel-wasm/transport-host");
const { transportBundleBytes } = await import("seedkernel-wasm/transport-bundle");
const {
  signManifest, hybridAuthorId, hybridAuthorKeysFromSeed, packBundle, unpackBundle,
  verifyManifest, genesisHash,
  MANIFEST_FILE, GUEST_FILE, moduleFile,
} = await import("seedkernel-wasm/bundle");
// The chat app shape the browser shell authors from — same guest source, same authority set.
const { chatGuestSource, isChatApp, CHAT_APP_REQUIRES, CHAT_PROTO, CHAT_OP_SEND, NET_PROTO, RENDER_PROTO } = await import("../browser/chat-app.js");
const { writeOp } = await import("seedkernel-wasm/op-frame");

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
  const bytesHashHex = v.modules.length > 0 ? v.modules[0].mod.hash : "";
  if (!pendingApprovals.has(bytesHashHex)) return false;
  pendingApprovals.delete(bytesHashHex);
  return true;
}

/** The channel adapter — the PLATFORM's, exactly as chat-shell.js builds it: the shell
 *  only routes its raw-link events to whichever admitted slot owns the `link` binding.
 *  The `contactSecret` getter is how chat feeds the CURRENT room secret to the
 *  accepting side, re-read on every fresh transport load (§12.6.3), which is what makes
 *  re-loading the bundle a way to change it. Handed to bootShell as an instance, so the
 *  transport load stays where chat puts it. */
function chatTransport(identity, contactSecret) {
  return new TransportHost({
    identity,
    get contactSecret() { return contactSecret; },
  });
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
// The one string in the kernel's vocabulary chat spells by hand (chat-app.js keeps a
// no-imports shape) must be the transport bundle's own claim, or the guest calls
// nothing. The kernel reserves no name for it: the claim is an ordinary local service
// name chosen by the composition that built the bundle, so the bundle itself is the
// ground truth.
const transportManifest = verifyManifest(sodium, unpackBundle(TRANSPORT_BYTES)[MANIFEST_FILE]).manifest;
assert((transportManifest.protocols ?? []).includes(NET_PROTO),
  `chat's net id ${JSON.stringify(NET_PROTO)} must be the transport bundle's claim`);
// The current host ABI, read off a real signed manifest rather than a client-facing
// constant — the kernel no longer exposes GUEST_ABI_VERSION outside authorBundle,
// since a caller can never meaningfully choose a different one.
const GUEST_ABI = transportManifest.guest.abi;
let failed = 0;
const ok = (name) => console.log(`  OK   ${name}`);
const fail = (name, err) => { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); };

const kpA = sodium.crypto_sign_keypair();
const identityA = { publicKey: kpA.publicKey, privateKey: kpA.privateKey };
const kpB = sodium.crypto_sign_keypair();
const identityB = { publicKey: kpB.publicKey, privateKey: kpB.privateKey };
// A's AUTHOR key set, which is not its node identity: a manifest is signed by both an
// Ed25519 and an ML-DSA-65 key (seedkernel §12.4), and the author id is the hash over
// the pair. Through the kernel's own seed→key-set derivation, the same call the browser
// shell makes, so this test signs with the key set the shell would.
const authorA = hybridAuthorKeysFromSeed(sodium, identityA.privateKey.slice(0, 32));
const CONTACT = new Uint8Array(32).fill(7); // a "room secret" both ends share

// What B's shell saw arrive, filled in by its `claims` handlers below — the shell's
// own exact claims, the browser shell's in the same shape (§12.10).
const inbound = { render: null, offers: 0 };

const netA = chatTransport(identityA, CONTACT);
const netB = chatTransport(identityB, CONTACT);

const A = (await bootShell({ sodium, identity: identityA, transport: netA, admit })).shell;
const B = (await bootShell({
  sodium, identity: identityB, transport: netB, admit,
  // The shell's own exact claims (§12.10), no wildcard and no fall-through, and one of
  // each kind. `offer/v1` is an ordinary id because a PEER reaches it (the app that
  // would handle it is the thing being offered); `_render` is `_`-led because only a
  // co-resident guest may — the render relay a chat app pushes through when it serves
  // an inbound frame, the receiving shell's own view of the answer since delivery is the
  // link occupant's return convention rather than a host call an app could make.
  claims: {
    "offer/v1": (attribution, payload) => {
      inbound.offers++;
      return Promise.resolve(new Uint8Array(0));
    },
    [RENDER_PROTO]: (callerId, bytes) => {
      inbound.render = new Uint8Array(bytes);
      return Promise.resolve(new Uint8Array(0));
    },
  },
})).shell;

// 1. transport bundle admitted by author pin; the socket driver standing
try {
  await A.loadBundleBlob(TRANSPORT_BYTES);
  await B.loadBundleBlob(TRANSPORT_BYTES);
  // The adapter carries the host's half of the network: sockets, the address book,
  // listeners. `send` is deliberately NOT there — an app sends by calling the local
  // service name the transport serves (§12.10) — so asserting its absence is asserting
  // the seam. Nor is the adapter on the SHELL: it is the platform's, and the shell's
  // whole part is having bound the raw-link capability to the bundle just admitted.
  assert(A.transport === undefined, "the shell exposes no transport — the adapter is the platform's");
  assert(A.resolve(NET_PROTO) !== null, `the admitted bundle serves ${NET_PROTO}`);
  assert(typeof netA.openLink === "function", "the adapter takes channels");
  assert(typeof netA.linkedPeers === "function", "the adapter answers the transport's peer set");
  assert(netA.send === undefined, "the adapter has no request facade — sending is an app's");
  ok("transport bundle admitted by author pin; the channel adapter has a raw-link owner");
} catch (err) { fail("transport bundle admission", err); }

// 2. a FORGED bundle reaching the transport privileges must be refused
try {
  const forgedManifest = {
    app: "evil", version: 1, modules: [],
    // A bundle that would BE the network: it reaches the `link` privilege by naming
    // `link/*` — the whole of what makes a bundle a transport, inbound delivery being
    // that slot's own return convention rather than a second privilege to name (§12.5).
    // `node/sign`/`node/verify` are the one sign pair, scoped to this slot's network key;
    // there is no `link/sign` name anymore. Its `_net` claim is an ordinary service
    // name, nothing malformed about the spelling: it is refused purely because an
    // author the transport pin does not pin reached a privilege.
    protocols: ["_net"],
    guest: {
      hash: "00".repeat(32), abi: GUEST_ABI,
      requires: ["link/open", "link/send", "link/close", "link/stat", "link/authenticated", "link/down",
                 "node/sign", "node/verify", "node/random", "timer/arm", "timer/clear"],
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
let chatKey = "";
try {
  // The ~5-line guest every chat app ships, from the same module the browser shell
  // authors from (browser/chat-app.js) — signed source is written once, so this test
  // exercises the bytes the shell would actually sign rather than a copy of them.
  const guestBytes = new TextEncoder().encode(chatGuestSource("chat"));
  const manifest = {
    app: "chat",
    version: 1,
    // The claim (§12.10) — every chat app declares the one chat protocol, and the load
    // is what routes it. Same constant the browser shell signs into its bundles.
    protocols: [CHAT_PROTO],
    modules: [{ name: "chat", hash: toHex(genesisHash(sodium, chatWasm)) }],
    guest: {
      hash: toHex(genesisHash(sodium, guestBytes)),
      abi: GUEST_ABI,
      requires: CHAT_APP_REQUIRES,
    },
  };
  const manifestEnv = signManifest(sodium, authorA, manifest);
  const chatBundle = packBundle({ [MANIFEST_FILE]: manifestEnv, [moduleFile("chat")]: chatWasm, [GUEST_FILE]: guestBytes });
  const moduleHash = toHex(genesisHash(sodium, chatWasm));
  pendingApprovals.add(moduleHash);            // auto-approve like addAppFromWasm
  const loaded = await A.loadBundleBlob(chatBundle);
  chatKey = loaded.key;
  // The app's module is private to its slot, so there is no table to ask what landed:
  // a load builds every module or none (§12.4), and what the shell exposes is the claim.
  assert(A.resolve(CHAT_PROTO) === chatKey, `A routes "${CHAT_PROTO}" to the app it installed`);
  // The receiving peer installs its own app, and that is the whole of it: the manifest
  // claims "chat" and B's load routes it there (§12.10). Each peer's routing is its own
  // — B would answer the same frames with a different author's chat app, as long as it
  // claimed the same protocol.
  pendingApprovals.add(moduleHash);
  await B.loadBundleBlob(chatBundle);
  assert(B.resolve(CHAT_PROTO) === chatKey, `B routes "${CHAT_PROTO}" to the app it installed`);
  ok(`chat app installed on both shells under ${chatKey.slice(0, 24)}…`);
} catch (err) { fail("chat app install", err); }

// 4. link A and B over the transport (the WebRTC seam's openLink shape)
const st = { a: { authed: false }, b: { authed: false } };
try {
  const [chA, chB] = wirePair();
  const aLink = netA.openLink({
    channel: chA, weDialed: true, expectPeerId: netB.peerId,
    contactSecret: CONTACT, source: chA.remoteAddr,
    onAuth: () => { st.a.authed = true; },
  });
  const bLink = netB.openLink({
    channel: chB, weDialed: false, source: chB.remoteAddr,
    onAuth: () => { st.b.authed = true; },
  });
  await until(() => st.a.authed && st.b.authed, 4000, "handshake");
  assert(aLink.linkId > 0 && bLink.linkId > 0, "link ids minted");
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
  arg.set(netB.peerId ? Buffer.from(netB.peerId, "hex") : new Uint8Array(32), 0);
  arg[32] = proto.length;
  arg.set(proto, 33);
  arg.set(chatBytes, 33 + proto.length);
  await A.invoke(writeOp(CHAT_OP_SEND, arg), chatKey);
  // B's view of the answer arrives through the render relay: the chat app's guest
  // pushed the render bytes it produced for the inbound frame to B's `_render` claim.
  await until(() => inbound.render !== null, 4000, "rendered message");
  const delivered = inbound.render;
  // chat v1 render: [type 1][pk_len 1][pk 32][body]
  assert(delivered[0] === 0x00, "render type");
  assert(delivered[1] === 32, "render pk_len");
  assert(toHex(delivered.slice(2, 34)) === toHex(identityA.publicKey), "render sender pk = A's key");
  assert(new TextDecoder().decode(delivered.slice(34)) === "hi there", "render body");
  ok(`dispatch round-trip: A's app → _net → B's shell → B's chat app's guest → render relay → ${delivered.length} render bytes`);
} catch (err) { fail("chat dispatch round-trip", err); }

// 6. the appKey derivation chat uses for its registry. It leads with the AUTHOR ID —
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

// 7. the shape gate an Offer passes through (peekMeta → isChatApp). A peer's bundle
// is installed on one click of a row showing a name and an author, so the requires it
// declares are the whole of what that click grants — and a chat app's are exactly two
// local names, `_net` and `_render`: the network it must reach to be a chat app at
// all, and the pipe that brings its renders home. Nothing else.
try {
  const chatManifest = (requires, modules, protocols) => ({
    app: "chat", version: 1,
    protocols: protocols ?? [CHAT_PROTO],
    modules: modules ?? [{ name: "chat", hash: "aa" }],
    guest: { hash: "bb", abi: GUEST_ABI, requires },
  });
  assert(isChatApp(chatManifest(CHAT_APP_REQUIRES)), "the shell's own app shape is accepted");
  assert(!isChatApp(chatManifest([...CHAT_APP_REQUIRES, "fs/get"])), "an offered app claiming fs beside the network is refused");
  assert(!isChatApp(chatManifest([...CHAT_APP_REQUIRES, "node/sign"])), "an offered app claiming a signing oracle is refused");
  assert(!isChatApp(chatManifest([NET_PROTO])), "an app that cannot relay its renders is refused");
  assert(!isChatApp(chatManifest([RENDER_PROTO])), "an app that cannot reach the network is refused");
  assert(!isChatApp(chatManifest(["link/open"])), "an offered app reaching for sockets is refused");
  assert(!isChatApp(chatManifest(["fs/get"])), "an offered app claiming fs instead of the network is refused");
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, [])), "a no-module app is refused");
  // The claim is part of what one click grants (§12.10): installing an offered
  // bundle routes every id it claims to it, so a bundle claiming something other than
  // the chat protocol — or nothing, or extra ids beside it — is not a chat app.
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, undefined, [])), "an app claiming no protocol is refused");
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, undefined, ["seedstore"])), "an app claiming another protocol is refused");
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, undefined, [CHAT_PROTO, "seedstore"])), "an app claiming an extra protocol is refused");
  ok("the offer shape gate admits only network-plus-render chat apps claiming the chat protocol");
} catch (err) { fail("offer shape gate", err); }

try { B.close(); } catch {}
try { A.close(); } catch {}

if (failed > 0) {
  console.error(`\nsmoke: ${failed} FAILED`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
