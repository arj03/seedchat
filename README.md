# seedshell: an app shell, and its apps, for [seedkernel](https://github.com/arj03/seedkernel)

Two things live here, and the line between them is the point.

The **shell** (`browser/shell.*`) is a browser page that hosts apps. It owns what is
the same for every app: this node's identity and nick, the relay, rooms, peers and
contacts, installing and offering apps, and calls. It knows nothing about what any app
does. Seedkernel has a `Shell` of its own, the node assembly `bootShell` returns (§12.8):
that one lives in seedkernel, and this page is built around it.

An **app** is a signed bundle that carries everything of its own: a confined JS **guest**
that is its behaviour, an HTML **view** the shell runs in a sandboxed iframe, and any
**pure-transform** WASM modules the guest drives. The shell passes bytes between a view
and its guest and reads none of them, so a new version of an app is a new bundle and
nothing else: the shell does not change. Two apps are here, and the shell that hosts one
is the shell that hosts the other. **Chat** is text and images, in rooms and in direct
chats. **Jam** stands beside it, under its own label and protocol: a room's chat with
emoji reactions, and a playlist the room keeps and plays together, FLAC and Ogg Vorbis
files streamed from peer to peer as they are.

Two smaller apps ride alongside as **boot bundles**, pinned to the exact author and app
the page was built with: **offers** (`browser/offers-app.js`), which owns the `offer/v1`
id a peer's signed bundle travels on — because the app an Offer would install is the thing
the Offer is offering, so until someone accepts it there is no app to route it to — and
**shell** (`browser/shell-app.js`), how one page talks to another: what each tells the
other about itself under `shell/v1`, and a call's signaling under `call/v1`.

