// seedkernel is a dependency, not a sibling directory. Every specifier below is
// a *published* entry point of seedkernel-wasm (its package.json "exports"), so
// this file can only reach what seedkernel has deliberately made public — the
// import map in chat-shell.html resolves them to the vendored build. If a future
// seedkernel change breaks chat, it broke a public export, which is the point.
import sodium from "seedkernel-wasm/libsodium";
// bootShell is the assembly itself (§12.9): platform members defaulted, the
// transport bundle pinned to its own author, the channel adapter built from the
// `transport` options passed to it. Chat's admit is then ONLY its consent gate —
// who may be the network is the assembly's, so nobody can lose it by forgetting it.
import { bootShell } from "seedkernel-wasm/shell-core";
// `writeOp` frames an app's own local op; `OpArgs` writes the transport bundle's op
// arguments, which is what the host's own door into the network takes (see linkedPeers).
import { writeOp, OpArgs } from "seedkernel-wasm/op-frame";
import { loadCrypto } from "seedkernel-wasm/crypto-browser";
import { verifyBundle, genesisHash } from "seedkernel-wasm/bundle";
// The sockets: a WebSocket for the relay the transport meets and links peers through, and
// seedkernel's WebRTC seam for the peer connections it then moves them to (§12.7).
import { WsNetwork } from "seedkernel-wasm/net-ws";
import { RtcNetwork } from "seedkernel-wasm/net-rtc";
import { combineChannels } from "seedkernel-wasm/socket-seam";
// Rooms are this page's, not the transport's: it meets peers in a relay room with
// seedrelay's room client and hands their keys to the transport, which knows only keys
// and the relays that reach them.
import { roomClient, roomId } from "seedrelay/rooms";
// Chat's own code. media-rtc.js is the call feature: audio and video ride peer
// connections this page owns, signaled through the calls boot bundle below.
import { MediaCalls } from "./media-rtc.js";
import { isChatApp, CHAT_OP_SEND, CHAT_OP_RENDER, NET_PROTO } from "./chat-app.js";
// The offers app: a second boot bundle, loaded right below alongside the transport —
// see "boot the offers app" further down for why a bundle rather than a page-held name.
import { OFFER_PROTO, OFFERS_KEY_PREFIX } from "./offers-app.js";
import { offersBundleBytes, OFFERS_AUTHOR_HEX, OFFERS_APP } from "./offers-bundle.js";
// The calls app: a third boot bundle, the signaling path for a call's media.
import { CALLS_OP_SEND } from "./calls-app.js";
import { callsBundleBytes, CALLS_AUTHOR_HEX, CALLS_APP } from "./calls-bundle.js";

// The media calls' peer connections ask the relay for their address, as the transport's do
// (seedkernel §12.7), so no third party learns who is calling: `connectRelay` points this at
// the relay it joins.
const RTC_CONFIG = { iceServers: [] };
/** A seedrelay answers STUN on this UDP port. */
const RELAY_STUN_PORT = 3478;

const shellLog = document.getElementById("shell-log");
const relayUrlInput = document.getElementById("relay-url");
const relayRoomInput = document.getElementById("relay-room");
const relaySecretInput = document.getElementById("relay-secret");
const relayConnectBtn = document.getElementById("connect-relay");
const roomJoinBtn = document.getElementById("join-room");
const relayNewRoomBtn = document.getElementById("new-room");
const roomListEl = document.getElementById("room-list");
const contactAddInput = document.getElementById("add-contact");
const contactAddSecretInput = document.getElementById("add-contact-secret");
const contactAddBtn = document.getElementById("add-contact-btn");
const contactInput = document.getElementById("contact-secret");
const contactSetBtn = document.getElementById("set-contact");
const contactNewBtn = document.getElementById("new-contact");
const contactCopyBtn = document.getElementById("copy-contact");
const contactHint = document.getElementById("contact-hint");
const relayStatus = document.getElementById("relay-status");
const peerListEl = document.getElementById("peer-list");
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
  // Whatever its dot was for, a message or an offer, is seen now.
  tabs[name].btn.classList.remove("unread");
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

/** 32 bytes as lowercase hex: a key or a contact secret. */
const HEX32_RE = /^[0-9a-f]{64}$/;

shellPrint("Starting the handler table...", "sys");
// Core libsodium + ML-DSA-65, mixed onto `sodium` before anything below touches
// it — bootShell's verifyBundle needs the PQ signature half for ANY bundle, and
// verifyBundle is synchronous, so this can't be lazy (seedkernel's crypto-browser.ts).
//
// This runtime only VERIFIES suite 0x02 bundle envelopes (§12.4, §14.1). Bundle
// authoring is offline and lives behind seedkernel-wasm/bundle-author, which is not
// shipped in the browser runtime tree.
await loadCrypto(sodium, new URL("./vendor/", import.meta.url));

// The host (its shell, admission policy and `install`) is assembled once the
// identity exists — see the boot sequence below. It is declared here because handlers
// defined above reach it through `shell`.
//
// Ongoing-consent admission (§12.4): the user approves each unique bundle before it
// runs. `pendingApprovals` holds the module hashes the user has consented to; the
// shell's `admit` callback consumes one (one-shot) on install. The shell runs under an
// open policy, so consent — not a static author allow-list — is this shell's gate.
const pendingApprovals = new Set();
let shell;
// The relay this page is on: its origin, its secret if it is private, and seedrelay's room
// client there. null while it is on none: before Connect, and after Disconnect.
let relay = null;
// The rooms this page is in, by name: `id` is the room's id on the relay, in hex, and
// `members` the keys the room client last heard are in it. A page may be in several.
const joinedRooms = new Map();
// Everyone this page wants a link to, by key in hex: its room-mates and its contacts, each
// with how the call to it stands (`calls`, further down).
const wanted = new Map();
// What the app calls each peer, by key in hex: its nick, shown in the Network tab's lists
// in place of the key.
const peerNicks = new Map();
// The notices peers are owed, by key in hex: true for one this node added, false for one
// it removed. Each is sent once its peer is linked (`tellPeers`).
const untoldPeers = new Map();
// Peers this node removed and is about to hang up on, by key in hex: no longer listed.
const leavingPeers = new Set();

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
// Local rendering gets the same attribution shape as an inbound frame: the authenticated
// peer identity, not a bundle-author id. This tab does not author bundles at runtime.
const myPeerId = myKeys.publicKey;

shellPrint(`I am ${myPkHex.slice(0, 8)}`, "sys");

// ─── rooms, contacts and the contact secret ────────────────────────────
//
// Two ways to be linked to a peer, and one gate:
//
//   A ROOM has no secret. Joining one is agreeing to be linked to everyone in it, and this
//   page may be in several at once. The transport is told who the room-mates are
//   (`welcome`), and answers their calls whether or not they hold the contact secret.
//
//   A CONTACT is one peer, by key, linked whatever room either is in: a direct connection.
//   Calling a contact takes its contact secret, if it has one.
//
//   The CONTACT SECRET is this node's own (seedkernel §12.6.3): 32 bytes a caller must
//   present to be answered at all, unless it is a room-mate. None, and anyone may call.
//
// `myContactSecret` is this node's, or null. `contacts` holds the contacts, by key in hex,
// each with its contact secret or null. Both are kept with the identity, as the rooms are.
const savedContact = sessionStorage.getItem("chat.contactSecret");
let myContactSecret = savedContact && HEX32_RE.test(savedContact) ? hexToBytes(savedContact) : null;
const contacts = new Map();
try {
  for (const [key, secret] of Object.entries(JSON.parse(sessionStorage.getItem("chat.contacts") ?? "{}"))) {
    if (HEX32_RE.test(key)) contacts.set(key, HEX32_RE.test(secret) ? hexToBytes(secret) : null);
  }
} catch {}

function saveContacts() {
  sessionStorage.setItem("chat.contacts",
    JSON.stringify(Object.fromEntries([...contacts].map(([k, s]) => [k, s ? bytesToHex(s) : ""]))));
}

// The tab's sockets, standing before the transport: bootShell registers its accept sink
// while starting it, and RtcNetwork announces every data channel through that sink. The
// transport itself opens the relay (a WebSocket), links through it, and drives the peer
// connections.
const net = combineChannels(new WsNetwork(), new RtcNetwork());

// Assemble the shared shell now that the identity exists — via bootShell, the ONE
// assembly (§12.9). The platform is a browser seam: sodium, our identity, a
// WebAssembly-backed module builder, an in-memory freshness store — all defaulted by
// bootShell — and the channel adapter, which bootShell CONSTRUCTS from the `transport`
// options (identity taken from the top-level fields, never restated) and returns with
// the shell. The adapter is the platform's: link ids and sockets. Transport policy belongs
// to the signed bundle, and so does the address book — it lives in that bundle's own realm
// now (§12.10), and chat writes nothing to it: a peer here is met in the relay room the
// transport joins, and linked by it.
// The sockets above are passed in as `channels`; bootShell registers their accept sink
// while starting the transport. Raw-link
// events then go only to whichever admitted slot owns the `link` binding, and
// `shell.close()` closes the whole stack.
//
// Contact policy belongs to the signed transport guest. This node's contact secret is
// its config here, so the gate stands before anything can call, and `setMyContact`
// changes it later with the guest's `contact` op. Who is linked follows the rooms and
// contacts (`syncPeers`), a peer at a time, without reloading the transport.
//
// bootShell installs the seedkernel-shipped transport bundle at boot and
// starts the ChannelFactory before returning. Connecting to a relay is the transport's
// `relay` op: it registers there, joins the room and links the peers it meets.
//
// The realm engine every app's guest runs in — the transport bundle's, the offers
// app's, and each chat app's — is bootShell's default (safe-js), imported lazily on
// the first realm.
//
// The page serves no name of its own: dispatch is a single claim → bundle
// slot map (seedkernel §12.10), and there is no owner but a signed bundle. `admit` is
// ONE predicate (§12.5), and it composes two things that are actually the page's: the
// offers boot bundle's author+app pin (below — deployment-shipped bytes, not a consent
// prompt) and the user-consent gate for every other app. The transport never reaches
// this gate: bootShell installs it by selection (§12.5).
const booted = await bootShell({
  sodium,
  identity: myKeys,
  // The transport asks the relay a peer is linked through for STUN (§12.7). A chat room
  // keeps its members linked, so links do not idle out; the page redials a member whose
  // link drops (`pollPeerViews`).
  transport: {
    channels: net,
    config: { linkIdleTimeoutMs: 0, ...(myContactSecret ? { contactSecret: bytesToHex(myContactSecret) } : {}) },
  },
  admit(v) {
    // The offers app is pinned: the exact author and app this PAGE was built with
    // (browser/offers-bundle.js, generated by scripts/build-boot-bundles.mjs), read off
    // the artifact rather than restated by hand. A boot bundle gets a pin rather than a
    // consent prompt because it is loaded once below, before any dialog could run, under
    // bytes this deployment shipped — there is nothing here for a click to actually
    // decide, the same reasoning that keeps the transport off the consent path.
    if (bytesToHex(v.author) === OFFERS_AUTHOR_HEX && v.manifest.app === OFFERS_APP) return true;
    if (bytesToHex(v.author) === CALLS_AUTHOR_HEX && v.manifest.app === CALLS_APP) return true;
    const bytesHashHex = v.modules.length > 0 ? bytesToHex(genesisHash(sodium, v.modules[0].wasm)) : "";
    if (!pendingApprovals.has(bytesHashHex)) return false;
    pendingApprovals.delete(bytesHashHex);
    return true;
  },
});
shell = booted.shell;

