// Headless smoke test: does the shell still work on the seedkernel it depends on?
//
// Replays the boot path browser/shell.js actually runs — the bootShell
// assembly + its boot-selected transport + consent-gated app install +
// protocol dispatch — minus the browser-only WebRTC/DOM. Two shells link through
// injected ChannelFactory sinks (the shape RtcNetwork implements), the real chat app
// round-trips messages through the shell's two ops (browser/app-api.js), a later build of
// it replaces it in place, and the offers app (a second boot bundle, browser/offers-app.js)
// round-trips an offer. Run it after a seedkernel update:
//
//   node scripts/smoke.mjs
//
// Fails loudly (non-zero exit) on any regression in the seedkernel surface the shell
// consumes, so a seedkernel bump that breaks it is caught headlessly instead of
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
// bootShell is the assembly itself (§12.8): platform members defaulted, the selected
// transport bundle installed at boot, the adapter built from the transport options passed
// here. The shells' admit is then ONLY the consent gate.
const { bootShell } = await import("seedkernel-wasm/shell-core");
// `TRANSPORT_SERVICE` is emitted beside the blob it belongs to, not known to the host:
// a replacement transport may spell its claim differently, and then THAT spelling is the
// one the host reaches. The shell runs the shipped one, so this is the id to agree with.
const { transportBundleBytes, TRANSPORT_SERVICE } = await import("seedkernel-wasm/transport-bundle");
const {
  verifyBundle, genesisHash,
} = await import("seedkernel-wasm/bundle");
const { signBundle, authorBundle, guestOpFraming, hybridAuthorKeysFromSeed }
  = await import("seedkernel-wasm/bundle-author");
// The shell's contract with its apps: the gate, the consent digest, the context and the two
// ops. The same module the browser shell runs, so what is exercised here is its contract.
const { APP_API, APP_OP_CONTEXT, APP_OP_UI, NET_PROTO, appFacts, bundleDigest, contextJson }
  = await import("../browser/app-api.js");
// An app's source directory, read the way scripts/build-app-bundle.mjs reads it: the same
// guest sources, view and module, so this test signs the bytes the builder would.
const { readAppSource } = await import("./app-source.mjs");
// The offers app shape — same guest source scripts/build-boot-bundles.mjs signs into
// bundle/offers.skb, read directly off disk below.
const { OFFER_PROTO, OFFERS_KEY_PREFIX, OFFERS_OP_SEND } = await import("../browser/offers-app.js");
// The identity the page pins its offers boot bundle by, off the generated artifact the
// page itself reads — so `admit` below is the browser's gate, not a stand-in for it.
const { OFFERS_AUTHOR_HEX, OFFERS_APP } = await import("../browser/offers-bundle.js");
// The calls app: the signaling path for a call's media, pinned the same way.
const { CALL_PROTO, CALLS_OP_SEND } = await import("../browser/calls-app.js");
const { CALLS_AUTHOR_HEX, CALLS_APP } = await import("../browser/calls-bundle.js");
// `writeOp` frames an app's own local op; `OpArgs` writes the transport bundle's op
// arguments, which is what the host's own door into the network takes (`peersOf` below).
const { writeOp, OpArgs } = await import("seedkernel-wasm/op-frame");

// The exact transport bundle bytes seedkernel embeds, reached through the export —
// so the smoke test touches no non-published surface and never reads the dependency's
// build directory off disk.
const TRANSPORT_BYTES = transportBundleBytes();

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));

// ── the shell admit gate, in shape ────────────────────────────────────────
// ONE admission predicate (§12.5), and the one branch that is actually the page's: the
// consent gate. The transport never reaches it — bootShell installs the selected blob
// at boot, and ordinary loading cannot acquire `link` — so the FORGED-transport check
// below exercises the rule the browser shell actually runs under.
const pendingApprovals = new Set();
/** What a consent names (shell.js `peekBundle`): the digest of the whole bundle. */
const digestOf = (v) => toHex(bundleDigest(v, (bytes) => genesisHash(sodium, bytes)));
/** Consent to one bundle, as dropping it or accepting its offer does in the browser. */
const consent = (blob) => pendingApprovals.add(digestOf(verifyBundle(sodium, blob)));
function admit(v) {
  // The offers boot bundle is pinned to the exact author and app this build produced,
  // exactly as shell.js pins it: bytes the deployment shipped, loaded before any
  // dialog could run, so there is nothing for a consent click to decide.
  if (toHex(v.author) === OFFERS_AUTHOR_HEX && v.manifest.app === OFFERS_APP) return true;
  if (toHex(v.author) === CALLS_AUTHOR_HEX && v.manifest.app === CALLS_APP) return true;
  const hash = digestOf(v);
  if (!pendingApprovals.has(hash)) return false;
  pendingApprovals.delete(hash);
  return true;
}

