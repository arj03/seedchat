// The chat app SHAPE, in one place: what a chat app's id may be, what its guest
// program is, and how much authority it holds. Both the browser shell (which
// authors bundles and peeks received ones) and scripts/smoke.mjs (which authors
// one headlessly) read it here, so the guest source that gets SIGNED is written
// once. Two hand-copies of signed source would be two things to keep in step, and
// the one that drifts is the one an author's key vouches for.
//
// No runtime import: offline authors pass `guestOpFraming` from the kernel's
// `/bundle-author` entry point into `chatGuestSource`, keeping that authoring module
// out of the browser shell's vendored runtime artifact.

/** A chat app's id, which is also its one module's manifest name. The §12.4 name
 *  grammar, applied HERE rather than trusted from the wasm: the id is read out of
 *  an `app_meta` custom section, so on any bundle that did not come from this
 *  shell it is attacker-chosen text. `chatGuestSource` interpolates it into JS
 *  that the local key then signs, and the manifest's own name check happens later
 *  — after the injection would already be inside the signed guest. So the rule the
 *  guest's comment relies on has to be enforced before the template, not after. */
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Throw unless `id` is a legal app id. Callers author bundles from it. */
export function assertAppId(id) {
    if (typeof id !== "string" || !APP_ID.test(id))
        throw new Error(`invalid app id ${JSON.stringify(id)}: expected 1-64 chars of [A-Za-z0-9_-] (§12.4)`);
}

/** The local service name the transport bundle serves (the `_net` of the bundled
 *  composition; no kernel semantics attach to the spelling). Named here rather than
 *  imported so this file keeps its no-imports property: it is the one string in the
 *  runtime's vocabulary chat has to spell, and `smoke.mjs` asserts it against the
 *  transport bundle's own `services` claim. */
export const NET_PROTO = "_net";

/** The HOST services a chat app holds (`manifest.guest.requires`, §12.2): NONE.
 *
 *  Empty is the strongest statement the consent row can make, and it is empty rather
 *  than one entry long because reaching a peer is not a host service. `requires` is the
 *  list an operator grants — `node`, `fs`, `link` — and a chat app names none of them;
 *  the network it does reach is a co-resident guest, which the manifest signs under its
 *  own list (`CHAT_APP_CALLS`).
 *
 *  Authored into every bundle this shell builds, and required of every bundle it
 *  accepts — see `peekMeta`. */
export const CHAT_APP_REQUIRES = [];

/** The local service ids a chat app CALLS (`manifest.guest.calls`, §12.10): the network,
 *  and nothing else.
 *
 *  Naming `_net` is not an indulgence but the whole of how an app sends. The host has
 *  no send: the socket driver holds descriptors and the
 *  transport is a guest that serves the local service name `_net`, so a message reaches
 *  a peer by an app CALLING that id. A chat app that could not name `_net`
 *  could receive chat and never send it, and the shell would need a second app of its
 *  own to do the sending — the same authority, one indirection further from the thing
 *  that uses it.
 *
 *  Its render bytes need no name of their own: they are the answer this guest returns
 *  for an inbound frame, and the loader that mounted this app receives them straight
 *  off that answer through `onInbound` (`LoadBundleOptions.onInbound`, seedkernel
 *  §12.10) — the page's own load, not a second claim the guest has to push through.
 *
 *  A call edge is a separate list from `requires` because it carries no privilege: an
 *  operator is asked who may *be* the network (`link`), not who may talk over it. It is
 *  still a name the consent row must read, since an id nobody would recognise is reach
 *  this shell did not ask for — and it is what tells a bare `host.call` from one of the
 *  bundle's own modules, which stay ungated like `crypto` (seedkernel §12.1) and appear
 *  in no signed list at all. */
export const CHAT_APP_CALLS = [NET_PROTO];

