// The kernel is a dependency, not a sibling directory. Every specifier below is
// a *published* entry point of seedkernel-wasm (its package.json "exports"), so
// this file can only reach what the kernel has deliberately made public — the
// import map in chat-shell.html resolves them to the vendored build. If a future
// kernel change breaks chat, it broke a public export, which is the point.
import sodium from "seedkernel-wasm/libsodium";
import { createShell, KernelHost } from "seedkernel-wasm/shell-core";
import { RtcNetwork } from "seedkernel-wasm/net-rtc";
import { createSafeRealm } from "seedkernel-wasm/safe-js";
import { TRANSPORT_BUNDLE_B64 } from "seedkernel-wasm/transport-bundle";
import { withMlDsa65, loadMlDsa65 } from "seedkernel-wasm/pq";
import { signManifestHybrid, hybridAuthorId, packBundle,
         genesisHash, appKeyFor, handlesOf,
         unpackBundle, verifyManifest, verifyBundle, FreshnessMarks, MANIFEST_FILE, GUEST_FILE, moduleFile }
  from "seedkernel-wasm/bundle";
import { GUEST_ABI_VERSION } from "seedkernel-wasm/cap-bridge";
import { assertAppId, chatGuestSource, isChatApp, CHAT_APP_CAPS } from "./chat-app.js";

const RTC_CONFIG = { iceServers: [{ urls: [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
  "stun:stun.nextcloud.com:443",
] }] };

const shellLog = document.getElementById("shell-log");
const relayUrlInput = document.getElementById("relay-url");
const relayRoomInput = document.getElementById("relay-room");
const relayConnectBtn = document.getElementById("connect-relay");
const relayNewRoomBtn = document.getElementById("new-room");
const relayCopyInviteBtn = document.getElementById("copy-invite");
const relayStatus = document.getElementById("relay-status");
const appStatus = document.getElementById("app-status");
const frame = document.getElementById("app-frame");
const appEmpty = document.getElementById("app-empty");
const aboutBtn = document.getElementById("about-toggle");
const aboutPanel = document.getElementById("about");
const dropzone = document.getElementById("dropzone");
const appFileInput = document.getElementById("app-file");
const appListEl = document.getElementById("app-list");
const offerListEl = document.getElementById("offer-list");
const offersSection = document.getElementById("offers-section");
const openAppsBtn = document.getElementById("open-apps-btn");
const appsNotice = document.getElementById("apps-notice");
let appsNoticeTimer = null;

// Surface a message on the Apps panel. Diagnostics still gets the full text
// via shellPrint; this is the part the user actually sees when they're not
// looking at the App-tab diagnostics drawer.
function showAppsNotice(text, kind = "err") {
  appsNotice.textContent = text;
  appsNotice.classList.remove("err", "ok");
  if (kind === "err" || kind === "ok") appsNotice.classList.add(kind);
  appsNotice.hidden = false;
  if (appsNoticeTimer) clearTimeout(appsNoticeTimer);
  appsNoticeTimer = setTimeout(() => { appsNotice.hidden = true; }, 6000);
  // Make sure the panel is visible — if the user dropped a file from the
  // Chat tab via the toolbar shortcut, surface the result where they'll see it.
  showTab("apps");
}

// top-bar status elements
const relayPill = document.getElementById("relay-pill");
const relayPillText = document.getElementById("relay-pill-text");
const peerPill = document.getElementById("peer-pill");
const peerPillText = document.getElementById("peer-pill-text");
const identityPill = document.getElementById("identity-pill");

const tabs = {
  relay:  { btn: document.getElementById("tab-relay"),  panel: document.getElementById("panel-relay")  },
  apps:   { btn: document.getElementById("tab-apps"),   panel: document.getElementById("panel-apps")   },
  app:    { btn: document.getElementById("tab-app"),    panel: document.getElementById("panel-app")    },
};
function showTab(name) {
  for (const [k, t] of Object.entries(tabs)) {
    t.btn.classList.toggle("active", k === name);
    t.panel.classList.toggle("hidden", k !== name);
  }
  if (name === "app") tabs.app.btn.classList.remove("unread");
}
for (const [k, t] of Object.entries(tabs)) {
  t.btn.addEventListener("click", () => showTab(k));
}

aboutBtn.addEventListener("click", () => {
  aboutPanel.classList.toggle("open");
  aboutPanel.hidden = !aboutPanel.classList.contains("open");
});

function shellPrint(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  shellLog.appendChild(line);
  shellLog.scrollTop = shellLog.scrollHeight;
}

function bytesToHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

shellPrint("Starting the handler table...", "sys");
// libsodium instantiates its wasm asynchronously; every crypto call below — identity
// generation, manifest signing, genesis hashing — needs it ready first.
await sodium.ready;

// ML-DSA-65 for manifest suite 0x02 (§12.4, §14.1), from the same mldsa65.wasm Node
// reads and the Go loader embeds — so this shell admits exactly the bundles they
// admit. It is loaded at boot rather than on first hybrid manifest because
// verifyManifest is synchronous: the method is either on `sodium` before the first
// verify or the bundle is refused as an unsupported suite.
//
// This shell SIGNS suite 0x02, the hybrid Ed25519 + ML-DSA-65 envelope (§12.4,
// §14.1). Verifying led on purpose — every node had to be able to check a hybrid
// manifest before any node started producing one — and that gate is long closed,
// so the demo signs PQ by default like every other author, and its author id is
// the key-set hash rather than the Ed25519 key.
withMlDsa65(sodium, await loadMlDsa65(
  await (await fetch(new URL("./vendor/mldsa65.wasm", import.meta.url))).arrayBuffer()));