// ─── boot the offers app ────────────────────────────────────────────────
//
// `offer/v1` carries a signed bundle from one browser to another, and the app that
// would handle it is the thing being offered — so until an offer is accepted there is
// no app to route it to, and something already installed at boot has to own the name
// (browser/offers-app.js). A second boot bundle, loaded here right beside the
// transport: it needs no network, but is loaded separately because it is chat's second
// pinned boot bundle rather than part of bootShell's transport assembly.
//
// `onInbound` is the one gap a single claim → bundle-slot map leaves open (seedkernel
// §12.10): the wire consumes a delivery's answer on its way back out, so the page's own
// view of "a fresh offer arrived" has no other path to it. A non-empty answer is the
// offer's hash — the guest's own dedupe key (browser/offers-app.js) — so read the fs
// record it just wrote and hand it to `handleOffer` (declared further down; a hoisted
// function declaration, and never actually reached until the app registry below has
// stood up the state it reads).
const offersApp = await shell.install(offersBundleBytes(), {
  onInbound: (claim, from, answer) => {
    if (answer.length === 0) return; // a duplicate the guest already had — nothing new
    const key = OFFERS_KEY_PREFIX + bytesToHex(answer);
    offersApp.fs.get(key).then((record) => {
      if (!record) return;
      handleOffer(record.subarray(32), bytesToHex(record.subarray(0, 32)), key).catch(() => {});
    });
  },
});

// ─── boot the calls app ─────────────────────────────────────────────────
//
// A call's audio and video ride peer connections this page owns (media-rtc.js), beside
// the transport's; their signaling rides the node's own authenticated channel under
// `call/v1`, the calls boot bundle's claim. A peer's signal reaches the page as that
// load's `onInbound` answer, attributed by the channel it arrived on; ours leave through
// the same app's `send` op, since only a guest can reach `_net`.
//
// It is the one channel two pages talk on directly, so it also carries what else they say
// to each other (`onPageSignal`): `{ peer: true }` from a page that added this node as a
// peer and `{ peer: false }` from one that removed it, and `{ nick }`, what a peer calls
// itself.
const callsApp = await shell.install(callsBundleBytes(), {
  onInbound: (claim, from, answer) => { if (answer.length > 0) onPageSignal(bytesToHex(from), answer); },
});

/** Send one signal to a peer's page. */
function sendSignal(peerId, signal) {
  const arg = new Uint8Array(32 + signal.length);
  arg.set(hexToBytes(peerId), 0);
  arg.set(signal, 32);
  return callsApp.invoke(writeOp(CALLS_OP_SEND, arg));
}

/** A signal from a peer's page, already attributed by the channel it arrived on. A peer
 *  that added this node is added here too, and one that removed it is removed, so the two
 *  ends agree on being peers; anything else is a call's (media-rtc.js). */
function onPageSignal(from, bytes) {
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  // What the peer calls itself, an empty nick for nothing: shown in place of its key.
  if (typeof msg?.nick === "string") {
    if (msg.nick) peerNicks.set(from, msg.nick.slice(0, 32)); else peerNicks.delete(from);
    renderRoomList();
    return;
  }
  if (typeof msg?.peer !== "boolean") { void media.onSignal(from, bytes); return; }
  if (msg.peer && !contacts.has(from)) {
    addContact(from, null, { tell: false });
    shellPrint(`${peerLabel(from)} added you as a peer.`, "sys");
  } else if (!msg.peer && contacts.has(from)) {
    removeContact(from, { tell: false });
    shellPrint(`${peerLabel(from)} removed you as a peer.`, "sys");
  }
}

const media = new MediaCalls({
  myId: myPkHex,
  rtcConfig: RTC_CONFIG,
  send: sendSignal,
  onPeerClosed: (peerId) => {
    removeRemoteTile(peerId);
    updateCallStatus();
  },
  onTrack: (peerId, track) => {
    const tile = getOrCreateRemoteTile(peerId);
    tile.stream.addTrack(track);
    track.addEventListener("ended", () => {
      try { tile.stream.removeTrack(track); } catch {}
      if (tile.stream.getTracks().length === 0) removeRemoteTile(peerId);
    });
  },
});

// ─── channel identity ──────────────────────────────────────────────────
//
// Transport identity is the transport bundle's job. Each data channel runs its
// in-channel HELLO/AUTH challenge (§12.6), proving the far end holds the node
// private key for the pubkey it claims — a continuous channel binding, which
// subsumes both SDP a=fingerprint signing and any per-message signature.
// Frames the driver hands us are already attributed to an authenticated peer, so
// the sender pubkey (`_from`) is authoritative — we prepend it to the message
// before running the app transform; there is no envelope signer to verify.

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

// The linked set is the TRANSPORT GUEST's answer: links are its own, so asking costs a
// round trip through its realm and this is async. The page asks through `shell.call` — the
// host's door into a co-resident guest's `services` claim (seedkernel §12.10), the same one
// seedkernel's CLI uses for a cohort — and composes the op with seedkernel's own `OpArgs`,
// so the argument writer and the transport's reader move in one artifact. `null` is "nothing
// claims that id": a node with no transport standing, which is no peers rather than an
// error, exactly like a rejection from a realm that is going down.
async function linkedPeers() {
  const answer = shell.call(NET_PROTO, new OpArgs("peers").build());
  if (!answer) return [];
  try {
    const bytes = await answer;
    const out = [];
    for (let off = 0; off + 32 <= bytes.length; off += 32) out.push(bytesToHex(bytes.subarray(off, off + 32)));
    return out;
  }
  catch { return []; }
}

// How each linked peer is reached is the transport's to say as well: its `routes` op answers
// the same set as `[key 32][direct u8]` apiece, 1 once the peer's link has moved off the
// relay to WebRTC and 0 while the relay still forwards it (seedkernel §12.7).
async function peerRoutes() {
  const answer = shell.call(NET_PROTO, new OpArgs("routes").build());
  if (!answer) return [];
  try {
    const bytes = await answer;
    const out = [];
    for (let off = 0; off + 33 <= bytes.length; off += 33) {
      out.push({ id: bytesToHex(bytes.subarray(off, off + 32)), direct: bytes[off + 32] === 1 });
    }
    return out;
  }
  catch { return []; }
}

/** Rotate the transport guest's inbound contact gate. Empty means open (§12.6.3). */
async function setTransportContact(secret) {
  const answer = shell.call(NET_PROTO, new OpArgs("contact")
    .blob(secret ?? new Uint8Array(0))
    .build());
  if (!answer) throw new Error(`nothing claims ${NET_PROTO}`);
  await answer;
}

// The pill counts the linked peers, and says how many of them the relay still forwards:
// green once every link is direct, amber while any is relayed.
function updatePeerPill(routes) {
  const open = routes.length;
  const relayed = routes.filter((r) => !r.direct).length;
  peerPillText.textContent = (open === 1 ? "1 peer" : `${open} peers`) + (relayed > 0 ? ` · ${relayed} via relay` : "");
  peerPill.classList.toggle("ok", open > 0 && relayed === 0);
  peerPill.classList.toggle("warn", relayed > 0);
  peerPill.title = open === 0 ? "Connected peers"
    : relayed === 0 ? "Connected peers — all linked directly"
    : `Connected peers — ${open - relayed} direct, ${relayed} through the relay`;
}

// The Network tab's peer list: the peers this node is connected to directly, by key. That
// is one row for every contact, linked or not, and for any linked peer in none of its
// rooms, which is one that called this node directly. A room-mate that is neither is in
// its room's list instead (`renderRoomList`). A row names the peer, by its nick if the
// app knows one, and says how it is reached, or how the call to it stands. A contact with
// no link takes its contact secret: the row's Connect calls it presenting what the field
// holds. Rows are kept and changed in place, never redrawn, so a field being typed in
// survives the poll.
const PEER_STATES = {
  direct: ["direct", "Linked peer to peer over WebRTC; the relay carries none of this traffic."],
  relayed: ["via relay", "The relay forwards this link's encrypted bytes; no direct link has been made."],
  calling: ["connecting…", "Calling this peer through the relay."],
  silent: ["no answer", "This peer did not answer. It may be offline, or have a contact secret this node did not present."],
  waiting: ["waiting", "Waiting for this peer to call."],
};
const peerRows = new Map(); // key hex to { li, name, secret, connect, remove, state, shown }
const peerListEmpty = peerListEl.querySelector(".empty-row");

function buildPeerRow(id) {
  const li = document.createElement("li");
  li.className = "peer-row";
  const name = document.createElement("span");
  name.className = "peer-row-id peer-row-name";
  name.title = id;
  const secret = document.createElement("input");
  secret.type = "password";
  secret.className = "peer-secret";
  secret.placeholder = "contact secret, if it has one";
  secret.autocomplete = "off";
  secret.spellcheck = false;
  secret.setAttribute("aria-label", `Contact secret of ${id.slice(0, 8)}`);
  const connect = document.createElement("button");
  connect.type = "button";
  connect.className = "icon";
  connect.textContent = "Connect";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon";
  remove.textContent = "Remove peer";
  remove.title = "Stop being a contact: the link goes unless you share a room.";
  const state = document.createElement("span");
  connect.addEventListener("click", () => connectPeer(id, secret));
  secret.addEventListener("input", () => secret.setCustomValidity(""));
  secret.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); connectPeer(id, secret); }
  });
  remove.addEventListener("click", () => removeContact(id));
  secret.hidden = connect.hidden = remove.hidden = true;
  li.append(name, secret, connect, remove, state);
  return { li, name, secret, connect, remove, state, shown: "" };
}