// ── an instrumented channel pair (mirrors seedkernel's wirePair) ──────────────
function wirePair() {
  const mk = (name, remoteAddr) => ({
    name, remoteAddr, sent: [], dead: false, inFlight: 0, msg: null, cls: null, peer: null,
    // One send is one delivery, so `stream` stays absent and the transport bundle
    // frames nothing — the same shape as an RTCDataChannel.
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

// A ChannelFactory over channels the TEST built: one end of a pair handed in as an accept,
// the other answered to the dial a node's transport makes for the peer it was taught at
// that destination — every dial goes through the transport's own address book.
class InjectedChannels {
  #onAccept = null;
  #dials = new Map();

  async listen(addrs, onAccept) {
    this.#onAccept = onAccept;
    return addrs.map(() => 0);
  }

  connect(dest) {
    const channel = this.#dials.get(dest) ?? null;
    this.#dials.delete(dest);
    return channel;
  }

  give(channel, arrival = {}) {
    if (!this.#onAccept) throw new Error("channel factory has no transport sink");
    this.#onAccept(channel, arrival);
  }

  /** Teach `shell`'s transport `peer` at a destination this factory answers with
   *  `channel`, presenting `secret`, and set the dial off with `ready`. */
  async dial(shell, peer, channel, secret) {
    const dest = `inject://${peer}`;
    this.#dials.set(dest, channel);
    const taught = shell.call(NET_PROTO, new OpArgs("addr").blob(Buffer.from(peer, "hex")).blob(secret).text(dest).build());
    if (!taught) throw new Error(`nothing claims ${NET_PROTO}`);
    await taught;
    void shell.call(NET_PROTO, new OpArgs("ready").u32(1).build())?.catch(() => {});
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
 *  §12.10) — the same call seedkernel's CLI makes for a cohort, and the same one
 *  shell.js's `linkedPeers` makes for its peer pill. The driver answers nothing
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

/** How a node reaches each linked peer: the transport's `routes` op, which shell.js's
 *  `peerRoutes` reads for the Network tab's peer list. Peer hex to whether its link is
 *  direct. */
async function routesOf(shell) {
  const answer = shell.call(NET_PROTO, new OpArgs("routes").build());
  if (!answer) return new Map();
  const bytes = await answer;
  const out = new Map();
  for (let off = 0; off + 33 <= bytes.length; off += 33) out.set(toHex(bytes.slice(off, off + 32)), bytes[off + 32] === 1);
  return out;
}

/** Set the transport guest's inbound contact gate. Empty means open (§12.6.3). */
async function setContactSecret(shell, secret) {
  const answer = shell.call(NET_PROTO, new OpArgs("contact")
    .blob(secret ?? new Uint8Array(0))
    .build());
  if (!answer) throw new Error(`nothing claims ${NET_PROTO}`);
  await answer;
}
// The one string in the host's vocabulary the shell spells by hand (app-api.js keeps a
// no-imports shape, and the guest library spells it again in guest source,
// assembly/guest-lib/net.js) must be the transport bundle's own claim, or the guest calls
// nothing. The host reserves no name for it: the claim is an ordinary LOCAL service
// name (§12.10) — the transport's manifest declares it under `services`, never under
// `protocols`, so a peer frame naming it is refused by the routing — and the bundle
// itself is the ground truth.
const transportManifest = verifyBundle(sodium, TRANSPORT_BYTES).manifest;
assert((transportManifest.services ?? []).includes(NET_PROTO),
  `the shell's net id ${JSON.stringify(NET_PROTO)} must be the transport bundle's services claim`);
assert(NET_PROTO === TRANSPORT_SERVICE,
  `the shell's net id ${JSON.stringify(NET_PROTO)} must be the id the shipped transport publishes `
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
// id is the node identity's public key in hex — the transport reads it from
// `HOST.identity` — and the adapter stopped carrying a copy when the address book moved
// into the transport guest's own realm (seedkernel §12.10). Nothing between that guest
// and a socket deals in peers any more, so the only thing still naming one is a test
// choosing a destination, and it can say it from the keypair it just made.
const peerA = toHex(identityA.publicKey);
const peerB = toHex(identityB.publicKey);
// A's AUTHOR key set, which is not its node identity: a manifest is signed by both an
// Ed25519 and an ML-DSA-65 key (seedkernel §12.4), and the author id is the hash over
// the pair. Through seedkernel's own seed→key-set derivation, the same call the browser
// shell makes, so this test signs with the key set the shell would.
const authorA = hybridAuthorKeysFromSeed(sodium, identityA.privateKey.slice(0, 32));
const CONTACT = new Uint8Array(32).fill(7); // each node's contact secret, which the other presents

// What B's chat app answered for each inbound frame it drew, filled in by its load's
// onInbound (seedkernel §12.10) — the shell itself serves no name any more, so there is no
// claims table to register a handler on; each load owns its own answer. An empty answer is
// a frame the guest did not draw.
const renders = [];
const onChatInbound = (claim, from, answer) => { if (answer.length > 0) renders.push(new Uint8Array(answer)); };
// A's handle into a second app beside chat (3b), which plays a misbehaving peer in 5c.
let rogueApp = null;

// The adapter is bootShell's, exactly as shell.js gets it: the factory exists first
// and is passed as `transport.channels`; boot installs the selected transport and registers
// each factory's accept sink. Contact policy is installation-local transport GUEST config.
const channelsA = new InjectedChannels();
const channelsB = new InjectedChannels();
const { shell: A, transport: netA } = await bootShell({
  sodium, identity: identityA,
  transport: { channels: channelsA, config: { contactSecret: toHex(CONTACT) } }, admit,
});
// B keeps no handle on its adapter: the assertions below are about what a driver no
// longer carries, one node says that once, and everything B is actually asked for — its
// peer set — goes through its shell like A's does.
const { shell: B } = await bootShell({
  sodium, identity: identityB,
  transport: { channels: channelsB, config: { contactSecret: toHex(CONTACT) } }, admit,
});

// 1. transport bundle installed at boot; the socket driver standing
try {
  // The adapter carries the host's half of the network and nothing else: sockets and
  // listeners, three link events out, and NOTHING peer-shaped — no address book, no
  // cohort, no peer set, all of which are the transport guest's own (§12.10). `send` is
  // deliberately absent too: an app sends by calling the local service name the transport
  // serves, so asserting these absences is asserting the seam. Nor is the adapter on the
  // SHELL: it is the platform's, and the shell's whole part is having bound the raw-link
  // service to the bundle just admitted.
  assert(A.transport === undefined, "the shell exposes no transport — the adapter is the platform's");
  assert(A.resolve(NET_PROTO) !== null, `the admitted bundle serves ${NET_PROTO}`);
  assert(netA.openLink === undefined, "the removed per-link injection seam stays absent");
  assert(netA.peerId === undefined, "the adapter names no peer — the guest reads HOST.identity");
  assert(netA.addPeerAddr === undefined && netA.addr === undefined,
    "the address book left the driver for the transport guest");
  assert(netA.linkedPeers === undefined && netA.ready === undefined,
    "cohorts and the peer set left the driver too — they are claim calls now");
  assert(netA.send === undefined, "the adapter has no request facade — sending is an app's");
  // What replaced all three: the host's own door into the claim the transport serves,
  // which is the call shell.js's peer pill makes. Not yet linked to anyone, so the
  // answer is an empty peer set rather than a refusal.
  assert((await peersOf(A)).length === 0, `${NET_PROTO} answers a host-side call, with no peers yet`);
  assert(A.call("no.such.service", new OpArgs("peers").build()) === null,
    "a claim nothing serves answers null rather than a promise nobody settles");
  ok("transport bundle installed at boot; the channel adapter has a raw-link owner");
} catch (err) { fail("transport bundle admission", err); }

// 2. a FORGED bundle reaching `link` must be refused
try {
  // Well-formed and correctly signed, so the refusal below is the link rule's rather than
  // an integrity failure. It would BE the network by naming `link` — the whole of what
  // makes a bundle a transport, inbound delivery being that slot's own return convention
  // (§12.5). Its `_net` claim is an ordinary local service name — declared under
  // `services`, never `protocols`, which is what a peer reaches.
  const forgedGuest = new TextEncoder().encode("function handle() { return new Uint8Array(); }");
  const forgedManifest = {
    app: "evil", version: 1, modules: [],
    services: ["_net"],
    guest: {
      requires: ["link", "node", "timer"],
    },
  };
  const blob = signBundle(sodium, authorA, forgedManifest, forgedGuest, []);
  await A.install(blob);
  throw new Error("forged transport bundle was admitted!");
} catch (err) {
  // An install that names no predecessor cannot acquire `link`; only one replacing the
  // current link owner can.
  if (/claim 'link' is already held/.test(err.message)) ok("forged transport bundle refused: an ordinary install cannot acquire link");
  else fail("forged transport refusal", err);
}

// 3. build + install a real chat app bundle, from the same source directory
//    scripts/build-app-bundle.mjs signs (this test assembles its own so it signs under a
//    key it holds, rather than shelling out)
const appDir = (name) => resolve(here, "../assembly", name);
const chatSource = readAppSource(appDir("chat-app"), guestOpFraming);
const chat = authorBundle(sodium, authorA, { ...chatSource, version: 1 });
const CHAT_PROTO = chat.manifest.protocols[0];
let chatApp = null;   // A's handle into its chat app's guest
let chatAppB = null;  // B's
let chatKey = "";
try {
  // What the shell reads off the signed manifest (`appFacts`): the app's row, its claim and
  // reach, and its view. All of it rides in the manifest, none of it in a module.
  const facts = appFacts(chat.manifest);
  assert(facts.name === "Chat" && facts.version === "v2", "the manifest carries the app's name and version");
  assert(typeof facts.ui === "string" && facts.ui.includes("<html"), "the manifest carries the app's view");
  assert(facts.requires.length === 1 && facts.requires[0] === NET_PROTO, "a chat app reaches the network and nothing else");
  consent(chat.blob);              // dropping the file is the consent
  chatApp = await A.install(chat.blob);
  chatKey = chatApp.manifest.app;
  // The app's module is private to its slot, so there is no table to ask what landed:
  // a load builds every module or none (§12.4), and what the shell exposes is the claim.
  assert(A.resolve(CHAT_PROTO) === chatKey, `A routes "${CHAT_PROTO}" to the app it installed`);
  // The receiving peer installs its own app, and that is the whole of it: the manifest
  // claims "chat" and B's load routes it there (§12.10). Each peer's routing is its own
  // — B would answer the same frames with a different author's chat app, as long as it
  // claimed the same protocol.
  consent(chat.blob);
  // B's view of what its own chat app answered for an inbound frame is this load's own
  // `onInbound` (seedkernel §12.10) — no second name for the guest to push through.
  chatAppB = await B.install(chat.blob, { onInbound: onChatInbound });
  assert(B.resolve(CHAT_PROTO) === chatKey, `B routes "${CHAT_PROTO}" to the app it installed`);
  ok(`chat app installed on both shells under '${chatKey}', its row and view read off the signed manifest`);
} catch (err) { fail("chat app install", err); }

// 3b. a consent names the WHOLE bundle (`bundleDigest`). Two bundles that differ only in
//     their guest are two bundles: a consent to one admits no other, which is what lets a
//     guest carry an app's behaviour.
try {
  const prelude = guestOpFraming() + readFileSync(resolve(here, "../assembly/guest-lib/net.js"), "utf8");
  // A guest-only app beside chat, serving nothing: its `send` op puts any frame on the
  // wire under the chat protocol, which the checks below use to play a peer that does not
  // keep to the chat guest's rules.
  const rogue = (extra) => authorBundle(sodium, authorA, {
    app: "rogue", version: 1, modules: [], guestRequires: [NET_PROTO],
    guestConfig: { shell: { api: APP_API, name: "Rogue" } },
    guestSource: `${prelude}
async function handle(arg) {
  const { args: p } = readOp(callerOf(arg).body);
  return await netSend(p.subarray(0, 32), ${JSON.stringify(CHAT_PROTO)}, p.subarray(32));
}${extra}`,
  }).blob;
  const [one, other] = [rogue(""), rogue("\n// the same app, with one more line of guest")];
  consent(one);
  let admitted = true;
  try { await A.install(other); } catch { admitted = false; }
  assert(!admitted, "a consent to one guest must not admit another");
  rogueApp = await A.install(one);
  ok("a consent names the whole bundle: a different guest is a different bundle");
} catch (err) { fail("consent names the whole bundle", err); }

// 4. link A and B through the ChannelFactory sinks registered during boot
try {
  const [chA, chB] = wirePair();
  channelsB.give(chB);
  await channelsA.dial(A, peerB, chA, CONTACT);
  await until(async () => {
    const [aPeers, bPeers] = await Promise.all([peersOf(A), peersOf(B)]);
    return aPeers.includes(peerB) && bPeers.includes(peerA);
  }, 4000, "handshake");
  ok("two transport ends authenticated over the channel seam");

  // The injected channel is a dial of the peer itself, not a splice through a relay, so
  // each end reads the other as direct — the answer the page's peer list shows.
  const [aRoutes, bRoutes] = await Promise.all([routesOf(A), routesOf(B)]);
  assert(aRoutes.get(peerB) === true && bRoutes.get(peerA) === true,
    "`routes` must answer each linked peer, and read a dialed link as direct");
  ok("the transport answers how each peer is reached");

  const rotated = new Uint8Array(32).fill(9);
  await Promise.all([setContactSecret(A, rotated), setContactSecret(B, rotated)]);
  const [aPeers, bPeers] = await Promise.all([peersOf(A), peersOf(B)]);
  assert(aPeers.includes(peerB) && bPeers.includes(peerA),
    "rotating the guest-owned contact gate must preserve existing links");
  ok("contact secret rotated in the transport guest without a reload");
} catch (err) { fail("transport handshake", err); }

// 5. dispatch: A's view hands its guest a frame, the guest sends it to the room's members,
//    and B's guest draws it — every step through the shell's two ops (app-api.js), with
//    the shell reading none of the bytes.
const ROOM = toHex(new Uint8Array(32).fill(5));     // a room both nodes are in
const STRAY = toHex(new Uint8Array(32).fill(6));    // one only A is in
/** The context a shell tells its apps (shell.js `contextNow`), as the `ctx` op's bytes. */
const contextOf = (me, rooms, linked, nicks = {}) =>
  utf8(contextJson({ me, nick: "", rooms, linked, contacts: [], nicks }));
const roomWith = (id, ...members) => ({ id, name: `room-${id.slice(0, 2)}`, members });
/** A room frame: [type][room 32][content]. */
const roomFrame = (type, room, content) => concat([type], fromHex(room), utf8(content));
try {
  // Each guest is told the context first, and answers it for its own view as render 0.
  // A nick is the shell's, and rides in the context: one outside ASCII is escaped on the way
  // in, because a guest reads a byte as a character, and comes out whole for the view.
  const view = await chatApp.invoke(writeOp(APP_OP_CONTEXT,
    contextOf(peerA, [roomWith(ROOM, peerB), roomWith(STRAY, peerB)], [peerB], { [peerB]: "Zoë" })));
  assert(view[0] === 0, "the context answer is render type 0, for the view");
  const told = JSON.parse(text(view.slice(1)));
  assert(told.api === APP_API && told.me === peerA && told.rooms.length === 2,
    "the view is handed the same context the guest was told");
  assert(told.nicks[peerB] === "Zoë", "a peer's nick reaches the view through the guest, whatever its characters");
  await chatAppB.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerB, [roomWith(ROOM, peerA)], [peerA])));

  // A frame for a room B is not in reaches B and is not drawn; the next, for the room they
  // share, is. One link carries both in order, so the first render B sees settles it.
  await chatApp.invoke(writeOp(APP_OP_UI, roomFrame(0x05, STRAY, "not for B")));
  const echo = await chatApp.invoke(writeOp(APP_OP_UI, roomFrame(0x05, ROOM, "hi there")));
  // The `ui` answer is the local echo: the frame drawn as A's own by A's module.
  assert(echo[0] === 0x05 && toHex(echo.slice(2, 34)) === peerA && text(echo.slice(66)) === "hi there",
    "the ui answer is the frame drawn as this node's own");
  await until(() => renders.length > 0, 4000, "rendered message");
  const delivered = renders[0];
  // a chat render: [type 1][pk_len 1][pk 32][body], the body passed through
  assert(delivered[0] === 0x05, "render type");
  assert(delivered[1] === 32, "render pk_len");
  assert(toHex(delivered.slice(2, 34)) === peerA, "render sender pk = A's key");
  assert(toHex(delivered.slice(34, 66)) === ROOM, "render room");
  assert(text(delivered.slice(66)) === "hi there", "render text — the frame for a room B is not in was not drawn");
  // A frame of a type chat does not speak goes nowhere, and is not drawn.
  assert((await chatApp.invoke(writeOp(APP_OP_UI, roomFrame(0x07, ROOM, "not a chat frame")))).length === 0,
    "chat's guest sends only the frame types it speaks");
  ok(`dispatch round-trip: A's view → ui op → A's guest → _net → B's guest → onInbound → ${delivered.length} render bytes`);
} catch (err) { fail("chat dispatch round-trip", err); }

/** A chat render, read: it is [type][pk_len][pk 32][body]. */
const parse = (r) => ({ type: r[0], from: toHex(r.slice(2, 34)), body: r.slice(34) });

// 5b. the upgrade: a later build of chat replaces it under the same label on both shells,
//     with no change to the shell — a new guest, module and view, driven through the same
//     two ops. A bundle under a standing label says which slot it retires (`replaces`), as
//     shell.js `applyAppBundle` does for one dropped over an app already installed.
try {
  const next = authorBundle(sodium, authorA, { ...chatSource, version: 2 });
  assert(digestOf(verifyBundle(sodium, next.blob)) !== digestOf(verifyBundle(sodium, chat.blob)), "a later build is another bundle");
  consent(next.blob);
  chatApp = await A.install(next.blob, { replaces: chatKey });
  consent(next.blob);
  chatAppB = await B.install(next.blob, { replaces: chatKey, onInbound: onChatInbound });
  assert(chatApp.manifest.version === 2 && A.resolve(CHAT_PROTO) === chatKey, "the later build holds the chat claim");
  // A replacement is a fresh realm: its guest is told the context again.
  await chatApp.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerA, [roomWith(ROOM, peerB)], [peerB])));
  await chatAppB.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerB, [roomWith(ROOM, peerA)], [peerA])));
  renders.length = 0;
  await chatApp.invoke(writeOp(APP_OP_UI, roomFrame(0x05, ROOM, "from the later build")));
  await until(() => renders.length >= 1, 4000, "the later build's render");
  const room = parse(renders[0]);
  assert(room.type === 0x05 && room.from === peerA && text(room.body.slice(32)) === "from the later build",
    "a room message from the later build");
  ok("upgrade under the same label: a later build replaces the app on both shells, with nothing but the bundle changed");
} catch (err) { fail("upgrade to a later build of chat", err); }

