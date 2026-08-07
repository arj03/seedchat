// Headless smoke test: does chat still work on the kernel it depends on?
//
// Replays the boot path browser/chat-shell.js actually runs — the createShell
// platform + author-pinned transport admission + consent-gated chat install +
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
// one crypto seam) readies libsodium AND mixes in ML-DSA-65, exactly what the
// browser shell's withMlDsa65 does.
const { loadCrypto } = await import("seedkernel-wasm");
const sodium = await loadCrypto();
const { createShell, ModuleTable } = await import("seedkernel-wasm/shell-core");
const {
  FreshnessMarks, signManifest, packBundle, verifyBundle, genesisHash,
  MANIFEST_FILE, GUEST_FILE, moduleFile, appKeyFor,
} = await import("seedkernel-wasm/bundle");
const { createSafeRealm } = await import("seedkernel-wasm/safe-js");
const { GUEST_ABI_VERSION } = await import("seedkernel-wasm/cap-bridge");
// The chat app shape the browser shell authors from — same guest source, same authority set.
const { chatGuestSource, isChatApp, CHAT_APP_REQUIRES } = await import("../browser/chat-app.js");

// The built transport bundle blob — the exact bytes host/transport-bundle.js
// embeds as B64 (both are written by the same kernel build step). Read from the
// dependency's build dir rather than parsing the embedded copy, so the smoke
// test touches no non-published surface.
const TRANSPORT_BYTES = new Uint8Array(readFileSync(
  resolve(here, "../node_modules/seedkernel-wasm/build/transport.skb")));
const transportAuthorHex = Buffer.from(verifyBundle(sodium, TRANSPORT_BYTES).author).toString("hex");

const toHex = (b) => Buffer.from(b).toString("hex");

// ── the chat-shell admit gates, in shape ──────────────────────────────────────
// The two admission classes (§12.5): `admit` answers app bundles (the consent
// gate), `admitTransport` answers the transport bundle, by author pin.
const pendingApprovals = new Set();
function admit(v) {
  const bytesHashHex = v.modules.length > 0 ? v.modules[0].mod.hash : "";
  if (!pendingApprovals.has(bytesHashHex)) return false;
  pendingApprovals.delete(bytesHashHex);
  return true;
}
function admitTransport(v) {
  return toHex(v.author) === transportAuthorHex;
}

function chatPlatform(identity, contactSecret) {
  return {
    sodium,
    identity,
    table: new ModuleTable(),
    freshnessStore: new FreshnessMarks(),
    // The getter is how chat-shell feeds the current room secret to the
    // transport driver at install time (§12.6.3).
    get contactSecret() { return contactSecret; },
    createRealm: async (o) => createSafeRealm(o),
  };
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

async function until(fn, ms = 4000, what = "condition") {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error("timeout waiting for " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
let failed = 0;
const ok = (name) => console.log(`  OK   ${name}`);
const fail = (name, err) => { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); };

const kpA = sodium.crypto_sign_keypair();
const identityA = { publicKey: kpA.publicKey, privateKey: kpA.privateKey };
const kpB = sodium.crypto_sign_keypair();
const identityB = { publicKey: kpB.publicKey, privateKey: kpB.privateKey };
const CONTACT = new Uint8Array(32).fill(7); // a "room secret" both ends share

const A = createShell({ platform: chatPlatform(identityA, CONTACT), admit, admitTransport });
const B = createShell({ platform: chatPlatform(identityB, CONTACT), admit, admitTransport });

// 1. transport bundle admitted by author pin; shell.net/transport live
try {
  await A.loadBundleBlob(TRANSPORT_BYTES);
  await B.loadBundleBlob(TRANSPORT_BYTES);
  assert(typeof A.net.linkedPeers === "function", "shell.net should be the transport driver");
  assert(typeof A.transport.send === "function", "shell.transport should be live");
  ok("transport bundle admitted by author pin; shell.net/transport live");
} catch (err) { fail("transport bundle admission", err); }

// 2. a FORGED bundle claiming the transport role must be refused
try {
  const forgedManifest = {
    app: "evil", version: 1, role: "transport", modules: [],
    // Claims both mount halves (§12.5) — the requires that make a bundle a transport
    // — signed by an author the transport slot does not pin.
    guest: { hash: "00".repeat(32), abi: GUEST_ABI_VERSION, requires: ["link/open", "link/send", "link/close", "link/stat", "transport/deliver", "transport/settle", "transport/link-auth", "transport/peer-edge", "transport/ready", "transport/link-down", "node/sign", "node/random", "timer/arm", "timer/clear"] },
  };
  const env = signManifest(sodium, identityA.privateKey, identityA.publicKey, forgedManifest);
  const blob = packBundle({ [MANIFEST_FILE]: env, [GUEST_FILE]: new Uint8Array(0) });
  await A.loadBundleBlob(blob);
  throw new Error("forged transport bundle was admitted!");
} catch (err) {
  if (err.message === "forged transport bundle was admitted!") fail("forged transport refusal", err);
  else ok("forged transport bundle refused (author pin)");
}

// 3. build + install a real chat app bundle (chat-shell's buildAppBundle)
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
    modules: [{ name: "chat", hash: toHex(genesisHash(sodium, chatWasm)) }],
    guest: {
      hash: toHex(genesisHash(sodium, guestBytes)),
      abi: GUEST_ABI_VERSION,
      requires: CHAT_APP_REQUIRES,
    },
  };
  const manifestEnv = signManifest(sodium, identityA.privateKey, identityA.publicKey, manifest);
  const chatBundle = packBundle({ [MANIFEST_FILE]: manifestEnv, [moduleFile("chat")]: chatWasm, [GUEST_FILE]: guestBytes });
  const moduleHash = toHex(genesisHash(sodium, chatWasm));
  pendingApprovals.add(moduleHash);            // auto-approve like addAppFromWasm
  const loaded = await A.loadBundleBlob(chatBundle);
  chatKey = appKeyFor(loaded.author, "chat");
  assert(A.host.isBound(chatKey, "chat"), `handler bound under ${chatKey}`);
  // The receiving peer installs its own app and points the protocol at it — each
  // peer's binding is its own (§12.10), and install is inert, so this bind is the
  // only thing that gives inbound "chat" frames a destination on B.
  pendingApprovals.add(moduleHash);
  const loadedB = await B.loadBundleBlob(chatBundle);
  B.bind("chat", appKeyFor(loadedB.author, loadedB.manifest.app));
  ok(`chat app installed on both shells under ${chatKey.slice(0, 24)}…`);
} catch (err) { fail("chat app install", err); }

