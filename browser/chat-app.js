// The chat app SHAPE, in one place: what a chat app's id may be, what its guest
// program is, and how much authority it holds. Both the browser shell (which
// authors bundles and peeks received ones) and scripts/smoke.mjs (which authors
// one headlessly) read it here, so the guest source that gets SIGNED is written
// once. Two hand-copies of signed source would be two things to keep in step, and
// the one that drifts is the one an author's key vouches for.
//
// No imports: this is pure text and one regex, so it loads identically under the
// browser's importmap and Node's resolver.

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

/** The reserved id the transport claims (seedkernel `NET_PROTOCOL`). Named
 *  here rather than imported so this file keeps its no-imports property: it is the one
 *  string in the runtime's vocabulary chat has to spell, and `smoke.mjs` asserts it
 *  against the kernel's own constant. */
export const NET_PROTO = "_net";

/** The whole authority a chat app holds (§12.2): the network, and nothing else.
 *
 *  It used to be nothing at all, and the change is not a relaxation — it is where
 *  sending moved to. The host has no send: the socket driver holds descriptors and the
 *  transport is a guest that claims `_net`, so a message reaches a peer by an app CALLING
 *  that id (§12.10). A chat app that could not name `_net` could receive chat and never
 *  send it, and the shell would need a second app of its own to do the sending — the
 *  same authority, one indirection further from the thing that uses it.
 *
 *  It is still the strongest statement the consent row can make, because of what stays
 *  absent: no `node/sign`, no `fs/*`, no `link/*`. `_net` carries no privilege — an
 *  operator is asked who may *be* the network (`link/*`), not who may talk over it — and
 *  a chat app's own module map is not a grant either (a bare `host.call` name is the
 *  bundle's own code, ungated like `crypto`, seedkernel §12.1).
 *
 *  Authored into every bundle this shell builds, and required of every bundle it
 *  accepts — see `peekMeta`. */
export const CHAT_APP_REQUIRES = [NET_PROTO];

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

/** The guest every chat app ships — two entrypoints, one per direction.
 *
 *  `handle` is inbound: the shell invokes it with `senderPk ‖ body`, it forwards that to
 *  the app's own module — named directly on the same `host.call` seam every other
 *  capability uses (§12.2) — and returns the render bytes. That has not changed.
 *
 *  `send` is outbound, and it is new because outbound had to move in here. The host owns
 *  no send: a message reaches a peer by calling the id the transport claims, and only a guest
 *  can call it. The shell drives this with `runGuest("send", …)`, once per peer.
 *
 *    argument   `[to 32][protoLen u8][proto][payload]` — the shell's shape, chosen so a
 *               caller writes what it knows (a peer, a protocol id, a body).
 *    to `_net`  `[opLen u8]["send"][noReply u8][deadline u32][to blob][proto blob][payload blob]`
 *               — the transport's op wire, where a blob is `[len u32][bytes]` and the op is a
 *               NAME rather than a number the two sides must agree on. The host prepends
 *               this app's own 32-byte key as the caller, exactly as it prepends the
 *               sender's key inbound, so the transport can tell an app's request from the
 *               platform's own events.
 *
 *  `noReply` is 1: chat is a broadcast, not a round trip. The frame is handed to the wire
 *  and the call answers `[1]` without waiting for the far end, which is what the shell's
 *  fire-and-forget send always was — the difference is that the choice is now written
 *  down in the frame instead of implied by which host method was called. A deadline of 0
 *  means the node's own default, which is the only place that number should live.
 *
 *  Interpolating the id into a string literal is safe because `assertAppId` already held
 *  it to `[A-Za-z0-9_-]`: nothing to escape, no quote to break out of, and no `/`, which
 *  is what keeps it a module name rather than a host name. */
export function chatGuestSource(appId) {
    assertAppId(appId);
    return `register("handle", (input) => host.call("${appId}", input));
register("send", (arg) => {
  const protoLen = arg[32];
  const proto = arg.subarray(33, 33 + protoLen);
  const payload = arg.subarray(33 + protoLen);
  const op = "send";
  const out = new Uint8Array(1 + op.length + 1 + 4 + 4 + 32 + 4 + proto.length + 4 + payload.length);
  let o = 0;
  out[o++] = op.length;
  for (let i = 0; i < op.length; i++) out[o++] = op.charCodeAt(i);
  out[o++] = 1;                       // noReply — a chat frame is not a round trip
  o += 4;                             // deadline 0 — the node's own default
  const u32 = (v) => { out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255; o += 4; };
  u32(32); out.set(arg.subarray(0, 32), o); o += 32;
  u32(proto.length); out.set(proto, o); o += proto.length;
  u32(payload.length); out.set(payload, o);
  return host.call("${NET_PROTO}", out);
});`;
}

/** Does a verified manifest describe a chat app this shell will run? The demo's apps are
 *  one module driven by the two-entrypoint guest, and — the load-bearing half — they hold
 *  EXACTLY `_net` and nothing else.
 *
 *  The requires check is not decoration, and it is an equality rather than a subset test
 *  for that reason. An Offer arrives from a peer and is installed on one click of a row
 *  showing a name, a version and an author; the manifest's `guest.requires` are the only
 *  place the bundle's authority is written down, and nothing else on this path reads
 *  them. Without this, a peer could offer an app whose guest holds `node/sign`, `fs/*` or
 *  `link/open` and the consent prompt would look exactly the same. */
export function isChatApp(manifest) {
    if (manifest.modules.length !== 1)
        return false;
    // What it will SERVE, checked beside what it may do. A bundle's claim is now the
    // routing (§12.10) — installing it points `chat` at it — so the claim is part of
    // what the consent prompt is agreeing to, and an offered bundle claiming ids this
    // shell knows nothing about would take those over on one click.
    const protocols = manifest.protocols ?? [];
    if (protocols.length !== 1 || protocols[0] !== CHAT_PROTO)
        return false;
    const requires = manifest.guest.requires;
    return requires.length === CHAT_APP_REQUIRES.length
        && requires.every((r) => CHAT_APP_REQUIRES.includes(r));
}
