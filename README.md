# seedchat — the chat app layer for [seedkernel](https://github.com/arj03/seedkernel)

Chat is the smallest possible app on the runtime: a confined JS **guest** over a
single **pure-transform** WASM module. The guest is a few lines — its one `handle`
entrypoint forwards an inbound frame to the module by name on the same `host.call`
seam and returns whatever it answers: the render bytes, which the loader that
mounted this app receives straight off its own load (`onInbound`, §12.10) — and
serves the local `send` op (a loopback that puts a frame on the wire by calling the
local service name the transport serves) — and the module does no I/O and no
crypto: it reads `senderPk ‖ chatType ‖ body` and returns render bytes for the UI.
Everything around it — authenticating the sender, moving frames, driving the iframe
— is the runtime's job, because a pure transform has no reach of its own and a
guest reaches the world only through `host.call`.

A second, smaller app rides alongside it: **offers**, a guest with no module at all
(`browser/offers-app.js`), whose whole job is owning the `offer/v1` id a peer's
signed bundle arrives on. It exists because a chat app can't hold that name itself
— the app an Offer would install is the thing the Offer is offering, so until
someone accepts it there is no app to route it to. Both apps are loaded as **boot
bundles**, pinned to the exact author and app the page was built with, the same way
the kernel pins its own transport bundle.

This lives outside the kernel repo for the same reason
[seed store](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The kernel repo stays runtime-only, and every reach
chat makes into the runtime has to go through a published entry point.

## What's here

| Path | What it is |
| --- | --- |
| `assembly/chat-app-v1/` | v1 handler — text only. `index.ts` is the pure transform, `ui.html` is the iframe UI embedded into the module as a custom section. |
| `assembly/chat-app-v2/` | v2 handler — text + image + nick. Same shape; upgrading v1→v2 is a re-admit at the same name under the same key. |
| `browser/chat-shell.*` | The browser shell: identity, admission policy, the transport-bundle and offers-bundle boot loads, a WebRTC mesh, the sandboxed iframe. The inline import map in `chat-shell.html` names the kernel surface. |
| `browser/chat-app.js` | The chat app *shape*, in one place: the guest's source (both directions), the id grammar it may be built from, and the network-and-nothing-else authority a chat app holds — `_net` to reach the transport, and nothing else; its render bytes are the answer to an inbound frame, read off the load's own `onInbound` (§12.10), not a second claim. The shell authors bundles from it and gates received Offers against it; `scripts/smoke.mjs` imports the same file, so the guest source that gets signed is written once. |
| `browser/offers-app.js` | The offers app *shape*: the `offer/v1` id, the app id `offers`, its one-service authority (`fs`), and its guest source — a keyspace and a claim, no module, no network, no signing. `scripts/build-offers-bundle.mjs` signs it into the boot bundle every page loads. |
| `browser/media-rtc.js` | The call feature: `MediaRtcNetwork`, a subclass of the kernel's `RtcNetwork` that publishes camera/mic over the peer connections the data channel already uses. The kernel seam is raw I/O only, so live media is chat's — it renegotiates through the seam's own perfect-negotiation path and adds no signaling. |
| `scripts/embed-ui.mjs` | Appends a `ui` custom section to a built `.wasm`. |
| `scripts/embed-meta.mjs` | Appends an `app_meta` JSON custom section (id, name, version). |
| `scripts/build-app-bundle.mjs` | The offline bundle author: signs a built + meta-embedded `.wasm` into a `.skb` under `chat-author.key` (auto-minted on first run, gitignored), tracking a monotonic freshness mark in `chat-author.version`. Anyone wanting to install a custom app builds their own `.skb` with this script instead of dragging a raw `.wasm` into the browser. |
| `scripts/build-offers-bundle.mjs` | Signs the offers app's guest-only bundle under the same `chat-author.key`, its own freshness mark in `offers-author.version`, and writes both `bundle/offers.skb` and the tracked, generated `browser/offers-bundle.js` — the embedded module that gets the boot bundle's bytes to the served page, in the shape of the kernel's own `host/transport-bundle.ts`. |
| `scripts/vendor.mjs` | Copies the kernel's built host (`build-min`: `host/` + `core/`) into `browser/vendor/`, plus the browser libsodium, `mldsa65.wasm`, and the QuickJS realm engine (safe-js's graph), for a bundler-free static serve. Refuses a stale (un-minified-since-compile) kernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam, round-trips a message through a real chat-app-v1.wasm, and round-trips an offer through the offers app. Run it after a kernel update. |
| `scripts/relay.mjs` | The WebSocket signaling rendezvous for the WebRTC mesh. App-neutral — seed store points at this file too. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