// 5c. the rest of what chat speaks: images, and direct messages. And what a guest draws of
//     a peer's frames is its own decision.
try {
  renders.length = 0;
  await chatApp.invoke(writeOp(APP_OP_UI, roomFrame(0x06, ROOM, "not really a jpeg")));
  await chatApp.invoke(writeOp(APP_OP_UI, concat([0x03], fromHex(peerB), utf8("just you"))));
  await until(() => renders.length >= 2, 4000, "chat's renders");
  const [image, direct] = renders.map(parse);
  assert(image.type === 0x06 && image.from === peerA && toHex(image.body.slice(0, 32)) === ROOM, "a room image");
  assert(direct.type === 0x03 && toHex(direct.body.slice(0, 32)) === peerB && text(direct.body.slice(32)) === "just you",
    "a direct message reaches its addressee");
  ok("chat draws room images and direct messages");

  // What B's guest draws is its own decision, not the sender's. The rogue app on A plays a
  // peer that sends what an honest chat guest never would.
  const asPeer = (frame) => rogueApp.invoke(writeOp("send", concat(fromHex(peerB), frame)));
  await chatAppB.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerB, [roomWith(ROOM)], [peerA]))); // A no longer in the room
  await asPeer(roomFrame(0x05, ROOM, "from outside the room"));
  await asPeer(concat([0x03], fromHex(peerA), utf8("addressed to someone else")));
  await asPeer(concat([0x03], fromHex(peerB), utf8("addressed to B")));
  await until(() => renders.length >= 3, 4000, "the one frame that is for B");
  assert(renders.length === 3 && text(parse(renders[2]).body.slice(32)) === "addressed to B",
    "a room frame from a peer not in the room, and a direct one for someone else, are not drawn");
  ok("the receive filter is the guest's: only frames for this node are drawn");
} catch (err) { fail("chat's frames and its receive filter", err); }