/** The wire protocol every chat app speaks (§12.10) — one id, claimed by every
 *  bundle this shell authors and required of every bundle it accepts.
 *
 *  It is deliberately NOT the app id. The id names the app (and its module); this
 *  names the conversation, and the whole point is that it is the same string for
 *  everyone: two peers running different authors' chat apps interoperate because
 *  both claim `chat`, and a frame says only which protocol it is. An app that
 *  claimed its own id would be a chat app nobody else could talk to.
 *
 *  Claiming it is what routes it: the load that admits a chat bundle makes it this
 *  node's `chat` app, and installing another one takes the id over (§12.10) — which
 *  is exactly the swap this demo exists to show, and is why the Apps panel reads the
 *  claim off the manifest instead of offering a bind button. */
export const CHAT_PROTO = "chat";

/** The chat guest's LOCAL op names — its one-vocabulary fold (seedkernel §12.2). A chat
 *  app registers a single entrypoint, `handle`; a peer's inbound frame carries
 *  `[peer 32][chatType ‖ body]`, and the host's own `invoke` loopback carries
 *  `[zero 32][opLen u8][op][args]` — the 32-byte caller id tells the two apart, and the
 *  guest splits both with the kernel framing's `callerOf`/`readOp`.
 *
 *  NAMES rather than bytes, and that is not cosmetic: an op byte is a number the shell
 *  and the guest source have to agree on, which is exactly what collapsing entrypoints
 *  onto one call must not smuggle back in. An op this guest does not implement then
 *  fails by name instead of silently landing on a neighbouring case. */
export const CHAT_OP_SEND = "send";     // [to 32][protoLen u8][proto][payload]
export const CHAT_OP_RENDER = "render"; // [sender 32][payload] → the module's render bytes

/** The guest every chat app ships — ONE entrypoint, `handle`, serving both directions.
 *
 *  `handle` is inbound: a peer's frame arrives as `senderPk ‖ body`, and the guest
 *  forwards it to the app's own module — named directly on the same `host.call` seam every
 *  other capability uses (§12.2) — and returns whatever the module answers: the render
 *  bytes for that frame. That answer IS the return value of this call, and nothing here
 *  pushes it anywhere: the loader that mounted this app is handed those same bytes through
 *  `onInbound` (`LoadBundleOptions.onInbound`, seedkernel §12.10), once the answer settles.
 *  There is no second name for it and no 32-byte comparison to make on the way in — the
 *  loader already knows which app it mounted, because it is the one that mounted it.
 *
 *  Sending is a LOCAL op on the same `handle`. The host owns no send: a message reaches a
 *  peer by calling the id the transport claims, and only a guest can call it. The shell
 *  drives this with `invoke(CHAT_OP_SEND, …)`, and the local echo with
 *  `invoke(CHAT_OP_RENDER, …)`.
 *
 *  The handler is `async` and `await`s every `host.call`: the seedkernel seam is
 *  uniformly asynchronous, including local services, modules, primitives and host
 *  services. The await is what makes the returned render bytes real bytes rather than
 *  a pending Promise, regardless of which backend answers the name.
 *
 *    send argument   `[to 32][protoLen u8][proto][payload]` — the shell's shape, chosen so a
 *                    caller writes what it knows (a peer, a protocol id, a body).
 *    to `_net`       `writeOp("send", [noReply u8][deadline u32][to blob][proto blob][payload blob])`
 *                    — the transport's op wire, where a blob is `[len u32][bytes]`. The
 *                    envelope comes from `writeOp` (seedkernel host/op-frame.ts), so
 *                    this guest writes the ARGUMENTS and never the framing. The host prepends
 *                    this app's own 32-byte key as the caller, exactly as it prepends the
 *                    sender's key inbound, so the transport can tell an app's request from the
 *                    platform's own events.
 *
 *  `noReply` is 1: chat is a broadcast, not a round trip. The frame is handed to the wire
 *  and the call answers `[1]` without waiting for the far end, which is what the shell's
 *  fire-and-forget send is. The choice is written down in the frame rather than implied
 *  by which host method was called. A deadline of 0 means the node's own default, which
 *  is the only place that number should live.
 *
 *  Interpolating the id into a string literal is safe because `assertAppId` already held
 *  it to `[A-Za-z0-9_-]`: nothing to escape, no quote to break out of, and no `/`, which
 *  is what keeps it a module name rather than a host name. */
