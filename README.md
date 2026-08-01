# seedchat — the chat app layer for [seedkernel](https://github.com/arj03/seedkernel)

Chat is the simplest possible app on the kernel: a single **pure-transform** WASM
handler bound at an app name. The handler does no I/O and no crypto — the shell
hands it `senderPk ‖ chatType ‖ body` and it returns render bytes for the UI.
Everything around it — authenticating the sender, moving frames, driving the
iframe — is the runtime's job, because a pure transform has no reach of its own.

This lives outside the kernel repo for the same reason
[seed store](https://github.com/arj03/seedstore) does: an app is a *consumer* of
the runtime, not part of it. The kernel repo stays runtime-only, and every reach
chat makes into the runtime has to go through a published entry point.

## What's here

| Path | What it is |
| --- | --- |
| `assembly/chat-app-v1/` | v1 handler — text only. `index.ts` is the pure transform, `ui.html` is the iframe UI embedded into the module as a custom section. |
| `assembly/chat-app-v2/` | v2 handler — text + image + nick. Same shape; upgrading v1→v2 is a re-admit at the same name under the same key. |
| `browser/chat-shell.*` | The browser shell: identity, admission policy, WebRTC wiring, the sandboxed iframe. Roughly 2,200 lines. |
| `scripts/embed-ui.mjs` | Appends a `ui` custom section to a built `.wasm`. |
| `scripts/embed-meta.mjs` | Appends an `app_meta` JSON custom section (id, name, version). |
| `scripts/vendor.mjs` | Copies the kernel's built host into `browser/vendor/` for a bundler-free static serve, refusing a stale (un-minified-since-compile) kernel build. |
| `scripts/relay.mjs` | The WebSocket signaling rendezvous for the WebRTC mesh. App-neutral — seed store points at this file too. |
| `scripts/clean.mjs` | Deletes `build/` and `browser/vendor/` when a rebuild isn't taking. |

`ui` and `app_meta` are **chat-shell conventions, not runtime contracts** — the
kernel never reads either section. They live here because the reader lives here.

## The kernel surface chat uses

The entire dependency is four published entry points of `seedkernel-wasm`:

| Import | Used for |
| --- | --- |
| `seedkernel-wasm/shell-core` | `createShell`, `KernelHost` |
| `seedkernel-wasm/bundle` | `signManifest`, `packBundle`, `unpackBundle`, `verifyManifest`, `genesisHash`, `kernelNameFor`, `appKeyFor`, `handlesOf`, `FreshnessMarks`, `MANIFEST_FILE`, `moduleFile` |
| `seedkernel-wasm/net-rtc` | `RtcNetwork` — the relay-signaled WebRTC mesh |
| `seedkernel-wasm/libsodium` | the browser libsodium build |

Plus one on the guest side: the app modules import `PK_LEN` and `PRIV_USER_OFF`
from `seedkernel-wasm/assembly/seedkernel/handler` — the AssemblyScript half of
the handler ABI (§4). It is imported, never vendored: an ABI that apps fork is an
ABI that drifts.

The four JS entry points are declared in exactly two places: the imports at the top of
`chat-shell.js`, and the import map in `chat-shell.html`. Nothing else in this
repo reaches into `node_modules`. If a kernel change breaks chat, it broke a
public export — which is the point of chat living out here.

## Build and run

```sh
# 1. build the kernel checkout it depends on
cd ../seedkernel/WASM && npm install && npm run build && npm run build:browser-sodium

# 2. build chat and vendor the runtime
cd ../../seedchat && npm install && npm run build

# 3. signaling rendezvous for the WebRTC mesh (kill it once channels are open)
npm run relay

# 4. in another terminal: re-vendor + serve browser/ with caching off
npm run serve        # → http://localhost:3000/chat-shell.html, open it in two browsers
```

`serve` passes `-c-1`, which is not optional in practice: a plain `http-server`
defaults to `max-age=3600`, so after a rebuild the browser keeps serving a stale
`vendor/host` and the shell fails in ways that look like kernel bugs. If a rebuild
still doesn't take, `npm run clean && npm run build` starts from nothing. `vendor`
also refuses to run when the kernel's `build/host-min` is older than its
`build/host` — the silent divergence where the kernel's own tests stay green
against fresh code while chat serves the last minified build.

`localhost` is a secure context, so plain HTTP is enough for WebRTC when both tabs
are on this machine; reaching the shell from another device needs HTTPS.

Load an app by picking `build/chat-app-v1.wasm` (or `v2`) in the shell — it
builds a signed one-module bundle from the local identity, verifies it, and the
loader admits it under the shell's policy. Peers hand each other the same bundles
in an `OFFER` frame; the recipient re-verifies the original author's manifest
signature, so a bundle survives any number of relays and still authenticates
against whoever wrote it.

The relay is partitioned into **rooms** (`ws://host:8080/<room>`, default
`global`), set on the shell's **Network** tab. A room is *not* an authenticated
channel — knowing the name is the only credential — but identity is bound
in-channel by PeerLink's HELLO/AUTH, so a relay can observe SDP metadata and
refuse to forward, and can never impersonate a peer.

## Protocol interop

A chat frame carries a *protocol id*, not an app name. Which chat app renders a
received message is the receiving user's own binding, so two peers running
different authors' chat apps interoperate as long as both speak the protocol.
See §11 and §12.10 in the kernel's `docs/RUNTIME.md`.