// 4. link A and B over the transport (the WebRTC seam's openLink shape)
const st = { a: { authed: false }, b: { authed: false } };
try {
  const [chA, chB] = wirePair();
  const aLink = A.net.openLink({
    channel: chA, weDialed: true, expectPeerId: B.net.peerId,
    contactSecret: CONTACT, source: chA.remoteAddr,
    onAuth: () => { st.a.authed = true; },
  });
  const bLink = B.net.openLink({
    channel: chB, weDialed: false, source: chB.remoteAddr,
    onAuth: () => { st.b.authed = true; },
  });
  await until(() => st.a.authed && st.b.authed, 4000, "handshake");
  assert(aLink.linkId > 0 && bLink.linkId > 0, "link ids minted");
  ok("two transport ends authenticated over the channel seam");
} catch (err) { fail("transport handshake", err); }

// 5. dispatch: A sends a chat message, B renders it via its bound app's guest
try {
  let delivered = null;
  let dispatchErr = null;
  B.transport.onRequest((from, proto, payload) => {
    if (proto === "_offer") return null;
    const result = B.dispatch(from, proto, payload);
    // The shell's dispatch always returns the guest's answer — a Promise the driver
    // awaits; the smoke test settles it to inspect the render bytes. Both arms, so a
    // failing guest fails this test by name instead of timing out on `delivered`.
    if (result) result.then(
      (bytes) => { delivered = bytes && new Uint8Array(bytes); },
      (err) => { dispatchErr = err; });
    return result;
  });
  const body = new TextEncoder().encode("hi there");
  const chatBytes = new Uint8Array(1 + body.length);
  chatBytes[0] = 0x00;
  chatBytes.set(body, 1);
  A.transport.send(B.net.peerId, new TextEncoder().encode("chat"), chatBytes);
  await until(() => delivered !== null || dispatchErr !== null, 4000, "rendered message");
  if (dispatchErr) throw dispatchErr;
  // chat v1 render: [type 1][pk_len 1][pk 32][body]
  assert(delivered[0] === 0x00, "render type");
  assert(delivered[1] === 32, "render pk_len");
  assert(toHex(delivered.slice(2, 34)) === toHex(identityA.publicKey), "render sender pk = A's key");
  assert(new TextDecoder().decode(delivered.slice(34)) === "hi there", "render body");
  ok(`dispatch round-trip: A → transport → B's chat app's guest → ${delivered.length} render bytes`);
} catch (err) { fail("chat dispatch round-trip", err); }

// 6. the appKey derivation chat uses for its registry
try {
  const key = appKeyFor(identityA.publicKey, "chat");
  assert(key.startsWith(toHex(identityA.publicKey).slice(0, 8)), "appKeyFor shape");
  ok("appKeyFor shape");
} catch (err) { fail("appKeyFor", err); }

// 7. the shape gate an Offer passes through (peekMeta → isChatApp). A peer's bundle
// is installed on one click of a row showing a name and an author, so the requires
// it declares are the whole of what that click grants — and a chat app grants nothing
// at all: its own module map is a primitive, not an authority (seedkernel §12.1).
try {
  const chatManifest = (requires, modules) => ({
    app: "chat", version: 1,
    modules: modules ?? [{ name: "chat", hash: "aa" }],
    guest: { hash: "bb", abi: GUEST_ABI_VERSION, requires },
  });
  assert(isChatApp(chatManifest(CHAT_APP_REQUIRES)), "the shell's own app shape is accepted");
  assert(!isChatApp(chatManifest(["net/send"])), "an offered app claiming net is refused");
  assert(!isChatApp(chatManifest(["fs/get"])), "an offered app claiming fs is refused");
  assert(!isChatApp(chatManifest(["node/sign"])), "an offered app claiming node is refused");
  assert(!isChatApp(chatManifest(CHAT_APP_REQUIRES, [])), "a no-module app is refused");
  ok("the offer shape gate admits only zero-authority chat apps");
} catch (err) { fail("offer shape gate", err); }

try { B.close(); } catch {}
try { A.close(); } catch {}

if (failed > 0) {
  console.error(`\nsmoke: ${failed} FAILED`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