export function chatGuestSource(appId, guestOpFraming) {
    assertAppId(appId);
    // The kernel's inbound shape is `handle([caller 32][body …])`: attribution only.
    // Everything after the 32-byte caller is THIS app's own format - the three
    // spellings below are the app's own, and the kernel never reads any of it
    // (seedkernel §12.2). The op is a NAME, never a tag byte.
    return `
${guestOpFraming()}

async function handle(arg) {
  const { fromHost, body } = callerOf(arg);
  if (fromHost) {
    const { op, args: p } = readOp(body);
    if (op === ${JSON.stringify(CHAT_OP_SEND)}) {
      const protoLen = p[32];
      const proto = p.subarray(33, 33 + protoLen);
      const payload = p.subarray(33 + protoLen);
      // The send op's ARGUMENTS: [noReply u8][deadline u32] then three blobs. The op name
      // in front is the transport's own envelope - this app writes only its arguments.
      const args = new Uint8Array(1 + 4 + 4 + 32 + 4 + proto.length + 4 + payload.length);
      let o = 0;
      args[o++] = 1;                   // noReply - a chat frame is not a round trip
      o += 4;                          // deadline 0 - the node's own default
      const u32 = (v) => { args[o] = v >>> 24; args[o + 1] = (v >>> 16) & 255; args[o + 2] = (v >>> 8) & 255; args[o + 3] = v & 255; o += 4; };
      u32(32); args.set(p.subarray(0, 32), o); o += 32;
      u32(proto.length); args.set(proto, o); o += proto.length;
      u32(payload.length); args.set(payload, o);
      return await host.call("${NET_PROTO}", writeOp("send", args));
    }
    if (op === ${JSON.stringify(CHAT_OP_RENDER)}) return await host.call("${appId}", p);
    return new Uint8Array(0);
  }
  // A peer's frame, forwarded straight to this app's own module. The render bytes it
  // returns ARE this call's answer — no relay hop, no second name: the loader that
  // mounted this app reads them off its own load's onInbound (seedkernel §12.10).
  return await host.call("${appId}", arg);
}`;
}

/** Does a verified manifest describe a chat app this shell will run? The demo's apps are
 *  one module driven by the one-entrypoint guest, and — the load-bearing half — they reach
 *  EXACTLY `_net` and nothing else.
 *
 *  The reach check is not decoration, and it is an equality on BOTH signed lists rather
 *  than a subset test for that reason. An Offer arrives from a peer and is installed on
 *  one click of a row showing a name, a version and an author; `guest.requires` and
 *  `guest.calls` are the only places the bundle's reach is written down, and nothing else
 *  on this path reads them. Checking only the host half would pass an app that calls a
 *  co-resident guest this shell never heard of; checking only the call half would pass one
 *  whose guest holds `node`, `fs` or `link`. Either way the consent prompt would look
 *  exactly the same. */
export function isChatApp(manifest) {
    if (manifest.modules.length !== 1)
        return false;
    // What it will SERVE, checked beside what it may do. A bundle's claim IS the
    // routing (§12.10) — installing it points `chat` at it — so the claim is part of
    // what the consent prompt is agreeing to, and an offered bundle claiming ids this
    // shell knows nothing about would take those over on one click.
    const protocols = manifest.protocols ?? [];
    if (protocols.length !== 1 || protocols[0] !== CHAT_PROTO)
        return false;
    // Absent `calls` ≡ none (seedkernel §12.10), which is a real answer here rather than a
    // missing field: an app that names no local service reaches no network.
    const sameSet = (got, want) => got.length === want.length && got.every((n) => want.includes(n));
    return sameSet(manifest.guest.requires, CHAT_APP_REQUIRES)
        && sameSet(manifest.guest.calls ?? [], CHAT_APP_CALLS);
}