function renderPeerList(routes) {
  const linked = new Map(routes.map((r) => [r.id, r.direct]));
  const ids = [...new Set([...linked.keys(), ...wanted.keys()])]
    .filter((id) => contacts.has(id) || (linked.has(id) && roomsOf(id).length === 0 && !leavingPeers.has(id)))
    .sort();
  for (const [id, row] of peerRows) {
    if (!ids.includes(id)) { row.li.remove(); peerRows.delete(id); }
  }
  peerListEmpty.hidden = ids.length > 0;
  ids.forEach((id, i) => {
    let row = peerRows.get(id);
    if (!row) peerRows.set(id, row = buildPeerRow(id));
    // After the empty row, in key order. A row already in place is not moved, which
    // would take the focus from its field.
    if (peerListEl.children[i + 1] !== row.li) peerListEl.insertBefore(row.li, peerListEl.children[i + 1] ?? null);
    const isLinked = linked.has(id), isContact = contacts.has(id);
    const label = peerLabel(id);
    const state = isLinked ? (linked.get(id) ? "direct" : "relayed")
      : wanted.get(id).silent ? "silent" : calls(id) ? "calling" : "waiting";
    const shown = `${state} ${isContact} ${label}`;
    if (shown === row.shown) return;
    // The field holds what this node presents to the contact, shown again each time the
    // row comes to need it.
    const asks = isContact && !isLinked;
    if (asks && row.secret.hidden) row.secret.value = contacts.get(id) ? bytesToHex(contacts.get(id)) : "";
    row.secret.hidden = row.connect.hidden = !asks;
    row.name.textContent = label;
    // A contact is removed here; one is added from a room's list, or by its link or key.
    row.remove.hidden = !isContact;
    row.shown = shown;
    row.state.className = `peer-route ${state}`;
    [row.state.textContent, row.state.title] = PEER_STATES[state];
  });
}

// ─── app registry ──────────────────────────────────────────────────────
//
// An "app" is an ordinary signed bundle (§12.4): a signed `manifest.bundle`
// envelope plus the app's WASM module and its guest program in one blob. That blob
// IS the bundle format — the same bytes seedstore's flagship deployment loads from
// disk, so a chat app is just a guest that calls its one module and needs no
// chat-specific install format, domain, or peek/unwrap code. The shell's
// `install` (the shared install path) authenticates the author's signature
// over the manifest, which commits to the guest's and module's genesisHash, so the
// blob survives any number of transitive relays and still authenticates against its
// original author — exactly the store-and-forward property an Offer needs. The local
// "add app" flow and the peer-to-peer Offer below carry the identical bundle.
//
// The module's WASM carries two embedded custom sections the runtime ignores but
// this shell reads: "app_meta" (JSON — id, name, version) and "ui" (HTML rendered
// in the sandboxed iframe). The signed manifest's `app` is the id, and it is also the
// key the app lands under (seedkernel §12.4): one slot per label on a node, whoever
// authored it.
//
// The key is node-local. Two peers need not agree on it: a CHAT frame carries a
// *protocol id*, and each side resolves that to whichever app it installed that claims
// it — so two peers running different authors' chat apps interoperate as long as both
// speak the protocol.
//
// An app's module is a PURE TRANSFORM: the guest hands it `senderPk ‖ chatType ‖
// body` and it returns the render bytes for the iframe. The guest — not the WASM
// and not the host — does all the I/O: the host authenticates the sender via the
// AKE channel, invokes the app's guest `handle` entrypoint (the same seam a
// local `invoke` takes), and the guest drives its module by naming it on the
// same seam (§12.2). Inbound delivery and local echo both cross the guest, so
// chat's whole app logic is the one-line forwarding guest it ships in the bundle.
//
// `installedApps` keeps the per-app state we need to re-mount the UI, send
// updates, and re-broadcast the packed bundle transitively (`bundleBytes` is the
// signed bundle blob — the author's manifest signature intact — and is what every
// "Offer" hands to a peer). Apps received via Offer keep the original author's
// manifest signature: we never re-sign a bundle.
// Keyed by the app label — the key the host installs a slot under (§12.4). A node
// holds one slot per label, so two authors' "chat" apps contend for it: the second
// lands only by replacing the first.
const installedApps = new Map();   // app label → AppRecord
let activeAppKey = null;

// Protocol routing (§12.10) — there is no table here and no bind button. Every chat
// bundle's manifest CLAIMS the chat protocol (CHAT_PROTO, chat-app.js), and the load
// that admits it is what routes the id to it: installing an app is what makes it the
// one this node chats with, and a claim has one holder, so another chat app lands only
// by replacing it. `shell.resolve` answers who holds it; the Apps panel below reads that
// rather than storing anything.

const STORE = "apps.v2";

// ── shell frame wire format ─────────────────────────────────────────────
//
// Messages ride the Transport request plane: a chat message is a req with a protocol
// id in the frame, and the receiving shell resolves that to the app claiming it. There
// is no chat-specific framing at all — one plane, one dispatch scheme (§12.10).

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

// ── extract metadata from a bundle blob ──────────────────────────────────
//
// Read app + module metadata off a bundle for the UI and the approval gate, through
// the shared §12.4 verify path: both signatures authenticate the entire body before
// its manifest, guest, or modules are read.
// Returns null on anything malformed, unauthentic, or not the demo's one-module
// app shape.
function peekMeta(bundleBytes) {
  let v;
  try { v = verifyBundle(sodium, bundleBytes); }
  catch { return null; }
  // One module, and a guest reaching the network and nothing else (chat-app.js). The
  // requires check is what keeps an Offer from installing authority behind a consent
  // row that only shows a name: `guest.requires` is where a bundle's reach is
  // written down, and this is the one place on the install path that reads it.
  if (!isChatApp(v.manifest)) return null;
  const mod = v.manifest.modules[0];
  const wasm = v.modules[0].wasm;
  if (!wasm || wasm.length === 0) return null;
  // `protocols` rides along because it is what the bundle will SERVE once admitted
  // (§12.10) — the same manifest read that gates the install answers "and what does it
  // take over", so the UI never re-parses the envelope to find out.
  return {
    app: v.manifest.app, moduleName: mod.name, moduleHash: bytesToHex(genesisHash(sodium, wasm)), wasm, authorPk: v.author,
    protocols: v.manifest.protocols ?? [],
  };
}

// Admit a bundle the user has already consented to. Calls the shared §12.4 installer,
// which verifies the bundle signatures, checks the admit gate, and stands the slot.
// Returns the UI AppRecord.
async function applyAppBundle(bundleBytes) {
  // Pre-peek metadata for the UI record: app_meta, ui, handler name, app label.
  const peeked = peekMeta(bundleBytes);
  if (!peeked) throw new Error("not a valid app bundle");
  const { meta, uiHtml } = await readWasmSections(peeked.wasm);
  if (!meta) throw new Error("bundle module has no app_meta");
  // The label this bundle installs under (§12.4) — a fact of the signed manifest, so the
  // page has it BEFORE the install, and the onInbound closure below just closes over it
  // rather than waiting for a handle to fill it in.
  const key = peeked.app;
  // Taking a standing label over takes its data and signing scope with it. The app's own
  // author shipping its next version is the one-click upgrade; a different author's
  // bundle under the same label is asked about by name.
  const standing = installedApps.get(key);
  if (standing && bytesToHex(standing.authorPk) !== bytesToHex(peeked.authorPk)
      && !confirm(`Replace ${standing.name} ${standing.version} with ${meta.name || peeked.app} ${meta.version || ""} ` +
        `by a different author (${bytesToHex(peeked.authorPk).slice(0, 12)}…)?`)) {
    throw new Error("replacing an app from a different author was declined");
  }

  const loaded = await shell.install(bundleBytes, {
    // Naming no predecessor takes a FREE label and refuses a standing one (§12.4), so a
    // bundle under a label already here — chat v1 → v2, or another author's chat — says
    // which slot it retires. The user's app row IS that question, and it is all that
    // separates a first install here from an upgrade.
    replaces: standing ? key : undefined,
    // Protocol routing (seedkernel §12.10): the render bytes ARE this app's own answer
    // to the frame it just served, and the installer that mounted it receives them right
    // here, off its own install — no second claim, and no 32-byte comparison against a
    // caller id. Painting them only when this app is the one currently shown in the
    // iframe is a plain equality against `key` above, because the page already knows
    // which app THIS install is.
    onInbound: (claim, from, answer) => {
      if (answer.length > 0 && key === activeAppKey) deliverRender(new Uint8Array(answer));
    },
  });

  const record = {
    id: peeked.app,
    key,
    /** The install's handle — the one loopback `invoke`, bound to this app's slot. */
    invoke: (arg) => loaded.invoke(arg),
    /** The manifest's signed claim (§12.10) — what this app serves when nothing
     *  later has taken the id over. The app row reads it against `shell.resolve`. */
    protocols: peeked.protocols,
    name: meta.name || peeked.app,
    version: meta.version || "",
    description: meta.description || "",
    authorPk: loaded.author.slice(),
    // Already-verified in peekMeta's verifyBundle call — reuse it rather than
    // re-hashing wasm bytes we just proved match this exact hash.
    bytesHash: hexToBytes(peeked.moduleHash),
    bundleBytes: bundleBytes.slice(),
    moduleName: peeked.moduleName,
    uiHtml,
  };
  installedApps.set(key, record);
  persistInstalledApps();
  renderAppList();
  return record;
}

// ── persistence ────────────────────────────────────────────────────────
// The packed bundle is the only piece of app state we need — the
// installed app and the uiHtml both derive from it. We keep them in sessionStorage so a reload
// within the same tab keeps the user's app set and lets transitive offers
// continue to work.
function persistInstalledApps() {
  try {
    const arr = [];
    for (const rec of installedApps.values()) {
      arr.push(Array.from(rec.bundleBytes));
    }
    sessionStorage.setItem(STORE + ".bundles", JSON.stringify(arr));
    // Nothing else to keep. The routing is a projection of the installed manifests
    // (§12.10), so the bundles above ARE it: restoring them restores what this node
    // serves, in the order it served them, with no second store to fall out of step.
    if (activeAppKey) sessionStorage.setItem(STORE + ".active", activeAppKey);
    else sessionStorage.removeItem(STORE + ".active");
  } catch {}
}

