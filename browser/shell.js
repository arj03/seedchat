// seedkernel is a dependency, not a sibling directory. Every specifier below is
// a *published* entry point of seedkernel-wasm (its package.json "exports"), so
// this file can only reach what seedkernel has deliberately made public — the
// import map in shell.html resolves them to the vendored build. If a future
// seedkernel change breaks the shell, it broke a public export, which is the point.
import sodium from "seedkernel-wasm/libsodium";
// bootShell is the assembly itself (§12.8): platform members defaulted, the
// transport bundle pinned to its own author, the channel adapter built from the
// `transport` options passed to it. The page's admit is then ONLY its consent gate —
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
// The shell's own code. media-rtc.js is the call feature: audio and video ride peer
// connections this page owns, signaled through the shell boot bundle below.
import { MediaCalls } from "./media-rtc.js";
// The contract with the apps this shell hosts: what it reads off a bundle, what it lets one
// reach, and the two ops it calls on an app's guest. Nothing in it, or in this file, knows
// what any one app does.
import { APP_GRANTS, APP_OP_CONTEXT, APP_OP_UI, NET_PROTO, appFacts, bundleDigest, contextJson } from "./app-api.js";
// What keeps a view off the network: the page an app's view is loaded as.
import { guardView } from "./view-guard.js";
// The offers app: a second boot bundle, loaded right below alongside the transport —
// see "boot the offers app" further down for why a bundle rather than a page-held name.
import { OFFERS_KEY_PREFIX, OFFERS_OP_SEND } from "./offers-app.js";
import { offersBundleBytes, OFFERS_AUTHOR_HEX, OFFERS_APP } from "./offers-bundle.js";
// The shell app: a third boot bundle, how this page talks to a peer's. What each tells the
// other about itself rides one of its claims, and a call's signaling the other.
import { CALL_PROTO, SHELL_OP_TELL, SHELL_OP_SIGNAL } from "./shell-app.js";
import { shellBundleBytes, SHELL_AUTHOR_HEX, SHELL_APP } from "./shell-bundle.js";

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
const nickInput = document.getElementById("nick");
const nickSetBtn = document.getElementById("set-nick");
const relayStatus = document.getElementById("relay-status");
const peerListEl = document.getElementById("peer-list");
const appStatus = document.getElementById("app-status");
const appPanel = document.getElementById("panel-app");
const diagnostics = appPanel.querySelector("details.diagnostics");
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
  // App tab via the toolbar shortcut, surface the result where they'll see it.
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

/** The most lines Diagnostics keeps. A view whose calls fail and a peer whose frames are
 *  refused each print one, and neither should be able to make this page grow without end. */
const MAX_LOG_LINES = 500;