// The transport bundle — the kernel-shipped signed program that IS the network
// (§12.6): the channel AKE, the record layer, link routing and the request/
// response layer run as a confined guest (transport/guest.js), signed into a
// `role: "transport"` bundle and embedded in the host as TRANSPORT_BUNDLE_B64.
// Admitting it below stands the shell's transport driver up; chat's own apps are
// ordinary guest bundles and never claim a role.
const TRANSPORT_BYTES = (() => {
  const bin = atob(TRANSPORT_BUNDLE_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
})();
// The author id of that exact artifact. The admit gate below pins the transport
// slot to it — the browser equivalent of an operator's `roles.transport` policy
// entry (§12.5) — so a bundle a PEER offers can never displace the shipped
// transport, whatever its manifest claims.
const transportAuthorHex = bytesToHex(verifyBundle(sodium, TRANSPORT_BYTES).author);

// The shell (kernel host + admission policy + bundle loader) is assembled once the
// identity exists — see the boot sequence below. It is declared here because handlers
// defined above reach it through `shell`.
//
// Ongoing-consent admission (§12.4): the user approves each unique bundle before it
// runs. `pendingApprovals` holds the module hashes the user has consented to; the
// shell's `admit` callback consumes one (one-shot) on install. The shell runs under an
// open policy, so consent — not a static author allow-list — is this shell's gate.
const pendingApprovals = new Set();
let shell;
// The WebRTC socket seam over the transport driver, and the state that tracks
// whether the standing driver still matches the room's current secret — see
// ensureTransport() in the networking section.
let net = null;
let transportSecret = null;
let transportWired = false;

// ─── per-tab Ed25519 identity ──────────────────────────────────────────
let myKeys;
// FIXME: this is just a demo
const stored = sessionStorage.getItem("chat.identity");
if (stored) {
  const parsed = JSON.parse(stored);
  myKeys = {
    publicKey:  new Uint8Array(parsed.pk),
    privateKey: new Uint8Array(parsed.sk),
  };
} else {
  const kp = sodium.crypto_sign_keypair();
  myKeys = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  sessionStorage.setItem("chat.identity", JSON.stringify({
    pk: Array.from(kp.publicKey),
    sk: Array.from(kp.privateKey),
  }));
}
const myPkHex = bytesToHex(myKeys.publicKey);
// The PQ half of this author's key set (§12.4): the ML-DSA-65 key, derived from the
// SAME seed as the Ed25519 half, so the one stored identity is the whole key set.
const myPqKeys = sodium.ml_dsa65_keypair_from_seed(sodium.crypto_generichash(
  32, new Uint8Array([...myKeys.privateKey.slice(0, 32), ...new TextEncoder().encode("seedkernel-author-mldsa-v1")])));
// The hybrid author id: what this tab signs app bundles under, and what peers pin.
const myAuthorId = hybridAuthorId(sodium, myKeys.publicKey, myPqKeys.publicKey);

shellPrint(`I am ${myPkHex.slice(0, 8)}`, "sys");

// Assemble the shared shell now that the identity exists. The platform is a browser
// seam: sodium, our identity, a WebAssembly-backed handler table, an in-memory
// freshness store — and NO network. The transport is no longer a platform member: it
// is a signed bundle admitted below, which stands the driver (the shell's `net` /
// `transport`) up. The `contactSecret` getter is read at that install moment, so a
// room secret minted after boot still gates this node's accepting side (§12.6.3).
//
// The QuickJS realm factory (safe-js) is supplied because every app is a guest:
// the transport bundle needs a realm to run in, and so does each chat app — its
// guest forwards to its module under the shell's execution budget (§12.3). That
// is the honest cost of one app shape: this shell now pays the lazy QuickJS
// engine for chat apps where it once paid only for the transport. Admission is
// deferred to `admit` (user consent), except for the
// transport bundle itself, which is admitted by author pin.
shell = createShell({
  platform: {
    sodium,
    identity: myKeys,
    kernel: new KernelHost(),
    freshnessStore: new FreshnessMarks(),
    get contactSecret() { return roomSecret ?? undefined; },
    createRealm: async (o) => createSafeRealm(o),
  },
  admit(v) {
    if (v.manifest.role === "transport") {
      return bytesToHex(v.author) === transportAuthorHex;
    }
    const bytesHashHex = v.modules.length > 0 ? v.modules[0].mod.hash : "";
    if (!pendingApprovals.has(bytesHashHex)) return false;
    pendingApprovals.delete(bytesHashHex);
    return true;
  },
});

// ─── channel identity ──────────────────────────────────────────────────
//
// Transport identity is the transport bundle's job. Each data channel runs its
// in-channel HELLO/AUTH challenge (§12.6), proving the far end holds the kernel
// private key for the pubkey it claims — a continuous channel binding that
// subsumes the old SDP a=fingerprint signing and any per-message signature.
// Frames the driver hands us are already attributed to an authenticated peer, so
// the sender pubkey (`_from`) is authoritative — we prepend it to the message
// before running the app transform; there is no envelope signer to verify.
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── top-bar status updates ───────────────────────────────────────────
identityPill.textContent = `id ${myPkHex.slice(0, 8)}`;
identityPill.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(myPkHex);
    const prev = identityPill.textContent;
    identityPill.textContent = "copied!";
    setTimeout(() => { identityPill.textContent = prev; }, 1100);
  } catch {}
});

function setRelayPill(state, label) {
  // state: "off" | "connecting" | "ok" | "err"
  relayPill.classList.remove("ok", "warn", "err");
  if (state === "ok")           relayPill.classList.add("ok");
  else if (state === "connecting") relayPill.classList.add("warn");
  else if (state === "err")     relayPill.classList.add("err");
  relayPillText.textContent = label;
}

function updatePeerPill() {
  const open = net ? net.linkedPeers().length : 0;
  peerPillText.textContent = open === 1 ? "1 peer" : `${open} peers`;
  peerPill.classList.toggle("ok", open > 0);
}

// ─── app registry ──────────────────────────────────────────────────────
//
// An "app" is an ordinary signed bundle (§12.4): a signed `manifest.bundle`
// envelope plus the app's WASM module and its guest program in one blob. That blob
// IS the bundle format — the same bytes seedstore's flagship deployment loads from
// disk, so a chat app is just a guest that calls its one module and needs no
// chat-specific install format, domain, or peek/unwrap code. `verifyBundle` (the
// shared loader) authenticates the author's signature over the manifest, which
// commits to the guest's and module's genesisHash, so the blob survives any number
// of transitive relays and still authenticates against its original author —
// exactly the store-and-forward property an Offer needs. The local "add app" flow
// and the peer-to-peer Offer below carry the identical bundle.
//
// The module's WASM carries two embedded custom sections the runtime ignores but
// this shell reads: "app_meta" (JSON — id, name, version) and "ui" (HTML rendered
// in the sandboxed iframe). The signed manifest's `app` is the id, and the loader
// binds the module inside its app's map, under `appKeyFor(author, app)` at the
// module's logical name (§5.1). The manifest declares no bind name, so there is
// nothing in it a forged manifest could point at an unexpected handler; the shell
// calls the same `appKeyFor` the loader does rather than keeping a derivation of
// its own.
//
// The key is node-local. Two peers need not agree on it: a CHAT frame carries a
// *protocol id*, and each side resolves that through its own `bindings` to whichever
// app it holds — so two peers running different authors' chat apps interoperate as
// long as both speak the protocol.
//
// An app's module is a PURE TRANSFORM: the guest hands it `senderPk ‖ chatType ‖
// body` and it returns the render bytes for the iframe. The guest — not the WASM
// and not the kernel — does all the I/O: the shell authenticates the sender via the
// AKE channel, invokes the app's guest `handle` entrypoint (the same seam an
// initiator's runGuest takes), and the guest drives its module through
// `module/call` (§12.2). Inbound delivery and local echo both cross the guest, so
// chat's whole app logic is the ~5-line forwarding guest it ships in the bundle.
//
// `installedApps` keeps the per-app state we need to re-mount the UI, send
// updates, and re-broadcast the packed bundle transitively (`bundleBytes` is the
// signed bundle blob — the author's manifest signature intact — and is what every
// "Offer" hands to a peer). Apps received via Offer keep the original author's
// manifest signature: we never re-sign a bundle.
// Keyed by APP KEY — `"<author hex>:<app>"` (§12.4), the same key the loader's freshness
// marks use. Not by the bare app id: two authors may both ship a "chat", and under
// derived names (§5.1) they coexist rather than contend, so the id alone is not an
// identity. `rec.id` remains the display/manifest name.
const installedApps = new Map();   // appKey → AppRecord
let activeAppKey = null;

// Protocol bindings (§12.10) — these are now handled by the shared Bindings module
// (shell-core.js re-exports Bindings from bindings.ts). The hand-rolled code that used
// to live here is gone; every target shares one implementation of the three binding rules.
// After the shell is assembled below, `shell.bindings` is the binding table.

const STORE = "apps.v2";

const OFFER_PROTO = "_offer";

// ── shell frame wire format ─────────────────────────────────────────────
//
// Messages now ride the Transport request plane: a chat message is a req with a
// protocol id in the frame, and the receiving shell resolves the protocol through
// bindings to the bound app's handler. The custom FRAME_CHAT / FRAME_OFFER framing
// that used to live here is gone — one plane, one dispatch scheme (§12.10).

// ── iframe bridge ──────────────────────────────────────────────────────
//
// The app transform returns render bytes; the shell posts them to the iframe.
// Renders that arrive before the iframe says "ready" are queued so a hot-swap
// doesn't drop the first message.
let iframeReady = false;
const renderQueue = [];

function deliverRender(payload) {
  if (iframeReady && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "render", payload }, "*");
  } else {
    renderQueue.push(payload);
  }
  for (const [k, t] of Object.entries(tabs)) {
    if (k !== "app" && t.btn.classList.contains("active")) {
      tabs.app.btn.classList.add("unread");
      break;
    }
  }
}

function deliverSys(text) {
  if (iframeReady && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "sys", text }, "*");
  }
}

// ── parsing the wasm artifact ──────────────────────────────────────────
async function readWasmSections(wasmBytes) {
  const mod = await WebAssembly.compile(wasmBytes);
  const ui = WebAssembly.Module.customSections(mod, "ui");
  const meta = WebAssembly.Module.customSections(mod, "app_meta");
  let parsedMeta = null;
  if (meta.length > 0) {
    try { parsedMeta = JSON.parse(new TextDecoder().decode(new Uint8Array(meta[0]))); }
    catch { parsedMeta = null; }
  }
  const uiHtml = ui.length > 0 ? new TextDecoder().decode(new Uint8Array(ui[0])) : null;
  return { meta: parsedMeta, uiHtml };
}