async function restoreInstalledApps() {
  let arr;
  try { arr = JSON.parse(sessionStorage.getItem(STORE + ".bundles") || "[]"); }
  catch { return; }
  if (!Array.isArray(arr)) return;
  // Replaying the bundles in the order they were stored reproduces the routing exactly:
  // each one lands on its own label and claims exactly what its manifest names, and a
  // contest with an already-restored app is refused rather than resolved by order
  // (§12.10). So there is nothing else to restore, and no order-dependent outcome to
  // reproduce beyond the list itself.
  for (const raw of arr) {
    try {
      const bundleBytes = new Uint8Array(raw);
      const peeked = peekMeta(bundleBytes);
      if (!peeked) continue;
      // A restored app cleared the consent gate when it was installed — wave it through.
      pendingApprovals.add(peeked.moduleHash);
      await applyAppBundle(bundleBytes);
    } catch (err) {
      shellPrint(`Could not restore an app: ${err.message}`, "err");
    }
  }
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
// An offer is a packed app bundle forwarded over a data channel on `offer/v1`, the
// offers app's own claim (browser/offers-app.js) — any peer who holds the bundle can
// forward it (transitive offer), and the manifest inside carries the original
// author's signature over the module hash, so the recipient still authenticates
// against the author (peekMeta verifies it).
//
// The relaying peer is identified by the AKE channel, not a signature — the frame is
// unsigned; the bundle's own manifest signature is the load-bearing authentication.
// `handleOffer` is reached two ways: fresh, off the offers app's `onInbound` (above),
// and replayed from its fs at boot (`restoreOffers`, below) — both hand it the exact
// same three things, because both read them off the same kind of record.
//
// Keyed by the offers app's OWN record key (`OFFERS_KEY_PREFIX + hex`, the blake2b-256
// of the whole blob) rather than the module hash: it is already the fs key the record
// lives under, so accepting or dismissing an offer can delete it with no second
// derivation.
const pendingOffers = new Map();   // recordKey → { bundleBytes, peeked, fromPkHex }

async function handleOffer(bundleBytes, fromPkHex, recordKey) {
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

  // Already running these exact bytes ⇒ nothing to offer. An update ships a new module
  // hash, so it still surfaces for consent (installs are consent-gated, §12.4); only a
  // redundant re-offer of what the user already has installed is dropped, so it never
  // shows a pointless Install row. The record stays in the offers app's fs either way —
  // the guest's own dedupe (browser/offers-app.js) already keeps it from growing on a
  // repeat delivery of the identical bytes.
  for (const rec of installedApps.values()) {
    if (rec.bytesHash && bytesToHex(rec.bytesHash) === moduleHash) return;
  }
  if (pendingOffers.has(recordKey)) return;
  pendingOffers.set(recordKey, {
    bundleBytes: bundleBytes.slice(),
    // Keep the fields buildOfferRow renders (author + module hash) plus the moduleHash
    // acceptOffer adds to pendingApprovals.
    peeked: { moduleHash, meta, authorPk, bytesHash },
    fromPkHex,
  });
  renderOfferList();
  if (!tabs.apps.btn.classList.contains("active")) tabs.apps.btn.classList.add("unread");
  shellPrint(
    `${fromPkHex.slice(0, 8)} offers app "${meta.name || meta.id}" — see the Apps tab.`, "sys");
}

/** Everything the offers app's fs already holds, replayed into the pending-offer list
 *  at boot. The slot's fs IS the record — not a closure's Map — so this is what makes a
 *  reload (on a backend that persists, unlike this demo's in-memory default) pick up an
 *  offer that arrived and was never dismissed or accepted. */
async function restoreOffers() {
  for (const key of await offersApp.fs.list(OFFERS_KEY_PREFIX)) {
    const record = await offersApp.fs.get(key);
    if (!record) continue;
    await handleOffer(record.subarray(32), bytesToHex(record.subarray(0, 32)), key);
  }
}

async function acceptOffer(recordKey) {
  const offer = pendingOffers.get(recordKey);
  if (!offer) return;
  pendingApprovals.add(offer.peeked.moduleHash);
  try {
    const rec = await applyAppBundle(offer.bundleBytes);
    pendingOffers.delete(recordKey);
    // The page holds the offers slot's host-side scoped fs view, so it deletes the
    // record directly — the guest never needed a delete grant of its own.
    offersApp.fs.delete(recordKey).catch(() => {});
    renderOfferList();
    shellPrint(`Installed ${rec.name} ${rec.version} from offer.`, "sys");
    setActiveApp(rec.key);
  } catch (err) {
    pendingApprovals.delete(offer.peeked.moduleHash);
    shellPrint(`Install from offer failed: ${err.message}`, "err");
    showAppsNotice(`Install from offer failed: ${err.message}`, "err");
  }
}

function dismissOffer(recordKey) {
  pendingOffers.delete(recordKey);
  offersApp.fs.delete(recordKey).catch(() => {});
  renderOfferList();
}

// ── sending ─────────────────────────────────────────────────────────────────
//
// Every outbound frame leaves through an APP's guest, because that is the only thing
// that can send: the host's driver holds sockets and no request face at all, and the
// network is the transport, reached by calling the id it claims (§12.10). So the shell asks
// an app it has installed to put the frame on the wire — a loopback `invoke` with the
// `send` op, whose argument the guest's `handle` reads (chat-app.js).
//
// `sender` is which app does the asking, and it is a real choice rather than a detail.
// For a chat frame it is the app that CLAIMS the protocol, so the app the message is
// about is the app that speaks; for an Offer — a bundle in transit, on a local service
// claim no peer can reach — it is the app being offered, which is by definition
// installed here.
/** One local op into `rec`'s app: the record's handle loops back through `handle`,
 *  with the host's caller id in front of THIS app's own op framing - composed by the
 *  seedkernel's op-frame (content, not host-seam metadata) and never read by it. The op NAME is
 *  the app's vocabulary. */
function appInvoke(rec, op, arg) {
  return rec.invoke(writeOp(op, arg));
}

function sendFrame(sender, peerId, proto, payload) {
  const protoBytes = new TextEncoder().encode(proto);
  const arg = new Uint8Array(32 + 1 + protoBytes.length + payload.length);
  arg.set(hexToBytes(peerId), 0);
  arg[32] = protoBytes.length;
  arg.set(protoBytes, 33);
  arg.set(payload, 33 + protoBytes.length);
  return appInvoke(sender, CHAT_OP_SEND, arg);
}

/** Fan one payload out to every linked peer, or to those it is for.
 *
 *  `among` narrows the fan-out to a room's members. `only` narrows it to one peer, a
 *  direct message, and is sent linked or not: the transport dials a contact it has an
 *  address for, and a peer it cannot reach is simply not reached.
 *
 *  `nickPrefix` is our current nick announcement, sent AHEAD of the payload to each peer
 *  that has not heard it yet (see lastSentNickBody). Once per peer, not once per message:
 *  chat v2 renders an announcement as a visible "… is now known as …" line, so re-sending it in
 *  front of every message would bury the conversation in its own presence traffic. A peer
 *  counts as told before the send, so `tellNick` does not tell it as well meanwhile.
 *
 *  The told-set is pruned against the peer list the TRANSPORT just answered with, which
 *  is what keeps this from being a peer mirror: nothing here observes a peer coming or
 *  going, and a peer that dropped and came back is simply absent from the set it is
 *  pruned against, so it is told again. */
async function broadcastToPeers(proto, payload, { nickPrefix = null, only = null, among = null } = {}) {
  const key = shell.resolve(proto);
  if (!key) return; // nothing installed claims this protocol — nothing to send with
  const sender = installedApps.get(key);
  if (!sender) return;
  const peers = await linkedPeers();
  pruneNickTold(peers);
  for (const peerId of only ? [only] : among ? peers.filter((p) => among.has(p)) : peers) {
    try {
      if (nickPrefix && !nickToldPeers.has(peerId)) {
        nickToldPeers.add(peerId);
        await sendFrame(sender, peerId, proto, nickPrefix);
      }
      await sendFrame(sender, peerId, proto, payload);
    }
    catch (err) { shellPrint(`send to ${peerId.slice(0, 8)} failed: ${err.message}`, "err"); }
  }
}

async function renderLocal(rec, payload) {
  const input = new Uint8Array(myPeerId.length + payload.length);
  input.set(myPeerId, 0);
  input.set(payload, myPeerId.length);
  // The local echo runs through the app's guest like an inbound frame does — the
  // guest `handle` forwards to the module by name (§12.2), under the
  // same seam a peer's request would take. Which means it can fail the same way,
  // so it reports rather than rejecting into a caller that has nowhere to put it.
  let render;
  try { render = await appInvoke(rec, CHAT_OP_RENDER, input); }
  catch (err) { shellPrint(`local echo failed: ${err.message}`, "err"); return; }
  if (render) deliverRender(new Uint8Array(render));
}

// Broadcast the stored bundle for `id` to every open peer. Anyone who receives
// this can forward it to others — that's transitivity for free.
async function offerApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  const linked = await linkedPeers();
  for (const peerId of linked) {
    // The offered app carries its own offer: `offer/v1` is the OFFERS BUNDLE's claim
    // (the app that would handle it is the thing being offered), so there is no app to
    // resolve it to — the one we know is installed is the one whose bytes are in the
    // frame. The sender is still the chat app regardless: the page has no send of its
    // own, only a guest can call `_net` (§12.10), and this is the guest already on hand.
    try { await sendFrame(rec, peerId, OFFER_PROTO, rec.bundleBytes); }
    catch (err) { shellPrint(`offer to ${peerId.slice(0, 8)} failed: ${err.message}`, "err"); }
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
  {
    const bId = document.createElement("b");
    bId.textContent = "id";
    meta.appendChild(bId);
    const vId = document.createTextNode(` ${rec.id} · `);
    meta.appendChild(vId);
    const bAu = document.createElement("b");
    bAu.textContent = "author";
    meta.appendChild(bAu);
    const vAu = document.createTextNode(` ${authorHex.slice(0, 8)} · `);
    meta.appendChild(vAu);
    const bWa = document.createElement("b");
    bWa.textContent = "wasm";
    meta.appendChild(bWa);
    const vWa = document.createTextNode(` ${bytesToHex(rec.bytesHash).slice(0, 12)}`);
    meta.appendChild(vWa);
  }
  li.appendChild(meta);

  // What this app SERVES (§12.10) — read, never set. The protocols are the manifest's
  // signed claim and the routing is the projection of every installed manifest, so this
  // row has nothing to offer the user but the truth: which ids this bundle claimed. An
  // installed app holds every one of them, because a claim changes hands only with the
  // slot.
  const protos = document.createElement("div");
  protos.className = "app-row-meta";
  const claimed = rec.protocols;
  if (claimed.length === 0) {
    const none = document.createElement("span");
    none.textContent = " claims no protocol — receives nothing";
    protos.appendChild(none);
  }
  for (const proto of claimed) {
    const span = document.createElement("span");
    span.className = "app-row-proto";
    const b = document.createElement("b");
    b.textContent = "serves";
    span.appendChild(b);
    span.appendChild(document.createTextNode(` “${proto}”`));
    protos.appendChild(span);
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
  if (!confirm(`Remove ${rec.name} ${rec.version}? The app will be uninstalled.`)) return;
  // Revocation (§12.5): uninstall drops the slot this label names — the protocols it
  // claimed and its guest realm.
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
  for (const [key, offer] of pendingOffers) {
    offerListEl.appendChild(buildOfferRow(key, offer));
  }
}

function buildOfferRow(key, offer) {
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
  ok.addEventListener("click", () => acceptOffer(key));
  const no = document.createElement("button");
  no.className = "icon";
  no.textContent = "Dismiss";
  no.addEventListener("click", () => dismissOffer(key));
  btns.appendChild(ok);
  btns.appendChild(no);
  li.appendChild(btns);
  return li;
}

// ── drag-drop + file picker plumbing ───────────────────────────────────
async function loadDroppedFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const peeked = peekMeta(bytes);
  if (!peeked) {
    const msg = "Not a valid app bundle (.skb)";
    shellPrint(msg, "err");
    showAppsNotice(msg, "err");
    return;
  }
  // Dropping a file IS the consent (§12.4) — the same one-shot approval the
  // (deleted) addAppFromWasm used to grant a just-built bundle, now granted to
  // whatever already-signed bundle the user picked.
  pendingApprovals.add(peeked.moduleHash);
  try {
    const record = await applyAppBundle(bytes);
    shellPrint(`Installed ${record.name} ${record.version}`, "sys");
    setActiveApp(record.key);
  } catch (err) {
    pendingApprovals.delete(peeked.moduleHash);
    shellPrint(`Install failed: ${err.message}`, "err");
    showAppsNotice(`Install failed: ${err.message}`, "err");
  }
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
    // The fresh page has not been told who is linked, which rooms there are, or been
    // heard on which conversation it has open.
    lastPeersKey = lastRoomsKey = null;
    openConv = undefined;
    postRoomsToApp();
    return;
  }

  // The conversation open in the app: a room, one peer, or none. A call started now is
  // with it (`callPeers`).
  if (msg.type === "conv") {
    openConv = msg.room ? { room: bytesToHex(new Uint8Array(msg.room)) }
      : msg.to ? { to: bytesToHex(new Uint8Array(msg.to)) } : null;
    return;
  }

  if (msg.type === "send" && typeof msg.chatType === "number" && msg.body) {
    const active = activeAppKey ? installedApps.get(activeAppKey) : null;
    if (!active) return;
    // Send under the protocol the active app CLAIMS (§12.10) — the same id its manifest
    // signed, so a peer routes the frame to whatever app it installed that claims the
    // same one, which may be a different author's implementation entirely. That is what
    // the id is for: it names the conversation, not the code.
    const proto = active.protocols[0];
    if (!proto) return;
    const body = msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body);
    const chatBytes = new Uint8Array(1 + body.length);   // [chatType][body]
    chatBytes[0] = msg.chatType & 0xff;
    chatBytes.set(body, 1);
    // A nick is this node's state, not one message: kept, echoed locally, and told to
    // every linked peer, now and as each one links (`tellNick`). A new one makes every
    // peer's copy stale, so nobody counts as told any more.
    if (msg.chatType === 0x02) {
      lastSentNickBody = { proto, body };
      nickToldPeers.clear();
      pageNickTold.clear();
      renderLocal(active, chatBytes);
      tellNick(await linkedPeers());
      return;
    }
    // The nick also rides in front of a chat message for a peer that has not heard it yet,
    // one that linked since the last poll, so it learns the name before it renders the
    // message. broadcastToPeers does the per-peer part.
    let nickPrefix = null;
    if (lastSentNickBody?.proto === proto) {
      nickPrefix = new Uint8Array(1 + lastSentNickBody.body.length);
      nickPrefix[0] = 0x02;
      nickPrefix.set(lastSentNickBody.body, 1);
    }
    // Fire-and-forget over Transport — one plane — to whom the message is for: one peer
    // (`to`) or a room's members (`room`). With neither it goes to every linked peer, which
    // is for an announcement like the nick, not for a message. A direct message makes its
    // addressee a contact, so the link to it outlives any shared room.
    const only = msg.to ? bytesToHex(new Uint8Array(msg.to)) : null;
    if (only && !contacts.has(only)) addContact(only, null);
    const among = msg.room ? membersOfRoom(bytesToHex(new Uint8Array(msg.room))) : null;
    broadcastToPeers(proto, chatBytes, { nickPrefix, only, among });
    // Local echo: run through the app's guest, render if active. Not awaited —
    // the echo is a view concern, and the send has already gone out; letting it
    // gate the lines below would make a guest failure also drop the presence
    // cache. `renderLocal` reports its own failure.
    renderLocal(active, chatBytes);
  }
});