function shellPrint(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  shellLog.appendChild(line);
  while (shellLog.childElementCount > MAX_LOG_LINES) shellLog.firstElementChild.remove();
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
// runs. `pendingApprovals` holds the digests of the bundles the user has consented to
// (`bundleDigest`, app-api.js: the whole bundle, guest included); the shell's `admit`
// callback consumes one (one-shot) on install. The shell runs under an open policy, so
// consent — not a static author allow-list — is this shell's gate.
const pendingApprovals = new Set();
/** The one system hash (seedkernel's BLAKE2b-256), with its crypto bound. */
const digest = (bytes) => genesisHash(sodium, bytes);
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
// The linked peers, by key in hex, as the last poll heard them of the transport: what the
// apps are told is linked (`postContext`). Presentation only, like the peer pill.
let linkedNow = [];
// What each peer calls itself, by key in hex: its nick, shown in the Network tab's lists in
// place of the key, and told to every app (`contextNow`). A peer's own word for itself.
const peerNicks = new Map();
/** The longest nick kept, a peer's or this node's. */
const MAX_NICK = 32;
// What this node calls itself: its nick, or "" for none. Kept with the identity.
let myNick = (sessionStorage.getItem("shell.nick") ?? "").slice(0, MAX_NICK);
// The notices peers are owed, by key in hex: true for one this node added, false for one
// it removed. Each is sent once its peer is linked (`tellPeers`).
const untoldPeers = new Map();
// Peers this node removed and is about to hang up on, by key in hex: no longer listed.
const leavingPeers = new Set();

// ─── per-tab Ed25519 identity ──────────────────────────────────────────
let myKeys;
// FIXME: this is just a demo
const stored = sessionStorage.getItem("shell.identity");
if (stored) {
  const parsed = JSON.parse(stored);
  myKeys = {
    publicKey:  new Uint8Array(parsed.pk),
    privateKey: new Uint8Array(parsed.sk),
  };
} else {
  const kp = sodium.crypto_sign_keypair();
  myKeys = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  sessionStorage.setItem("shell.identity", JSON.stringify({
    pk: Array.from(kp.publicKey),
    sk: Array.from(kp.privateKey),
  }));
}
const myPkHex = bytesToHex(myKeys.publicKey);

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
const savedContact = sessionStorage.getItem("shell.contactSecret");
let myContactSecret = savedContact && HEX32_RE.test(savedContact) ? hexToBytes(savedContact) : null;
const contacts = new Map();
try {
  for (const [key, secret] of Object.entries(JSON.parse(sessionStorage.getItem("shell.contacts") ?? "{}"))) {
    if (HEX32_RE.test(key)) contacts.set(key, HEX32_RE.test(secret) ? hexToBytes(secret) : null);
  }
} catch {}

function saveContacts() {
  sessionStorage.setItem("shell.contacts",
    JSON.stringify(Object.fromEntries([...contacts].map(([k, s]) => [k, s ? bytesToHex(s) : ""]))));
}

// The tab's sockets, standing before the transport: bootShell registers its accept sink
// while starting it, and RtcNetwork announces every data channel through that sink. The
// transport itself opens the relay (a WebSocket), links through it, and drives the peer
// connections.
const net = combineChannels(new WsNetwork(), new RtcNetwork());

// Assemble the shared shell now that the identity exists — via bootShell, the ONE
// assembly (§12.8). The platform is a browser seam: sodium, our identity, a
// WebAssembly-backed module builder, an in-memory freshness store — all defaulted by
// bootShell — and the channel adapter, which bootShell CONSTRUCTS from the `transport`
// options (identity taken from the top-level fields, never restated) and returns with
// the shell. The adapter is the platform's: link ids and sockets. Transport policy belongs
// to the signed bundle, and so does the address book — it lives in that bundle's own realm
// now (§12.10), and the page writes nothing to it: a peer here is met in the relay room the
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
// app's, and each installed app's — is bootShell's default (safe-js), imported lazily on
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
  // The transport asks the relay a peer is linked through for STUN (§12.7). A room
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
    if (bytesToHex(v.author) === SHELL_AUTHOR_HEX && v.manifest.app === SHELL_APP) return true;
    // Every other bundle is an app the user consented to, named by the digest of all of it:
    // a consent to one guest admits no other beside the same module.
    const hash = bytesToHex(bundleDigest(v, digest));
    if (!pendingApprovals.has(hash)) return false;
    pendingApprovals.delete(hash);
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
// transport, separately because it is the page's own pinned boot bundle rather than part
// of bootShell's transport assembly. It owns `offer/v1` both ways: a peer's offer arrives
// through it, and this node's own leave through its `send` op (`offerApp`).
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

// ─── boot the shell app ─────────────────────────────────────────────────
//
// What this page says to a peer's rides the node's own authenticated channel, under the
// two claims the shell boot bundle holds (shell-app.js). A peer's frame reaches the page as
// that load's `onInbound` answer, attributed by the channel it arrived on and told apart by
// the claim it arrived under; ours leave through the same app's two ops, since only a guest
// can reach `_net`.
//
//   shell/v1   what a page tells another about itself (`onPageNotice`): `{ peer: true }`
//              from a page that added this node as a peer and `{ peer: false }` from one
//              that removed it, and `{ nick }`, what a peer calls itself.
//   call/v1    a call's signaling. Its audio and video ride peer connections this page owns
//              (media-rtc.js), beside the transport's.
const shellApp = await shell.install(shellBundleBytes(), {
  onInbound: (claim, from, answer) => {
    if (answer.length === 0) return;
    if (claim === CALL_PROTO) void media.onSignal(bytesToHex(from), answer);
    else onPageNotice(bytesToHex(from), answer);
  },
});

/** Hand `bytes` to a peer's page through one of the shell app's two ops, each of which
 *  sends under one of its protocols. */
function sendPage(op, peerId, bytes) {
  const arg = new Uint8Array(32 + bytes.length);
  arg.set(hexToBytes(peerId), 0);
  arg.set(bytes, 32);
  return shellApp.invoke(writeOp(op, arg));
}

/** Tell a peer's page something about this one, under shell/v1. */
function tellPage(peerId, notice) {
  return sendPage(SHELL_OP_TELL, peerId, notice);
}

/** Send a peer's page one signal of a call, under call/v1. */
function sendSignal(peerId, signal) {
  return sendPage(SHELL_OP_SIGNAL, peerId, signal);
}

/** What a peer's page tells this one about itself, already attributed by the channel it
 *  arrived on. A peer that added this node is added here too, and one that removed it is
 *  removed, so the two ends agree on being peers. */
function onPageNotice(from, bytes) {
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  // What the peer calls itself, an empty nick for nothing: shown in place of its key, by
  // this page and by every app.
  if (typeof msg?.nick === "string") {
    if (msg.nick) peerNicks.set(from, msg.nick.slice(0, MAX_NICK)); else peerNicks.delete(from);
    renderRoomList();
    postContext();
    return;
  }
  if (typeof msg?.peer !== "boolean") return;
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
  onCallers: () => callersChanged(),
  onPeerClosed: (peerId) => {
    removeRemoteTile(peerId);
    updateCallStatus();
  },
  onTrack: (peerId, track) => {
    const tile = getOrCreateRemoteTile(peerId);
    // A track its peer turned off and on again is announced again.
    if (tile.stream.getTracks().includes(track)) return;
    tile.stream.addTrack(track);
    const draw = () => drawTile(tile.wrap, tile.stream);
    track.addEventListener("mute", draw);
    track.addEventListener("unmute", draw);
    track.addEventListener("ended", () => {
      try { tile.stream.removeTrack(track); } catch {}
      if (tile.stream.getTracks().length === 0) removeRemoteTile(peerId);
      else draw();
    });
    draw();
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
// its room's list instead (`renderRoomList`). A row names the peer, by its nick if it has
// told one, and says how it is reached, or how the call to it stands. A contact with
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
// An "app" is an ordinary signed bundle (§12.4): a signed manifest, the app's guest
// program and its WASM modules in one blob. That blob IS the bundle format — the same
// bytes seedstore's flagship deployment loads from disk, so an app here needs no install
// format of its own. The shell's `install` (the shared install path) authenticates the
// author's signatures over the whole body, so the blob survives any number of transitive
// relays and still authenticates against its original author — exactly the
// store-and-forward property an Offer needs. The local "add app" flow and the
// peer-to-peer Offer below carry the identical bundle.
//
// What this shell READS of an app is in its signed manifest (`appFacts`, app-api.js): its
// name and version for a row, the protocols it claims and what it reaches for the consent
// that row asks, and its view, an HTML page. The manifest's `app` is the label, and it is
// also the key the app lands under (seedkernel §12.4): one slot per label on a node,
// whoever authored it.
//
// What an app DOES is its guest's, and the shell never reads it. Three things reach a
// guest, each as bytes: a peer's frame under a protocol the app claims, with the sender
// the channel authenticated in front; the node's context; and whatever the app's own view
// sent. Each answer goes to the view: render bytes, or the answer to the view's own call.
// So the format of a frame, of a render and of what a view asks its guest are all the
// app's own, and an app changes them by shipping a new bundle, with nothing here to change
// beside it.
//
// The key is node-local. Two peers need not agree on it: a frame carries a *protocol
// id*, and each side resolves that to whichever app it installed that claims it — so two
// peers running different authors' apps interoperate as long as both speak the protocol.
//
// `installedApps` keeps the per-app state: the handle into its guest, its view, and the
// packed bundle (`bundleBytes` is the signed blob — the author's manifest signature
// intact — and is what every "Offer" hands to a peer). Apps received via Offer keep the
// original author's signature: we never re-sign a bundle.
// Keyed by the app label — the key the host installs a slot under (§12.4). A node holds
// one slot per label, so two authors' apps under one label contend for it: the second
// lands only by replacing the first.
const installedApps = new Map();   // app label → AppRecord
// The app shown in the App tab, by label, or null. Every installed app runs; this is only
// whose view is in front.
let activeAppKey = null;

// Protocol routing (§12.10) — there is no table here and no bind button. A bundle's
// manifest CLAIMS its protocols, and the load that admits it is what routes each id to
// it. A claim has one holder, so an app claiming an id another app holds lands only by
// replacing it. `shell.resolve` answers who holds one; the Apps panel reads the claim off
// the manifest rather than storing anything.

const STORE = "apps.v2";

// ── an app's guest ──────────────────────────────────────────────────────
//
// The shell's two ops into a guest (app-api.js), and nothing else: `ctx`, the node's
// context, and `ui`, bytes from the app's own view. Messages ride the Transport request
// plane under the protocol the app claims, and reach the guest without the shell seeing
// them; there is no app-specific framing here at all.

/** One local op into `rec`'s guest: the install's handle loops back through `handle`,
 *  with the host's caller id in front of the op, framed by seedkernel's op-frame. The op
 *  NAME is the contract's; the bytes behind it are the app's. */
function invokeApp(rec, op, bytes) {
  return rec.invoke(writeOp(op, bytes));
}

/** The node's context, as every app's guest is told it (`contextJson`, app-api.js): who
 *  this node is and what it calls itself, its rooms and who the relay says is in each, the
 *  linked peers, the contacts, and what each peer calls itself. All of it is the shell's
 *  to know, and none of it is a secret: a contact's secret stays here. */
function contextNow() {
  return contextJson({
    me: myPkHex,
    nick: myNick,
    rooms: [...joinedRooms].map(([name, r]) =>
      ({ id: r.id, name: friendlyRoom(name), members: [...r.members].sort() })),
    linked: [...linkedNow].sort(),
    contacts: [...contacts.keys()].sort(),
    nicks: Object.fromEntries([...peerNicks].sort(([a], [b]) => (a < b ? -1 : 1))),
  });
}

/** Tell one app's guest the context, and hand its view the answer. */
async function tellContext(rec, json) {
  rec.ctx = json;
  try {
    deliverRender(rec, await invokeApp(rec, APP_OP_CONTEXT, new TextEncoder().encode(json)), { isContext: true });
  }
  catch (err) { shellPrint(`${rec.name}: ${err.message}`, "err"); }
}

/** Tell every app whose guest has not heard the context as it now stands. Called wherever
 *  it may have changed: a room joined or left, a member heard, a contact added, a peer
 *  linked, a nick told. A guest is told once per change, however often this is called. */
function postContext() {
  const json = contextNow();
  for (const rec of installedApps.values()) if (rec.ctx !== json) void tellContext(rec, json);
}

// ── an app's view ───────────────────────────────────────────────────────
//
// A view is the app's own HTML page in a sandboxed iframe, loaded from a `blob:` URL: an
// opaque origin with no access to this page's DOM or keys, which reaches the shell only by
// postMessage. Each installed app has its own, made when the app is installed and kept
// until it is removed or replaced. The app shown is the one whose frame is in front; one
// that is not still hears from its guest, so its view is current when it is opened.
//
// The sandbox keeps a view from this page, and `guardView` (view-guard.js) keeps it from
// the network: the page loaded is the author's with a policy of its own in front, under
// which it makes no request and has no WebRTC. So what a view is shown goes nowhere but
// back through its guest, which reaches what the app's consent row said.
//
// allow-forms lets a view use a normal <form> element for its input. A view still
// preventDefault()s in its submit handler so no actual navigation happens; the null
// sandbox origin contains anything the form could attempt regardless.
//
// allow-downloads lets a view hand the user a file it has put together, as a link to a
// blob of its own: jam saves a track that way. A file is all it is. The view still reads
// and writes nothing on disk, and the browser shows a download like any other.

/** Renders held for a view that has not said it is ready; past this the oldest go. */
const MAX_QUEUED_RENDERS = 512;

function mountView(rec) {
  if (!rec.ui) return;
  const frame = document.createElement("iframe");
  frame.className = "app-frame hidden";
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads");
  frame.title = `${rec.name} UI`;
  rec.blobUrl = URL.createObjectURL(new Blob([guardView(rec.ui)], { type: "text/html;charset=utf-8" }));
  frame.src = rec.blobUrl;
  appPanel.insertBefore(frame, diagnostics);
  rec.frame = frame;
}

function unmountView(rec) {
  if (!rec.frame) return;
  rec.frame.remove();
  URL.revokeObjectURL(rec.blobUrl);
  rec.frame = rec.blobUrl = null;
  rec.ready = false;
  rec.queue.length = 0;
}

/** Hand an app's view the render bytes its guest answered, to a peer's frame or to the
 *  context. The shell does not read them. What a guest answers its view's own `call` is
 *  not a render: it goes back to that call (below).
 *
 *  Renders that arrive before the view says "ready" are queued, so an app just installed
 *  does not drop its first message. A context answer is not: `viewReady` gives the view
 *  the context as it then stands, ahead of the queue, and an older one behind it would
 *  put the view back. `fromPeer` is an answer to a peer's frame, which is what the App
 *  tab's unread dot is for when the user is looking at another tab. */
function deliverRender(rec, payload, { fromPeer = false, isContext = false } = {}) {
  if (!rec.ui || payload.length === 0) return;
  if (rec.ready) rec.frame.contentWindow.postMessage({ type: "render", payload }, "*");
  else if (!isContext) {
    rec.queue.push(payload);
    if (rec.queue.length > MAX_QUEUED_RENDERS) rec.queue.shift();
  }
  if (fromPeer && rec.key === activeAppKey && !tabs.app.btn.classList.contains("active")) {
    tabs.app.btn.classList.add("unread");
  }
}

/** A view said it is ready. Its guest is told the context, and the view is handed that
 *  answer first and then what arrived while it loaded, in order: a message is drawn by a
 *  view that already knows the room it is in. */
async function viewReady(rec) {
  const frame = rec.frame;
  const json = contextNow();
  rec.ctx = json;
  let context = new Uint8Array(0);
  try { context = await invokeApp(rec, APP_OP_CONTEXT, new TextEncoder().encode(json)); }
  catch (err) { shellPrint(`${rec.name}: ${err.message}`, "err"); }
  if (!frame || rec.frame !== frame) return; // removed or replaced meanwhile
  rec.ready = true;
  for (const payload of [context, ...rec.queue.splice(0)]) {
    if (payload.length > 0) frame.contentWindow.postMessage({ type: "render", payload }, "*");
  }
}

// ── reading a bundle ────────────────────────────────────────────────────
//
// Read an app's facts off a bundle for the UI and the consent gate, through the shared
// §12.4 verify path: both signatures authenticate the entire body before its manifest is
// read. Throws, saying why, for anything malformed, unauthentic, or not an app this shell
// runs (`appFacts`). That check is what keeps an Offer from installing authority behind a
// consent row: `guest.requires` is where a bundle's reach is written down, and this is the
// one place on the install path that reads it.
function peekBundle(bundleBytes) {
  let v;
  try { v = verifyBundle(sodium, bundleBytes); }
  catch { throw new Error("not a valid app bundle (.skb)"); }
  return {
    app: v.manifest.app,
    authorPk: v.author,
    // What a consent to this bundle names, and what tells two bundles apart.
    hash: bytesToHex(bundleDigest(v, digest)),
    ...appFacts(v.manifest),
  };
}

// Install a bundle the user has consented to: by dropping it, by accepting its offer, or
// by having installed it before a reload. Calls the shared §12.4 installer, which
// verifies the bundle signatures, checks the admit gate, and stands the slot. Returns the
// AppRecord.
async function applyAppBundle(bundleBytes) {
  const peeked = peekBundle(bundleBytes);
  // The label this bundle installs under (§12.4) — a fact of the signed manifest, so the
  // page has it BEFORE the install, and the onInbound closure below just closes over the
  // record rather than waiting for a handle to fill it in.
  const key = peeked.app;
  // Taking a standing label over takes its data and signing scope with it. The app's own
  // author shipping its next version is the one-click upgrade; a different author's
  // bundle under the same label is asked about by name.
  const standing = installedApps.get(key);
  if (standing && bytesToHex(standing.authorPk) !== bytesToHex(peeked.authorPk)
      && !confirm(`Replace ${standing.name} ${standing.version} with ${peeked.name} ${peeked.version} ` +
        `by a different author (${bytesToHex(peeked.authorPk).slice(0, 12)}…)?`)) {
    throw new Error("replacing an app from a different author was declined");
  }

  const record = {
    key,
    name: peeked.name,
    version: peeked.version,
    description: peeked.description,
    /** The manifest's signed claim (§12.10) and reach (§12.2), which its row shows. */
    protocols: peeked.protocols,
    requires: peeked.requires,
    authorPk: peeked.authorPk.slice(),
    hash: peeked.hash,
    bundleBytes: bundleBytes.slice(),
    ui: peeked.ui,
    /** The install's handle — the one loopback `invoke`, bound to this app's slot. */
    invoke: null,
    // Its view: the frame, whether it has said it is ready, and the renders held until then.
    frame: null,
    blobUrl: null,
    ready: false,
    queue: [],
    /** The context its guest was last told, as JSON. */
    ctx: null,
    /** The conversation its view says is open, `{ room }` or `{ to }` by id in hex, null
     *  for none, and undefined for a view that never says. */
    conv: undefined,
  };

  // The consent is one-shot (`admit`), and withdrawn if the install does not take it.
  pendingApprovals.add(peeked.hash);
  let loaded;
  try {
    loaded = await shell.install(bundleBytes, {
      // Naming no predecessor takes a FREE label and refuses a standing one (§12.4), so a
      // bundle under a label already here — an app's next version, or another author's
      // app — says which slot it retires. The user's app row IS that question, and it is
      // all that separates a first install here from an upgrade.
      replaces: standing ? key : undefined,
      // Protocol routing (seedkernel §12.10): the render bytes ARE this app's own answer
      // to the frame it just served, and the installer that mounted it receives them
      // right here, off its own install — no second claim, and no 32-byte comparison
      // against a caller id, because the page already knows which app THIS install is.
      onInbound: (claim, from, answer) => deliverRender(record, new Uint8Array(answer), { fromPeer: true }),
    });
  } finally {
    pendingApprovals.delete(peeked.hash);
  }
  record.invoke = (arg) => loaded.invoke(arg);

  if (standing) unmountView(standing);
  installedApps.set(key, record);
  mountView(record);
  // Its guest starts with no context: tell it, without waiting for its view to load.
  postContext();
  persistInstalledApps();
  renderAppList();
  return record;
}

// ── persistence ────────────────────────────────────────────────────────
// The packed bundle is the only piece of app state we need — the installed app and its
// view both derive from it. We keep them in sessionStorage so a reload within the same
// tab keeps the user's app set and lets transitive offers continue to work.
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
  // Read before the replay: each install below saves the app set as it then stands, with
  // no app shown yet.
  const saved = sessionStorage.getItem(STORE + ".active");
  // Replaying the bundles in the order they were stored reproduces the routing exactly:
  // each one lands on its own label and claims exactly what its manifest names, and a
  // contest with an already-restored app is refused rather than resolved by order
  // (§12.10). So there is nothing else to restore, and no order-dependent outcome to
  // reproduce beyond the list itself. A restored app cleared the consent gate when it was
  // installed, which is the consent `applyAppBundle` installs it under.
  for (const raw of arr) {
    try { await applyAppBundle(new Uint8Array(raw)); }
    catch (err) { shellPrint(`Could not restore an app: ${err.message}`, "err"); }
  }
  if (saved && installedApps.has(saved)) setActiveApp(saved);
}

// ── the app shown ──────────────────────────────────────────────────────
function setActiveApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  if (!rec.frame) {
    shellPrint(`${rec.name} has no UI to show.`, "err");
    return;
  }
  activeAppKey = key;
  for (const r of installedApps.values()) r.frame?.classList.toggle("hidden", r !== rec);
  appEmpty.classList.add("hidden");
  appStatus.textContent = `${rec.name} ${rec.version}`.trim();
  persistInstalledApps();
  renderAppList();
}

function showNoApp() {
  activeAppKey = null;
  for (const r of installedApps.values()) r.frame?.classList.add("hidden");
  appEmpty.classList.remove("hidden");
  appStatus.textContent = "no app loaded";
  persistInstalledApps();
}

// ── peer-to-peer app offers ────────────────────────────────────────────
//
// An offer is a packed app bundle forwarded over a data channel on `offer/v1`, the
// offers app's own claim (browser/offers-app.js) — any peer who holds the bundle can
// forward it (transitive offer), and the bundle carries the original author's signatures
// over all of it, so the recipient still authenticates against the author (peekBundle
// verifies it).
//
// The relaying peer is identified by the AKE channel, not a signature — the frame is
// unsigned; the bundle's own manifest signature is the load-bearing authentication.
// `handleOffer` is reached two ways: fresh, off the offers app's `onInbound` (above),
// and replayed from its fs at boot (`restoreOffers`, below) — both hand it the exact
// same three things, because both read them off the same kind of record.
//
// Keyed by the offers app's OWN record key (`OFFERS_KEY_PREFIX + hex`, the blake2b-256
// of the whole blob): it is already the fs key the record lives under, so accepting or
// dismissing an offer can delete it with no second derivation.
const pendingOffers = new Map();   // recordKey → { bundleBytes, peeked, fromPkHex }

/** The most offers one peer has waiting here. The offers app keeps whatever arrives under
 *  `offer/v1` before anything has read it, in a store every app on this node shares, and an
 *  offer costs a peer one frame: so what is waiting is bounded here, where it is read. */
const MAX_OFFERS_PER_PEER = 8;

async function handleOffer(bundleBytes, fromPkHex, recordKey) {
  // An offer that will never be shown is never accepted or dismissed either, which is what
  // deletes a record: so its record goes now.
  const drop = (why) => {
    shellPrint(`Offer from ${fromPkHex.slice(0, 8)} dropped: ${why}`, "err");
    offersApp.fs.delete(recordKey).catch(() => {});
  };
  let peeked;
  try { peeked = peekBundle(bundleBytes); }
  catch (err) {
    drop(err.message);
    return;
  }

  // Already running this exact bundle ⇒ nothing to offer. An update differs somewhere, in
  // its guest or a module or its view, so its digest differs and it still surfaces for
  // consent (installs are consent-gated, §12.4); only a redundant re-offer of what the
  // user already has installed is dropped, so it never shows a pointless Install row. The
  // record stays in the offers app's fs either way — the guest's own dedupe
  // (browser/offers-app.js) already keeps it from growing on a repeat delivery of the
  // identical bytes.
  for (const rec of installedApps.values()) {
    if (rec.hash === peeked.hash) return;
  }
  if (pendingOffers.has(recordKey)) return;
  if ([...pendingOffers.values()].filter((o) => o.fromPkHex === fromPkHex).length >= MAX_OFFERS_PER_PEER) {
    drop(`it has ${MAX_OFFERS_PER_PEER} waiting here already`);
    return;
  }
  pendingOffers.set(recordKey, { bundleBytes: bundleBytes.slice(), peeked, fromPkHex });
  renderOfferList();
  if (!tabs.apps.btn.classList.contains("active")) tabs.apps.btn.classList.add("unread");
  shellPrint(`${fromPkHex.slice(0, 8)} offers app "${peeked.name}" — see the Apps tab.`, "sys");
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
    shellPrint(`Install from offer failed: ${err.message}`, "err");
    showAppsNotice(`Install from offer failed: ${err.message}`, "err");
  }
}