`ui` and `app_meta` are **chat-shell conventions, not runtime contracts** — the
kernel never reads either section. They live here because the reader lives here.

## The kernel surface chat uses

The entire dependency is seven published entry points of `seedkernel-wasm`:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm/shell-core` | `bootShell` — the ONE assembly (§12.9): platform members defaulted, the transport bundle pinned to its own author, the adapter taken as the instance below. Chat's `admit` composes two things of its own: the offers boot bundle's author+app pin (chat-shell.js, alongside `browser/offers-bundle.js`) and the consent gate for everything else. |
| `seedkernel-wasm/transport-host` | `TransportHost` — the channel adapter the platform owns, whose raw-link events the shell binds to whichever admitted slot holds the `link` capability. Handed to `bootShell` as an instance, so chat owns its transport-bundle load. |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes()` — the kernel-shipped transport bundle as raw bytes (§12.6) |
| `seedkernel-wasm/bundle` | `verifyBundle` — the one call that unpacks and checks an offered bundle (`peekMeta`); `hybridAuthorKeysFromSeed`/`hybridAuthorId` derive this browser's own author id from its key seed. Authoring is offline (`scripts/build-app-bundle.mjs`, `scripts/build-offers-bundle.mjs`, `authorBundle`), the same API seedstore's build uses. `scripts/smoke.mjs` also reaches the module's lower-level primitives, to forge and tamper with bundles the verifier must reject — a test path, not the shell's |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the relay-signaled WebRTC mesh, subclassed for calls in `browser/media-rtc.js` |
| `seedkernel-wasm/crypto-browser` | `loadCrypto` — the browser build of the same crypto seam Node's `loadCrypto` provides |
| `seedkernel-wasm/libsodium` | the browser libsodium build |

Plus one on the guest side: the app modules define their two memory-layout
literals — `PK_LEN = 32` (the sender pk the shell prepends) and
`PRIV_USER_OFF = 0` (where app bookkeeping starts in private memory) — alongside
their own layout comments (§4).

**The protocol is a bundle; the sockets are the platform's.** The channel AKE, record
layer and request/response layer ship as a *signed transport bundle* that serves the
local service name `_net` — declared under the manifest's `services` claim, which is a
co-resident guest's to reach and never a peer's (chosen by the composition that built
it — no kernel semantics attach to the spelling), embedded in the host and
reached as raw bytes through `seedkernel-wasm/transport-bundle`. What stays host-side
is the `TransportHost` — link ids, the address book, the handshake budgets — which
chat constructs itself and hands to `bootShell` as `transport` (an instance, so
`bootShell` neither loads the bundle nor starts the listeners: chat loads at first
relay connect and re-loads to change its room secret). The shell's whole part is
binding the adapter's raw-link events to the slot that owns the `link` capability,
and `shell.close()` closes it. Admission is the assembly's composition: **an implicit
author pin** — only the exact artifact this host ships may reach the `link` and
`route` privileges (raw links and attributed inbound delivery, both), derived from the
blob itself so nobody can lose it by forgetting it — composed around chat's own gate.
Chat rebuilds the `RtcNetwork` under the bundle whenever the room secret changes,
because the accepting-side gate is re-read each time a fresh transport load activates
the binding.

**The offers app gets the same kind of pin, chat's own half of it.** `offer/v1`
carries a signed bundle from one browser to another, and the app that would handle it
is the thing being offered — so until an Offer is accepted there is no app to route
it to, and something already installed at boot has to own the name
(`browser/offers-app.js`). Chat loads it right beside the transport, and `admit`
checks the exact author and app the page was built with (`browser/offers-bundle.js`,
generated by `scripts/build-offers-bundle.mjs`) — a pin, not a consent prompt, for the
same reason the transport is one: it is loaded once, under bytes this deployment
shipped, before any dialog could run. Chat's own consent gate is everything else.