// ---------------------------------------------------------------------------
// Networking: the page meets peers in a relay room; the transport bundle links to them
// through the relay and moves each link to WebRTC.
//
// The transport is the seedkernel-shipped signed bundle bootShell loaded: the channel
// AKE, record layer, link routing and request/response layer run as its confined
// guest program, driven by the shell's TransportHost, and so do the relay registration,
// the links through the relay, the move to WebRTC (signaled over the peer's authenticated
// link) and who offers; a WebRTC link that is lost is dialed again through the relay
// (§12.7). What net-rtc.ts contributes is the platform
// object: it holds each RTCPeerConnection and passes its negotiation through as bytes.
// Channel identity is the transport's in-channel HELLO/AUTH (§12.6),
// so any frame the driver hands to our sink is already attributed to an
// authenticated peer — `_from` is that peer's pubkey, which we treat as the
// message author. No per-message signature.
// ---------------------------------------------------------------------------

let lastSentNickBody = null;   // {proto, body} — this node's nick, as its chat app last set it
// The peers whose chat app already carries the nick above, and those whose page does: a
// page shows it in its Network tab, whatever chat app it runs (`tellNick`).
const nickToldPeers = new Set();
const pageNickTold = new Set();

/** Drop everyone the transport no longer counts as linked. This is the whole reason the
 *  told-sets are not a peer mirror: they hold no opinion about peers, they are only ever
 *  narrowed to an answer the transport guest gave — so a peer that dropped and came back
 *  (a reloaded tab keeps its id but starts with an empty nick table) is simply absent and
 *  gets told again. Run on every answer the page asks for, the status poll's included, so
 *  the window in which a returning peer looks already-told is one poll interval. */
function pruneNickTold(peers) {
  if (nickToldPeers.size === 0 && pageNickTold.size === 0) return;
  const linked = new Set(peers);
  for (const told of [nickToldPeers, pageNickTold]) {
    for (const id of told) if (!linked.has(id)) told.delete(id);
  }
}

/** Give each linked peer that has not heard it this node's nick. Its page is told on the
 *  pages' own channel, an empty nick for none, and shows it in its Network tab; its chat
 *  app is sent the announcement, so a peer that links after the nick was set has it
 *  without waiting for a message. A peer counts as told before the send, so nothing tells
 *  it twice. */
function tellNick(peers) {
  pruneNickTold(peers);
  const nick = lastSentNickBody ? new TextDecoder().decode(lastSentNickBody.body) : "";
  const signal = new TextEncoder().encode(JSON.stringify({ nick }));
  for (const peerId of peers) {
    if (pageNickTold.has(peerId)) continue;
    pageNickTold.add(peerId);
    void sendSignal(peerId, signal).catch(() => pageNickTold.delete(peerId));
  }
  if (!lastSentNickBody) return;
  const { proto, body } = lastSentNickBody;
  const key = shell.resolve(proto);
  const sender = key ? installedApps.get(key) : null;
  if (!sender) return;
  const frame = new Uint8Array(1 + body.length);
  frame[0] = 0x02;
  frame.set(body, 1);
  for (const peerId of peers) {
    if (nickToldPeers.has(peerId)) continue;
    nickToldPeers.add(peerId);
    void sendFrame(sender, peerId, proto, frame).catch(() => nickToldPeers.delete(peerId));
  }
}

// Nothing here reloads the transport bundle or replaces its sockets: the page says who it
// wants linked, and the transport links them, a peer at a time (`syncPeers`).
//
// `relaySecret` is a private relay's (seedrelay's `--secret`), or null for an open one. It
// is the relay operator's credential, so it never rides in a link that is shared.
// The room client and the transport each prove it with BLAKE2b, and never send it.

/** One op of the transport's. The page has nothing to do about one it refuses. */
function netOp(op) {
  const answer = shell.call(NET_PROTO, op.build());
  return answer ? answer.catch(() => {}) : Promise.resolve();
}

/** A room's name as people say it: without the random suffix "Random" gives one. */
function friendlyRoom(name) {
  return name.replace(/-[0-9a-f]{32}$/, "") || name;
}

/** Who the relay says is in the joined room with this id; nobody for a room not joined. */
function membersOfRoom(id) {
  for (const r of joinedRooms.values()) if (r.id === id) return r.members;
  return new Set();
}

/** The names of the joined rooms `key` is in. */
function roomsOf(key) {
  return [...joinedRooms].filter(([, r]) => r.members.has(key)).map(([name]) => name);
}

/** The joined rooms changed: keep them, show them, and bring the links in step. */
function roomsChanged() {
  sessionStorage.setItem("chat.rooms", JSON.stringify([...joinedRooms.keys()]));
  renderRoomList();
  syncPeers();
}

/** Be on the relay at `origin`: the room client in every joined room, and the transport
 *  registered there, so this node's key can be called. Answers the relay's state as
 *  `pollRelay` reads it. */
async function joinRelay(origin, relaySecret) {
  if (relay?.origin !== origin || relay.relaySecret !== relaySecret) {
    // The old relay's rooms are left, and their members heard leaving.
    relay?.client.close();
    const client = roomClient({
      relay: origin,
      publicKey: myKeys.publicKey,
      sign: (m) => sodium.crypto_sign_detached(m, myKeys.privateKey),
      ...(relaySecret ? { secret: relaySecret, blake2b: (m) => sodium.crypto_generichash(64, m) } : {}),
      onMember: onRoomMember,
      onRefused: (name) => {
        shellPrint(`Room ${friendlyRoom(name)} is full; try again later.`, "err");
        joinedRooms.delete(name);
        roomsChanged();
      },
    });
    relay = { origin, relaySecret, client };
    showRelayButton();
    for (const name of joinedRooms.keys()) await client.join(name);
    // Contacts are called through this relay now.
    syncPeers();
  }
  const op = new OpArgs("relay").text(origin);
  if (relaySecret) op.text(relaySecret);
  const answer = shell.call(NET_PROTO, op.build());
  if (!answer) throw new Error(`nothing claims ${NET_PROTO}`);
  return (await answer)[0];
}