function promptMeta(defaultId) {
  // Fallback when a dropped .wasm has no app_meta section.
  const id = prompt("App id (lowercase, no spaces — used as the kernel name):", defaultId);
  if (!id) return null;
  const trimmed = id.trim();
  // The same charset a manifest module name is held to (§12.4): the id becomes the
  // module's name, and so its file in the bundle. Reject it here rather than let the
  // user sign a manifest their own shell would then refuse as malformed.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    const msg = "App id must be alphanumeric / _ -";
    shellPrint(msg, "err");
    showAppsNotice(msg, "err");
    return null;
  }
  const name = prompt("Display name:", trimmed) || trimmed;
  const version = prompt("Version label:", "v1") || "v1";
  return { id: trimmed, name, version };
}

// ── build an app bundle (local-authored) ────────────────────────────────
//
// Turn a WASM module into a signed bundle: read its app_meta for the
// id, build a manifest declaring the module under that id plus the ~5-line guest
// that forwards to it, sign the manifest under
// the local key (the real §12.4 manifest signature), and pack the manifest envelope
// + module + guest into one blob. The manifest names no kernel name — the loader derives
// it from the signed `(app, name)` pair. `version` is a nominal 1 — the interactive
// shell gates installs on user consent (the approve callback), not on a monotonic
// freshness mark, so a chat bundle carries no meaningful version counter.
//
// A chat app is an ordinary guest bundle: the guest's `handle` forwards its input to
// the app's own module by name through `module/call` and returns the render bytes —
// the whole app is that forwarding guest (chat-app.js). It declares no cap at all
// (§12.2): its own module map is a primitive, not a grant (seedkernel §12.1).
async function buildAppBundle(wasmBytes) {
  const { meta } = await readWasmSections(wasmBytes);
  if (!meta || !meta.id) throw new Error("cannot build a bundle: wasm has no app_meta id");
  // The id is attacker-chosen text from a custom section, and it is about to be
  // interpolated into JS this key signs — so it is checked against the §12.4 name
  // grammar HERE, before the template, not by the manifest parser afterwards.
  assertAppId(meta.id);
  const guestBytes = new TextEncoder().encode(chatGuestSource(meta.id));
  const manifest = {
    app: meta.id,
    version: 1,
    modules: [{
      name: meta.id,
      hash: bytesToHex(genesisHash(sodium, wasmBytes)),
    }],
    guest: {
      hash: bytesToHex(genesisHash(sodium, guestBytes)),
      abi: GUEST_ABI_VERSION,
      caps: CHAT_APP_CAPS,
    },
  };
  const manifestEnv = signManifestHybrid(sodium, {
    ed: { publicKey: myKeys.publicKey, privateKey: myKeys.privateKey },
    mlDsa: { publicKey: myPqKeys.publicKey, privateKey: myPqKeys.privateKey },
  }, manifest);
  return packBundle({
    [MANIFEST_FILE]: manifestEnv,
    [moduleFile(meta.id)]: wasmBytes,
    [GUEST_FILE]: guestBytes,
  });
}

// ── extract metadata from a bundle blob ──────────────────────────────────
//
// Read app + module metadata off a bundle for the UI and the approval gate,
// through the SHARED §12.4 manifest parser (bundle.ts verifyManifest): it reads the
// envelope suite, verifies the author signature, and returns the parsed manifest +
// the author key. So this shell never hand-parses envelope offsets — the layout stays
// private to bundle.ts, where the suite-first parse lives. (Module-byte integrity is
// still loadBundleBlob's job at install; this only needs the manifest.) Returns null on
// anything malformed, unauthentic, or not the demo's one-module app shape.
function peekMeta(bundleBytes) {
  let files;
  try { files = unpackBundle(bundleBytes); }
  catch { return null; }
  const env = files[MANIFEST_FILE];
  if (!env) return null;
  let vm;
  try { vm = verifyManifest(sodium, env); }   // throws on an unsupported suite / malformed body
  catch { return null; }
  if (!vm) return null;                        // bad signature ⇒ decline quietly
  const { author, manifest } = vm;
  // One module, and a guest holding no capability at all (chat-app.js). The
  // caps half is what keeps an Offer from installing authority behind a consent row
  // that only shows a name: `guest.caps` is where a bundle's reach is written down,
  // and this is the one place on the install path that reads it.
  if (!isChatApp(manifest)) return null;
  const mod = manifest.modules[0];
  const wasm = files[moduleFile(mod.name)];
  if (!wasm || wasm.length === 0) return null;
  return { app: manifest.app, moduleName: mod.name, moduleHash: mod.hash, wasm, authorPk: author };
}

// Admit a bundle the user has already consented to. Calls the shared
// §12.4 loadBundleBlob which verifies the manifest signature, checks the
// admit gate, and installs the module. Returns the UI AppRecord.
async function applyAppBundle(bundleBytes) {
  // Pre-peek metadata for the UI record: app_meta, ui, handler name, app key.
  const peeked = peekMeta(bundleBytes);
  if (!peeked) throw new Error("not a valid app bundle");
  const { meta, uiHtml } = await readWasmSections(peeked.wasm);
  if (!meta) throw new Error("bundle module has no app_meta");

  const loaded = await shell.loadBundleBlob(bundleBytes);
  const author = loaded.author;
  const key = appKeyFor(author, peeked.app);
  const handles = handlesOf(loaded.manifest);

  const record = {
    id: peeked.app,
    key,
    name: meta.name || peeked.app,
    version: meta.version || "",
    description: meta.description || "",
    authorPk: author.slice(),
    bytesHash: genesisHash(sodium, peeked.wasm),
    bundleBytes: bundleBytes.slice(),
    moduleName: peeked.moduleName,
    handles,
    uiHtml,
  };
  installedApps.set(key, record);
  persistInstalledApps();
  renderAppList();
  return record;
}

// Add an app from raw WASM bytes by building + signing a bundle with the local
// key (the local user becomes the author).
async function addAppFromWasm(wasmBytes, fallbackId) {
  let { meta } = await readWasmSections(wasmBytes);
  if (!meta || !meta.id) {
    meta = promptMeta(fallbackId);
    if (!meta) return;
    wasmBytes = embedAppMeta(wasmBytes, meta);
  }
  const bundleBytes = await buildAppBundle(wasmBytes);
  const peeked = peekMeta(bundleBytes);
  if (!peeked) throw new Error("internal: just-built app bundle did not parse");

  // Auto-approve locally-authored bundles and load through the shared shell.
  pendingApprovals.add(peeked.moduleHash);
  try {
    const record = await applyAppBundle(bundleBytes);
    shellPrint(`Installed ${record.name} ${record.version}`, "sys");
    setActiveApp(record.key);
  } catch (err) {
    pendingApprovals.delete(peeked.moduleHash);
    shellPrint(`Install failed: ${err.message}`, "err");
    showAppsNotice(`Install failed: ${err.message}`, "err");
  }
}

// Embed an app_meta JSON custom section into a wasm buffer. Mirror of
// scripts/embed-meta.mjs so the shell can produce a fully self-describing
// bundle when the user supplies metadata for a meta-less .wasm.
function embedAppMeta(wasmBytes, meta) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const nameUtf = new TextEncoder().encode("app_meta");
  const leb = (n) => {
    const out = [];
    do { let b = n & 0x7f; n >>>= 7; if (n !== 0) b |= 0x80; out.push(b); } while (n !== 0);
    return new Uint8Array(out);
  };
  const inner = (() => {
    const nl = leb(nameUtf.length);
    const buf = new Uint8Array(nl.length + nameUtf.length + json.length);
    let o = 0;
    buf.set(nl, o); o += nl.length;
    buf.set(nameUtf, o); o += nameUtf.length;
    buf.set(json, o);
    return buf;
  })();
  const sz = leb(inner.length);
  const section = new Uint8Array(1 + sz.length + inner.length);
  section[0] = 0x00;
  section.set(sz, 1);
  section.set(inner, 1 + sz.length);
  const out = new Uint8Array(wasmBytes.length + section.length);
  out.set(wasmBytes, 0);
  out.set(section, wasmBytes.length);
  return out;
}