// 6. the offers app: a second boot bundle on both shells (browser/offers-app.js), and
//    a real offer/v1 frame end to end. A's offers app sends an opaque blob under
//    offer/v1 — its own claim, in both directions — B's offers app
//    hashes it, stores `[from 32][blob]` under its own fs key, and answers with the
//    hash; B's view of "a fresh offer arrived" is that answer, delivered through
//    onInbound exactly like a chat render, with no shell-level claims table anywhere.
const offersSkbBytes = new Uint8Array(readFileSync(resolve(here, "../bundle/offers.skb")));
let bOffers = null;
try {
  // No consent entry for either load: the offers bundle is admitted by the author+app
  // pin in `admit` above, which is the whole difference between a boot bundle and an
  // app a user installs.
  const aOffers = await A.install(offersSkbBytes);
  const offersInbound = { hash: null };
  bOffers = await B.install(offersSkbBytes, {
    onInbound: (claim, from, answer) => { if (answer.length > 0) offersInbound.hash = new Uint8Array(answer); },
  });
  assert(A.resolve(OFFER_PROTO) === aOffers.manifest.app, `A routes "${OFFER_PROTO}" to the offers app`);
  assert(B.resolve(OFFER_PROTO) === bOffers.manifest.app, `B routes "${OFFER_PROTO}" to the offers app`);

  const offeredBlob = utf8("a bundle blob, opaque to the offers app");
  // Sent through A's OFFERS app's guest, same as offerApp() in shell.js: only a
  // guest can call `_net` (§12.10), and the app that owns offer/v1 is the one that
  // speaks it. No other app's guest is borrowed to carry it.
  await aOffers.invoke(writeOp(OFFERS_OP_SEND, concat(identityB.publicKey, offeredBlob)));

  await until(() => offersInbound.hash !== null, 4000, "offer notification");
  const hex = toHex(offersInbound.hash);
  assert(toHex(sodium.crypto_generichash(32, offeredBlob)) === hex,
    "the offer notification is the blake2b-256 hash of the blob");
  const record = await bOffers.fs.get(OFFERS_KEY_PREFIX + hex);
  assert(record !== null, `B's offers slot holds ${OFFERS_KEY_PREFIX}${hex.slice(0, 12)}…`);
  assert(toHex(record.slice(0, 32)) === toHex(identityA.publicKey), "the record's sender is A's key");
  assert(toHex(record.slice(32)) === toHex(offeredBlob), "the record's blob is the exact bytes A sent");
  ok(`offer end-to-end: A's offers app → offer/v1 → B's offers app's guest → fs record ${OFFERS_KEY_PREFIX}${hex.slice(0, 12)}…`);
} catch (err) { fail("offer end-to-end", err); }

