# seedchat: a chat app for [seedkernel](https://github.com/arj03/seedkernel)

Chat is the smallest possible app on the runtime: a confined JS **guest** over a
single **pure-transform** WASM module. The guest's one `handle` entrypoint
forwards an inbound frame to the module by name on the same `host.call` seam and
returns whatever it answers; the module does no I/O and no crypto — it reads
`senderPk ‖ chatType ‖ body` and returns render bytes for the UI. Everything
around it — authenticating the sender, moving frames, driving the iframe — is
the runtime's job.

A second, smaller app rides alongside: **offers** (`browser/offers-app.js`), a
guest with no module at all, whose whole job is owning the `offer/v1` id a
peer's signed bundle arrives on — because the app an Offer would install is the
thing the Offer is offering, so until someone accepts it there is no app to
route it to. Both apps are loaded as **boot bundles**, pinned to the exact
author and app the page was built with.

This lives outside the seedkernel repo for the same reason
[seedstore](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The seedkernel repo stays runtime-only, and every reach
chat makes into the runtime goes through a published entry point of
`seedkernel-wasm` — see seedkernel's
[CLIENT](https://github.com/arj03/seedkernel/blob/main/docs/CLIENT.md) guide.

**Contents:** [Quick start](#quick-start) · [Using the shell](#using-the-shell) ·
[What's here](#whats-here) · [Writing your own chat app](#writing-your-own-chat-app) ·
[Protocol interop](#protocol-interop) · [The seedkernel surface chat uses](#the-seedkernel-surface-chat-uses) ·
[Troubleshooting](#troubleshooting)

## Quick start

### Prerequisites

- **Node.js ≥ 20.**
- **Sibling checkouts** of [seedkernel](https://github.com/arj03/seedkernel) and
  [seedrelay](https://github.com/arj03/seedrelay). Both are `file:` dependencies
  (`../seedkernel/WASM`, `../seedrelay`), so the layout must be:

  ```
  some-dir/
  ├── seedkernel/
  ├── seedrelay/
  └── seedchat/     ← this repo
  ```
- **clang**, for seedkernel's post-quantum C → wasm step.

### Build and run

```sh
# 1. build the seedkernel checkout it depends on (transport bundle + host + minified,
#    browser core libsodium and PQ wasm)
cd ../seedkernel/WASM && npm install && npm run build:browser

# 2. build chat (both app bundles + the offers boot bundle) and vendor the runtime
cd ../../seedchat && npm install && npm run build

# 2b. (optional) headless check that chat still works against this seedkernel:
#     two shells, a real chat app, a full message round-trip, an offer round-trip
npm run smoke

# 3. signaling rendezvous for the WebRTC mesh (kill it once channels are open)
npm run relay

# 4. in another terminal: re-vendor + serve browser/ with caching off
npm run serve        # → http://localhost:3000/chat-shell.html
```

Open the page in two tabs or two browsers and connect both to the same room on the
**Network** tab. Then load a chat app (below) in each.

| Script | What it does |
| --- | --- |
| `npm run build` | Compiles both AssemblyScript modules, embeds their UI and metadata, signs `bundle/chat-app-v1.skb` and `bundle/chat-app-v2.skb`, signs the offers boot bundle, then vendors the runtime. |
| `npm run build:chat-app-v1` / `build:chat-app-v2` | One app's compile → embed → sign pipeline. |
| `npm run build:offers-bundle` | Signs the offers app into `bundle/offers.skb` and generates `browser/offers-bundle.js`. |
| `npm run vendor` | Copies the built seedkernel host, libsodium, QuickJS and the seedrelay client into `browser/vendor/`. |
| `npm run smoke` | Headless regression test (needs `npm run build` first). Run it after every seedkernel update. |
| `npm run relay` | Starts the `seedrelay` WebSocket rendezvous on port 8080. |
| `npm run serve` | Re-vendors, then serves `browser/` on port 3000 with caching disabled. |
| `npm run clean` | Deletes `build/` and `browser/vendor/`. |

## Using the shell

**Identity.** Each tab mints an Ed25519 identity and keeps it in `sessionStorage`,
so closing the tab discards it. That is also why two tabs of the same browser are
two distinct peers.

**Loading an app.** On the **Apps** tab, pick or drop `bundle/chat-app-v1.skb` (or
`v2`). The browser only verifies the bundle's signature and admits it under the
shell's consent policy; it never signs anything itself. Dropping a newer `.skb` of
an app you already have is how you upgrade it.

**Offers.** Peers hand each other bundles in an `OFFER` frame; the recipient
re-verifies the original author's manifest signature. An Offer is installed on one
click, so the recipient also checks its *shape* before showing that click: one
module, the single protocol claim `chat`, and a guest whose reach is exactly `_net`
and nothing else. A signature says who wrote a bundle, not what it may reach — the
signed `guest.requires` list is where that is written down, host services and
co-resident guests alike (a chat app names no host service, and the network and
only that) — and this shell checks it exactly (`isChatApp` in
`browser/chat-app.js`), so it will not install an app claiming reach it did not ask
for.

**Rooms and invite links.** The `seedrelay` server is partitioned into **rooms**
(`ws://host:8080/<room>`, default `global`), set on the **Network** tab. A room can
be *open* or *gated*:

- An **open** room answers anyone who learns its name. Fine for `global` on a laptop.
- **Random** mints a private room name *and* a 32-byte contact secret, and the
  transport refuses peers that don't present it. **Copy invite link** produces
  `…/chat-shell.html#room=<name>&s=<hex>`. The secret rides in the URL fragment,
  which browsers never send over the network, so the relay learns the room name it
  needs for routing and never the credential. A peer with a wrong or missing secret
  is refused silently: it just never appears.

Either way, identity is bound in-channel by the transport bundle's HELLO/AUTH
handshake, so a relay can observe SDP metadata and refuse to forward, but can never
impersonate a peer.

**Other devices.** `localhost` is a secure context, so plain HTTP is enough for WebRTC
when both tabs are on this machine. Reaching the shell from another device needs HTTPS
(and a relay URL that device can reach; `wss://` if the page is served over HTTPS).

## What's here

| Path | What it is |
| --- | --- |
| `assembly/chat-app-v1/` | v1 handler — text only. `index.ts` is the pure transform, `ui.html` is the iframe UI embedded into the module as a custom section. |
| `assembly/chat-app-v2/` | v2 handler — text + image + nick. Same shape; upgrading v1→v2 is a re-admit at the same name under the same key. |
| `asconfig.chat-app-v*.json` | AssemblyScript compiler config for each handler (`build/chat-app-v*.wasm`). |
| `browser/chat-shell.*` | The browser shell: identity, admission policy, the transport-bundle and offers-bundle boot loads, a WebRTC mesh, the sandboxed iframe. The inline import map in `chat-shell.html` names the seedkernel surface. |
| `browser/chat-app.js` | The chat app *shape*, in one place: the guest's source, the `chat` protocol id, and its reach — no host service at all and one co-resident guest, the network (`guest.requires` is exactly `_net`). `scripts/build-app-bundle.mjs` and `scripts/smoke.mjs` author bundles from it; the shell gates received Offers against it with `isChatApp`. |
| `browser/offers-app.js` | The offers app *shape*: the `offer/v1` id, the app id `offers`, its one-service authority (`fs` — a host service, so it really is a `guest.requires` entry), and its guest source — a keyspace and a claim, no module. `scripts/build-offers-bundle.mjs` signs it into the boot bundle. |
| `browser/media-rtc.js` | The call feature: `MediaRtcNetwork`, a subclass of seedkernel's `RtcNetwork` that publishes camera/mic over the peer connections the data channel already uses. Live media is chat's own — the host's seam is raw I/O only. |
| `scripts/embed-ui.mjs` | Appends a `ui` custom section to a built `.wasm`. |
| `scripts/embed-meta.mjs` | Appends an `app_meta` JSON custom section (id, name, version, description). |
| `scripts/build-app-bundle.mjs` | The offline bundle author: signs a built + meta-embedded `.wasm` into a `.skb` under `chat-author.key`, tracking a monotonic freshness mark in `chat-author.version`. |
| `scripts/build-offers-bundle.mjs` | Signs the offers app's guest-only bundle under the same key, with its own freshness mark in `offers-author.version`. |
| `scripts/vendor.mjs` | Copies seedkernel's built host (`build-min`: `host/` + `services/`) into `browser/vendor/`, plus the browser libsodium, the QuickJS realm engine and the seedrelay client. Refuses a stale seedkernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam, round-trips a message through a real `chat-app-v1.wasm`, and round-trips an offer through the offers app. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

`ui` and `app_meta` are **chat-shell conventions, not runtime contracts** — the
host never reads either section. They live here because the reader lives here.

### Generated and local files (all gitignored)

| Path | What it is |
| --- | --- |
| `build/` | Compiled `.wasm` (and `.wat`) handlers. |
| `bundle/` | Signed bundles: `chat-app-v1.skb`, `chat-app-v2.skb`, `offers.skb`. |
| `browser/vendor/` | The vendored runtime the page loads. |
| `browser/offers-bundle.js` | The offers boot bundle embedded as a JS module, since the page is served from `browser/` and `bundle/` is not. |
| `chat-author.key` | The author signing key, minted on the first build. |
| `chat-author.version`, `offers-author.version` | Each app's version high-water mark. |

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

## Writing your own chat app

Any bundle the shell will install as a chat app has the same three layers. v1 is
the minimal reference: `assembly/chat-app-v1/index.ts`.

### 1. The module: a pure transform

An AssemblyScript (or any wasm) module exporting `scratch` (a pointer) and
`handle(input_len) → output_len`. The host stages the input at `scratch`, calls
`handle`, and reads the output back from the same region. It may export
`scratchSize` to ask for a larger region than the 128 KB default (v2 does, for
images). See seedkernel PROTOCOL §4 for the full ABI.

**Input**, as the host stages it:

```
[senderPk 32][chatType u8][body …]
```

The 32-byte sender key is prepended by the host after the channel has
authenticated the peer. The module never verifies anything. The `chatType ‖ body`
part is chat's own format, and the host never reads it:

| `chatType` | Body | Supported by |
| --- | --- | --- |
| `0x00` text | UTF-8 text | v1, v2 |
| `0x01` image | JPEG bytes | v2 |
| `0x02` nick | UTF-8 nick for this sender | v2 |

**Output (the render bytes)** is whatever your UI knows how to draw. Return `0` to
render nothing. Unknown `chatType`s should render nothing, which is how v1 stays
silent on v2's image and nick frames:

```
v1:  [chatType u8][pkLen u8][pk …][body …]
v2:  [chatType u8][pkLen u8][pk …][nickLen u8][nick …][body …]
```

### 2. The UI: `ui.html`

A self-contained HTML page, embedded into the `.wasm` as a `ui` custom section
by `scripts/embed-ui.mjs`. The shell loads it into an iframe sandboxed
`allow-scripts allow-forms` from a `blob:` URL, so it has no access to the page's
keys. It talks to the shell only via `postMessage`:

| Direction | Message | Meaning |
| --- | --- | --- |
| UI → shell | `{ type: "ready" }` | Sent once on load. The shell replies with `init`, then flushes any queued renders. |
| shell → UI | `{ type: "init", pk: Uint8Array(32) }` | This tab's own public key. |
| shell → UI | `{ type: "render", payload: Uint8Array }` | One set of render bytes from your module. This covers both inbound frames and the local echo of your own sends. |
| UI → shell | `{ type: "send", chatType: number, body: Uint8Array }` | Broadcast `[chatType][body]` to every linked peer under the `chat` protocol, and echo it locally through the module. |

### 3. Metadata and signing

Copy `asconfig.chat-app-v1.json` to `asconfig.my-chat.json`, point its entry and
output paths at your app, then run the same four steps the `build:chat-app-v*`
npm scripts do:

```sh
npx asc assembly/my-chat/index.ts --config asconfig.my-chat.json --target release
node scripts/embed-ui.mjs   build/my-chat.wasm assembly/my-chat/ui.html build/my-chat.wasm
node scripts/embed-meta.mjs build/my-chat.wasm build/my-chat.wasm \
  '{"id":"chat","name":"My chat","version":"v1","description":"…"}'
node scripts/build-app-bundle.mjs build/my-chat.wasm bundle/my-chat.skb
```

The `id` in
`app_meta` becomes the manifest's `app` label and the module name, and must match
`[A-Za-z0-9_-]{1,64}`. Keeping it `chat` means your bundle upgrades or replaces
the existing chat app instead of being refused alongside it (see
[Protocol interop](#protocol-interop)). `build-app-bundle.mjs` supplies the
guest (`chatGuestSource`), the `chat` protocol claim and the `_net`-only reach
itself, so your bundle passes the shell's shape check without any extra steps.

There is no in-browser signing: anyone installing a custom app builds their own
`.skb` with `scripts/build-app-bundle.mjs`. Admission trust is purely "did I
consent to install this bundle", never "did I sign it as myself".

## Protocol interop

A chat frame carries a *protocol id*, not an app name. Every chat app's signed
manifest claims the one id `chat` (`CHAT_PROTO`, `browser/chat-app.js`), and
installing an app is what routes it — so two peers running different authors'
chat apps interoperate as long as both speak the protocol, and neither had to
point anything at anything. A claim has one holder, so a node runs one chat app
at a time. A second one under the same `app` label **replaces** the first:
accept a peer's Offer and their app becomes the one this node chats with. The
author's own next version upgrades in one click; a different author's app asks
first, because it takes over the label's data and signing scope along with the
slot (seedkernel §12.4). One under a different label is refused while the first
holds `chat` — remove the first to install it.

## The seedkernel surface chat uses

Nine published entry points of `seedkernel-wasm`, across the browser shell and the
build/smoke scripts:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm` | Node `loadCrypto()` in the offline bundle builders and the headless smoke test. |
| `seedkernel-wasm/shell-core` | `bootShell` — the one assembly (§12.9): the transport bundle pinned to its own author, the adapter built around the supplied `transport.channels` factory, and the boot loads. Chat's `admit` composes the offers-pin and the consent gate. Its `Shell.call` is the host's own door into a co-resident guest's `services` claim, which is how the peer pill asks the transport who is linked. |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes()` and `TRANSPORT_SERVICE` — the seedkernel-shipped transport bundle as raw bytes, and the local service id it claims, used by the headless smoke assertions (§12.6); browser boot gets the same artifact through `bootShell`. |
| `seedkernel-wasm/bundle` | `verifyBundle` — the one call that unpacks and checks an offered bundle (`peekMeta`) — and `genesisHash`, the module hash the consent gate keys on. The browser only verifies; peer attribution uses its node public key. |
| `seedkernel-wasm/bundle-author` | `authorBundle`, `guestOpFraming` and `hybridAuthorKeysFromSeed` in the offline `build-app-bundle.mjs` and `build-offers-bundle.mjs` scripts. This entry point is never imported by the browser shell. |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the relay-signaled WebRTC `ChannelFactory`, constructed before `bootShell` and subclassed for calls in `browser/media-rtc.js`. |
| `seedkernel-wasm/op-frame` | `writeOp` — the signed apps' own operation framing for local guest invocations — and `OpArgs`, the transport bundle's argument writer, paired with its reader so a host-side call cannot drift from what the guest parses. |
| `seedkernel-wasm/crypto-browser` | `loadCrypto` — the browser build of the same crypto seam Node's `loadCrypto` provides. |
| `seedkernel-wasm/libsodium` | The browser libsodium build. |

The import map in `chat-shell.html` also maps `seedkernel-wasm/quickjs`. Chat
never imports it; the vendored host does, for its QuickJS realms.

The JSON-over-WebSocket rendezvous is deliberately not another seedkernel entry point.
`seedrelay` owns both its bounded server and reconnectable client adapter; chat owns
only the selected URL, room, credential, and UI lifecycle.

Plus one on the guest side: the app modules define their two memory-layout
literals — `PK_LEN = 32` and `PRIV_USER_OFF = 0` — alongside their layout
comments (§4).

Three properties serve as the summary; the details live in the seedkernel docs:

- **The protocol is a bundle; the sockets are the platform's.** The channel AKE,
  record layer and request/response layer ship as a signed transport bundle
  serving the local service name `_net`, embedded in the host and reached as raw
  bytes through `transport-bundle`. The host side — link ids and sockets — is
  `bootShell`'s channel adapter, built around the platform's `RtcNetwork`
  ChannelFactory supplied as `transport.channels`; transport policy and its
  defaults belong to the signed bundle, as do the address book and contact gate,
  which live in that bundle's own realm rather than under the adapter. Chat rotates
  the gate with the transport's local `contact` operation (the room secret) before
  opening signaling;
  it never writes an address because an RTC peer arrives as an accepted link the
  signaling already named, not as an address something dialed
  (§12.6, [CHANNEL](https://github.com/arj03/seedkernel/blob/main/docs/CHANNEL.md)).
- **The offers app gets a pin, chat's own half of it.** `offer/v1` carries a
  signed bundle for an app that does not exist yet, so something already
  installed at boot owns the name and `admit` allows exactly the author and app
  the page was built with — a pin, not a consent prompt. Chat's own consent gate
  is everything else.
- **Both directions cross an app's guest.** The host has no send and no receive:
  an inbound frame reaches the shell as the link occupant's own delivery return,
  and an outbound frame leaves by an app *calling* `_net`. The render bytes a
  chat app's guest returns for an inbound frame are that call's answer, read off
  the load's own `onInbound` (§12.10) — no second claim, no host-side tap. The
  page's own questions go the same way: "who is linked" is a call on `_net`
  through `Shell.call`, not a field on the adapter, because links are the
  transport guest's and the adapter knows only sockets.

The browser JS entry points are declared in exactly two places: the imports at the top of
`chat-shell.js`, and the inline import map in `chat-shell.html`. The CSP allows
inline scripts (`'unsafe-inline'`) because app UIs run in a sandboxed `blob:`
iframe that inherits this page's policy — the iframe sandbox is the actual
boundary. Nothing else in this repo reaches into `node_modules`. If a seedkernel
change breaks chat, it broke a public export — which is the point of chat living
out here.

## Troubleshooting

- **The shell fails in ways that look like seedkernel bugs after a rebuild.**
  Almost always a stale cache. `npm run serve` passes `-c-1` for this reason: a
  plain `http-server` defaults to `max-age=3600`, so the browser keeps serving an
  old `vendor/host`. Hard-reload, and if a rebuild still doesn't take,
  `npm run clean && npm run build` starts from nothing.
- **`npm run vendor` refuses with a staleness error.** seedkernel's `build/` is
  newer than its `build-min/`, which happens when you rerun its `tsc` without
  minifying. Rerun `npm run build:browser` in `../seedkernel/WASM`.
- **`seedkernel-wasm not found` / `seedrelay not found`.** The sibling checkouts
  are missing or misnamed; see [Prerequisites](#prerequisites).
- **`npm run smoke` can't find `build/chat-app-v1.wasm` or `bundle/offers.skb`.**
  Run `npm run build` first.
- **Peers never appear.** Both tabs must use the same relay URL and room. In a
  gated room they must also hold the same secret, so share the invite link rather
  than the room name: a peer with the wrong secret is refused without any error.
- **A dropped `.skb` says "Not a valid app bundle", or a peer's Offer never
  shows up.** The bundle failed verification or the `isChatApp` shape check (an
  Offer that fails is dropped silently). A chat app needs exactly one module, the
  single protocol claim `chat`, `guest.requires` exactly `["_net"]`, and an
  `app_meta` section in its module.