// ── persistence ────────────────────────────────────────────────────────
// The packed bundle is the only piece of app state we need — the
// handler in the kernel and the uiHtml both derive from it. We keep them in sessionStorage so a reload
// within the same tab keeps the user's app set and lets transitive offers
// continue to work.
function persistInstalledApps() {
  try {
    const arr = [];
    for (const rec of installedApps.values()) {
      arr.push(Array.from(rec.bundleBytes));
    }
    sessionStorage.setItem(STORE + ".bundles", JSON.stringify(arr));
    // Bindings are ordinary user preference (§12.10) — they persist beside the apps and
    // carry no security property, so a hand-edited store can misroute a message and
    // nothing more.
    sessionStorage.setItem(STORE + ".bindings", JSON.stringify(shell.bindings.entries()));
    if (activeAppKey) sessionStorage.setItem(STORE + ".active", activeAppKey);
    else sessionStorage.removeItem(STORE + ".active");
  } catch {}
}

async function restoreInstalledApps() {
  let arr;
  try { arr = JSON.parse(sessionStorage.getItem(STORE + ".bundles") || "[]"); }
  catch { return; }
  if (!Array.isArray(arr)) return;
  // Bindings BEFORE apps: `autoBind` only fills vacancies.
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE + ".bindings") || "[]");
    if (Array.isArray(saved)) {
      for (const pair of saved) {
        if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
          shell.bindings.bind(pair[0], pair[1]);
        }
      }
    }
  } catch {}
  for (const raw of arr) {
    try {
      const bundleBytes = new Uint8Array(raw);
      const peeked = peekMeta(bundleBytes);
      if (!peeked) continue;
      // Restored apps were previously approved — wave through the admit gate.
      pendingApprovals.add(peeked.moduleHash);
      await applyAppBundle(bundleBytes);
    } catch (err) {
      shellPrint(`Could not restore an app: ${err.message}`, "err");
    }
  }
  for (const [proto, key] of shell.bindings.entries()) if (!installedApps.has(key)) shell.bindings.unbind(proto);
  for (const rec of installedApps.values()) shell.bindings.autoBind(rec.key, rec.handles);
  const saved = sessionStorage.getItem(STORE + ".active");
  if (saved && installedApps.has(saved)) setActiveApp(saved);
}

// ── active-app iframe mount ────────────────────────────────────────────
function setActiveApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  if (!rec.uiHtml) {
    shellPrint(`${rec.name} has no UI; cannot mount.`, "err");
    return;
  }
  activeAppKey = key;
  iframeReady = false;
  renderQueue.length = 0;
  if (frame.dataset.blobUrl) URL.revokeObjectURL(frame.dataset.blobUrl);
  const uiBlob = new Blob([rec.uiHtml], { type: "text/html" });
  const uiUrl  = URL.createObjectURL(uiBlob);
  frame.dataset.blobUrl = uiUrl;
  frame.src = uiUrl;
  frame.classList.remove("hidden");
  appEmpty.classList.add("hidden");
  appStatus.textContent = `${rec.name} ${rec.version}`.trim();
  persistInstalledApps();
  renderAppList();
}

function unmountActiveApp() {
  activeAppKey = null;
  iframeReady = false;
  renderQueue.length = 0;
  frame.src = "about:blank";
  if (frame.dataset.blobUrl) {
    URL.revokeObjectURL(frame.dataset.blobUrl);
    delete frame.dataset.blobUrl;
  }
  frame.classList.add("hidden");
  appEmpty.classList.remove("hidden");
  appStatus.textContent = "no app loaded";
  persistInstalledApps();
}

// ── peer-to-peer app offers ────────────────────────────────────────────
//
// An offer is a packed app bundle forwarded over a data channel in an OFFER frame.
// Any peer who holds the bundle can forward it (transitive offer) — the manifest
// inside carries the original author's signature over the module hash, so the
// recipient still authenticates against the author (peekAppBundle verifies it).
//
// The relaying peer is identified by the AKE channel (`_from`), not a signature —
// the frame is unsigned; the bundle's own manifest signature is the load-bearing
// authentication. Inbound OFFER frames are routed here from the network sink.
const pendingOffers = new Map();   // bytesHashHex → { bundleBytes, peeked, fromPkHex }

async function handleOffer(bundleBytes, fromPkHex) {
  const peeked = peekMeta(bundleBytes);
  if (!peeked) return;
  const { wasm, app: id, moduleHash, authorPk } = peeked;
  const bytesHash = hexToBytes(moduleHash);

  let meta = null;
  try { meta = (await readWasmSections(wasm)).meta; } catch {}
  if (!meta) {
    shellPrint(`Offer from ${fromPkHex.slice(0, 8)} dropped: bundle module has no app_meta`, "err");
    return;
  }
  meta = { ...meta, id };

  const hex = bytesToHex(bytesHash);
  // Already running these exact bytes ⇒ nothing to offer. An update ships a new module
  // hash, so it still surfaces for consent (installs are consent-gated, §12.4); only a
  // redundant re-offer of what the user already has installed is dropped, so it never
  // shows a pointless Install row.
  for (const rec of installedApps.values()) {
    if (rec.bytesHash && bytesToHex(rec.bytesHash) === hex) return;
  }
  if (pendingOffers.has(hex)) return;
  pendingOffers.set(hex, {
    bundleBytes: bundleBytes.slice(),
    // Keep the fields buildOfferRow renders (author + module hash) plus the moduleHash
    // acceptOffer adds to pendingApprovals.
    peeked: { moduleHash, meta, authorPk, bytesHash },
    fromPkHex,
  });
  renderOfferList();
  tabs.apps.btn.classList.add("unread");
  shellPrint(
    `${fromPkHex.slice(0, 8)} offers app "${meta.name || meta.id}" — see the Apps tab.`, "sys");
}

async function acceptOffer(bytesHashHex) {
  const offer = pendingOffers.get(bytesHashHex);
  if (!offer) return;
  pendingApprovals.add(offer.peeked.moduleHash);
  try {
    const rec = await applyAppBundle(offer.bundleBytes);
    pendingOffers.delete(bytesHashHex);
    renderOfferList();
    shellPrint(`Installed ${rec.name} ${rec.version} from offer.`, "sys");
    setActiveApp(rec.key);
  } catch (err) {
    pendingApprovals.delete(offer.peeked.moduleHash);
    shellPrint(`Install from offer failed: ${err.message}`, "err");
    showAppsNotice(`Install from offer failed: ${err.message}`, "err");
  }
}

function dismissOffer(bytesHashHex) {
  pendingOffers.delete(bytesHashHex);
  renderOfferList();
}

function broadcastToPeers(proto, payload) {
  if (!net) return; // no transport yet — nothing to send to
  const protoBytes = new TextEncoder().encode(proto);
  for (const peerId of net.linkedPeers()) {
    shell.transport.send(peerId, protoBytes, payload);
  }
}

async function renderLocal(rec, payload) {
  const input = new Uint8Array(myAuthorId.length + payload.length);
  input.set(myAuthorId, 0);
  input.set(payload, myAuthorId.length);
  // The local echo runs through the app's guest like an inbound frame does — the
  // guest `handle` forwards to the module through `module/call` (§12.2), under the
  // same seam a peer's request would take. Which means it can fail the same way,
  // so it reports rather than rejecting into a caller that has nowhere to put it.
  let render;
  try { render = await shell.runGuest("handle", input, rec.key); }
  catch (err) { shellPrint(`local echo failed: ${err.message}`, "err"); return; }
  if (render) deliverRender(new Uint8Array(render));
}