// 7. the calls app: a third boot bundle (browser/calls-app.js). A call's media rides a
//    peer connection the page owns; its signaling rides the node's channel under
//    call/v1. A's calls app sends a signal, and B's page sees it as its load's
//    onInbound answer, attributed to A by the channel.
try {
  const callsSkbBytes = new Uint8Array(readFileSync(resolve(here, "../bundle/calls.skb")));
  const aCalls = await A.install(callsSkbBytes);
  const signals = [];
  const bCalls = await B.install(callsSkbBytes, {
    onInbound: (claim, from, answer) => { if (answer.length > 0) signals.push({ claim, from: toHex(from), signal: new Uint8Array(answer) }); },
  });
  assert(B.resolve(CALL_PROTO) === bCalls.manifest.app, `B routes "${CALL_PROTO}" to the calls app`);
  const signal = new TextEncoder().encode(JSON.stringify({ sdp: { type: "offer", sdp: "v=0" } }));
  const arg = new Uint8Array(32 + signal.length);
  arg.set(identityB.publicKey, 0);
  arg.set(signal, 32);
  await aCalls.invoke(writeOp(CALLS_OP_SEND, arg));
  await until(() => signals.length > 0, 4000, "call signal");
  assert(signals[0].claim === CALL_PROTO, "the signal arrived under call/v1");
  assert(signals[0].from === peerA, "the signal is attributed to A by the channel");
  assert(toHex(signals[0].signal) === toHex(signal), "the signal arrives byte for byte");
  ok("call signaling end-to-end: A's calls app → call/v1 → B's calls app → onInbound");
} catch (err) { fail("call signaling end-to-end", err); }