/** Join the room `name`, beside any this page is already in. */
async function joinRoom(name) {
  if (joinedRooms.has(name)) return;
  joinedRooms.set(name, { id: await roomId(name), members: new Set() });
  roomsChanged();
  await relay?.client.join(name);
}

/** Leave one room, and hang up on everyone it was the only reason to be linked to. */
async function leaveRoom(name) {
  if (!joinedRooms.has(name)) return;
  const before = [...wanted.keys()];
  await relay?.client.leave(name);
  joinedRooms.delete(name);
  roomsChanged();
  hangUpUnwanted(before);
}

/** What a peer is shown as: the nick the app knows it by, or the start of its key. */
function peerLabel(key) {
  return peerNicks.get(key) ?? key.slice(0, 8);
}

/** Make `key` a contact, with its contact secret or null: linked whether or not a room is
 *  shared. A new one is told, once it is linked, so it is this node's peer at both ends;
 *  `tell: false` is for one that said so itself. */
function addContact(key, secret, { tell = true } = {}) {
  if (key === myPkHex) return;
  if (!contacts.has(key)) {
    if (tell) untoldPeers.set(key, true); else untoldPeers.delete(key);
  }
  leavingPeers.delete(key);
  contacts.set(key, secret);
  saveContacts();
  renderRoomList();
  syncPeers();
}

/** Stop `key` being a contact, and tell it, unless it said so itself. */
function removeContact(key, { tell = true } = {}) {
  const before = [...wanted.keys()];
  // One never told it was added has nothing to hear.
  const knows = untoldPeers.get(key) !== true;
  untoldPeers.delete(key);
  contacts.delete(key);
  saveContacts();
  renderRoomList();
  syncPeers();
  if (!tell || !knows) { hangUpUnwanted(before); return; }
  leavingPeers.add(key);
  void tellRemoved(key, before);
}

/** The notice one page sends another: it added it as a peer, or removed it. */
const peerNotice = (added) => new TextEncoder().encode(JSON.stringify({ peer: added }));

/** How long a peer told it was removed has to hang up, before this node does. The
 *  transport drops what is still queued on a link it closes, so a link closed right behind
 *  the notice would take the notice with it, and the peer would go on listing this node. */
const HANG_UP_GRACE_MS = 1500;

/** Tell `key` this node removed it, then hang up on those of `before` no longer wanted. One
 *  with no link is owed the notice until it has one (`tellPeers`): a send would dial it. */
async function tellRemoved(key, before) {
  let told = false;
  try {
    if ((await linkedPeers()).includes(key)) {
      await sendSignal(key, peerNotice(false));
      told = true;
    }
  } catch { /* not told: owed, below */ }
  if (told) await new Promise((r) => setTimeout(r, HANG_UP_GRACE_MS));
  else if (!contacts.has(key)) untoldPeers.set(key, false);
  leavingPeers.delete(key);
  hangUpUnwanted(before);
}

/** Send each linked peer the notice it is owed: that this node added it, or removed it. */
function tellPeers(linked) {
  for (const [key, added] of [...untoldPeers]) {
    if (!linked.includes(key)) continue;
    untoldPeers.delete(key);
    void sendSignal(key, peerNotice(added)).catch(() => {});
    if (added) continue;
    // A removed peer that linked again, still listing this node: it hangs up once it has
    // heard, and this node does after the grace.
    leavingPeers.add(key);
    setTimeout(() => { leavingPeers.delete(key); hangUpUnwanted([key]); }, HANG_UP_GRACE_MS);
  }
}

/** Close the links to those of `before` this page no longer wants. Only what the user did
 *  here hangs up, leaving a room or removing a contact: a peer merely heard leaving hangs
 *  up itself, and one whose relay dropped has not gone anywhere. */
function hangUpUnwanted(before) {
  for (const key of before) {
    if (!wanted.has(key)) void netOp(new OpArgs("forget").blob(hexToBytes(key)));
  }
}

// A key the room client heard join or leave a room. One that joins is waited for afresh.
function onRoomMember(room, key, present) {
  const r = joinedRooms.get(room);
  if (!r || key === myPkHex) return;
  if (present) { r.members.add(key); wanted.delete(key); }
  else r.members.delete(key);
  renderRoomList();
  syncPeers();
}

/** Bring the transport in step with who this page wants linked: its room-mates and its
 *  contacts. Room-mates are welcomed, so their calls need no contact secret, and every
 *  wanted peer gets its address. */
function syncPeers() {
  const mates = new Set();
  for (const r of joinedRooms.values()) for (const key of r.members) mates.add(key);
  void netOp(new OpArgs("welcome").blob(hexToBytes([...mates].join(""))));
  const want = new Set([...mates, ...contacts.keys()]);
  for (const key of [...wanted.keys()]) if (!want.has(key)) wanted.delete(key);
  for (const key of want) {
    if (!wanted.has(key)) wanted.set(key, { since: performance.now(), silent: false, late: false });
    teachPeer(key);
  }
  postRoomsToApp();
}

/** How long a wanted peer may stay unlinked before the wait for it is over: one this node
 *  calls then reads as `silent` and is left alone, and one that was to call is `late`.
 *  Just under the transport's handshake deadline, so a node that answers nothing, as one
 *  whose contact secret was not presented does, is called once. */
const CALL_PATIENCE_MS = 9000;

/** Whether this node calls `key`. It calls a contact, which may not know to call back. Of
 *  two room-mates the smaller key calls, so a pair dials once, and the larger one when the
 *  smaller is late. A peer that gave no answer is left alone until its row's Connect, or
 *  until it calls or joins a room again. */
function calls(key) {
  const w = wanted.get(key);
  if (!w || w.silent) return false;
  return contacts.has(key) || myPkHex < key || w.late;
}

/** What a call presents to a node with no contact secret, or to a room-mate, which
 *  welcomes this node: 32 zero bytes. Not an empty blob, which the transport reads as
 *  "present this node's own". */
const NO_SECRET = new Uint8Array(32);

/** Give the transport its address for `key`: the contact secret to present, and the relay
 *  to call it through. A key this node does not call has no destination, and none has one
 *  while this page is on no relay, which the transport then leaves alone (`ready` dials
 *  only what has one). */
function teachPeer(key) {
  const secret = roomsOf(key).length > 0 ? NO_SECRET : contacts.get(key) ?? NO_SECRET;
  void netOp(new OpArgs("addr").blob(hexToBytes(key)).blob(secret)
    .text(relay && calls(key) ? `relay+${relay.origin}` : ""));
}

/** A contact row's Connect: call `key` again, presenting what its field holds as the
 *  contact secret, or none for an empty one. */
function connectPeer(key, field) {
  const typed = field.value.trim().toLowerCase();
  if (typed !== "" && !HEX32_RE.test(typed)) {
    field.setCustomValidity("A contact secret is 64 hex characters.");
    field.reportValidity();
    return;
  }
  wanted.delete(key);
  addContact(key, typed === "" ? null : hexToBytes(typed));
}

/** Set this node's own contact secret, or with null open it to any caller. Links already
 *  up stay, and room-mates are answered either way. */
async function setMyContact(secret) {
  await setTransportContact(secret);
  myContactSecret = secret;
  if (secret) sessionStorage.setItem("chat.contactSecret", bytesToHex(secret));
  else sessionStorage.removeItem("chat.contactSecret");
  updateContactHint();
}

// Boot the app registry now that the shell exists: render the (empty) lists, then
// pull back anything installed earlier this session so a transitive Offer works the
// moment peers connect, from the saved signed bytes — and separately, replay whatever
// the offers app's own fs already holds (restoreOffers, "peer-to-peer app offers"
// above), since that record is the offer list's source of truth, not this session's
// installedApps.
renderAppList();
renderOfferList();
restoreInstalledApps().catch((err) =>
  shellPrint(`Restore failed: ${err.message}`, "err"));
restoreOffers().catch((err) =>
  shellPrint(`Could not replay stored offers: ${err.message}`, "err"));

// ─── live audio/video calls ────────────────────────────────────────────
//
// Calls ride peer connections of their own, one per peer in the call, through MediaCalls
// (./media-rtc.js), signaled over the calls boot bundle. A call is with the conversation
// open in the app when it starts: media.start publishes our camera/mic to that room's
// linked members, or to that one peer, and pollPeerViews keeps it following them (`callPeers`);
// endCall hangs up with every peer. Remote tracks arrive via the onTrack callback wired
// on `media` above and land in a per-peer tile keyed by pubkey hex; a tile is cleaned up
// when its track ends or its media connection closes.

const callBar      = document.getElementById("call-bar");
const callStartBtn = document.getElementById("call-start");
const callMuteBtn  = document.getElementById("call-mute");
const callEndBtn   = document.getElementById("call-end");
const callStatus   = document.getElementById("call-status");
const videoTiles   = document.getElementById("video-tiles");

let localStream = null;
let micEnabled = true;
const remoteTiles = new Map(); // pkHex -> { wrap, video, stream }
// The conversation open in the app, `{ room }` or `{ to }` by id in hex, null for none, and
// undefined for an app that never says. `callScope` is what it was when the call in
// progress started.
let openConv;
let callScope;

/** Who of the linked peers the call in progress is with: a room's members, or one peer.
 *  A call from an app that never says which conversation is open is with everyone linked. */
function callPeers(linked) {
  if (callScope === undefined) return linked;
  if (callScope === null) return [];
  if (callScope.to) return linked.filter((p) => p === callScope.to);
  const members = membersOfRoom(callScope.room);
  return linked.filter((p) => members.has(p));
}