// Broadcast the stored bundle for `id` to every open peer. Anyone who receives
// this can forward it to others — that's transitivity for free.
function offerApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  const linked = net ? net.linkedPeers() : [];
  for (const peerId of linked) {
    shell.transport.send(peerId, new TextEncoder().encode(OFFER_PROTO), rec.bundleBytes);
  }
  const n = linked.length;
  shellPrint(
    n > 0
      ? `Offered ${rec.name} ${rec.version} to ${n} peer${n === 1 ? "" : "s"}.`
      : `No connected peers to offer ${rec.name} to.`,
    n > 0 ? "sys" : "err");
}

// ── apps panel UI ──────────────────────────────────────────────────────
function renderAppList() {
  appListEl.innerHTML = "";
  if (installedApps.size === 0) {
    const li = document.createElement("li");
    li.className = "empty-row";
    li.textContent = "No apps installed yet.";
    appListEl.appendChild(li);
    return;
  }
  for (const rec of installedApps.values()) {
    appListEl.appendChild(buildAppRow(rec));
  }
}

function buildAppRow(rec) {
  const li = document.createElement("li");
  li.className = "app-row";
  if (rec.key === activeAppKey) li.classList.add("active");

  const head = document.createElement("div");
  head.className = "app-row-head";
  const nm = document.createElement("span");
  nm.className = "app-row-name";
  nm.textContent = rec.name;
  head.appendChild(nm);
  if (rec.version) {
    const v = document.createElement("span");
    v.className = "app-row-version";
    v.textContent = rec.version;
    head.appendChild(v);
  }
  li.appendChild(head);

  if (rec.description) {
    const d = document.createElement("div");
    d.className = "app-row-desc";
    d.textContent = rec.description;
    li.appendChild(d);
  }

  const meta = document.createElement("div");
  meta.className = "app-row-meta";
  const authorHex = bytesToHex(rec.authorPk);
  const isMine = bytesEqual(rec.authorPk, myAuthorId);
  {
    const bId = document.createElement("b");
    bId.textContent = "id";
    meta.appendChild(bId);
    const vId = document.createTextNode(` ${rec.id} · `);
    meta.appendChild(vId);
    const bAu = document.createElement("b");
    bAu.textContent = "author";
    meta.appendChild(bAu);
    const vAu = document.createTextNode(
      ` ${authorHex.slice(0, 8)}` + (isMine ? " (you)" : "") + ` · `);
    meta.appendChild(vAu);
    const bWa = document.createElement("b");
    bWa.textContent = "wasm";
    meta.appendChild(bWa);
    const vWa = document.createTextNode(` ${bytesToHex(rec.bytesHash).slice(0, 12)}`);
    meta.appendChild(vWa);
  }
  li.appendChild(meta);

  // Protocol bindings (§12.10). One row per protocol this app offers to serve, each a
  // plain toggle: binding is a preference, so switching is one click and reversible.
  // "Handles" is what the author declared; the checkbox is what the user decided.
  const protos = document.createElement("div");
  protos.className = "app-row-meta";
  for (const proto of rec.handles) {
    const boundKey = shell.bindings.boundApp(proto);
    const mine = boundKey === rec.key;
    const label = document.createElement("label");
    label.className = "app-row-proto";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = mine;
    cb.addEventListener("change", () => {
      if (cb.checked) { shell.bindings.bind(proto, rec.key); persistInstalledApps(); renderAppList(); }
      else { shell.bindings.unbind(proto); persistInstalledApps(); renderAppList(); }
    });
    label.appendChild(cb);
    const txt = document.createElement("span");
    // Name the app currently holding a contested protocol, so "why am I not getting
    // messages" has a visible answer rather than being silent.
    const other = boundKey && !mine ? installedApps.get(boundKey) : null;
    txt.textContent = ` handles “${proto}”` +
      (mine ? "" : other ? ` — bound to ${other.name}` : " — unbound");
    label.appendChild(txt);
    protos.appendChild(label);
  }
  li.appendChild(protos);

  const btns = document.createElement("div");
  btns.className = "app-row-buttons";
  if (rec.uiHtml) {
    const openBtn = document.createElement("button");
    openBtn.className = "icon primary";
    openBtn.textContent = rec.key === activeAppKey ? "Active" : "Open";
    openBtn.disabled = rec.key === activeAppKey;
    openBtn.addEventListener("click", () => {
      setActiveApp(rec.key);
      showTab("app");
    });
    btns.appendChild(openBtn);
  }
  if (isMine) {
    const updateBtn = document.createElement("button");
    updateBtn.className = "icon";
    updateBtn.textContent = "Update…";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".wasm,application/wasm";
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      fileInput.value = "";
      await addAppFromWasm(bytes, rec.id);
    });
    updateBtn.addEventListener("click", () => fileInput.click());
    btns.appendChild(updateBtn);
    btns.appendChild(fileInput);
  }
  const offerBtn = document.createElement("button");
  offerBtn.className = "icon";
  offerBtn.textContent = "Offer to peers";
  offerBtn.addEventListener("click", () => offerApp(rec.key));
  btns.appendChild(offerBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "icon danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => removeApp(rec.key));
  btns.appendChild(removeBtn);

  li.appendChild(btns);
  return li;
}

function removeApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  if (!confirm(`Remove ${rec.name} ${rec.version}? The kernel handler will be uninstalled.`)) return;
  // Revocation (§12.5): uninstall removes every kernel handler derived from the app key,
  // drops all protocol bindings, and disposes the guest realm if this was the loaded app.
  shell.uninstall(key);
  installedApps.delete(key);
  if (activeAppKey === key) unmountActiveApp();
  persistInstalledApps();
  renderAppList();
}

function renderOfferList() {
  offerListEl.innerHTML = "";
  if (pendingOffers.size === 0) {
    offersSection.hidden = true;
    return;
  }
  offersSection.hidden = false;
  for (const [hex, offer] of pendingOffers) {
    offerListEl.appendChild(buildOfferRow(hex, offer));
  }
}

function buildOfferRow(hex, offer) {
  const meta = offer.peeked.meta;
  const li = document.createElement("li");
  li.className = "app-row offer-row";
  const head = document.createElement("div");
  head.className = "app-row-head";
  const nm = document.createElement("span");
  nm.className = "app-row-name";
  nm.textContent = meta.name || meta.id;
  head.appendChild(nm);
  if (meta.version) {
    const v = document.createElement("span");
    v.className = "app-row-version";
    v.textContent = meta.version;
    head.appendChild(v);
  }
  li.appendChild(head);
  if (meta.description) {
    const d = document.createElement("div");
    d.className = "app-row-desc";
    d.textContent = meta.description;
    li.appendChild(d);
  }
  const m = document.createElement("div");
  m.className = "app-row-meta";
  {
    const bId = document.createElement("b");
    bId.textContent = "id";
    m.appendChild(bId);
    const vId = document.createTextNode(` ${meta.id} · `);
    m.appendChild(vId);
    const bAu = document.createElement("b");
    bAu.textContent = "author";
    m.appendChild(bAu);
    const vAu = document.createTextNode(` ${bytesToHex(offer.peeked.authorPk).slice(0, 8)} · `);
    m.appendChild(vAu);
    const bFr = document.createElement("b");
    bFr.textContent = "from";
    m.appendChild(bFr);
    const vFr = document.createTextNode(` ${offer.fromPkHex.slice(0, 8)} · `);
    m.appendChild(vFr);
    const bWa = document.createElement("b");
    bWa.textContent = "wasm";
    m.appendChild(bWa);
    const vWa = document.createTextNode(` ${bytesToHex(offer.peeked.bytesHash).slice(0, 12)}`);
    m.appendChild(vWa);
  }
  li.appendChild(m);
  const btns = document.createElement("div");
  btns.className = "app-row-buttons";
  const ok = document.createElement("button");
  ok.className = "icon primary";
  ok.textContent = "Install";
  ok.addEventListener("click", () => acceptOffer(hex));
  const no = document.createElement("button");
  no.className = "icon";
  no.textContent = "Dismiss";
  no.addEventListener("click", () => dismissOffer(hex));
  btns.appendChild(ok);
  btns.appendChild(no);
  li.appendChild(btns);
  return li;
}

