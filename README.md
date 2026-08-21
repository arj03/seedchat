# seedchat — the chat app layer for [seedkernel](https://github.com/arj03/seedkernel)

Chat is the smallest possible app on the runtime: a confined JS **guest** over a
single **pure-transform** WASM module. The guest is a few lines — its one `handle`
entrypoint forwards an inbound frame to the module by name on the same `host.call`
seam, returns the render bytes (relaying them to the shell's own `_render` name, the
one direction the seam cannot push), and serves the local `send` op (a loopback that
puts a frame on the wire by calling the local service name the transport serves) —
and the module does no I/O and no crypto: it reads `senderPk ‖ chatType ‖ body` and
returns render bytes for the UI. Everything around it — authenticating the sender,
moving frames, driving the iframe — is the runtime's job, because a pure transform
has no reach of its own and a guest reaches the world only through `host.call`.

This lives outside the kernel repo for the same reason
[seed store](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The kernel repo stays runtime-only, and every reach
chat makes into the runtime has to go through a published entry point.

## What's here

| Path | What it is |
| --- | --- |
| `assembly/chat-app-v1/` | v1 handler — text only. `index.ts` is the pure transform, `ui.html` is the iframe UI embedded into the module as a custom section. |
| `assembly/chat-app-v2/` | v2 handler — text + image + nick. Same shape; upgrading v1→v2 is a re-admit at the same name under the same key. |
| `browser/chat-shell.*` | The browser shell: identity, admission policy, the transport-bundle network under a WebRTC mesh, the sandboxed iframe. Roughly 1,700 lines. The inline import map in `chat-shell.html` names the kernel surface. |
| `browser/chat-app.js` | The chat app *shape*, in one place: the guest's source (both directions), the id grammar it may be built from, and the network-and-nothing-else authority a chat app holds — `_net` to reach the transport, `_render` to hand its render bytes back to the shell. The shell authors bundles from it and gates received Offers against it; `scripts/smoke.mjs` imports the same file, so the guest source that gets signed is written once. |
| `browser/media-rtc.js` | The call feature: `MediaRtcNetwork`, a subclass of the kernel's `RtcNetwork` that publishes camera/mic over the peer connections the data channel already uses. The kernel seam is raw I/O only, so live media is chat's — it renegotiates through the seam's own perfect-negotiation path and adds no signaling. |
| `scripts/embed-ui.mjs` | Appends a `ui` custom section to a built `.wasm`. |
| `scripts/embed-meta.mjs` | Appends an `app_meta` JSON custom section (id, name, version). |
| `scripts/vendor.mjs` | Copies the kernel's built host (`build-min`: `host/` + `core/`) into `browser/vendor/`, plus the browser libsodium, `mldsa65.wasm`, and the QuickJS realm engine (safe-js's graph), for a bundler-free static serve. Refuses a stale (un-minified-since-compile) kernel build. |
| `scripts/smoke.mjs` | Headless regression test: boots two shells over the transport bundle's channel seam and round-trips a message through a real chat-app-v1.wasm. Run it after a kernel update. |
| `scripts/relay.mjs` | The WebSocket signaling rendezvous for the WebRTC mesh. App-neutral — seed store points at this file too. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

`ui` and `app_meta` are **chat-shell conventions, not runtime contracts** — the
kernel never reads either section. They live here because the reader lives here.

## The kernel surface chat uses