This lives outside the seedkernel repo for the same reason
[seedstore](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The seedkernel repo stays runtime-only, and every reach
the shell makes into the runtime goes through a published entry point of
`seedkernel-wasm` — see seedkernel's
[CLIENT](https://github.com/arj03/seedkernel/blob/main/docs/CLIENT.md) guide.

**Contents:** [Quick start](#quick-start) · [Using the shell](#using-the-shell) ·
[What's here](#whats-here) · [Writing an app](#writing-an-app) · [The chat app](#the-chat-app) ·
[The jam app](#the-jam-app) · [Protocol interop](#protocol-interop) ·
[The seedkernel surface the shell uses](#the-seedkernel-surface-the-shell-uses) ·
[Troubleshooting](#troubleshooting)

## Quick start

### Prerequisites

- **Node.js ≥ 20.**
- **Sibling checkouts** of [seedkernel](https://github.com/arj03/seedkernel) and
  [seedrelay](https://github.com/arj03/seedrelay) (the relay server `npm run relay`
  starts). Both are `file:` dependencies (`../seedkernel/WASM`, `../seedrelay`), so the
  layout must be:

  ```
  some-dir/
  ├── seedkernel/
  ├── seedrelay/
  └── seedshell/    ← this repo
  ```
- **clang**, for seedkernel's post-quantum C → wasm step.

### Build and run

```sh
# 1. build the seedkernel checkout it depends on (transport bundle + host + minified,
#    browser core libsodium and PQ wasm)
cd ../seedkernel/WASM && npm install && npm run build:browser

# 2. build the apps (chat and jam, + the offers and shell boot bundles)
#    and vendor the runtime
cd ../../seedshell && npm install && npm run build

# 2b. (optional) headless check that the shell still works against this seedkernel:
#     two shells, the real chat app, a message round-trip, an upgrade in place,
#     an offer round-trip, a page notice and a call signal round-trip
npm run smoke

# 2c. (optional) the same in a real browser: two tabs of the shell and a relay,
#     through install, an offer, chat, an app replaced in place, a call and a
#     reload, then jam beside chat with a FLAC file added in one tab and streamed
#     to the other. Needs Chrome, Edge or Chromium.
npm run e2e

# 3. the relay where peers meet and link before moving to WebRTC (the transport bundle
#    joins it; once peers are on WebRTC, killing it leaves them linked)
npm run relay

# 4. in another terminal: re-vendor + serve browser/ with caching off
npm run serve        # → http://localhost:3000/shell.html
```

Open the page in two tabs or two browsers and join the same room in both on the
**Network** tab. Then load an app (below) in each: chat, jam, or both.

| Script | What it does |
| --- | --- |
| `npm run build` | Compiles chat's AssemblyScript module, signs `bundle/chat.skb` and `bundle/jam.skb` from their app directories, signs the offers and shell boot bundles, then vendors the runtime. |
| `npm run build:chat-app` | Chat's compile → sign pipeline. |
| `npm run build:jam-app` | Signs `bundle/jam.skb`. Jam has no module, so there is nothing to compile. |
| `npm run build:boot-bundles` | Signs the offers and shell apps into `bundle/offers.skb` and `bundle/shell.skb` and generates `browser/offers-bundle.js` and `browser/shell-bundle.js`. |
| `npm run vendor` | Copies the built seedkernel host, libsodium and QuickJS into `browser/vendor/`. |
| `npm run smoke` | Headless regression test (needs `npm run build` first). Run it after every seedkernel update. |
| `npm run e2e` | The shell in a real headless browser, two tabs and a relay (needs `npm run build` first). Run it after a change to the shell or an app's view. |
| `npm run relay` | Starts the `seedrelay` relay on port 8080. |
| `npm run serve` | Re-vendors, then serves `browser/` on port 3000 with caching disabled. |
| `npm run clean` | Deletes `build/` and `browser/vendor/`. |

## Using the shell

**Identity.** Each tab mints an Ed25519 identity and keeps it in `sessionStorage`,
so closing the tab discards it. That is also why two tabs of the same browser are
two distinct peers.

**Nick.** *My nick* on the **Network** tab is what this node calls itself. Each linked
peer's shell is told it, shows it in place of the key, and hands it to every app it runs,
so a name is the same in every app and needs none installed. It is a peer's own word, not
proof of who it is: anyone can take any nick, and the key is what the channel
authenticated.

**Loading an app.** On the **Apps** tab, pick or drop `bundle/chat.skb`, or
`bundle/jam.skb`, which installs beside chat. The browser only verifies the
bundle's signature and admits it under the shell's consent policy; it never signs anything
itself. Dropping a newer `.skb` of
an app you already have is how you upgrade it. Each installed app has a view of its own;
**Open** on its row puts it in front. A node holds eight bundles at once, and the shell's
own take three of them (the transport and the two boot bundles), so five apps can be
installed side by side.

**Offers.** Peers hand each other bundles in an `OFFER` frame; the recipient
re-verifies the original author's manifest signature. An Offer is installed on one
click, so the recipient checks what the bundle asks for before showing that click, and
the row says it: the protocols it **serves**, and what it **reaches** (see the [trust model](#trust-model)). A signature says
who wrote a bundle, not what it may reach — the signed `guest.requires` list is where
that is written down, host services and co-resident guests alike — and this shell grants
an app at most the network (`_net`), a keyspace of its own (`fs`) and a wake (`timer`).
A bundle reaching for anything else, such as the node's signing key or the sockets, is
not installed (`appFacts` in `browser/app-api.js`). Consent names the whole bundle,
guest and view included, so an update that changes only an app's behaviour is a new
offer, and a consent to one bundle admits no other. A peer has at most eight offers
waiting here at once, and one that is not a bundle this shell runs is dropped as it
arrives.

**Rooms, contacts and the contact secret.** On the **Network** tab, **Connect** puts
this node on the relay in the URL field, where its key can be called. That needs no room.
The button then reads **Disconnect**, which leaves the relay: rooms keep their names for
the next Connect, the links they were the reason for close, and a contact already linked
stays linked. From the relay there are two ways to be linked to a peer, and one gate:

- A **room** has no secret. Joining one is agreeing to be linked to everyone in it, and
  you can be in several at once: type a name and press **Join** (with none typed, the
  default `global`), which also connects a node that is on no relay yet. Whoever has a
  room's name can join it, so **Random** gives the name typed an ending nobody can guess,
  `cats-5c1e…`, shown as `cats`. Each room lists the other peers in it, and has a
  **Copy link** (`…/shell.html#room=<name>`) and a **Leave**; leaving closes only the
  links that room was the reason for. The relay keeps no list of rooms a client could
  read, and sees a hash of each name, never the name.
- A **contact** is one peer you link to directly, by its key, whether or not you share a
  room. The Peers list holds them, not your room-mates, each by its nick if it has set
  one and by its key otherwise. It is easiest with someone you share a room with:
  **Add peer** beside them in the room's list makes them a contact, as sending them a
  direct message does. For anyone else, **Add peer** under the Peers list takes a contact
  link, or a key with its contact secret if it has one. Either way the other end is told
  once it is linked, and lists you as its peer too; **Remove peer** undoes it at both ends.
- The **contact secret** (*My contact secret*) is this node's own. With one set, a caller
  who is not in a room with you must present it to be answered at all; a wrong or missing
  one is refused silently, and shows on the caller's side as `no answer`. Your room-mates
  never need it. **Copy contact link** gives `…#pk=<your key>&s=<your secret>`.

Links carry what they share in the URL fragment, which browsers never send over the
network. A room message goes only to that room's members, and a direct message only to its
addressee.

**Calls.** The call bar above the app on the **App** tab is the shell's, not the app's.
**Start call** starts a call with the conversation open in the app: a room's linked
members, or the one peer of a direct chat. With no app shown, or one that never says which
conversation is open, a call is with every linked peer. Which conversation is open is the
app's word, and it is your camera and microphone that go there, so the shell says who that
is itself: with no call on, the call bar names who one started now would ring.

Those peers are only told of the call. Each one's bar says who is calling, and offers
**Accept call** and **Decline**; until it accepts, a peer receives nothing of the call
and sends nothing, since media is negotiated only between two nodes that are both in it.
Accepting enters that call, whatever conversation is open. A call turned down, or hung up
on, does not ring again while it lasts; it can still be entered with **Start call** from
its conversation.

Starting or accepting a call asks for the microphone and the camera together and
publishes both, and each then has its own button. **Mute** silences the microphone, which
stays captured, and **Unmute** brings it back. **Stop video** lets the camera go, and
**Start video** asks for it again. A call the browser gives neither to (permission
refused, or no camera) goes on all the same with both off, **Unmute** then asking for the
microphone alone and **Start video** for the camera.

Media rides peer connections the page owns, one per peer, beside the transport's and
asking the same relay for STUN. Their signaling rides the node's authenticated channel,
so a call needs no relay once the peers are linked, and nobody on the relay can inject
into one.

A call is the shell's because an app cannot hold one. A view's sandbox gives it an opaque
origin, which cannot be granted the camera or microphone: `getUserMedia` fails there in
Chromium with a `SecurityError`, whatever the iframe's `allow` says. So the shell holds
the media, and a view only says which conversation is open (`conv`, under
[The view](#3-the-view-uihtml)).

**Private relays.** A relay started with `--secret` (seedrelay's
[Private relays](https://github.com/arj03/seedrelay#private-relays)) serves only
clients that know its secret. Enter it in the **Relay secret** field on the Network
tab. It belongs to the relay, not to a room or a node, so it is not part of any link: get
it from whoever runs the relay. The room client and the transport each prove it with
BLAKE2b and never send it; whoever sees a registration can still test guesses at it,
so a relay's secret must be long and random.

Either way, identity is bound in-channel by the transport bundle's handshake, which
runs end to end through the relay, so a relay can see which keys meet and refuse to
forward, but can never read the traffic or impersonate a peer. WebRTC signaling rides the
peers' own authenticated link, so no relay or room member sees SDP or candidates.

**Direct or relayed.** The Peers list on the **Network** tab shows how each of them is
reached: `direct` once its link has moved to WebRTC, `via relay` while the relay still
forwards it, which is where a link stays when no direct one can be made. The peer pill
in the top bar counts every link, room-mates' too, says how many are relayed, and turns
green once every link is direct.

**Other devices.** `localhost` is a secure context, so plain HTTP is enough for WebRTC
when both tabs are on this machine. Reaching the shell from another device needs HTTPS
(and a relay URL that device can reach; `wss://` if the page is served over HTTPS).

## Trust model

**An app is trusted code, as a browser extension is.** Installing one is the decision, and
the row on the Apps tab is the permission prompt: who wrote it, the protocols it **serves**
and what it **reaches**, all read off its signed manifest. Dropping a file, or clicking
install on an Offer, says you trust that author with what the row lists. The shell does not
try to contain an app that misuses what it was granted; it keeps the row true, and it
treats peers, who are not asked, as strangers.

**What installing an app grants.** Its guest runs with the grants in `requires`:

- `_net`, the network: it sends to any peer this node is linked to, as this node, under the
  protocols it claims and no other, and receives the frames of those protocols.
- `fs`, a keyspace of its own in the one storage backend the shell runs.
- `timer`, one wake.

Its view is part of the app and is granted nothing of its own. Every app is also told the
context: this node's rooms (with the ids that join them), the linked peers, the contacts and
each peer's nick.

**What the shell enforces, so that the row is true:**

- An app cannot reach the node's signing key or the sockets, and a bundle that asks is not
  installed (`appFacts`, `browser/app-api.js`).
- A consent names the whole bundle, guest and view, so an update that changes behaviour is a
  new consent, and a bundle from a different author under an installed label asks first.
- A view reaches nothing but its own guest: no request of any kind, no WebRTC, no frame it
  can run script in (`browser/view-guard.js`). So an app that did not ask for `_net` has no
  network through its view either. The doors a view has to the shell are held to what the
  row already says: it may make a contact only of a peer the node knows, and the call bar
  says who a call would ring, since the camera and microphone go there.
- Each claim has one owner on a node, and the shell's own, `offer/v1`, `shell/v1` and
  `call/v1`, are held by apps it pinned at boot. An app sends only under the protocol ids it claims, so it
  cannot write another app's messages, or the shell's own, as you (seedkernel §12.10); an app
  that needs a second id claims it.

**What it does not defend against.** An app with `_net` can:

- claim a protocol id before the app that would use it is installed, and receive what peers
  send under it;
- fill the shared storage or the send queue, and so starve every other app, or spend what
  its CPU and memory budgets allow;
- read every room, peer and nick in the context, and hand them to any peer it is linked to;
- carry a display name that looks like another app's. The row also shows its id and the
  start of its author's key.

So install apps from authors you trust, as you would an extension, and remove one you no
longer do. Removing an app drops its claims and stops it, and its stored keys stay under
its label for whatever is installed there next. **Peers are strangers.** What a peer sends
is attributed to the key the channel authenticated and is nothing more: the receiving guest
decides what to draw, an offer is verified, bounded and installed only by a click, and a
nick is a peer's own word.

## What's here

| Path | What it is |
| --- | --- |
| `browser/shell.*` | The browser shell: identity and nick, admission policy, the transport, offers and shell boot loads, the sockets the transport's WebRTC mesh runs over, the rooms, peers and contacts, and a sandboxed iframe for each installed app. The inline import map in `shell.html` names the seedkernel surface. |
| `browser/app-api.js` | The contract between the shell and any app, in one place: the contract version, what an app may reach, what the shell reads off a signed manifest (`appFacts`), the digest a consent names, and the two ops the shell calls on an app's guest. The shell gates and drives every bundle through it, and the builder refuses to sign what it would refuse. |
| `browser/offers-app.js` | The offers app *shape*: the `offer/v1` id, the app id `offers`, its authority (`fs` for the offers that arrive, `_net` for the ones this node makes), and its guest source — a claim, a keyspace and a `send` op, no module. `scripts/build-boot-bundles.mjs` signs it into the boot bundle. |
| `browser/shell-app.js` | The shell app *shape*, how one page talks to another: the app id `shell`, its one reach (`_net`), its two claims, and its guest source — it hands what a peer sent under either claim to the page, and has an op for each that puts the page's on the wire. `shell/v1` is what a page tells another about itself: `{ peer }`, that it added or removed the other as a peer, and `{ nick }`, what it calls itself. `call/v1` is a call's signaling. The page tells the two apart by the claim a frame arrived under. |
| `browser/view-guard.js` | What holds a view to its sandbox: `guardView` makes the page a view is loaded as, the author's own with a Content Security Policy in front that lets it make no request, and a prelude, the one script that policy lets the parser run, which takes WebRTC out of the realm and then runs the view's scripts. See [The view](#3-the-view-uihtml). |
| `browser/media-rtc.js` | The call feature: `MediaCalls`, one `RTCPeerConnection` per peer that the page owns, beside the transport's, with perfect negotiation signaled over `call/v1`. A node in a call tells its peers so (`{ call }`), and a connection is opened only between two that have each said they are in the same one. Live media is the page's own — the host holds only the transport's connections. |
| `assembly/chat-app/` | Chat — text and images, in several rooms and in direct chats. `app.json` says what the bundle is, `guest.js` is its guest, which holds the chat wire vocabulary and decides who each frame is for, `index.ts` is its module, the one transform that draws a frame, and `ui.html` its view, with the view's CSS and JS in files of their own (`ui.css`, `ui.js`) beside the page. |
| `assembly/jam-app/` | Jam: a room's chat, emoji reactions, and a playlist kept and played together. Its guest is the room pipe, to which `guest.js` adds a name for each block of audio, its hash. Its view (`ui.html`, `ui.css`, `ui.js`) holds the room's state and plays it, `formats.js` finds where a FLAC or Ogg Vorbis file may be cut, and there is no module. See [The jam app](#the-jam-app). |
| `assembly/guest-lib/net.js` | Guest source any guest that reaches the network puts in front of its own: the transport's `send` and `peers` ops, and keys as hex. Every app and both boot bundles use it. |
| `assembly/guest-lib/context.js` | Guest source for a guest whose frames are written to rooms: the shell's two ops by name, the rooms read out of the node's context, the context passed on to the view as render type 0, and the entrypoint, which tells a peer's frame from the view's bytes so a guest is written as what it does with each (`guest.peer`, `guest.view`). Chat and jam use it. |
| `assembly/guest-lib/room-pipe.js` | A guest, whole: a pipe scoped to a room, for an app whose state lives in its view. What the view casts goes to the room's linked members, what it tells goes to one of them, and a peer's frame is passed on only from a member of the room it names. An app that needs no more writes no guest. Jam builds on it. |
| `assembly/view-lib/app.js` | View source any view puts in front of its own: bytes as hex, and the door to the shell as one object, `app`. A call to the guest is a promise of its answer, and `cast`, `tell` and `onFrame` are the view's half of the room pipe. Chat's and jam's views use it. |
| `asconfig.chat-app.json` | AssemblyScript compiler config for chat's module (`build/chat-app.wasm`). |
| `scripts/app-source.mjs` | Reads an app directory (`app.json` and what it names) into what gets signed, putting a view's stylesheets and scripts into its page. The builder and the smoke test share it. |
| `scripts/build-app-bundle.mjs` | The offline bundle author: signs an app directory into a `.skb` under `chat-author.key`, tracking a monotonic freshness mark per app label in `<app>-author.version`. |
| `scripts/build-boot-bundles.mjs` | Signs the offers and shell apps' guest-only bundles under the same key, each with its own freshness mark in `<name>-author.version`. |
| `scripts/vendor.mjs` | Copies seedkernel's built host (`build-min`: `host/` + `services/`) into `browser/vendor/`, plus the browser libsodium and the QuickJS realm engine. Refuses a stale seedkernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam, round-trips messages through the real chat app and the shell's two ops, replaces it in place with a later build, round-trips an offer through the offers app, and a page notice and a call signal through the shell app, each under its own claim, carries a frame and a block of audio through jam's guest, and a cast and a tell through the room pipe with no guest behind it. |
| `scripts/e2e.mjs` | Browser regression test, for what the smoke test cannot reach: the page and the apps' views. Serves `browser/`, starts the `seedrelay` dependency, and drives two tabs of a headless Chrome, Edge or Chromium over the DevTools pipe: install by drop, rooms, nicks, an offer, messages, an app replaced in place by a bundle dropped over it, a direct message, a call that reaches its peer only once accepted, with a microphone muted and a camera turned off and on again, and one turned down, removing an app, and a reload. Then jam beside chat: a message and a reaction, a FLAC file added in one tab, downloaded in the other and streamed to it, a seek, the list moving on, a peer held to an uplink slower than its track plays, the list reordered and trimmed, a reload that gets the room and its music back from the other tab, and a tab left alone in the room. Then what a view may not do: each app's view tries a request, a socket, a peer connection and a script in a frame of its own, against a server that must hear nothing, then a script that names a file on the page's own server, and asks for a contact the node has never met. The FLAC file it writes itself. It adds no Ogg Vorbis file, which only an encoder can make. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

What the shell reads of an app — its name, version, description and view — rides in the
bundle's **signed manifest**, under `guest.config.shell`. That entry is **this shell's
convention, not a runtime contract**: the host hands `guest.config` to the guest and
reads none of it. Nothing is read out of a module, so an app needs none.

### Generated and local files (all gitignored)

| Path | What it is |
| --- | --- |
| `build/` | Compiled `.wasm` (and `.wat`) handlers. |
| `bundle/` | Signed bundles: `chat.skb`, `jam.skb`, `offers.skb`, `shell.skb`. |
| `browser/vendor/` | The vendored runtime the page loads. |
| `browser/offers-bundle.js`, `browser/shell-bundle.js` | The boot bundles embedded as JS modules, since the page is served from `browser/` and `bundle/` is not. |
| `chat-author.key` | The author signing key, minted on the first build. |
| `chat-author.version`, `jam-author.version`, `offers-author.version`, `shell-author.version` | Each app label's version high-water mark. |

**Back up `chat-author.key` and the `.version` files together.** The key *is* the
author identity: bundles signed under a new key are a different author, so peers
can no longer upgrade in one click from your earlier bundles. The version files
live beside the key rather than in `bundle/` so that wiping build output never
resets the count. If the key exists but a version file is missing, the build warns
and restarts at 1; put the last version you shipped back in the file before
publishing anything.

### Section references in the source

Comments across this repo cite seedkernel sections as bare `§N` (e.g. `§12.4`).
Seedkernel numbers its sections globally across its doc set, so each number lives in
exactly one file:

| Sections | File |
| --- | --- |
| §1 | [README](https://github.com/arj03/seedkernel/blob/main/README.md) |
| §2–§5, §16 — message model, bundle slots, **the WASM module ABI (§4)**, protocol constants | [PROTOCOL](https://github.com/arj03/seedkernel/blob/main/docs/PROTOCOL.md) |
| §10–§12 — the app host: host services, the guest seam, signed bundles, admission, transport, routing | [RUNTIME](https://github.com/arj03/seedkernel/blob/main/docs/RUNTIME.md) (rationale in [DESIGN](https://github.com/arj03/seedkernel/blob/main/docs/DESIGN.md)) |
| §13–§14 | [SECURITY](https://github.com/arj03/seedkernel/blob/main/docs/SECURITY.md) |

The channel handshake is in
[CHANNEL](https://github.com/arj03/seedkernel/blob/main/docs/CHANNEL.md).

## Writing an app

Anything the shell installs has the same parts, and `browser/app-api.js` is the whole of
what it and the shell agree on. Chat (`assembly/chat-app/`) is the reference for an app
with a guest of its own and a module. Jam (`assembly/jam-app/`) is one with no module,
whose state lives in its view and whose guest is little more than the room pipe.

The least an app can be is an `app.json` and a page. Its guest is three library files, and
its view talks to the room through one object:

```json
{ "app": "hello", "api": 2, "protocols": ["hello"], "requires": ["_net"],
  "guest": ["../guest-lib/net.js", "../guest-lib/context.js", "../guest-lib/room-pipe.js"],
  "ui": "ui.html" }
```

```js
// ui.js, which ui.html names behind ../view-lib/app.js
const enc = new TextEncoder(), dec = new TextDecoder();
let room = null;
app.onContext((ctx) => { room = ctx.rooms[0]?.id ?? null; });   // who and where, from the shell
app.onFrame((from, room, body) => log.append(`${from.slice(0, 8)}: ${dec.decode(body)}\n`));
form.onsubmit = (e) => { e.preventDefault(); if (room) app.cast(room, enc.encode(msg.value)); };
app.ready();
```

A cast goes to the linked members of a room, a frame is heard only from a member of the
room it names, and what a room holds is the view's to keep. The rest of this section is
what those two files stand on, for an app that needs more.

### 1. `app.json`: what the bundle is

One file beside the app's sources. Every path in it is relative to it.

```json
{
  "app": "chat",
  "api": 2,
  "name": "Chat",
  "version": "v2",
  "description": "text + images, rooms and direct chats",
  "protocols": ["chat"],
  "requires": ["_net"],
  "guest": ["../guest-lib/net.js", "../guest-lib/context.js", "guest.js"],
  "ui": "ui.html",
  "modules": { "chat": "../../build/chat-app.wasm" }
}
```

| Field | Meaning |
| --- | --- |
| `app` | The label the app installs under, `[A-Za-z0-9_-]{1,64}`. A node holds one app per label, and the label is also its storage and signing scope. A bundle under a label already installed upgrades or replaces that app (see [Protocol interop](#protocol-interop)). |
| `api` | The version of the shell contract the app was built for. The shell refuses any other by name, so a bundle from before a contract change is never installed and left silent. |
| `name`, `version`, `description` | What the app's row in the shell says. |
| `protocols` | The protocol ids the app claims. A peer's frame under one of them reaches its guest, and they are the only ids its guest may send under. The builder tells the guest them too, as `APP.protocols`, since a guest is handed its config and not its manifest's claims. |
| `requires` | Everything its guest reaches: `_net` (the network), `fs` (a keyspace of its own), `timer` (one wake). The shell grants nothing else, and the consent row shows the list. |
| `guest` | The guest's source files, joined in order behind seedkernel's op-frame. A library two apps share is one more path, and the three in `assembly/guest-lib/` are a guest by themselves. |
| `ui` | The view, an HTML page, with any stylesheets and scripts it names. Left out for an app with nothing to show. |
| `modules` | Pure WASM modules, by the name the guest calls each. May be empty. |

`scripts/build-app-bundle.mjs <app-dir> <skb-out>` signs it. The name, version,
description and view go into the signed manifest (`guest.config.shell`), so they are
vouched for by the same key as the code.

### 2. The guest: the app's behaviour

Confined JS with one entrypoint, `handle(bytes)`, and one way out, `host.call(name,
bytes)` (seedkernel §12.2). The shell hands it three things and reads none of the
answers. Each answer goes to the view, or is nothing.

| Caller | `handle` receives | Sent | Its answer |
| --- | --- | --- | --- |
| A peer | `[sender 32][frame …]` under a protocol the app claims. The sender's key is prepended by the host after the channel has authenticated the peer; the guest never verifies anything. | When the frame arrives. | **Render bytes**, for the view. |
| The shell, op `ctx` | `[zero 32][3]["ctx"][JSON]`: the node's context, below. | After the install, when the context changes, and when the view says it is ready. | Render bytes too. |
| The shell, op `ui` | `[zero 32][2]["ui"][bytes …]`: whatever the app's own view posted with `call`. | When the view calls. | The **answer** to that call. |

The 32-byte caller id tells a peer from the shell, and `callerOf`/`readOp` from
seedkernel's op-frame split both. `assembly/guest-lib/context.js` does that once, as the
`handle` of any guest that names it, so a guest is written as what it does with each
caller:

```js
guest.peer = (caller, frame) => …;   // a peer's frame: render bytes, or EMPTY
guest.view = async (bytes) => …;     // the view's call: its answer, or EMPTY
```

The context it keeps itself: the rooms a guest decides with (`inRoom`), and all of it
passed on to the view as render type 0. To send, a guest calls `_net` (`netSend` in
`assembly/guest-lib/net.js`); to draw, it calls its own module by name, or builds the
bytes itself.

`assembly/guest-lib/room-pipe.js` sets both, and is a guest whole. A frame on the wire is
`[room 32][body]` under the app's first protocol, and the pipe reads the room and never
the body:

| What the view asks (`ui`) | |
| --- | --- |
| `[1][frame]` cast | The frame goes to every linked member of its room. |
| `[2][to 32][frame]` tell | The frame goes to one member of its room. |

| What it renders | |
| --- | --- |
| `[0][context JSON]` | The node's context (`context.js`). |
| `[1][from 32][frame]` | A peer's frame, passed on only if the relay lists its sender in the room it names. |

An app that needs more than the pipe lists a guest file of its own behind it and sets
`guest.peer` or `guest.view` again, handing the rest to `pipePeer` and `pipeView`. Jam's
does: it hashes a block of audio on its way in, and answers one more ask.

An answer to a peer's frame is **render bytes and nothing else**. The shell hands every
one to the view (seedkernel's `onInbound`), so a guest that answered a peer's request with
the reply itself would be drawing that reply on its own page. An app that asks a peer for
something therefore has the peer send it back as a frame of its own, which is how jam moves
audio. Asking its own guest is another matter: what a guest answers the `ui` op goes back
to the call the view made, which is how jam's view learns what a block is called.

The **context** is ASCII JSON, with every key and room id in lowercase hex:

```json
{
  "api": 2,
  "me": "<this node's key>",
  "nick": "<what this node calls itself, or empty>",
  "rooms": [{ "id": "<room id>", "name": "cats", "members": ["<key>"] }],
  "linked": ["<key>"],
  "contacts": ["<key>"],
  "nicks": { "<key>": "<what that peer calls itself>" }
}
```

It is the shell's to know and the same for every app: rooms are joined on the Network
tab, and a nick is set there. A contact's secret is never in it.

### 3. The view: `ui.html`

An HTML page, signed and loaded as one self-contained document. It can be written as
several files: a `<link rel="stylesheet" href="ui.css">` or a `<script src="ui.js"></script>`
naming a file by its path from the page is replaced by that file's text when the bundle is
built (`readView` in `scripts/app-source.mjs`), so the page opens in a browser as it stands
and travels as one. Nothing else can be named: there is no file beside a view once it is
running. Chat's view is three files and the view library, and jam's has a second script
beside its own.

The shell loads it into an iframe sandboxed `allow-scripts allow-forms
allow-downloads` from a `blob:` URL, so it has no access to the page's keys. A view may
hand the user a file it has put together, as a link to a blob of its own, which is how
jam saves a track; it reads and writes nothing on disk.

A view reaches nothing but its guest. What an app reaches is what its guest reaches, which
is on its consent row; a view is granted nothing, and the shell holds it to that
(`browser/view-guard.js`). The page loaded is the author's with two things put in front:

- **A Content Security Policy of its own**, `default-src 'none'` and little given back.
  No request leaves a view: no `fetch`, no WebSocket, no image, stylesheet or font from
  anywhere, no form sent, no script that names a file. What it shows is its own inline
  styles, images and media it holds as `data:` or `blob:`, and fonts as `data:`. It may
  run WASM, and a worker made from a blob.
- **A prelude**, the one script the policy lets the parser run. It takes
  `RTCPeerConnection` out of the page, since a peer connection asks whatever server its
  script names and no policy governs that, and then runs the view's own scripts, where
  they stood and in order.

So a view is written with these in mind:

- Its scripts run as the page is parsed, as written, but they are run by the prelude and
  not the parser. An **inline handler** (`onclick="…"`) and a `javascript:` URL are the
  parser's and do not run: listen with `addEventListener`. A script the view makes itself
  (`document.createElement("script")`) runs if it carries its code; one that names a file
  loads nothing, and nor does `import()` or a worker's `importScripts`.
- There is **no WebRTC** in a view, and no frame it makes gets one: a frame inherits the
  policy, so nothing runs in it but the same prelude.
- Nothing outside the bundle can be loaded, a font or a script from a CDN included. What
  a view needs travels in it.

One thing is left that no policy stops: a `<link rel="preconnect">` or `dns-prefetch` opens
a connection to, or looks up, a name of the view's choosing. Nothing is sent on it but the
name, and the name is the view's to choose: so a view can tell a server it names a little
at a time, and hears nothing back.

The same opaque
origin is refused the camera and microphone, which is why a call is the shell's. Nor will a
media element there load a `blob:` URL: in Chromium an `<audio>` given one stalls without
an error, so a view that plays audio decodes it with Web Audio, as jam's does. Each
installed app has its own, kept until the app is removed or replaced. It talks to the
shell only via `postMessage`:

| Direction | Message | Meaning |
| --- | --- | --- |
| view → shell | `{ type: "ready" }` | Sent once on load. The shell tells the guest the context, hands the view that answer, then flushes any renders queued while it loaded. |
| view → shell | `{ type: "call", id: integer, bytes: Uint8Array }` | Bytes for the app's own guest (its `ui` op). The shell does not read them. `id` is the view's to choose, and comes back on the answer. |
| shell → view | `{ type: "answer", id, payload: Uint8Array }` | What the guest answered that call, which may be nothing. Every call is answered: one whose guest failed gets `{ type: "answer", id, error: string }` instead. |
| shell → view | `{ type: "render", payload: Uint8Array }` | Render bytes the app's guest answered: to a peer's frame, or to the context. The format is the app's. |
| view → shell | `{ type: "conv", room?: hex, to?: hex }` | The conversation now open, a room or one peer, or neither for none. A call started from the shell is with it; an app that never says calls every linked peer. |
| view → shell | `{ type: "contact", peer: hex }` | Make a peer a contact, so the link to it outlives any shared room. Only of a peer the node shares a room with or is linked to, which are the ones a view is told of: a key from anywhere else is refused, and is the user's to add on the Network tab. |

So a view learns of rooms, peers and nicks from its own guest, as a render, and the two
never hold different pictures.

A view need not write any of that. `assembly/view-lib/app.js`, named in a script tag ahead
of the view's own (`<script src="../view-lib/app.js"></script>`), is the same door as one
object, with `toHex`, `fromHex` and `concat` beside it:

| | |
| --- | --- |
| `app.ready()` | The view is listening. |
| `app.call(...parts)` | The parts, end to end, for the guest. A promise of its answer, rejected if the guest failed. |
| `app.onRender(fn)` | `fn(bytes)` for each render. |
| `app.onContext(fn)` | `fn(ctx)` for the context, which is taken out of what `onRender` hears. |
| `app.conv({ room })`, `app.conv({ to })`, `app.conv()` | The conversation now open. |
| `app.contact(peer)` | Make a peer a contact. |
| `app.cast(room, ...parts)` | With the room pipe: a frame to every linked member of a room. |
| `app.tell(room, to, ...parts)` | With the room pipe: a frame to one member of it. |
| `app.onFrame(fn)` | With the room pipe: `fn(from, room, body)` for a peer's frame, taken out of what `onRender` hears. |

Rooms and peers are named by id in hex, as the context names them.

### 4. Modules: pure compute, optional

A WASM module exporting `scratch` (a pointer) and `handle(input_len) → output_len`. The
host stages the guest's input at `scratch`, calls `handle`, and reads the output back
from the same region. It may export `scratchSize` to ask for a larger region than the
128 KB default (chat does, for images). A module does no I/O and holds no authority;
see seedkernel PROTOCOL §4 for the full ABI.

### Building it

For an app with an AssemblyScript module, copy `asconfig.chat-app.json` to
`asconfig.my-app.json`, point its entry and output paths at your app, then run the same
two steps the `build:chat-app` npm script does:

```sh
npx asc assembly/my-app/index.ts --config asconfig.my-app.json --target release
node scripts/build-app-bundle.mjs assembly/my-app bundle/my-app.skb
```

An app with no module skips the first. There is no in-browser signing: anyone
installing a custom app builds their own `.skb`. Admission trust is purely "did I
consent to install this bundle", never "did I sign it as myself".

## The chat app

Text and images, written to a room or to one peer. All of it is in `assembly/chat-app/`.

**A frame** is `[type u8][body …]`, the same bytes on the wire, from the view to the
guest, and into the module. The shell never reads one.

| `type` | Body |
| --- | --- |
| `0x03` / `0x04` direct text / image | `[to 32][content]` |
| `0x05` / `0x06` room text / image | `[room 32][content]`, `room` the room's id on the relay |

A message is written to a room or to one peer, never to everyone linked. A node can be in
several rooms at once, so a room message names its room.

**The guest** (`chat-app/guest.js`) does three things with a frame. Its own, from
the view, it sends to the linked members of the frame's room, or to the one peer a direct
frame names. A peer's it draws only if it is for this node: a room frame from someone the
relay lists in that room, or a direct one addressed to this node. A frame of a type it
does not speak is not drawn. And either way it has the module draw the frame, and answers
what was drawn: a peer's frame as a render, and the view's own as the answer to the call
that sent it, which is the local echo.

**What the view draws** is one of:

```
[0][context JSON]                       the node's context, passed on for the view
[type u8][pkLen u8][pk …][body …]       a frame as the module drew it
```

A sender's nick is not in a frame or a render. It is the shell's, and the view reads it
out of the context.

## The jam app

A room's chat, emoji reactions on what is said, and a playlist the room keeps and plays
together. It follows [seedstore](https://github.com/arj03/seedstore)'s split into two
planes: small frames that say what the room agrees on, and blocks of audio that are named
by their hash and so need no trust in whoever sent them.

**A frame** is the room pipe's, `[room 32][type u8][body]`, under the protocol id `jam`.

| `type` | Body | For |
| --- | --- | --- |
| `1` DOC | JSON | A part of the room's state, or all of it |
| `2` WANT | block ids, 32 bytes each | Send me these blocks |
| `3` NACK | block ids | I do not have these |
| `4` BLOCK | the bytes of one block | A block that was asked for |

**The guest** is the room pipe (`guest-lib/room-pipe.js`), which reads the room of every
frame: one its view *casts* goes to the linked members of the frame's room, one it *tells*
goes to a single member, and a peer's frame is passed to the view only if the relay lists
its sender in that room. `jam-app/guest.js` adds what a block is called. A BLOCK is hashed
on the way in, so its render (`[2][from 32][room 32][id 32][bytes]`) carries the id this
node's own guest gave those bytes, never the one the sender claimed. The view also asks it
to name the blocks of a file being added (`[3][bytes]`, answered with the id), so the two
never name a block two ways.

**The room's state** is the view's (`jam-app/ui.js`), and is one document:

```
msgs    [{ by, id, n, at, text }]      added, never changed
reacts  [{ t, e, by, on, n }]          per (target, emoji, peer), the latest n wins
tracks  [{ id, by, n, title, codec, rate, ch, size, head, blocks, lens, pre,
           pos, gone, v, vBy }]        what a track is never changes; pos goes to the
                                       latest (v, vBy); gone, once set, stays set
play    { v, by, id, pos, on }         what is playing: the latest (v, by) wins
```

Every change is a smaller document of the same shape, merged the same way whoever sent it
and however often. `n` and `v` are a clock the room shares: a change takes one more than
the highest its author has seen. So a newcomer is caught up by being sent the state, a
change heard twice changes nothing the second time, and two peers that move the same track
at once end up agreeing on one of the moves. A node asks each linked member for the state
when it first sees it (`hello`), which is also what brings a reloaded tab back.

**Audio** is the file's own bytes: nothing is re-encoded, on the way in or on the way
out. A file is cut into pieces that each decode without the rest (`jam-app/formats.js`),
of at most 256 KB or five seconds, and each piece is a block, named by the BLAKE2b-256 of
its bytes.

- A **FLAC** file is a header and then frames, and every frame decodes on its own, so a
  piece is whole frames. A frame does not say how long it is: it ends where the next
  begins, which is found by the next one's sync code and header and proved by the CRC-16
  the frame ends with, since audio can hold bytes that read as a header.
- An **Ogg Vorbis** file is pages, each saying how long it is and how many samples the
  stream has reached, so a piece is whole pages, cut where no packet runs over. A Vorbis
  packet is decoded against the one before it, so a piece is decoded with the last page of
  the piece before it in front (`pre`), and the samples that page yields are dropped.

A track lists its blocks, how many samples each holds (`lens`), and one more block that
every piece is decoded behind (`head`): FLAC's STREAMINFO, or Vorbis's three header
packets. Whoever added a track serves it from the file on disk, a slice at a time, and
everyone who has fetched a track serves it too, so the one who added it can leave. Blocks
are asked of any member that says it holds the track (`have`), a few at a time, and one
that does not arrive is asked for again, of someone else if there is anyone.

A track is a file to keep, too: **Download** on its row fetches whatever of it is not
here yet, listening or not, and saves the head and then the pieces, end to end. The audio
is the bytes that were added. An Ogg Vorbis track comes out as the file itself. A FLAC
track comes out as the file's frames behind a STREAMINFO that says how long the stream is,
without the tags and pictures the file carried, which no peer was sent.

**Playing** is the room's, and listening is each node's own. `play` says which track,
from where, and whether it is running, so play, pause, seek and skip are for everyone. A
node that has tuned in asks first for the piece the room has reached, then the ones after
it, and needs only those to sound: it comes in anywhere in a track as readily as at its
start. Each piece is decoded by Web Audio into the samples it holds and set down on the
audio clock at the sample the one before it stopped at, in a context that runs at the
track's own sample rate. Decoded that way a piece is the same samples a decode of the
whole file gives, and a node holds a few seconds of them however long the track. One that
has not tuned in sees what is on and is nudged. When a track ends each node works out the
next from the same list, and the one with the highest key says so first.

**Buffering.** The room's clock does not stop for a node whose blocks are slow, so a node
does not start sounding until it will not run dry. It measures how fast blocks have been
arriving and counts on four fifths of that.

- *Faster than the track plays*, it starts once it holds four seconds ahead of the room,
  which is what carries it over a link that stutters. From then on its lead only grows: it
  goes on to fetch the rest of the track, and the one after it.
- *Slower than the track plays*, sound started at once would stall. So it works out how
  much it must hold for the rest to arrive in time, aims at the place in the track where
  the room will be when it holds that much, and asks for pieces from there rather than
  ones the room will have passed. It says when it will join, and from there plays to the
  end of the track without a break.

Until a block has arrived there is nothing to measure, so a node asks for little at first:
what is asked for cannot be called back, and a slow link has to deliver all of it before
anything asked for after. A peer that is still delivering is not given up on for being
slow. And a track someone starts begins a second and a half later when not everyone holds
it yet, so that the others have its opening by the time it sounds.

What it does not do:

- **Nothing is signed.** A frame is attributed by the channel it arrived on, and only
  members of a room are heard, so the state is the members' to write. What one member
  relays of another's messages is its own word for them.
- **Nothing is kept.** The room's state and its audio live in the page, so they last as
  long as someone in the room stays. A tab that reloads gets both back from the others; a
  room everyone has left is empty when they return.
- **Only FLAC and Ogg Vorbis.** They are the two formats it knows how to cut. A file of
  another kind is refused rather than converted: MP3, AAC and Opus could each be cut too,
  and are not yet. A file is at most 512 MB.
- **The room does not wait for a slow node.** One whose blocks come slower than a track
  plays cannot hear all of it, whatever it does. It hears the later part of each track,
  unbroken, rather than all of it in pieces.

## Protocol interop

A frame carries a *protocol id*, not an app name. An app's signed manifest claims
its ids (`protocols` in its `app.json`; every chat app claims the one id `chat`), and
installing an app is what routes them — so two peers running different authors'
chat apps, or different versions of one, interoperate as long as both speak the
protocol, and neither had to point anything at anything. A claim has one holder, so a
node runs one chat app at a time, beside any apps that claim other ids. A second one
under the same `app` label **replaces** the first: accept a peer's Offer and their app
becomes the one this node chats with. The author's own next version upgrades in one
click; a different author's app asks first, because it takes over the label's data and
signing scope along with the slot (seedkernel §12.4). One under a different label is
refused while the first holds `chat` — remove the first to install it.

## The seedkernel surface the shell uses

Eleven published entry points of `seedkernel-wasm`, across the browser shell and the
build/smoke scripts:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm` | Node `loadCrypto()` in the offline bundle builders and the headless smoke test. |
| `seedkernel-wasm/shell-core` | `bootShell` — the one assembly (§12.8): the transport bundle pinned to its own author, the adapter built around the supplied `transport.channels` factory, and the boot loads. The page's `admit` composes the offers and shell pins and the consent gate. Its `Shell.call` is the host's own door into a co-resident guest's `services` claim, which is how the peer pill and the peer list ask the transport who is linked, and whether directly or through the relay. |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes()` and `TRANSPORT_SERVICE` — the seedkernel-shipped transport bundle as raw bytes, and the local service id it claims, used by the headless smoke assertions (§12.6); browser boot gets the same artifact through `bootShell`. |
| `seedkernel-wasm/bundle` | `verifyBundle` — the one call that unpacks and checks an offered bundle (`peekBundle`) — and `genesisHash`, the hash the consent gate's digest of a whole bundle is built from. The browser only verifies; peer attribution uses its node public key. |
| `seedkernel-wasm/bundle-author` | `authorBundle`, `guestOpFraming` and `hybridAuthorKeysFromSeed` in the offline `build-app-bundle.mjs` and `build-boot-bundles.mjs` scripts. This entry point is never imported by the browser shell. |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the WebRTC `ChannelFactory`: it holds the transport's peer connections, which the transport negotiates over links made through the relay (§12.7). |
| `seedkernel-wasm/net-ws` | `WsNetwork` — the WebSocket the transport opens to the relay. |
| `seedkernel-wasm/socket-seam` | `combineChannels` — both factories behind one driver, passed as `transport.channels`. |
| `seedkernel-wasm/op-frame` | `writeOp` — the signed apps' own operation framing for local guest invocations — and `OpArgs`, the transport bundle's argument writer, paired with its reader so a host-side call cannot drift from what the guest parses. |
| `seedkernel-wasm/crypto-browser` | `loadCrypto` — the browser build of the same crypto seam Node's `loadCrypto` provides. |
| `seedkernel-wasm/libsodium` | The browser libsodium build. |

The import map in `shell.html` also maps `seedkernel-wasm/quickjs`. The shell
never imports it; the vendored host does, for its QuickJS realms.

The relay is deliberately not a seedkernel entry point. `seedrelay` is the server;
the transport bundle speaks its control wire, registering through its `relay` operation
and redialing a relay that drops, and the shell meets the room with seedrelay's room
client. The shell owns only the selected URL, room, credentials, and UI.

Plus two on the guest side. The chat module defines its two memory-layout
literals — `PK_LEN = 32` and `PRIV_USER_OFF = 0` — alongside its layout
comments (§4, `assembly/chat-app/index.ts`). And guest source spells the
transport's `send` and `peers` ops and its service name `_net` by hand
(`assembly/guest-lib/net.js`), since a guest imports nothing; seedkernel's host reads the
protocol a `send` names as the transport reads it (§12.10), and the smoke test runs the
guest's ops against the shipped transport.

Three properties serve as the summary; the details live in the seedkernel docs:

- **The protocol is a bundle; the sockets are the platform's.** The channel AKE,
  record layer and request/response layer ship as a signed transport bundle
  serving the local service name `_net`, embedded in the host and reached as raw
  bytes through `transport-bundle`. The host side — link ids and sockets — is
  `bootShell`'s channel adapter, built around a WebSocket and the platform's
  `RtcNetwork`, combined and supplied as `transport.channels`; transport policy and its
  defaults belong to the signed bundle, as do the address book and contact gate,
  which live in that bundle's own realm rather than under the adapter. The shell sets
  the gate, this node's own contact secret, with the transport's local `contact`
  operation, and names its room-mates with `welcome`, so their calls pass it. It
  registers on the relay with the `relay` operation, hands the transport each room-mate
  and contact it calls as a `relay+` address with `addr`, and drops a peer it no longer
  wants with `forget`; the transport links to them through the relay and moves each
  link to WebRTC itself
  (§12.6, §12.7, [CHANNEL](https://github.com/arj03/seedkernel/blob/main/docs/CHANNEL.md)).
- **The offers and shell apps get a pin, the shell's own half of it.** `offer/v1` carries a
  signed bundle for an app that does not exist yet, so something already
  installed at boot owns the name and `admit` allows exactly the author and app
  the page was built with — a pin, not a consent prompt. The shell app, which carries
  what two pages tell each other and a call's signaling, is pinned the same way. The
  shell's own consent gate is everything else.
- **Both directions cross an app's guest.** The host has no send and no receive:
  an inbound frame reaches the shell as the link occupant's own delivery return,
  and an outbound frame leaves by an app *calling* `_net`. The render bytes an
  app's guest returns for an inbound frame are that call's answer, read off
  the load's own `onInbound` (§12.10) — no second claim, no host-side tap. The
  page sends nothing through an app's guest: its own frames, an Offer, what it tells a
  peer's page and a call's signals, leave through the offers and shell apps it pinned.
  The page's own
  questions go the same way: "who is linked, and is it direct" is a
  call on `_net` through `Shell.call`, not a field on the adapter, because links
  are the transport guest's and the adapter knows only sockets.

The browser JS entry points are declared in exactly two places: the imports at the top of
`shell.js`, and the inline import map in `shell.html`. The page's CSP allows
inline scripts (`'unsafe-inline'`) because app UIs run in a sandboxed `blob:`
iframe that inherits this page's policy. The iframe sandbox is what keeps a view from the
page, and the policy each view is loaded under (`browser/view-guard.js`) what keeps it
from the network: the page's own has to let the page reach any relay, so it holds a view
to nothing. Nothing else in this repo reaches into `node_modules`. If a seedkernel
change breaks the shell, it broke a public export — which is the point of the shell
living out here.

## Troubleshooting

- **The shell fails in ways that look like seedkernel bugs after a rebuild.**
  Almost always a stale cache. `npm run serve` passes `-c-1` for this reason: a
  plain `http-server` defaults to `max-age=3600`, so the browser keeps serving an
  old `vendor/host`. Hard-reload, and if a rebuild still doesn't take,
  `npm run clean && npm run build` starts from nothing.
- **`npm run vendor` refuses with a staleness error.** seedkernel's `build/` is
  newer than its `build-min/`, which happens when you rerun its `tsc` without
  minifying. Rerun `npm run build:browser` in `../seedkernel/WASM`.
- **`seedkernel-wasm not found`.** The sibling checkouts
  are missing or misnamed; see [Prerequisites](#prerequisites).
- **`npm run smoke` can't find `build/chat-app.wasm` or a boot bundle.**
  Run `npm run build` first.
- **`npm run e2e` finds no browser.** It looks for Edge, Chrome or Chromium in their
  usual places. Set `E2E_BROWSER` to the path of one installed elsewhere.
- **Peers never appear.** Both tabs must use the same relay URL and be in the same room.
- **A contact shows `no answer`.** It is offline or on another relay, or it has a contact
  secret this node did not present, or presented wrongly, which is refused without any
  error. Get its contact link, or its secret, enter the secret on its row and press
  **Connect**. A room-mate needs no secret.
- **The relay reads as unreachable, but it is running.** It may be private: a relay
  started with `--secret` drops a client without its secret, or with another one.
  Enter the relay's secret in the **Relay secret** field.
- **A button in an app's view does nothing, or a font or image is missing.** A view runs
  under a policy that lets it reach nothing (see [The view](#3-the-view-uihtml)). An inline
  handler (`onclick="…"`) does not run, so listen with `addEventListener`; and nothing
  loads from outside the bundle, so a view carries what it shows.
- **Jam shows what is playing, with no sound.** Press **Tune in**: listening is each
  node's own choice, and a browser lets a page make sound only after a click in it.
- **Jam says `Not connected to a room`, or `Nobody else is connected here yet`.** Music is
  added to a room, for whoever else is in it. Join one on the **Network** tab. With a room
  and nobody else linked in it, music can still be added: whoever joins is sent the list,
  and fetches the audio from this node.
- **A track in jam says `nobody here has it`.** Its audio is held by whoever added it and
  by everyone who has played it since. If they have all left or reloaded, the entry is
  still in the list and its audio is gone: remove it and add the file again.
- **A dropped `.skb` is refused, or a peer's Offer never shows up.** The notice says
  why, and for an Offer the reason is in the App tab's **Diagnostics**. Either the
  bundle failed verification ("not a valid app bundle"), or it is not an app this shell
  runs (`appFacts` in `browser/app-api.js`): its manifest has no `shell` entry, it was
  built for another contract version, or it reaches something the shell grants no app.
- **An install fails with `this node already holds its 8 app slots`.** A node holds eight
  bundles, and the transport, offers and shell are three of them. Remove an app
  to install another.
- **An app's message never leaves, and Diagnostics says it `does not claim` a protocol.**
  An app sends only under the protocols in its own `protocols`. Add the one it sends under
  there, which also makes it the app that receives it on this node.