// ── drag-drop + file picker plumbing ───────────────────────────────────
async function loadDroppedFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The filename's stem is the only signal we have for an id when the
  // bundle is meta-less; the prompt fallback uses it as a default.
  const stem = (file.name || "app").replace(/\.wasm$/i, "");
  await addAppFromWasm(bytes, stem);
}

dropzone.addEventListener("click", () => appFileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    appFileInput.click();
  }
});
appFileInput.addEventListener("change", async () => {
  const f = appFileInput.files && appFileInput.files[0];
  appFileInput.value = "";
  if (f) await loadDroppedFile(f);
});
;["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add("dragover");
  }));
;["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ev !== "drop") dropzone.classList.remove("dragover");
  }));
dropzone.addEventListener("drop", async (e) => {
  dropzone.classList.remove("dragover");
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return;
  for (const f of dt.files) await loadDroppedFile(f);
});
openAppsBtn.addEventListener("click", () => showTab("apps"));

// ─── iframe protocol: handshake + outgoing messages ────────────────────
window.addEventListener("message", async (ev) => {
  if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
  const msg = ev.data;
  if (!msg) return;

  if (msg.type === "ready") {
    iframeReady = true;
    frame.contentWindow.postMessage(
      { type: "init", pk: myKeys.publicKey }, "*");
    for (const payload of renderQueue) {
      frame.contentWindow.postMessage({ type: "render", payload }, "*");
    }
    renderQueue.length = 0;
    return;
  }

  if (msg.type === "send" && typeof msg.chatType === "number" && msg.body) {
    const active = activeAppKey ? installedApps.get(activeAppKey) : null;
    if (!active) return;
    // Send under a protocol the active app is actually BOUND to, so our own echo
    // (and a peer that binds the same protocol to a different implementation) routes
    // to the right place. An app the user has unbound sends nothing.
    const proto = shell.bindings.boundProtocols(active.key)[0];
    if (!proto) return;
    const body = msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body);
    const chatBytes = new Uint8Array(1 + body.length);   // [chatType][body]
    chatBytes[0] = msg.chatType & 0xff;
    chatBytes.set(body, 1);
    // Fire-and-forget to every linked peer over Transport — one plane.
    broadcastToPeers(proto, chatBytes);
    // Local echo: run through the app's guest, render if active. Not awaited —
    // the echo is a view concern, and the send has already gone out; letting it
    // gate the lines below would make a guest failure also drop the presence
    // cache. `renderLocal` reports its own failure.
    renderLocal(active, chatBytes);
    if (msg.chatType === 0x02) {
      // Sticky "presence" replay: nick announcements are cached and
      // re-broadcast on every newly-opened dc so peers joining mid-session
      // pick up our identity without us having to send it again. The chat
      // app uses chatType=0x02 for this; other apps that don't use the
      // same convention simply never set the cache.
      lastSentNickBody = { proto, body };
    }
  }
});

// ---------------------------------------------------------------------------
// Networking — the transport bundle under a WebRTC socket seam (RtcNetwork,
// host/net-rtc.ts) over a relay signaling channel.
//
// The transport is now a signed bundle (see TRANSPORT_BYTES above): the channel
// AKE, record layer, link routing and request/response layer run as its confined
// guest program, driven by the shell's TransportHost. What net-rtc.ts contributes
// is the WebRTC fabric — perfect negotiation, the relay rendezvous, the unauthed-
// peer cap, ICE-restart recovery — each data channel handed to the driver's
// openLink(). Channel identity is the transport's in-channel HELLO/AUTH (§12.6),
// so any frame the driver hands to our sink is already attributed to an
// authenticated peer — `_from` is that peer's pubkey, which we treat as the
// message author. No per-message signature.
// ---------------------------------------------------------------------------

let lastSentNickBody = null;   // {proto, body} — replayed to peers that join mid-session

// Reconnectable relay signaling. RtcNetwork takes a Signaling at construction;
// we hand it one whose underlying WebSocket can be (re)pointed at a relay URL
// at runtime. Dropping or swapping the relay leaves authenticated P2P links
// untouched — the relay was only ever the initial rendezvous.
let relayWs = null;
let signalCb = () => {};
const signalOutbox = [];
const signaling = {
  send(msg) {
    const s = JSON.stringify(msg);
    if (relayWs && relayWs.readyState === WebSocket.OPEN) relayWs.send(s);
    else signalOutbox.push(s);   // queued until the relay is (re)connected
  },
  onMessage(fn) { signalCb = fn; },
  close() { if (relayWs) { try { relayWs.close(); } catch {} } },
};

// The room's contact secret: 32 bytes, or null for an open room — we answer anyone who
// finds the room name. Set from the invite link's `#` fragment on load, or minted by
// "Random"; the sharing machinery is further down, under "Room secret".
//
// Declared HERE, above the code that reads it, rather than beside that machinery:
// `let` is not hoisted like `var`, so a declaration below this point would leave a
// getter reading a temporal-dead-zone binding. Nothing reads it during module
// evaluation today, which means that would be a latent throw waiting for the first
// code path that touches it earlier — not a failure we would see now.
let roomSecret = null;

// Admit the kernel-shipped transport bundle (standing the shell's transport driver
// up), then put the WebRTC socket seam under it. Runs lazily on the first relay
// connect — nothing needs a network before that — and re-runs whenever the room
// secret changed, because the driver's ACCEPTING-side gate reads the secret at
// install time (§12.6.3): the re-install is the in-place upgrade path the shell
// supports for a replaced transport bundle. The DIALING side stays fully dynamic —
// `peerContactFor` is a hook the RtcNetwork reads afresh for every link.
async function ensureTransport() {
  const secret = roomSecret ?? undefined;
  if (net && transportSecret === secret) return;
  if (net) net = null; // links die with the outgoing driver's close below
  await shell.loadBundleBlob(TRANSPORT_BYTES);
  transportSecret = secret;
  net = new RtcNetwork({
    driver: shell.net,
    signaling,
    rtcConfig: RTC_CONFIG,
    peerContactFor: () => roomSecret ?? undefined,
    onPeerUp: (peerId) => {
      shellPrint(`P2P link to ${peerId.slice(0, 8)} open`, "sys");
      deliverSys(`P2P link to ${peerId.slice(0, 8)} open`);
      updatePeerPill();
      // Replay our last nick so a peer joining mid-session learns our identity
      // without us re-sending it (chat v2 uses chatType 0x02 for nick).
      if (lastSentNickBody && shell.bindings.boundApp(lastSentNickBody.proto)) {
        const body = lastSentNickBody.body;
        const chatBytes = new Uint8Array(1 + body.length);
        chatBytes[0] = 0x02;
        chatBytes.set(body, 1);
        shell.transport.send(peerId, new TextEncoder().encode(lastSentNickBody.proto), chatBytes);
      }
    },
    onPeerDown: (peerId) => {
      shellPrint(`P2P link to ${peerId.slice(0, 8)} closed`, "sys");
      updatePeerPill();
      removeRemoteTile(peerId);
      updateCallStatus();
    },
    onTrack: (peerId, track) => {
      // A remote peer is sending media — attach the track to their tile. When it
      // ends (they hung up, or their pc died) drop it; an empty tile goes away.
      const tile = getOrCreateRemoteTile(peerId);
      tile.stream.addTrack(track);
      track.addEventListener("ended", () => {
        try { tile.stream.removeTrack(track); } catch {}
        if (tile.stream.getTracks().length === 0) removeRemoteTile(peerId);
      });
    },
  });
  if (!transportWired) {
    transportWired = true;
    // One plane, one dispatch scheme: the shell owns the shared dispatch (§12.10).
    // An inbound frame names a protocol id; the shell resolves it through bindings
    // to the installed app and invokes that app's guest `handle` entrypoint — the
    // answer is a Promise, which the driver awaits and we render when it settles.
    // The only special protocol is _offer (bundle transit), which we handle
    // directly. Wired here, on the standing driver, because the shell's
    // `transport` face is a throw-until-loaded stub before that.
    shell.transport.onRequest((from, proto, payload) => {
      if (proto === OFFER_PROTO) {
        handleOffer(payload, from).catch(() => {});
        return null;
      }
      const result = shell.dispatch(from, proto, payload);
      if (result) {
        const appKey = shell.bindings.boundApp(proto);
        if (appKey === activeAppKey) {
          // A second consumer of the same promise, purely for the local view — the
          // driver owns the answer that goes back on the wire. It needs its own
          // catch: a guest that throws (or blows its execution budget, §12.3) would
          // otherwise surface as an unhandled rejection with no route to the user.
          result.then(
            (bytes) => { if (bytes) deliverRender(new Uint8Array(bytes)); },
            (err) => shellPrint(`app "${proto}" failed to render an inbound message: ${err.message}`, "err"));
        }
      }
      return result;
    });
  }
}