async function updateCallStatus(peerCount) {
  if (!localStream) {
    // Not sending — but a peer that is shows up here anyway, so the bar says so, and the
    // button offers to join that call rather than to start one.
    const n = remoteTiles.size;
    callStartBtn.textContent = n > 0 ? "Join call" : "Start call";
    callStatus.textContent = n > 0 ? `receiving from ${n} peer${n === 1 ? "" : "s"}` : "idle";
    callBar.classList.toggle("idle", n === 0);
  } else {
    const n = peerCount ?? callPeers(await linkedPeers()).length;
    // Re-read after the await: a hang-up while the transport was answering means there is no
    // call to report on any more, and the idle branch above has already had the last word.
    if (!localStream) return;
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
  updateCallStatus();
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
  updateCallStatus();
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
  // Published to the open conversation's linked peers now, and to any of them that links
  // later (pollPeerViews).
  callScope = openConv;
  media.start(localStream.getTracks().map((track) => ({ track, stream: localStream })), callPeers(await linkedPeers()));
  const joined = remoteTiles.size > 0;
  updateCallStatus();
  shellPrint(joined ? "Joined the call." : "Call started.", "sys");
}

function endCall() {
  if (!localStream) return;
  media.end();
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
// Proactive ICE restart on a network change, for a call's media connections. ICE
// keepalives take 5–10s to notice a network flip on their own; kicking restartAllIce()
// the moment the browser tells us connectivity changed cuts straight to recovery. The
// transport restarts its own connections when they report `disconnected` (§12.7).
window.addEventListener("online", () => {
  shellPrint("Network online — restarting ICE", "sys");
  media.restartAllIce();
});
if (navigator.connection && typeof navigator.connection.addEventListener === "function") {
  navigator.connection.addEventListener("change", () => {
    shellPrint("Network changed — restarting ICE", "sys");
    media.restartAllIce();
  });
}

// Room names stay URL-safe identifier characters, length 1..128, so they read cleanly in
// the relay URL and room links; the relay itself sees only a hash of the name.
const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
// The room joined when none is named: where two tabs on a laptop meet.
const DEFAULT_ROOM = "global";

// The relay's origin, and the room a URL typed with a path names (lets them paste a full
// `ws://host:8080/my-room` URL in just the URL field if they prefer).
function parseRelay(base) {
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  return { origin: `${u.protocol}//${u.host}`, room: decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, "")) };
}

// The relay as last joined, for the status line and a reload: { base, url, relaySecret,
// joining }.
let relayJoin = null;

/** Whether `room` is a name a room can have, saying so when it is not. */
function roomNameOk(room) {
  if (ROOM_NAME_RE.test(room)) return true;
  shellPrint("Room name must match [A-Za-z0-9._-] (up to 128 chars).", "err");
  return false;
}

/** "Connect": be on the relay in the URL field, where this node's key can be called and
 *  its contacts reached, and in the rooms already joined. No room is needed for it; a URL
 *  typed with a path joins the room it names. */
async function connectRelay() {
  const base = relayUrlInput.value.trim();
  if (!base) { shellPrint("Enter a relay URL.", "err"); return; }
  const target = parseRelay(base);
  if (!target) { shellPrint("Relay URL must be ws:// or wss://.", "err"); return; }
  if (target.room && !roomNameOk(target.room)) return;
  const relaySecret = relaySecretInput.value.trim() || null;
  const join = relayJoin = { base, url: target.origin, relaySecret, joining: true };
  try {
    RTC_CONFIG.iceServers = [{ urls: `stun:${new URL(base).hostname}:${RELAY_STUN_PORT}` }];
    relayShown = -1;
    relayStatus.textContent = "connecting...";
    setRelayPill("connecting", "connecting");
    shellPrint(`Connecting to ${target.origin}...`, "sys");
    if (target.room) await joinRoom(target.room);
    const state = await joinRelay(target.origin, relaySecret);
    if (relayJoin !== join) return; // disconnected meanwhile, or connecting elsewhere
    join.joining = false;
    relayShown = state;
    showRelayState(state);
  }
  catch (err) {
    if (relayJoin !== join) return;
    join.joining = false;
    relayStatus.textContent = "error";
    setRelayPill("err", "relay error");
    shellPrint(`Relay connection failed: ${err?.message ?? err}`, "err");
  }
}

/** "Disconnect": be on no relay. The rooms keep their names for the next Connect, with
 *  nobody heard in them, so the links they were the reason for are closed; a contact
 *  already linked stays linked. */
async function disconnectRelay() {
  if (!relay) return;
  const before = [...wanted.keys()];
  const { client } = relay;
  relay = null;
  relayJoin = null;
  relayShown = 0;
  showRelayButton();
  // The room client hears every member leave as it closes (`onRoomMember`), and with no
  // relay a contact has no address to be called at.
  client.close();
  syncPeers();
  hangUpUnwanted(before);
  // A reload stays off the relay too.
  sessionStorage.removeItem("chat.relayUrl");
  sessionStorage.removeItem("chat.relaySecret");
  await netOp(new OpArgs("relay").text(""));
  showRelayState(0);
  shellPrint("Disconnected from the relay.", "sys");
}

/** The relay button is the way out while this page is on a relay, or trying to be. */
function showRelayButton() {
  relayConnectBtn.textContent = relay ? "Disconnect" : "Connect";
  relayConnectBtn.classList.toggle("primary", !relay);
}

// The relay link is the transport's, so its state is asked of the transport: 0 none
// joined, 1 registered, 2 dropped and redialing (seedkernel §12.6). Polled, and shown
// only when it changes; a join shows as connecting until the transport answers it with
// that state, once registered or once that attempt has failed.
let relayShown = -1;
async function pollRelay() {
  try {
    const answer = shell.call(NET_PROTO, new OpArgs("relayState").build());
    const state = answer ? (await answer)[0] : 0;
    if (state !== relayShown && !relayJoin?.joining) { relayShown = state; showRelayState(state); }
  } catch {}
  setTimeout(pollRelay, 1000);
}

/** The joined rooms in a few words, for the pill and the status line. */
function roomsLabel() {
  const names = [...joinedRooms.keys()].map(friendlyRoom);
  return names.length === 0 ? "no room" : names.length === 1 ? `room ${names[0]}` : `${names.length} rooms`;
}

/** Show the relay as connected: the pill names the rooms, or just says so with none. */
function showConnected() {
  relayStatus.textContent = `connected · ${roomsLabel()}`;
  setRelayPill("ok", joinedRooms.size === 0 ? "connected" : roomsLabel());
}

function showRelayState(state) {
  const current = relayJoin;
  if (!current || state === 0) {
    relayStatus.textContent = "disconnected";
    setRelayPill("off", "no relay");
    return;
  }
  const { base, url, relaySecret } = current;
  if (state === 1) {
    shellPrint(`Relay link up — ${roomsLabel()}.`, "sys");
    showConnected();
    // Remember the relay so a reload picks it, and the rooms, back up automatically.
    sessionStorage.setItem("chat.relayUrl", base);
    // The relay secret belongs to the relay, so it is saved and cleared with the relay.
    if (relaySecret) sessionStorage.setItem("chat.relaySecret", relaySecret);
    else sessionStorage.removeItem("chat.relaySecret");
  } else {
    relayStatus.textContent = "unreachable — retrying";
    setRelayPill("err", "relay down");
    // A private relay drops a node without its secret, which reads here as unreachable.
    shellPrint(`Relay unreachable — is one running at ${url}, and if it is private, is the relay secret right? ` +
      "Retrying; existing P2P links are unaffected.", "err");
  }
}

/** "Join": be in the room typed, or the default one with none typed, beside any already
 *  joined. A page on no relay yet connects to the one in the URL field as well. */
async function joinTypedRoom() {
  const room = relayRoomInput.value.trim() || DEFAULT_ROOM;
  if (!roomNameOk(room)) return;
  try {
    shellPrint(`Joining room ${friendlyRoom(room)}...`, "sys");
    await joinRoom(room);
    relayRoomInput.value = "";
  }
  catch (err) {
    shellPrint(`Could not join room ${friendlyRoom(room)}: ${err?.message ?? err}`, "err");
    return;
  }
  if (!relay) await connectRelay();
}

pollRelay();
relayConnectBtn.addEventListener("click", () => (relay ? disconnectRelay() : connectRelay()));
roomJoinBtn.addEventListener("click", joinTypedRoom);
for (const [field, act] of [[relayUrlInput, connectRelay], [relaySecretInput, connectRelay], [relayRoomInput, joinTypedRoom]]) {
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); act(); }
  });
}

// The Network tab's room list: each joined room with who else is in it, a link to share it
// by, and the way out of it.
function renderRoomList() {
  roomListEl.replaceChildren();
  if (joinedRooms.size === 0) {
    const li = document.createElement("li");
    li.className = "empty-row";
    li.textContent = "No room joined.";
    roomListEl.appendChild(li);
  }
  for (const [name, r] of joinedRooms) {
    const li = document.createElement("li");
    li.className = "peer-row room-row";
    const label = document.createElement("span");
    label.className = "peer-row-id";
    label.textContent = friendlyRoom(name);
    label.title = name;
    const count = document.createElement("span");
    count.className = "peer-row-where";
    count.textContent = r.members.size === 0 ? "no other peers"
      : r.members.size === 1 ? "1 other peer" : `${r.members.size} other peers`;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon";
    copy.textContent = "Copy link";
    copy.addEventListener("click", () => void copyOrPrint(roomLink(name),
      `Link to room ${friendlyRoom(name)} copied. Anyone with it can join.`, "link"));
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "icon";
    leave.textContent = "Leave";
    leave.addEventListener("click", () => void leaveRoom(name));
    li.append(label, count, copy, leave);
    // Who they are, a line each under the room. One that is not a contact yet is made one
    // from here, and is then in the peer list.
    if (r.members.size > 0) {
      const members = document.createElement("div");
      members.className = "room-members";
      for (const key of [...r.members].sort()) {
        const member = document.createElement("div");
        member.className = "room-member";
        const id = document.createElement("span");
        id.className = "peer-row-id";
        id.textContent = peerLabel(key);
        id.title = key;
        member.appendChild(id);
        if (!contacts.has(key)) {
          const add = document.createElement("button");
          add.type = "button";
          add.className = "icon";
          add.textContent = "Add peer";
          add.title = "Make this peer a contact: stay linked whether or not you share a room.";
          add.addEventListener("click", () => addContact(key, null));
          member.appendChild(add);
        }
        members.appendChild(member);
      }
      li.appendChild(members);
    }
    roomListEl.appendChild(li);
  }
  if (relay && relayShown === 1) showConnected();
}

// ── Links: a room to meet in, a contact to reach ─────────────────────────────
//
// A room link is `#room=<name>`. The name is all there is to a room, so whoever has the
// link can join it, and a room meant to stay private wants a name nobody can guess, which
// "Random" gives it. A contact link is `#pk=<key>` and, from a node with a contact secret,
// `&s=<secret>`: how to reach one node directly. Both ride in the URL fragment (`#`),
// which browsers never put on the wire, so the relay learns neither a room's name nor a
// secret from a link.