**Both directions cross an app's guest.** The host has no send and no receive: an
inbound frame reaches the shell as the link occupant's own delivery return — the
transport's `linkBytes` invocation answers with the request it decoded, and the host's
claim routing is what hands it to the app claiming the protocol — and an outbound frame leaves by an app
*calling* `_net` — so a chat app's manifest declares exactly that one local name,
and its guest serves the local `send` op on the one `handle` (`browser/chat-app.js`).
The shell drives it with a loopback `invoke`, once per linked peer. The render bytes a
chat app's guest returns for an inbound frame ARE that call's answer, and the loader
that mounted the app receives them straight off its own load's `onInbound`
(seedkernel §12.10) — no second claim, no host-side tap needed. The page's own view of
a fresh Offer works the same way: the offers app's guest answers with the blob's hash,
and the boot load's `onInbound` is what tells chat to go read the fs record it just
wrote. Neither app holds a name of its own beyond the one thing it exists to serve.

The JS entry points are declared in exactly two places: the imports at the top of
`chat-shell.js`, and the inline import map in `chat-shell.html` (which also names
every bare specifier in safe-js's vendored QuickJS graph). The CSP allows inline
scripts (`'unsafe-inline'`) because app UIs run in a sandboxed `blob:` iframe that
inherits this page's policy, and the UI is arbitrary app content the shell cannot
pre-authorize with a hash or nonce — the iframe sandbox (no `allow-same-origin`)
is the actual boundary. Nothing else in this repo reaches into `node_modules`. If
a kernel change breaks chat, it broke a public export — which is the point of chat
living out here.

## Build and run

```sh
# 1. build the kernel checkout it depends on (transport bundle + host + minified,
#    browser libsodium, PQ wasm; needs clang for the PQ C → wasm step)
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
still doesn't take, `npm run clean && npm run build` starts from nothing. `vendor`
also refuses to run when the kernel's `build-min` is older than its `build` — the
silent divergence where the kernel's own tests stay green against fresh code while
chat serves the last minified build.

`localhost` is a secure context, so plain HTTP is enough for WebRTC when both tabs
are on this machine; reaching the shell from another device needs HTTPS.

Load an app by picking `bundle/chat-app-v1.skb` (or `v2`, both written by `npm run
build`) in the shell — the browser only verifies the bundle's signature and admits
it under the shell's policy; no signing happens in the browser. Dropping a newer
`.skb` of an app you already have is how you upgrade it: the shell's install path
is the same one either way, so a re-drop from the same author replaces the running
app in place. Peers hand each other the same bundles in an `OFFER` frame; the
recipient re-verifies the original author's manifest signature, so a bundle
survives any number of relays and still authenticates against whoever wrote it. An
Offer is installed on one click, so the recipient also checks its *shape* before
showing that click: one module, and a guest whose reach is exactly `_net` and
nothing else (`browser/chat-app.js`). A signature says who wrote a
bundle, not what it may reach — `guest.requires` is where that is written down, and
this shell will not install an app claiming reach it did not ask for.

Anyone wanting to install a custom app builds their own `.skb` with
`scripts/build-app-bundle.mjs` — there is no per-browser-session self-signing
anymore, so admission trust is purely "did I consent to install this bundle",
never "did I sign it as myself".

The relay is partitioned into **rooms** (`ws://host:8080/<room>`, default
`global`), set on the shell's **Network** tab. A room is *not* an authenticated
channel — knowing the name is the only credential — but identity is bound
in-channel by the transport bundle's HELLO/AUTH handshake, so a relay can observe
SDP metadata and refuse to forward, and can never impersonate a peer.

## Protocol interop

A chat frame carries a *protocol id*, not an app name. Every chat app's signed
manifest claims the one id `chat` (`CHAT_PROTO`, `browser/chat-app.js`), and
installing an app is what routes it — so two peers running different authors'
chat apps interoperate as long as both speak the protocol, and neither had to
point anything at anything.

Installing a second chat app therefore **takes `chat` over**: accept a peer's
Offer and their app becomes the one this node chats with. The displaced app stays
installed and intact — the Apps panel shows it as *claims “chat” — taken over by
…* — and gets the protocol back the moment the newcomer is removed. That is the
whole of rebinding. See §11 and §12.10 in the kernel's `docs/RUNTIME.md`.