// Boot the app registry now that the shell exists: render the (empty) lists, then
// pull back anything installed earlier this session so a transitive Offer works the
// moment peers connect, from the saved signed bytes.
renderAppList();
renderOfferList();
restoreInstalledApps().catch((err) =>
  shellPrint(`Restore failed: ${err.message}`, "err"));

// ─── live audio/video calls ────────────────────────────────────────────
//
// Calls ride the same RTCPeerConnections as the data channel. net.addLocalTrack
// publishes our camera/mic to every connected peer (and to peers that connect
// later); RtcNetwork renegotiates as tracks are added (startCall) or removed
// (endCall → net.removeLocalTracks). Remote tracks arrive via the onTrack
// callback wired on `net` above and land in a per-peer tile keyed by pubkey
// hex; a tile is cleaned up when its track ends or the peer's link drops
// (onPeerDown).

const callBar      = document.getElementById("call-bar");
const callStartBtn = document.getElementById("call-start");
const callMuteBtn  = document.getElementById("call-mute");
const callEndBtn   = document.getElementById("call-end");
const callStatus   = document.getElementById("call-status");
const videoTiles   = document.getElementById("video-tiles");

let localStream = null;
let micEnabled = true;
const remoteTiles = new Map(); // pkHex -> { wrap, video, stream }

function updateCallStatus() {
  if (!localStream) {
    callStatus.textContent = "idle";
    callBar.classList.add("idle");
  } else {
    const n = net ? net.linkedPeers().length : 0;
    callStatus.textContent = n === 0
      ? "in call (waiting for peers)"
      : `in call · ${n} peer${n === 1 ? "" : "s"}`;
    callBar.classList.remove("idle");
  }
}

function showTilesIfAny() {
  const has = !!localStream || remoteTiles.size > 0;
  videoTiles.classList.toggle("hidden", !has);
}

function ensureLocalTile() {
  if (document.getElementById("tile-local")) return;
  const wrap = document.createElement("div");
  wrap.className = "tile local";
  wrap.id = "tile-local";
  const v = document.createElement("video");
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  v.srcObject = localStream;
  const lab = document.createElement("div");
  lab.className = "tile-label";
  lab.textContent = `me · ${myPkHex.slice(0, 8)}`;
  wrap.appendChild(v);
  wrap.appendChild(lab);
  videoTiles.appendChild(wrap);
  showTilesIfAny();
}

function removeLocalTile() {
  const t = document.getElementById("tile-local");
  if (!t) return;
  const v = t.querySelector("video");
  if (v) v.srcObject = null;
  t.remove();
  showTilesIfAny();
}

function getOrCreateRemoteTile(pkHex) {
  let t = remoteTiles.get(pkHex);
  if (t) return t;
  const wrap = document.createElement("div");
  wrap.className = "tile";
  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  const stream = new MediaStream();
  v.srcObject = stream;
  const lab = document.createElement("div");
  lab.className = "tile-label";
  lab.textContent = pkHex.slice(0, 8);
  wrap.appendChild(v);
  wrap.appendChild(lab);
  videoTiles.appendChild(wrap);
  t = { wrap, video: v, stream };
  remoteTiles.set(pkHex, t);
  showTilesIfAny();
  return t;
}

function removeRemoteTile(pkHex) {
  const t = remoteTiles.get(pkHex);
  if (!t) return;
  for (const track of t.stream.getTracks()) {
    try { t.stream.removeTrack(track); } catch {}
  }
  t.video.srcObject = null;
  t.wrap.remove();
  remoteTiles.delete(pkHex);
  showTilesIfAny();
}

async function startCall() {
  if (localStream) return;
  callStartBtn.disabled = true;
  callStatus.textContent = "requesting camera + mic...";
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: true,
    });
  } catch (err) {
    shellPrint(`getUserMedia failed: ${err.message}`, "err");
    callStartBtn.disabled = false;
    updateCallStatus();
    return;
  }
  micEnabled = true;
  callMuteBtn.textContent = "Mute";
  callMuteBtn.disabled = false;
  callEndBtn.disabled = false;
  callStartBtn.disabled = true;
  ensureLocalTile();
  // RtcNetwork publishes each track to every connected peer and to any peer
  // that connects later, renegotiating as needed.
  if (!net) {
    shellPrint("Connect to a relay first — there is no network yet.", "err");
    return;
  }
  for (const track of localStream.getTracks()) net.addLocalTrack(track, localStream);
  updateCallStatus();
  shellPrint("Call started.", "sys");
}

function endCall() {
  if (!localStream) return;
  if (net) net.removeLocalTracks();
  for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  removeLocalTile();
  for (const pkHex of Array.from(remoteTiles.keys())) removeRemoteTile(pkHex);
  callStartBtn.disabled = false;
  callMuteBtn.disabled = true;
  callEndBtn.disabled = true;
  updateCallStatus();
  shellPrint("Call ended.", "sys");
}

function toggleMute() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  for (const t of localStream.getAudioTracks()) t.enabled = micEnabled;
  callMuteBtn.textContent = micEnabled ? "Mute" : "Unmute";
}

callStartBtn.addEventListener("click", startCall);
callEndBtn.addEventListener("click", endCall);
callMuteBtn.addEventListener("click", toggleMute);

// ─── relay connection ───────────────────────────────────────────────────
//
// Proactive ICE restart on a network change. ICE keepalives take 5–10s to
// notice a network flip on their own; kicking restartAllIce() the moment the
// browser tells us connectivity changed cuts straight to recovery. The
// renegotiation offers ride the relay signaling channel, so the relay must be
// reachable for recovery to complete.
window.addEventListener("online", () => {
  shellPrint("Network online — restarting ICE", "sys");
  if (net) net.restartAllIce();
});
if (navigator.connection && typeof navigator.connection.addEventListener === "function") {
  navigator.connection.addEventListener("change", () => {
    shellPrint("Network changed — restarting ICE", "sys");
    if (net) net.restartAllIce();
  });
}

// Room names mirror the relay-side validation (see scripts/relay.mjs):
// URL-safe identifier characters, length 1..128. Empty input is allowed
// and means "use the default room".
const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_ROOM = "global";

// Splice the chosen room onto the base relay URL as a path component. The
// relay reads the first path segment as the room name; if the user typed
// a URL that already contains a path we keep it (lets them paste a full
// `ws://host:8080/my-room` URL in just the URL field if they prefer).
function buildRelayUrl(base, room) {
  // Trim any trailing slash on the base, then append `/<encoded room>`.
  // If `base` already ends with a non-empty path we leave it alone — the
  // user typed an explicit URL.
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  const hasPath = u.pathname && u.pathname !== "/";
  if (!hasPath && room) u.pathname = "/" + encodeURIComponent(room);
  return u.toString();
}

