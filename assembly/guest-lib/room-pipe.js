// A guest, whole: a pipe scoped to a room, for an app whose state lives in its view. It
// follows net.js and context.js in an app.json's `guest` list, and an app that needs no
// more than this names no guest file of its own. What is left to a guest here is the part a
// view cannot be trusted with or cannot do: who a frame goes to, and whether a peer's frame
// is from someone in the room it names. The view's half is assembly/view-lib/app.js
// (`cast`, `tell`, `onFrame`).
//
// An app that needs more puts a guest of its own behind this file and sets `guest.peer` or
// `guest.view` again (context.js), with `pipePeer` and `pipeView` for the rest: jam's hashes
// a block of audio on its way in.

/** The wire protocol the pipe's frames travel under (§12.10): the first id in app.json
 *  `protocols`, which the builder writes into the guest's config (scripts/app-source.mjs),
 *  since a guest is handed its config and not its manifest's claims. */
const PIPE_PROTO = APP.protocols[0];

/** A frame on the wire is `[room 32][body]`, `room` the room's id on the relay. The pipe
 *  reads the room of every frame and the body of none: that is the view's vocabulary.
 *
 *  What a view asks, as the `ui` op's bytes: `[ask u8][..]`. */
const ASK_CAST = 1;      // [frame]          to every linked member of the frame's room
const ASK_TELL = 2;      // [to 32][frame]   to one member of the frame's room

/** A render, for the view. Type 0 is the node's context (context.js). */
const RENDER_FRAME = 1;  // [from 32][frame]   a peer's frame

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The room a frame names, in hex. */
function roomOf(frame) {
  return toHex(frame.subarray(0, 32));
}

/** Whether a peer's frame is from someone the relay lists in the room it names. The
 *  decision is made here, on the receiving side, whatever the sender's guest chose to send. */
function fromMember(caller, frame) {
  return frame.length >= 32 && inRoom(roomOf(frame), toHex(caller));
}

/** A PEER's frame is passed to the view when it is from a member of its room, with the
 *  sender the channel authenticated in front. */
function pipePeer(caller, frame) {
  return fromMember(caller, frame) ? concat([[RENDER_FRAME], caller, frame]) : EMPTY;
}

/** An ask from the VIEW. A frame it casts goes to the linked members of its room, and one
 *  it tells goes to a single member. Both are fire-and-forget, and neither is answered with
 *  anything: the view has already applied what it sent. A peer that cannot be reached is
 *  not reached, and the rest still are. */
async function pipeView(ask) {
  const rest = ask.subarray(1);
  if (ask[0] === ASK_CAST && rest.length >= 32) {
    const room = roomOf(rest);
    const members = (await netPeers()).filter((p) => inRoom(room, p));
    await Promise.all(members.map((p) => netSend(fromHex(p), PIPE_PROTO, rest).catch(() => {})));
  }
  if (ask[0] === ASK_TELL && rest.length >= 64) {
    const to = rest.subarray(0, 32), frame = rest.subarray(32);
    if (inRoom(roomOf(frame), toHex(to))) await netSend(to, PIPE_PROTO, frame).catch(() => {});
  }
  return EMPTY;
}

guest.peer = pipePeer;
guest.view = pipeView;