The entire dependency is nine published entry points of `seedkernel-wasm`:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm/shell-core` | `bootShell` — the ONE assembly (§12.9): platform members defaulted, the transport bundle pinned to its own author, the adapter taken as the instance below. Chat's `admit` is only its consent gate. |
| `seedkernel-wasm/transport-host` | `TransportHost` — the channel adapter the platform owns, whose raw-link events the shell binds to whichever admitted slot holds the `link` capability. Handed to `bootShell` as an instance, so chat owns its transport-bundle load. |
| `seedkernel-wasm/transport-bundle` | `transportBundleBytes()` — the kernel-shipped transport bundle as raw bytes (§12.6) |
| `seedkernel-wasm/bundle` | `signManifest`, `packBundle`, `unpackBundle`, `verifyManifest`, `genesisHash`, `MANIFEST_FILE`, `GUEST_FILE`, `moduleFile` — chat authors and signs app bundles at runtime, the same API seedstore's build uses offline |
| `seedkernel-wasm/guest-seam` | `GUEST_ABI_VERSION` — the guest seam version the chat bundle's guest declares |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the relay-signaled WebRTC mesh, subclassed for calls in `browser/media-rtc.js` |
| `seedkernel-wasm/safe-js` | `createSafeRealm` — the QuickJS realm every app's guest runs in (the transport bundle's and each chat app's) |
| `seedkernel-wasm/pq` | `withMlDsa65`, `loadMlDsa65` — the browser's substitute for Node's `loadCrypto` |
| `seedkernel-wasm/libsodium` | the browser libsodium build |

Plus one on the guest side: the app modules import `PK_LEN` and `PRIV_USER_OFF`
from `seedkernel-wasm/guest-handler` — the AssemblyScript half of the handler ABI
(§4). It is imported, never vendored: an ABI that apps fork is an ABI that drifts.

**The protocol is a bundle; the sockets are the platform's.** The channel AKE, record
layer and request/response layer ship as a *signed transport bundle* that serves the
local service name `_net` (an ordinary `_`-led claim, chosen by the composition that
built it — no kernel semantics attach to the spelling), embedded in the host and
reached as raw bytes through `seedkernel-wasm/transport-bundle`. What stays host-side
is the `TransportHost` — link ids, the address book, the handshake budgets — which
chat constructs itself and hands to `bootShell` as `transport` (an instance, so
`bootShell` neither loads the bundle nor starts the listeners: chat loads at first
relay connect and re-loads to change its room secret). The shell's whole part is
binding the adapter's raw-link events to the slot that owns the `link` capability,
and `shell.close()` closes it. Admission is the assembly's composition: **an implicit
author pin** — only the exact artifact this host ships may reach the `link` and
`route` privileges (raw links and attributed inbound delivery, both), derived from the
blob itself so nobody can lose it by forgetting it — composed around chat's own gate,
which is the consent dialog and nothing else. Chat rebuilds the `RtcNetwork` under the
bundle whenever the room secret changes, because the accepting-side gate is re-read each
time a fresh transport load activates the binding.

**Both directions cross an app's guest.** The host has no send and no receive: an
inbound frame reaches the shell as the transport's `route/deliver` submission and is
routed to the app claiming the protocol, and an outbound frame leaves by an app
*calling* `_net` — so a chat app's manifest declares exactly those two local names,
and its guest serves the local `send` op on the one `handle` (`browser/chat-app.js`).
The shell drives it with a loopback `invoke`, once per linked peer. The shell's own
claims (`createShell({ claims })`) are `offer/v1`, the bundle-in-transit id whose
handler is the thing being offered, and `_render`, the name a chat app's guest pushes
its inbound render bytes through — the receiving shell's view of the answer, since
the routing's reply goes back over the wire and there is no host-side tap. The
spellings are the reach: an ordinary id is what a peer may name, and a `_`-led one is
refused on the inbound path whoever claims it, the shell itself included.

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

Load an app by picking `build/chat-app-v1.wasm` (or `v2`) in the shell — it
builds a signed one-module bundle from the local identity, verifies it, and the
loader admits it under the shell's policy. Peers hand each other the same bundles
in an `OFFER` frame; the recipient re-verifies the original author's manifest
signature, so a bundle survives any number of relays and still authenticates
against whoever wrote it. An Offer is installed on one click, so the recipient
also checks its *shape* before showing that click: one module, and a guest whose
reach is exactly `_net` and `_render` and nothing else (`browser/chat-app.js`). A
signature says who wrote a bundle, not what it may reach — `guest.requires` is where
that is written down, and this shell will not install an app claiming reach it did
not ask for.

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