function connectRelay() {
  const base = relayUrlInput.value.trim();
  if (!base) { shellPrint("Enter a relay URL.", "err"); return; }
  const room = relayRoomInput.value.trim();
  if (room && !ROOM_NAME_RE.test(room)) {
    shellPrint("Room name must match [A-Za-z0-9._-] (up to 128 chars).", "err");
    return;
  }
  const url = buildRelayUrl(base, room);
  if (!url) { shellPrint("Relay URL must be ws:// or wss://.", "err"); return; }
  // Keep the address bar in step with a hand-typed room, so "Copy invite link" (and the
  // browser's own copy-URL) always describe the room we are actually joining.
  syncHash();
  updateRoomGateHint();
  if (relayWs) { try { relayWs.close(); } catch {} }
  const label = room || DEFAULT_ROOM;
  shellPrint(`Connecting to ${url} (room: ${label})...`, "sys");
  relayStatus.textContent = "connecting...";
  setRelayPill("connecting", `room ${label}`);
  relayConnectBtn.disabled = true;
  relayWs = new WebSocket(url);
  relayWs.addEventListener("open", () => {
    shellPrint(`Relay connected — room ${label}, waiting for peers.`, "sys");
    relayStatus.textContent = `connected · room ${label}`;
    setRelayPill("ok", `room ${label}`);
    relayConnectBtn.disabled = false;
    // Remember the working URL + room so a reload picks the relay back up
    // automatically. Saved on success only, so a typo doesn't get retried
    // forever.
    sessionStorage.setItem("chat.relayUrl", base);
    sessionStorage.setItem("chat.relayRoom", room);
    // The secret belongs to the room, so it is saved and cleared with it — a reload must
    // not rejoin a gated room having forgotten the credential, nor keep a stale secret
    // after moving to an open one.
    if (roomSecret) sessionStorage.setItem("chat.roomSecret", bytesToHex(roomSecret));
    else sessionStorage.removeItem("chat.roomSecret");
    // Flush any signals RtcNetwork queued while the socket was down, then
    // stand the transport up (first connect, or the room secret changed) and
    // announce ourselves into the room so the WebRTC dance can begin.
    for (const s of signalOutbox) relayWs.send(s);
    signalOutbox.length = 0;
    ensureTransport()
      .then(() => net.join())
      .catch((err) => {
        shellPrint(`Transport start failed: ${err.message}`, "err");
        relayStatus.textContent = "error";
        setRelayPill("err", "no transport");
      });
  });
  relayWs.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    signalCb(msg);   // hand it to RtcNetwork's signaling
  });
  relayWs.addEventListener("close", () => {
    relayStatus.textContent = "disconnected";
    setRelayPill("off", "no relay");
    relayConnectBtn.disabled = false;
    shellPrint("Relay disconnected. Existing P2P links unaffected.", "sys");
  });
  relayWs.addEventListener("error", () => {
    relayStatus.textContent = "error";
    setRelayPill("err", "relay error");
    relayConnectBtn.disabled = false;
    shellPrint(`Relay error — is one running at ${url}?`, "err");
  });
}
relayConnectBtn.addEventListener("click", connectRelay);
relayUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); connectRelay(); }
});
relayRoomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); connectRelay(); }
});

// ── Room secret: the credential that rides in the invite link ────────────────
//
// The room NAME is routing — the relay needs it to forward our signaling, so it is
// necessarily visible to whoever runs the relay. The room SECRET is the credential, and
// it travels in the URL fragment (`#`), which browsers never put on the wire. So one
// pasteable link carries both halves while the relay only ever learns the half it needs.
// That is the whole point: a relay you do not control can carry your signaling without
// being able to join the conversation.
//
// `roomSecret` itself is declared up with the networking section (see there for
// why). null ⇒ open room: we answer anyone who finds the name. Fine for `global`
// on a laptop, not for anything else.

/** Read `#room=<name>&s=<64 hex>` from the current URL. Both parts optional. */
function inviteFromHash() {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!raw) return {};
  const q = new URLSearchParams(raw);
  const room = q.get("room") ?? undefined;
  const s = q.get("s") ?? undefined;
  return {
    room: room && ROOM_NAME_RE.test(room) ? room : undefined,
    secret: s && /^[0-9a-f]{64}$/i.test(s) ? hexToBytes(s.toLowerCase()) : undefined,
  };
}

/** Mirror the current room + secret into the address bar without adding history
 *  entries, so a reload or a "copy URL" from the browser chrome keeps working. */
function syncHash() {
  const room = relayRoomInput.value.trim();
  const q = new URLSearchParams();
  if (room) q.set("room", room);
  if (roomSecret) q.set("s", bytesToHex(roomSecret));
  const hash = q.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

/** Reflect gated/open in the panel, since a wrong or missing secret has no error path —
 *  a refused peer is simply one that never appears. Telling the user which mode they are
 *  in is the only warning we can give. */
function updateRoomGateHint() {
  const el = document.getElementById("room-gate-hint");
  if (!el) return;
  el.innerHTML = roomSecret
    ? "This room is <strong>gated</strong> — peers need the secret from your invite link. " +
      "Share the link, not just the room name."
    : "This room is <strong>open</strong> — anyone who learns the name can join. " +
      "Press <strong>Random</strong> for a private room with a secret.";
}

// "Random": mint a private room AND its secret together. 64 bits of room name is plenty
// to keep two rooms from colliding; the secret is a full 32 bytes because it is the
// actual credential and is never guessed at, only pasted. Lowercase hex throughout so
// both round-trip through case-insensitive copy paths (URLs, chat clients) unchanged.
relayNewRoomBtn.addEventListener("click", () => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  relayRoomInput.value = bytesToHex(bytes);
  roomSecret = new Uint8Array(32);
  crypto.getRandomValues(roomSecret);
  syncHash();
  updateRoomGateHint();
  shellPrint("New private room + secret minted — use \"Copy invite link\" to share both.", "sys");
  relayRoomInput.focus();
  relayRoomInput.select();
});

// The invite link is page URL + `#room=…&s=…`. Clipboard access can be denied or absent
// (file://, older browsers), so fall back to printing it into the shell log where it can
// still be selected by hand — never leave the user with a button that silently does
// nothing.
relayCopyInviteBtn.addEventListener("click", async () => {
  syncHash();
  const link = location.href;
  try {
    await navigator.clipboard.writeText(link);
    shellPrint(roomSecret
      ? "Invite link copied — it carries the room AND its secret. Anyone with it can join."
      : "Invite link copied (open room — no secret; press \"Random\" for a private one).", "sys");
  } catch {
    shellPrint(`Copy failed — here is the link: ${link}`, "sys");
  }
});

// Default relay URL: same host the page is loaded from (so phones loading
// the shell off a desktop's LAN IP get the right pre-fill out of the box).
// Always ws:// — the relay is plain WebSocket; user can override to wss://.
// Falls back to "localhost" on file:// where location.hostname is empty.
function defaultRelayUrl() {
  const host = location.hostname || "localhost";
  return `ws://${host}:8080`;
}

// Auto-reconnect to the last relay that successfully accepted us. This is
// the other half of the reload story: re-establishing the relay link is
// what lets our broadcast hello reach peers and tear down their zombie
// entries for our previous tab.
const savedRelayUrl = sessionStorage.getItem("chat.relayUrl");
const savedRelayRoom = sessionStorage.getItem("chat.relayRoom");
const savedRoomSecret = sessionStorage.getItem("chat.roomSecret");
relayUrlInput.value = savedRelayUrl || defaultRelayUrl();
if (savedRelayRoom) relayRoomInput.value = savedRelayRoom;
if (savedRoomSecret && /^[0-9a-f]{64}$/.test(savedRoomSecret)) roomSecret = hexToBytes(savedRoomSecret);

// An invite link WINS over the saved session: following someone's link is an explicit
// instruction to join their room, whereas sessionStorage is just where we happened to be
// last. Taking the room without its secret (or vice versa) would produce a peer that
// cannot link and cannot be told why, so the two move together — an invite naming a room
// with no `s` means that room is open, and must clear any secret we were holding.
const invite = inviteFromHash();
if (invite.room !== undefined || invite.secret !== undefined) {
  if (invite.room !== undefined) relayRoomInput.value = invite.room;
  roomSecret = invite.secret ?? null;
  shellPrint(invite.secret
    ? `Invite link: room "${relayRoomInput.value || DEFAULT_ROOM}" (gated).`
    : `Invite link: room "${relayRoomInput.value || DEFAULT_ROOM}" (open — no secret).`, "sys");
}
updateRoomGateHint();
syncHash();
if (savedRelayUrl) connectRelay();

// Initial peer / call status. (relay pill is already in its "off" default
// state from markup; connectRelay below will manage it from here on.)
updatePeerPill();
updateCallStatus();