// 8. the jam app: a second app beside chat, under its own label and its own protocol, with
//    no module at all. Its guest is a pipe scoped to a room that names the blocks of audio
//    passing through it: a frame its view casts reaches the room's members, one it tells
//    reaches one of them, and a block is drawn under the hash the RECEIVING guest gave it.
try {
  const jam = authorBundle(sodium, authorA, { ...readAppSource(appDir("jam-app"), guestOpFraming), version: 1 });
  const JAM_PROTO = jam.manifest.protocols[0];
  const facts = appFacts(jam.manifest);
  assert(facts.name === "Jam" && typeof facts.ui === "string", "the manifest carries jam's row and view");
  assert(facts.requires.length === 1 && facts.requires[0] === NET_PROTO && jam.manifest.modules.length === 0,
    "jam reaches the network and nothing else, and has no module");
  const jamRenders = [];
  consent(jam.blob);
  const jamA = await A.install(jam.blob);
  consent(jam.blob);
  const jamB = await B.install(jam.blob, { onInbound: (claim, from, answer) => { if (answer.length > 0) jamRenders.push(new Uint8Array(answer)); } });
  assert(A.resolve(JAM_PROTO) === jamA.manifest.app && A.resolve(CHAT_PROTO) === chatKey,
    "jam and chat stand side by side, each holding its own claim");
  assert(B.resolve(JAM_PROTO) === jamB.manifest.app, `B routes "${JAM_PROTO}" to the app it installed`);

  // A is in two rooms with B, as far as A knows; B is in one of them.
  const told = await jamA.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerA, [roomWith(ROOM, peerB), roomWith(STRAY, peerB)], [peerB])));
  assert(told[0] === 0 && JSON.parse(text(told.slice(1))).me === peerA, "jam's guest hands its view the context");
  await jamB.invoke(writeOp(APP_OP_CONTEXT, contextOf(peerB, [roomWith(ROOM, peerA)], [peerA])));

  const ASK_CAST = 1, ASK_TELL = 2, ASK_HASH = 3, DOC = 1, BLOCK = 4;
  const jamFrame = (type, room, body) => concat([type], fromHex(room), body);
  // Cast into the room B is not in, then into the one it is: one link carries both in
  // order, so the first render B sees says the first was not passed on.
  await jamA.invoke(writeOp(APP_OP_UI, concat([ASK_CAST], jamFrame(DOC, STRAY, utf8('{"msgs":[]}')))));
  const doc = jamFrame(DOC, ROOM, utf8('{"hello":true}'));
  const castAnswer = await jamA.invoke(writeOp(APP_OP_UI, concat([ASK_CAST], doc)));
  assert(castAnswer.length === 0, "a cast answers nothing: the view has already applied what it sent");
  await until(() => jamRenders.length >= 1, 4000, "jam's frame");
  assert(jamRenders[0][0] === 1 && toHex(jamRenders[0].slice(1, 33)) === peerA && toHex(jamRenders[0].slice(33)) === toHex(doc),
    "a peer's frame is passed to the view with its sender in front, and one for a room B is not in is not");

  // A block of the size the view cuts audio into, told to one member.
  const block = Uint8Array.from({ length: 128 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 255);
  const id = toHex(sodium.crypto_generichash(32, block));
  await jamA.invoke(writeOp(APP_OP_UI, concat([ASK_TELL], identityB.publicKey, jamFrame(BLOCK, ROOM, block))));
  await until(() => jamRenders.length >= 2, 4000, "jam's block");
  const got = jamRenders[1];
  assert(got[0] === 2 && toHex(got.slice(1, 33)) === peerA && toHex(got.slice(33, 65)) === ROOM, "a block is drawn with its sender and room");
  assert(toHex(got.slice(65, 97)) === id, "a block is named by the BLAKE2b-256 of its bytes, by the guest that received it");
  assert(got.length === 97 + block.length && toHex(got.slice(97)) === toHex(block), "a 128 KB block arrives whole");
  // The same name from the sender's own guest, which is how a track's block list is made.
  const named = await jamA.invoke(writeOp(APP_OP_UI, concat([ASK_HASH], [0, 0, 0, 7], block)));
  assert(named[0] === 3 && named[4] === 7 && toHex(named.slice(5)) === id, "a view's hash ask is answered under its tag");
  ok(`jam: cast and tell scoped to a room, and a ${block.length / 1024} KB block named by its hash at both ends`);
} catch (err) { fail("jam app", err); }