function dismissOffer(recordKey) {
  pendingOffers.delete(recordKey);
  offersApp.fs.delete(recordKey).catch(() => {});
  renderOfferList();
}

// ── offering an app ─────────────────────────────────────────────────────
//
// Every outbound frame leaves through a guest, because that is the only thing that can
// send: the host's driver holds sockets and no request face at all, and the network is
// the transport, reached by calling the id it claims (§12.10). An app's own frames leave
// through its own guest, and the shell never sees them. The shell's own leave through its
// two boot bundles: what it tells a peer's page and a call's signals through the shell app
// (`tellPage`, `sendSignal`), and an Offer through the offers app, which owns `offer/v1`
// in both directions. No app's guest is borrowed to carry any of them.

// Send the stored bundle for `key` to every linked peer. Anyone who receives this can
// forward it to others — that's transitivity for free.
async function offerApp(key) {
  const rec = installedApps.get(key);
  if (!rec) return;
  const linked = await linkedPeers();
  for (const peerId of linked) {
    const arg = new Uint8Array(32 + rec.bundleBytes.length);
    arg.set(hexToBytes(peerId), 0);
    arg.set(rec.bundleBytes, 32);
    try { await offersApp.invoke(writeOp(OFFERS_OP_SEND, arg)); }
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
//
// An installed app's row and an offered one's are the same row, with different buttons:
// both say what the bundle is and, the part a consent rests on, what it serves and what
// it reaches. `app` is the facts `peekBundle` read off the signed manifest, which an
// AppRecord carries too.

/** The top of a row: the app's name, version and description, as its author wrote them. */
function appRowHead(li, app) {
  const head = document.createElement("div");
  head.className = "app-row-head";
  const nm = document.createElement("span");
  nm.className = "app-row-name";
  nm.textContent = app.name;
  head.appendChild(nm);
  if (app.version) {
    const v = document.createElement("span");
    v.className = "app-row-version";
    v.textContent = app.version;
    head.appendChild(v);
  }
  li.appendChild(head);
  if (app.description) {
    const d = document.createElement("div");
    d.className = "app-row-desc";
    d.textContent = app.description;
    li.appendChild(d);
  }
}

/** One line of `label value` pairs, a dot between them. */
function appRowMeta(li, pairs) {
  const meta = document.createElement("div");
  meta.className = "app-row-meta";
  pairs.forEach(([label, value], i) => {
    const b = document.createElement("b");
    b.textContent = label;
    meta.append(b, document.createTextNode(` ${value}${i < pairs.length - 1 ? " · " : ""}`));
  });
  li.appendChild(meta);
}

/** What a bundle SERVES (§12.10) and what it REACHES (§12.2) — read, never set. Both are
 *  the manifest's signed word. The protocols are its claim, and installing it is what
 *  routes each to it; `guest.requires` is the whole of what its guest can touch, so on an
 *  offer's row this line is what the Install button grants. */
function appRowClaims(li, app) {
  const line = document.createElement("div");
  line.className = "app-row-meta";
  const say = (label, value) => {
    const span = document.createElement("span");
    span.className = "app-row-proto";
    const b = document.createElement("b");
    b.textContent = label;
    span.append(b, document.createTextNode(` ${value}`));
    line.appendChild(span);
  };
  if (app.protocols.length === 0) say("serves", "no protocol — receives nothing");
  for (const proto of app.protocols) say("serves", `“${proto}”`);
  if (app.requires.length === 0) say("reaches", "nothing");
  for (const r of app.requires) say("reaches", APP_GRANTS[r]);
  li.appendChild(line);
}

function appRowButton(btns, label, cls, onClick) {
  const btn = document.createElement("button");
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  btns.appendChild(btn);
  return btn;
}

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
  appRowHead(li, rec);
  appRowMeta(li, [["id", rec.key], ["author", bytesToHex(rec.authorPk).slice(0, 8)], ["bundle", rec.hash.slice(0, 12)]]);
  appRowClaims(li, rec);

  const btns = document.createElement("div");
  btns.className = "app-row-buttons";
  if (rec.frame) {
    const openBtn = appRowButton(btns, rec.key === activeAppKey ? "Active" : "Open", "icon primary", () => {
      setActiveApp(rec.key);
      showTab("app");
    });
    openBtn.disabled = rec.key === activeAppKey;
  }
  appRowButton(btns, "Offer to peers", "icon", () => offerApp(rec.key));
  appRowButton(btns, "Remove", "icon danger", () => removeApp(rec.key));
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
  unmountView(rec);
  if (activeAppKey === key) showNoApp();
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
  const app = offer.peeked;
  const li = document.createElement("li");
  li.className = "app-row offer-row";
  appRowHead(li, app);
  appRowMeta(li, [["id", app.app], ["author", bytesToHex(app.authorPk).slice(0, 8)],
    ["from", offer.fromPkHex.slice(0, 8)], ["bundle", app.hash.slice(0, 12)]]);
  appRowClaims(li, app);
  const btns = document.createElement("div");
  btns.className = "app-row-buttons";
  appRowButton(btns, "Install", "icon primary", () => acceptOffer(key));
  appRowButton(btns, "Dismiss", "icon", () => dismissOffer(key));
  li.appendChild(btns);
  return li;
}

// ── drag-drop + file picker plumbing ───────────────────────────────────
async function loadDroppedFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Dropping a file IS the consent (§12.4), granted to whatever already-signed bundle
  // the user picked. One this shell will not run is refused here, with the reason.
  try {
    const record = await applyAppBundle(bytes);
    shellPrint(`Installed ${record.name} ${record.version}`, "sys");
    setActiveApp(record.key);
  } catch (err) {
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

// ─── what a view says to the shell ─────────────────────────────────────
//
// The view's half of the contract (app-api.js). `ready` and `call` are about its own app:
// the shell passes bytes between a view and its guest and reads none of them. The other
// two ask something of the shell, about things that are the shell's, a room or a peer
// named by its id in hex: `conv` and `contact`. A view is any author's page, so each is
// checked for shape, and neither of those two hands it anything back.

/** Whether `v` is 32 bytes as lowercase hex: a key, or a room's id. */
const isHex32 = (v) => typeof v === "string" && HEX32_RE.test(v);

window.addEventListener("message", (ev) => {
  const rec = [...installedApps.values()].find((r) => r.frame && r.frame.contentWindow === ev.source);
  const msg = ev.data;
  if (!rec || !msg) return;

  if (msg.type === "ready") { void viewReady(rec); return; }

  // Bytes for the app's own guest. Every call is answered, under the id the view gave it:
  // with what the guest answered, empty or not, or with why it failed. So a view can ask
  // its guest something and wait, and one whose guest threw is not left waiting.
  if (msg.type === "call") {
    if (!(msg.bytes instanceof Uint8Array) || !Number.isSafeInteger(msg.id)) return;
    // To the view that asked, if it is still there: the app may be gone by the answer.
    const answer = (fields) => rec.frame?.contentWindow.postMessage({ type: "answer", id: msg.id, ...fields }, "*");
    invokeApp(rec, APP_OP_UI, msg.bytes).then((payload) => answer({ payload }), (err) => {
      shellPrint(`${rec.name}: ${err.message}`, "err");
      answer({ error: err.message });
    });
    return;
  }

  // The conversation open in the view: a room, one peer, or none. A call started now is
  // with it (`callPeers`).
  if (msg.type === "conv") {
    rec.conv = isHex32(msg.room) ? { room: msg.room } : isHex32(msg.to) ? { to: msg.to } : null;
    // The call bar names who a call would ring, which just changed.
    updateCallStatus();
    return;
  }

  // Make a peer a contact, so the link to it outlives any shared room: what a view asks
  // before it writes to one peer directly. Only of a peer this node already knows, one it
  // shares a room with or is linked to, which are the peers a view is told of. A contact is
  // a key this node calls, wherever it is, and is told so; so a view that could name any
  // key could have this node link to one its user never met, and its guest then write to
  // it. A key from anywhere else is added by the user, on the Network tab.
  if (msg.type === "contact") {
    if (!isHex32(msg.peer) || contacts.has(msg.peer) || msg.peer === myPkHex) return;
    if (!linkedNow.includes(msg.peer) && roomsOf(msg.peer).length === 0) {
      // Said once for a key asked again and again, as chat asks ahead of every direct message.
      if (rec.refusedContact !== msg.peer) {
        shellPrint(`${rec.name} asked to make ${msg.peer.slice(0, 8)} a contact, which is not a peer this node ` +
          "shares a room with or is linked to. Add it on the Network tab to link to it.", "err");
      }
      rec.refusedContact = msg.peer;
      return;
    }
    addContact(msg.peer, null);
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

// A nick is the shell's, not an app's: what this node calls itself, set on the Network
// tab, and what each peer calls itself. The pages tell each other on their own channel
// (`{ nick }` on shell/v1, `onPageNotice`), so a name is the same in every app and needs
// none installed, and every app reads it out of its context (`contextNow`).

/** The linked peers whose page has heard this node's nick. It holds no opinion about
 *  peers: it is only ever narrowed to an answer the transport gave, so a peer that dropped
 *  and came back (a reloaded tab keeps its key and forgets what it was told) is absent,
 *  and is told again. */
const nickTold = new Set();

/** Give each linked peer that has not heard it this node's nick, an empty one for none. A
 *  peer counts as told before the send, so nothing tells it twice. Run on every poll's
 *  answer, so a peer that links is told within a poll interval. */
function tellNick(peers) {
  for (const id of [...nickTold]) if (!peers.includes(id)) nickTold.delete(id);
  const notice = new TextEncoder().encode(JSON.stringify({ nick: myNick }));
  for (const peerId of peers) {
    if (nickTold.has(peerId)) continue;
    nickTold.add(peerId);
    void tellPage(peerId, notice).catch(() => nickTold.delete(peerId));
  }
}

/** Set this node's nick, or with "" have none. Every peer's copy is stale, so nobody
 *  counts as told any more, and the apps hear of it in their context. */
function setMyNick(nick) {
  myNick = nick.trim().slice(0, MAX_NICK);
  if (myNick) sessionStorage.setItem("shell.nick", myNick);
  else sessionStorage.removeItem("shell.nick");
  nickInput.value = myNick;
  nickTold.clear();
  tellNick(linkedNow);
  postContext();
  shellPrint(myNick ? `You are now known as ${myNick}.` : "You no longer have a nick.", "sys");
}
nickInput.value = myNick;
nickSetBtn.addEventListener("click", () => setMyNick(nickInput.value));
nickInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); setMyNick(nickInput.value); }
});

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
  sessionStorage.setItem("shell.rooms", JSON.stringify([...joinedRooms.keys()]));
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

/** What a peer is shown as: the nick it told this page, or the start of its key. */
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
      await tellPage(key, peerNotice(false));
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
    void tellPage(key, peerNotice(added)).catch(() => {});
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
  postContext();
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
  if (secret) sessionStorage.setItem("shell.contactSecret", bytesToHex(secret));
  else sessionStorage.removeItem("shell.contactSecret");
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
// (./media-rtc.js), signaled over the shell boot bundle. A call is with the conversation
// open in the app when it starts: its linked peers, a room's members or one peer, are told
// of it, and pollPeerViews keeps that following them (`callPeers`). Being told is all a
// peer gets: the bar says who is calling, and nothing of the call is received, or sent,
// until it is accepted there (`incomingCall`). Whoever enters a call does so with the
// microphone and the camera on, each then turned off and on by its own button (`capture`,
// `release`); endCall hangs up with every peer. Remote tracks arrive via the onTrack
// callback wired on `media` above and land in a per-peer tile keyed by pubkey hex; a tile
// is cleaned up when its track ends or its media connection closes.
//
// All of it is here rather than in an app's view because a view cannot capture: its
// sandbox gives it an opaque origin, and `getUserMedia` fails there with a SecurityError
// whatever the iframe's `allow` says.

const callBar      = document.getElementById("call-bar");
const callStartBtn = document.getElementById("call-start");
const callDeclineBtn = document.getElementById("call-decline");
const callMuteBtn  = document.getElementById("call-mute");
const callCamBtn   = document.getElementById("call-cam");
const callEndBtn   = document.getElementById("call-end");
const callStatus   = document.getElementById("call-status");
const videoTiles   = document.getElementById("video-tiles");

// What we have captured for the call in progress: the microphone and the camera, less
// whichever is off or the browser did not give, and null out of a call.
let localStream = null;
const remoteTiles = new Map(); // pkHex -> { wrap, video, stream }
// The conversation the call in progress is with: what the app shown said was open when the
// call started (its record's `conv`), `{ room }` or `{ to }` by id in hex, null for none,
// and undefined for an app that never says, or with no app shown.
let callScope;

/** Who of the linked peers a call with `scope` is with: a room's members, or one peer. A
 *  call from an app that never says which conversation is open is with everyone linked. */
function peersIn(scope, linked) {
  if (scope === undefined) return linked;
  if (scope === null) return [];
  if (scope.to) return linked.filter((p) => p === scope.to);
  const members = membersOfRoom(scope.room);
  return linked.filter((p) => members.has(p));
}

/** Who of the linked peers the call in progress is with. */
const callPeers = (linked) => peersIn(callScope, linked);

/** Who a call with `scope` rings, in the shell's own words. Which conversation is open is
 *  the view's word (`conv`), and it is the user's camera and microphone that go there: so
 *  the call bar says who that is, and the user need not take it from the view as well. */
function callTarget(scope) {
  const n = peersIn(scope, linkedNow).length;
  if (scope === undefined) {
    return n === 0 ? "nobody, since no peer is linked" : n === 1 ? "the 1 linked peer" : `all ${n} linked peers`;
  }
  if (scope === null) return "nobody, since no conversation is open in the app";
  if (scope.to) return n > 0 ? peerLabel(scope.to) : `${peerLabel(scope.to)}, who is not linked`;
  const room = [...joinedRooms].find(([, r]) => r.id === scope.room)?.[0];
  if (!room) return "nobody, since this node is not in that room";
  return n === 0 ? `nobody, since no one in ${friendlyRoom(room)} is linked` : `the ${n} linked in ${friendlyRoom(room)}`;
}

/** What both ends of a call with `scope` name it by: a room's id, "direct" for a call with
 *  one peer, "all" for one with everyone linked. */
const callName = (scope) => scope === undefined ? "all" : scope?.room ?? "direct";

/** What a call is turned down by, and kept from ringing again: a room's or everyone's by
 *  its name, one peer's by that peer. */
const callId = (peer, call) => call === "direct" ? peer : call;

// The calls turned down, or hung up on, by `callId`: none rings again while it lasts.
const declined = new Set();

/** The call waiting to be accepted: the first a peer says it is in that we could enter and
 *  have not turned down, as { id, scope, callers }, or null. A room's is one whose caller
 *  the relay says is in that room with us. */
function incomingCall() {
  const callers = media.callers;
  for (const [from, call] of callers) {
    const direct = call === "direct";
    if (!direct && call !== "all" && !membersOfRoom(call).has(from)) continue;
    if (declined.has(callId(from, call))) continue;
    return {
      id: callId(from, call),
      scope: direct ? { to: from } : call === "all" ? undefined : { room: call },
      callers: direct ? [from] : [...callers].filter(([, c]) => c === call).map(([p]) => p),
    };
  }
  return null;
}

/** Who is in a call changed: one nobody is in any more is not one turned down, so its
 *  next caller rings; and the bar says who is calling now. */
function callersChanged() {
  const live = new Set([...media.callers].map(([from, call]) => callId(from, call)));
  for (const id of [...declined]) if (!live.has(id)) declined.delete(id);
  updateCallStatus();
}

function updateCallStatus() {
  const ring = localStream ? null : incomingCall();
  callStartBtn.textContent = ring ? "Accept call" : "Start call";
  callStartBtn.classList.toggle("primary", !!ring);
  callBar.classList.toggle("ringing", !!ring);
  callBar.classList.toggle("idle", !localStream);
  if (ring) {
    const [first, ...more] = ring.callers;
    const room = [...joinedRooms].find(([, r]) => r.id === ring.scope?.room)?.[0];
    callStatus.textContent = `${peerLabel(first)}${more.length > 0 ? ` and ${more.length} more are` : " is"} calling` +
      (room ? ` in ${friendlyRoom(room)}` : "");
  } else if (!localStream) {
    // Who a call started now would ring, beside the button that starts it.
    callStatus.textContent = `a call rings ${callTarget(installedApps.get(activeAppKey)?.conv)}`;
  } else {
    const n = media.size;
    callStatus.textContent = n === 0
      ? "in call (waiting for peers)"
      : `in call · ${n} peer${n === 1 ? "" : "s"}`;
  }
}

function showTilesIfAny() {
  const has = !!localStream || remoteTiles.size > 0;
  videoTiles.classList.toggle("hidden", !has);
}

/** Draw a tile as its video, or as its label alone while it has none to show: no camera,
 *  or one its peer has turned off, which mutes the track here. */
function drawTile(wrap, stream) {
  const video = stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  wrap.classList.toggle("no-video", !video);
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

/** Start a call with the open conversation, or join the one it is in, with the microphone
 *  and the camera on. A call the browser gives neither to goes on with both off, each
 *  button then asking for its own. */
function startCall() {
  if (localStream) return;
  // A call waiting to be accepted is the one entered, whatever is open in the app.
  const ring = incomingCall();
  localStream = new MediaStream();
  callScope = ring ? ring.scope : installedApps.get(activeAppKey)?.conv;
  media.start(callName(callScope), callPeers, linkedNow);
  callStartBtn.disabled = true;
  callEndBtn.disabled = false;
  ensureLocalTile();
  showCapture();
  updateCallStatus();
  shellPrint(ring ? "Call accepted." : `Call started with ${callTarget(callScope)}.`, "sys");
  void capture({ audio: true, video: true });
}

function endCall() {
  if (!localStream) return;
  // Hung up on, the call does not ring here again for as long as others stay in it.
  declined.add(callId(callScope?.to, callName(callScope)));
  media.end();
  for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  removeLocalTile();
  for (const pkHex of Array.from(remoteTiles.keys())) removeRemoteTile(pkHex);
  callStartBtn.disabled = false;
  callMuteBtn.disabled = true;
  callCamBtn.disabled = true;
  callEndBtn.disabled = true;
  showCapture();
  callersChanged();
  shellPrint("Call ended.", "sys");
}

/** Turn the waiting call down: its callers are not told, and it rings here no more. */
function declineCall() {
  const ring = incomingCall();
  if (!ring) return;
  declined.add(ring.id);
  updateCallStatus();
}

/** The microphone and camera buttons, each reading what a click on it does, and our own
 *  tile, showing the camera while it is on. */
function showCapture() {
  const [mic] = localStream?.getAudioTracks() ?? [];
  const [cam] = localStream?.getVideoTracks() ?? [];
  callMuteBtn.textContent = mic?.enabled ? "Mute" : "Unmute";
  callCamBtn.textContent = cam ? "Stop video" : "Start video";
  const tile = document.getElementById("tile-local");
  if (tile) drawTile(tile, localStream);
}

/** Turn on the microphone (`audio`), the camera (`video`), or both in one asking: ask the
 *  browser for just that, and publish it to the peers in the call, and to any that enters
 *  it later. */
async function capture(what) {
  const stream = localStream;
  if (what.audio) callMuteBtn.disabled = true;
  if (what.video) callCamBtn.disabled = true;
  let tracks = [];
  try {
    tracks = (await navigator.mediaDevices.getUserMedia(what)).getTracks();
  } catch (err) {
    shellPrint(`getUserMedia failed: ${err.message}`, "err");
  }
  // A hang-up while the browser was asking leaves no call to add it to.
  if (localStream !== stream) { for (const t of tracks) t.stop(); return; }
  if (what.audio) callMuteBtn.disabled = false;
  if (what.video) callCamBtn.disabled = false;
  for (const track of tracks) {
    // A device that goes away, unplugged or its permission withdrawn, ends its track.
    track.addEventListener("ended", () => release(track));
    stream.addTrack(track);
    media.publish(track, stream);
  }
  showCapture();
}

/** Let go of a captured track: stop sending it, and stop capturing it. */
function release(track) {
  if (!localStream?.getTracks().includes(track)) return;
  media.unpublish(track);
  track.stop();
  localStream.removeTrack(track);
  showCapture();
}

/** A mute only silences the microphone, which stays captured, so the unmute is at once.
 *  One the call never got is asked for here. */
function toggleMute() {
  if (!localStream) return;
  const [mic] = localStream.getAudioTracks();
  if (!mic) { void capture({ audio: true }); return; }
  mic.enabled = !mic.enabled;
  showCapture();
}

/** The camera is captured only while its video is on: stopping it lets the camera go. */
function toggleCamera() {
  if (!localStream) return;
  const [cam] = localStream.getVideoTracks();
  if (cam) release(cam); else void capture({ video: true });
}

callStartBtn.addEventListener("click", startCall);
callDeclineBtn.addEventListener("click", declineCall);
callEndBtn.addEventListener("click", endCall);
callMuteBtn.addEventListener("click", toggleMute);
callCamBtn.addEventListener("click", toggleCamera);

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
  sessionStorage.removeItem("shell.relayUrl");
  sessionStorage.removeItem("shell.relaySecret");
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
    sessionStorage.setItem("shell.relayUrl", base);
    // The relay secret belongs to the relay, so it is saved and cleared with the relay.
    if (relaySecret) sessionStorage.setItem("shell.relaySecret", relaySecret);
    else sessionStorage.removeItem("shell.relaySecret");
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
const savedRelayUrl = sessionStorage.getItem("shell.relayUrl");
const savedRelaySecret = sessionStorage.getItem("shell.relaySecret");
relayUrlInput.value = savedRelayUrl || defaultRelayUrl();
if (savedRelaySecret) relaySecretInput.value = savedRelaySecret;
if (myContactSecret) contactInput.value = bytesToHex(myContactSecret);
let savedRooms = [];
try { savedRooms = JSON.parse(sessionStorage.getItem("shell.rooms") ?? "[]"); } catch {}

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
// What it hears is also what the apps are told is linked (`postContext`), with the rooms
// and the contacts: each app's guest is told when any of them changes.
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
    linkedNow = peers;
    tellNick(peers);
    postContext();
    media.sync(peers);
    updateCallStatus();
  } catch {}
  setTimeout(pollPeerViews, 750);
}
pollPeerViews();
updateCallStatus();
