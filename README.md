# seedchat — the chat app layer for [seedkernel](https://github.com/arj03/seedkernel)

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

This lives outside the kernel repo for the same reason
[seed store](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The kernel repo stays runtime-only, and every reach
chat makes into the runtime goes through the six published entry points in
[EXPORTS](https://github.com/arj03/seedkernel/blob/main/docs/EXPORTS.md).

The runtime mechanics — the pure-transform boundary, the assembly, protocol
routing, signed bundles, the channel handshake — are documented in the kernel:
[RUNTIME](https://github.com/arj03/seedkernel/blob/main/docs/RUNTIME.md) (§4, §11,
§12), [PROTOCOL](https://github.com/arj03/seedkernel/blob/main/docs/PROTOCOL.md),
[CHANNEL](https://github.com/arj03/seedkernel/blob/main/docs/CHANNEL.md).

## What's here

| Path | What it is |
| --- | --- |
| `assembly/chat-app-v1/` | v1 handler — text only. `index.ts` is the pure transform, `ui.html` is the iframe UI embedded into the module as a custom section. |
| `assembly/chat-app-v2/` | v2 handler — text + image + nick. Same shape; upgrading v1→v2 is a re-admit at the same name under the same key. |
| `browser/chat-shell.*` | The browser shell: identity, admission policy, the transport-bundle and offers-bundle boot loads, a WebRTC mesh, the sandboxed iframe. The inline import map in `chat-shell.html` names the kernel surface. |
| `browser/chat-app.js` | The chat app *shape*, in one place: the guest's source, the `chat` protocol id grammar, and its one-service authority (`_net`). The shell authors bundles from it and gates received Offers against it; `scripts/smoke.mjs` imports the same file. |
| `browser/offers-app.js` | The offers app *shape*: the `offer/v1` id, the app id `offers`, its one-service authority (`fs`), and its guest source — a keyspace and a claim, no module. `scripts/build-offers-bundle.mjs` signs it into the boot bundle. |
| `browser/media-rtc.js` | The call feature: `MediaRtcNetwork`, a subclass of the kernel's `RtcNetwork` that publishes camera/mic over the peer connections the data channel already uses. Live media is chat's own — the kernel seam is raw I/O only. |
| `scripts/embed-ui.mjs` | Appends a `ui` custom section to a built `.wasm`. |
| `scripts/embed-meta.mjs` | Appends an `app_meta` JSON custom section (id, name, version). |
| `scripts/build-app-bundle.mjs` | The offline bundle author: signs a built + meta-embedded `.wasm` into a `.skb` under `chat-author.key` (auto-minted on first run, gitignored), tracking a monotonic freshness mark in `chat-author.version`. |
| `scripts/build-offers-bundle.mjs` | Signs the offers app's guest-only bundle under the same key, its own freshness mark in `offers-author.version`. |
| `scripts/vendor.mjs` | Copies the kernel's built host (`build-min`: `host/` + `core/`) into `browser/vendor/`, plus the browser libsodium and the QuickJS realm engine. Refuses a stale kernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam, round-trips a message through a real chat-app-v1.wasm, and round-trips an offer through the offers app. Run it after a kernel update. |
| `seedrelay` (sibling dependency) | The app-neutral WebSocket rendezvous server and reconnectable signaling client shared with seedstore. `npm run relay` invokes its CLI. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

`ui` and `app_meta` are **chat-shell conventions, not runtime contracts** — the
kernel never reads either section. They live here because the reader lives here.

## The kernel surface chat uses

Nine published entry points of `seedkernel-wasm` across the browser and build/smoke scripts:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm` | Node `loadCrypto()` in the headless smoke test. |
| `seedkernel-wasm/shell-core` | `bootShell` — the one assembly (§12.9): the transport bundle pinned to its own author, the adapter built around the supplied `transport.channels` factory, and the boot loads. Chat's `admit` composes the offers-pin and the consent gate. |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes()` — the kernel-shipped transport bundle as raw bytes used by the headless smoke assertions (§12.6); browser boot gets the same artifact through `bootShell`. |
| `seedkernel-wasm/bundle` | `verifyBundle` — the one call that unpacks and checks an offered bundle (`peekMeta`). The browser only verifies; peer attribution uses its node public key. |
| `seedkernel-wasm/bundle-author` | `authorBundle` and `hybridAuthorKeysFromSeed` in the offline `build-app-bundle.mjs` and `build-offers-bundle.mjs` scripts. This entry point is never imported by the browser shell. |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the relay-signaled WebRTC `ChannelFactory`, constructed before `bootShell` and subclassed for calls in `browser/media-rtc.js`. |
| `seedkernel-wasm/op-frame` | `writeOp` — the signed apps' own operation framing for local guest invocations. |
| `seedkernel-wasm/crypto-browser` | `loadCrypto` — the browser build of the same crypto seam Node's `loadCrypto` provides |
| `seedkernel-wasm/libsodium` | the browser libsodium build |

The JSON-over-WebSocket rendezvous is deliberately not another kernel entry point.
`seedrelay` owns both its bounded server and reconnectable client adapter; chat owns
only the selected URL, room, credential, and UI lifecycle.

Plus one on the guest side: the app modules define their two memory-layout
literals — `PK_LEN = 32` and `PRIV_USER_OFF = 0` — alongside their layout
comments (§4).

Three properties serve as the summary; the details live in the kernel docs:

- **The protocol is a bundle; the sockets are the platform's.** The channel AKE,
  record layer and request/response layer ship as a signed transport bundle
  serving the local service name `_net`, embedded in the host and reached as raw
  bytes through `transport-bundle`. The host side — link ids, sockets and the
  address book — is `bootShell`'s channel adapter, built around the platform's
  `RtcNetwork` ChannelFactory supplied as `transport.channels`; transport policy
  and its defaults belong to the signed bundle
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
  the load's own `onInbound` (§12.10) — no second claim, no host-side tap.

The browser JS entry points are declared in exactly two places: the imports at the top of
`chat-shell.js`, and the inline import map in `chat-shell.html`. The CSP allows
inline scripts (`'unsafe-inline'`) because app UIs run in a sandboxed `blob:`
iframe that inherits this page's policy — the iframe sandbox is the actual
boundary. Nothing else in this repo reaches into `node_modules`. If a kernel
change breaks chat, it broke a public export — which is the point of chat living
out here.

## Build and run

```sh
# 1. build the kernel checkout it depends on (transport bundle + host + minified,
#    browser core libsodium and PQ wasm; needs clang for the PQ C → wasm step)
cd ../seedkernel/WASM && npm install && npm run build:browser

# 2. build chat and vendor the runtime
cd ../../seedchat && npm install && npm run build

# 2b. (optional) headless check that chat still works against this kernel:
#     two shells, a real chat app, a full message round-trip
npm run smoke

# 3. signaling rendezvous for the WebRTC mesh (kill it once channels are open)
npm run relay

# 4. in another terminal: re-vendor + serve browser/ with caching off
npm run serve        # → http://localhost:3000/chat-shell.html, open it in two browsers
```

`serve` passes `-c-1`, which is not optional in practice: a plain `http-server`
defaults to `max-age=3600`, so after a rebuild the browser keeps serving a stale
`vendor/host` and the shell fails in ways that look like kernel bugs. If a rebuild
still doesn't take, `npm run clean && npm run build` starts from nothing.

`localhost` is a secure context, so plain HTTP is enough for WebRTC when both tabs
are on this machine; reaching the shell from another device needs HTTPS.

Load an app by picking `bundle/chat-app-v1.skb` (or `v2`, both written by `npm run
build`) in the shell — the browser only verifies the bundle's signature and admits
it under the shell's policy. Dropping a newer `.skb` of an app you already have is
how you upgrade it. Peers hand each other the same bundles in an `OFFER` frame;
the recipient re-verifies the original author's manifest signature. An Offer is
installed on one click, so the recipient also checks its *shape* before showing
that click: one module, and a guest whose reach is exactly `_net` and nothing
else. A signature says who wrote a bundle, not what it may reach —
`guest.requires` is where that is written down, and this shell will not install
an app claiming reach it did not ask for.

Anyone wanting to install a custom app builds their own `.skb` with
`scripts/build-app-bundle.mjs` — there is no per-browser-session self-signing
anymore, so admission trust is purely "did I consent to install this bundle",
never "did I sign it as myself".

The `seedrelay` server is partitioned into **rooms** (`ws://host:8080/<room>`, default
`global`), set on the shell's **Network** tab. A room is *not* an authenticated
channel — knowing the name is the only credential — but identity is bound
in-channel by the transport bundle's HELLO/AUTH handshake, so a relay can observe
SDP metadata and refuse to forward, and can never impersonate a peer.

## Protocol interop

A chat frame carries a *protocol id*, not an app name. Every chat app's signed
manifest claims the one id `chat` (`CHAT_PROTO`, `browser/chat-app.js`), and
installing an app is what routes it — so two peers running different authors'
chat apps interoperate as long as both speak the protocol, and neither had to
point anything at anything. Installing a second chat app therefore **takes
`chat` over**: accept a peer's Offer and their app becomes the one this node
chats with. The displaced app stays installed and intact — the Apps panel shows
it as *claims “chat” — taken over by …* — and gets the protocol back the moment
the newcomer is removed. That is the whole of rebinding (§12.10).