/** Read `room=<name>` and `pk=<64 hex>[&s=<64 hex>]` from a link, or from its fragment. */
function parseLink(text) {
  const q = new URLSearchParams(text.slice(text.indexOf("#") + 1));
  const room = q.get("room") ?? "";
  const pk = (q.get("pk") ?? "").toLowerCase(), s = (q.get("s") ?? "").toLowerCase();
  return {
    room: ROOM_NAME_RE.test(room) ? room : undefined,
    contact: HEX32_RE.test(pk) ? { key: pk, secret: HEX32_RE.test(s) ? hexToBytes(s) : null } : undefined,
  };
}

const pageUrl = () => location.origin + location.pathname + location.search;
const roomLink = (name) => `${pageUrl()}#${new URLSearchParams({ room: name })}`;
/** This node's contact link: its key, and its contact secret when it has one. */
function contactLink() {
  const q = new URLSearchParams({ pk: myPkHex });
  if (myContactSecret) q.set("s", bytesToHex(myContactSecret));
  return `${pageUrl()}#${q}`;
}

/** Say what this node's contact secret does, since a caller without it has no error path —
 *  it is simply a peer that never links. */
function updateContactHint() {
  contactHint.innerHTML = myContactSecret
    ? "Someone who is not in a room with you must present this node's <strong>contact secret</strong> " +
      "to connect. <strong>Copy contact link</strong> carries it, with your key."
    : "This node has <strong>no contact secret</strong>: anyone on the relay who has its key can connect. " +
      "Set one to answer only your room-mates and whoever you give it to.";
}

// "Random": a room nobody can guess. A room's name is all it takes to join it, so a private
// one wants 16 random bytes (seedrelay's README). They follow the name typed, which is how
// the room is shown. Lowercase hex so it round-trips through case-insensitive copy paths
// (URLs, chat clients) unchanged.
relayNewRoomBtn.addEventListener("click", () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const name = friendlyRoom(relayRoomInput.value.trim()).slice(0, 95) || "room";
  relayRoomInput.value = `${name}-${bytesToHex(bytes)}`;
  shellPrint("Private room name minted — press Join, then share its link.", "sys");
  relayRoomInput.focus();
});

/** Copy `text`, or failing that print it. Clipboard access can be denied or absent
 *  (file://, older browsers), so fall back to the shell log, where it can still be
 *  selected by hand — never leave the user with a button that silently does nothing. */
async function copyOrPrint(text, copied, what) {
  try {
    await navigator.clipboard.writeText(text);
    shellPrint(copied, "sys");
  } catch {
    shellPrint(`Copy failed — here is the ${what}: ${text}`, "sys");
  }
}

/** Apply what the contact secret field holds: 64 hex characters, or nothing for none. */
async function applyContactField() {
  const typed = contactInput.value.trim().toLowerCase();
  if (typed !== "" && !HEX32_RE.test(typed)) {
    contactInput.setCustomValidity("A contact secret is 64 hex characters, or empty for none.");
    contactInput.reportValidity();
    return;
  }
  try { await setMyContact(typed === "" ? null : hexToBytes(typed)); }
  catch (err) { shellPrint(`Could not set the contact secret: ${err.message}`, "err"); }
}
contactInput.addEventListener("input", () => contactInput.setCustomValidity(""));
contactInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); void applyContactField(); }
});
contactSetBtn.addEventListener("click", () => void applyContactField());
contactNewBtn.addEventListener("click", () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  contactInput.value = bytesToHex(bytes);
  void applyContactField();
});
contactCopyBtn.addEventListener("click", () => void copyOrPrint(contactLink(), myContactSecret
  ? "Contact link copied — it carries this node's key and contact secret. Anyone with it can connect to you."
  : "Contact link copied — this node's key; it has no contact secret.", "link"));

/** "Add peer", under the peer list: a contact link, or a key with its contact secret beside
 *  it if it has one. */
function addContactFromFields() {
  const typed = contactAddInput.value.trim();
  const linked = parseLink(typed).contact;
  const key = linked ? linked.key : typed.toLowerCase();
  const secret = contactAddSecretInput.value.trim().toLowerCase();
  const refuse = (field, why) => { field.setCustomValidity(why); field.reportValidity(); };
  if (!HEX32_RE.test(key)) return refuse(contactAddInput, "A contact is a contact link, or a key of 64 hex characters.");
  if (key === myPkHex) return refuse(contactAddInput, "That is this node's own key.");
  if (secret !== "" && !HEX32_RE.test(secret)) return refuse(contactAddSecretInput, "A contact secret is 64 hex characters.");
  wanted.delete(key);
  addContact(key, secret !== "" ? hexToBytes(secret) : linked?.secret ?? null);
  contactAddInput.value = contactAddSecretInput.value = "";
  shellPrint(`Contact ${key.slice(0, 8)} added.`, "sys");
}
contactAddBtn.addEventListener("click", addContactFromFields);
for (const field of [contactAddInput, contactAddSecretInput]) {
  field.addEventListener("input", () => field.setCustomValidity(""));
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addContactFromFields(); }
  });
}

// Default relay URL: same host the page is loaded from (so phones loading
// the shell off a desktop's LAN IP get the right pre-fill out of the box).
// An HTTPS page may open only wss://, so it names its own origin: the proxy that serves
// it over TLS fronts the relay too (seedrelay's droplet script sets both up under one
// name). Otherwise ws:// on the relay's own port; user can override to wss://.
// Falls back to "localhost" on file:// where location.hostname is empty.
function defaultRelayUrl() {
  if (location.protocol === "https:") return `wss://${location.host}`;
  const host = location.hostname || "localhost";
  return `ws://${host}:8080`;
}

// Auto-reconnect to the last relay that successfully accepted us, in the rooms we were
// in. This is the other half of the reload story: rejoining a room announces our key to
// its members, and the transport links each of them with our new tab.
const savedRelayUrl = sessionStorage.getItem("chat.relayUrl");
const savedRelaySecret = sessionStorage.getItem("chat.relaySecret");
relayUrlInput.value = savedRelayUrl || defaultRelayUrl();
if (savedRelaySecret) relaySecretInput.value = savedRelaySecret;
if (myContactSecret) contactInput.value = bytesToHex(myContactSecret);
let savedRooms = [];
try { savedRooms = JSON.parse(sessionStorage.getItem("chat.rooms") ?? "[]"); } catch {}

// A link that was followed: its room is joined beside the saved ones, and its contact
// added. Nothing of it stays in the address bar, a contact secret least of all.
const followed = parseLink(location.hash);
if (followed.room) {
  savedRooms.push(followed.room);
  shellPrint(`Room link: ${friendlyRoom(followed.room)}.`, "sys");
}
if (followed.contact && followed.contact.key !== myPkHex) {
  if (!contacts.has(followed.contact.key)) untoldPeers.set(followed.contact.key, true);
  contacts.set(followed.contact.key, followed.contact.secret);
  saveContacts();
  shellPrint(`Contact link: ${followed.contact.key.slice(0, 8)}` +
    (followed.contact.secret ? ", with its contact secret." : "."), "sys");
}
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
for (const name of savedRooms) {
  if (typeof name === "string" && ROOM_NAME_RE.test(name)) joinedRooms.set(name, { id: await roomId(name), members: new Set() });
}
updateContactHint();
roomsChanged();
if (savedRelayUrl) connectRelay();

// Presentation-only polling: authenticated peer truth stays in the transport guest. The
// page asks for the current set to render counts and routes; it never mirrors transitions or
// drives reconnection/fan-out from a client-side Set.
// The linked set and the contacts, handed to the app's page so it can offer a direct chat
// with someone who has not spoken yet. Presentation only, like the pill: posted when
// either changes.
let lastPeersKey = null;
function postPeersToApp(peers) {
  const key = [...peers].sort().join(",") + "|" + [...contacts.keys()].sort().join(",");
  if (!iframeReady || !frame.contentWindow || key === lastPeersKey) return;
  lastPeersKey = key;
  frame.contentWindow.postMessage(
    { type: "peers", peers: peers.map(hexToBytes), contacts: [...contacts.keys()].map(hexToBytes) }, "*");
}

// The joined rooms and who the relay says is in each, handed to the app's page: it files a
// room message under its room, and drops one whose sender is not in that room. Posted when
// they change.
let lastRoomsKey = null;
function postRoomsToApp() {
  const key = JSON.stringify([...joinedRooms].map(([name, r]) => [name, [...r.members].sort()]));
  if (!iframeReady || !frame.contentWindow || key === lastRoomsKey) return;
  lastRoomsKey = key;
  frame.contentWindow.postMessage({
    type: "rooms",
    rooms: [...joinedRooms].map(([name, r]) =>
      ({ id: hexToBytes(r.id), name: friendlyRoom(name), members: [...r.members].map(hexToBytes) })),
  }, "*");
}

async function pollPeerViews() {
  // A failed tick is swallowed rather than logged: this runs every 750ms, and the next
  // one either succeeds or the pill simply keeps its last value. What must NOT happen is
  // the reschedule being skipped — that would freeze the pill for the tab's life.
  try {
    const routes = await peerRoutes();
    const peers = routes.map((r) => r.id);
    // A wanted peer this node calls (`calls`) and has no link to is dialed: `ready` dials
    // every address the transport holds a destination for. One that has not linked within
    // CALL_PATIENCE_MS is silent, and left alone until its row's Connect, or until it
    // calls or joins a room again. A room-mate that was to call and has not is late, and
    // this node then calls it instead.
    const t = performance.now();
    let dial = false;
    for (const [key, w] of wanted) {
      if (peers.includes(key)) { w.since = null; w.silent = w.late = false; continue; }
      w.since ??= t;
      const waited = t - w.since >= CALL_PATIENCE_MS;
      if (calls(key)) {
        if (!waited) dial = true;
        else { w.silent = true; teachPeer(key); }
      } else if (waited && !w.silent) {
        w.late = true;
        w.since = t;
        teachPeer(key);
      }
    }
    if (dial && relay) void netOp(new OpArgs("ready").u32(0));
    tellPeers(peers);
    updatePeerPill(routes);
    renderPeerList(routes);
    tellNick(peers);
    postPeersToApp(peers);
    postRoomsToApp();
    media.sync(callPeers(peers));
    if (localStream) await updateCallStatus(callPeers(peers).length);
  } catch {}
  setTimeout(pollPeerViews, 750);
}
pollPeerViews();
updateCallStatus();
