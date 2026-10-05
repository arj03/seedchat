// The calls app SHAPE, in the same spirit as offers-app.js: what the calls app's guest
// program is, and how much authority it holds. Both the browser shell (which loads the
// boot bundle built from it) and scripts/build-boot-bundles.mjs (which signs it) read it
// here, so the guest source that gets SIGNED is written once.
//
// A call's audio and video ride a peer connection the PAGE owns (media-rtc.js), one per
// peer, separate from the transport's: the transport's connections carry bytes and are
// the host's to hold. That media connection still needs signaling, and this app is it —
// a claim on `call/v1` so a peer's SDP and ICE reach this page, and `_net` so this page's
// reach that peer. Signaling over the node's own channel is authenticated by it, so a call
// needs no relay once the peers are linked, and nobody on the relay can inject one.

/** The wire protocol a peer's call signal travels under (§12.10). */
export const CALL_PROTO = "call/v1";

/** This app's id, and its manifest's `app`. */
export const CALLS_APP = "calls";

/** The whole authority the calls guest holds (§12.2): the network, to send a signal, and
 *  nothing else. The page does everything that touches media. */
export const CALLS_REQUIRES = ["_net"];

/** The page's one local op: `[to 32][signal …]`, sent to that peer under `CALL_PROTO`. */
export const CALLS_OP_SEND = "send";

/** The guest this shell signs into the boot bundle. `prelude` is the guest source in front
 *  of it: seedkernel's op-frame and the network library (assembly/guest-lib/net.js).
 *  `handle` has two callers:
 *
 *  - a peer's inbound `call/v1` frame, `[from 32][signal …]` — answered with the signal
 *    itself, which is exactly what the page's `onInbound` receives (seedkernel §12.10),
 *    with `from` beside it: the answer doubling as the notification, as offers-app.js does;
 *  - the page's `send` op, `[to 32][signal …]` — handed to `_net` fire-and-forget: a
 *    signal is not a round trip, and its answer comes back as a signal of the peer's own. */
export function callsGuestSource(prelude) {
  return `
${prelude}

const PROTO = ${JSON.stringify(CALL_PROTO)};

async function handle(arg) {
  const { fromHost, body } = callerOf(arg);
  if (!fromHost) return arg.subarray(32);
  const { op, args: p } = readOp(body);
  if (op !== ${JSON.stringify(CALLS_OP_SEND)}) return new Uint8Array(0);
  return await netSend(p.subarray(0, 32), PROTO, p.subarray(32));
}`;
}