// 9. the gate a bundle passes before it is installed (peekBundle → appFacts). A peer's
// bundle is installed on one click of a row showing a name and an author, so the reach it
// declares is the whole of what that click grants. The shell hosts any app, so the gate is
// not about what an app is for: it is the contract version it was built to, and a reach
// within what the shell grants — the network, a keyspace of its own, a wake.
try {
  const manifest = (over = {}) => ({
    app: "friends", version: 1, modules: [],
    protocols: over.protocols ?? ["friends/v1"],
    ...(over.services ? { services: over.services } : {}),
    guest: {
      requires: over.requires ?? [NET_PROTO],
      config: over.config ?? { shell: { api: APP_API, name: "Friends" } },
    },
  });
  const refused = (m) => { try { appFacts(m); return false; } catch { return true; } };
  assert(!refused(manifest()), "an app claiming its own protocol and reaching the network is accepted");
  assert(!refused(manifest({ requires: [NET_PROTO, "fs", "timer"] })), "storage and a timer beside the network are granted");
  assert(!refused(manifest({ requires: [], protocols: [] })), "an app that reaches and serves nothing is harmless");
  assert(appFacts(manifest()).ui === null, "an app may have no view");
  assert(refused(manifest({ requires: [NET_PROTO, "node"] })), "an app claiming a signing oracle is refused");
  assert(refused(manifest({ requires: [NET_PROTO, "link"] })), "an app reaching for sockets is refused");
  assert(refused(manifest({ requires: [NET_PROTO, "_store"] })), "an app calling a second guest beside the network is refused");
  assert(refused(manifest({ services: ["friends"] })), "an app serving a local service is refused");
  assert(refused(manifest({ config: {} })), "a bundle with no shell entry is not an app for this shell");
  assert(refused(manifest({ config: { shell: { api: APP_API + 1 } } })), "an app built for another contract version is refused by name");
  ok("the install gate admits any app within the shell's grants and its contract version");
} catch (err) { fail("install gate", err); }

// 10. the two transport ops the page's rooms and contacts rest on: `welcome` names the
//    room-mates, whose calls need no contact secret, and `forget` drops one peer and its
//    links, which is how leaving a room hangs up without touching anyone else.
try {
  const welcomed = A.call(NET_PROTO, new OpArgs("welcome").blob(identityB.publicKey).build());
  assert(welcomed !== null, "the transport answers `welcome`");
  await welcomed;
  assert((await peersOf(A)).includes(peerB), "welcoming a peer leaves its link up");
  await A.call(NET_PROTO, new OpArgs("forget").blob(identityB.publicKey).build());
  await until(async () => !(await peersOf(A)).includes(peerB) && !(await peersOf(B)).includes(peerA),
    4000, "the forgotten peer's link to close at both ends");
  ok("the transport welcomes room-mates, and forgets one peer without a reset");
} catch (err) { fail("welcome and forget", err); }

try { B.close(); } catch {}
try { A.close(); } catch {}

if (failed > 0) {
  console.error(`\nsmoke: ${failed} FAILED`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
