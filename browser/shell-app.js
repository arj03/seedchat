// The shell app SHAPE, in the same spirit as offers-app.js: what the shell app's guest
// program is, and how much authority it holds. Both the browser shell (which loads the
// boot bundle built from it) and scripts/build-boot-bundles.mjs (which signs it) read it
// here, so the guest source that gets SIGNED is written once.
//
// It is how one page talks to another. A peer's frame reaches only a bundle that claims
// its protocol id (seedkernel §12.10), so what two pages say to each other needs a bundle
// to hold the claim, and `_net` so this page's word reaches that peer. This app holds two
// claims, and what rides each is told apart by the id it arrived under, not by its shape:
//
//   shell/v1   what a page tells another about itself: `{ nick }`, what it calls itself,
//              and `{ peer }`, that it added or removed the other as a peer.
//   call/v1    a call's signaling. A call's audio and video ride a peer connection the PAGE
//              owns (media-rtc.js), one per peer, separate from the transport's: the
//              transport's connections carry bytes and are the host's to hold. That media
//              connection still needs signaling, and this is its path.
//
// Both ride the node's own channel and are authenticated by it, so neither needs a relay
// once the peers are linked, and nobody on the relay can inject into either.

/** The wire protocol what one page tells another travels under (§12.10). */
export const SHELL_PROTO = "shell/v1";

/** The wire protocol a peer's call signal travels under. */
export const CALL_PROTO = "call/v1";

/** This app's id, and its manifest's `app`. */
export const SHELL_APP = "shell";

/** The whole authority the shell app's guest holds (§12.2): the network, to send, and
 *  nothing else. The page does everything that touches media. */
export const SHELL_REQUIRES = ["_net"];

/** The page's two local ops, each `[to 32][bytes …]`, sent to that peer: `tell` under
 *  `SHELL_PROTO` and `signal` under `CALL_PROTO`. The op is what names the protocol, so
 *  the page spells no id into what it sends. */
export const SHELL_OP_TELL = "tell";
export const SHELL_OP_SIGNAL = "signal";

/** The guest this shell signs into the boot bundle. `prelude` is the guest source in front
 *  of it: seedkernel's op-frame and the network library (assembly/guest-lib/net.js).
 *  `handle` has two callers:
 *
 *  - a peer's inbound frame under either claim, `[from 32][bytes …]` — answered with the
 *    bytes themselves, which is exactly what the page's `onInbound` receives (seedkernel
 *    §12.10), with `from` and the claim beside them: the answer doubling as the
 *    notification, as offers-app.js does;
 *  - the page's `tell` and `signal` ops, `[to 32][bytes …]` — handed to `_net`
 *    fire-and-forget: neither is a round trip, and what a peer says back comes as a frame
 *    of its own. */
export function shellGuestSource(prelude) {
  return `
${prelude}

const SHELL_PROTO = ${JSON.stringify(SHELL_PROTO)};
const CALL_PROTO = ${JSON.stringify(CALL_PROTO)};

async function handle(arg) {
  const { fromHost, body } = callerOf(arg);
  if (!fromHost) return arg.subarray(32);
  const { op, args: p } = readOp(body);
  const proto = op === ${JSON.stringify(SHELL_OP_TELL)} ? SHELL_PROTO
    : op === ${JSON.stringify(SHELL_OP_SIGNAL)} ? CALL_PROTO : null;
  if (proto === null) return new Uint8Array(0);
  return await netSend(p.subarray(0, 32), proto, p.subarray(32));
}`;
}
