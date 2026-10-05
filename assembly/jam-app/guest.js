// Jam's guest: a room's chat, its emoji reactions and the playlist it keeps and plays
// together. What a room holds, and how two nodes' copies of it are brought to agree, is the
// view's (ui.js). What is the guest's is the part a view cannot be trusted with or cannot
// do: who a frame goes to, whether a peer's frame is from someone in the room it names, and
// what a block of audio is called.
//
// The split follows seedstore's two planes. The control plane is small frames the view
// reads; the bulk plane is blocks of a file, each named by the hash of its bytes, so a block
// needs no signature and no trust in whoever sent it. A view asks for a block by its id, and
// this guest hashes what arrives before the view sees it: the id in a block's render is this
// node's own word for those bytes, never the sender's.
//
// It needs no module, and reaches nothing but the network.

const EMPTY = new Uint8Array(0);

/** The wire protocol a jam app speaks (§12.10), the one id in app.json `protocols`. */
const JAM = "jam";

/** A jam frame is `[type u8][room 32][body]`, `room` the room's id on the relay. The guest
 *  reads the room of every frame and the body of none, and knows one type by name: a block
 *  of a file, which it hashes on the way in. The rest are the view's vocabulary. */
const BLOCK = 4;         // [room 32][bytes]

/** What this app's view asks, as the `ui` op's bytes: `[ask u8][..]`. */
const ASK_CAST = 1;      // [frame]          to every linked member of the frame's room
const ASK_TELL = 2;      // [to 32][frame]   to one member of the frame's room
const ASK_HASH = 3;      // [tag 4][bytes]   the block id of these bytes, answered under `tag`

/** A render, for the view. Type 0 is the node's context (guest-lib/context.js). */
const RENDER_FRAME = 1;  // [from 32][frame]                  a peer's frame
const RENDER_BLOCK = 2;  // [from 32][room 32][id 32][bytes]  a peer's block, with its id
const RENDER_HASH = 3;   // [tag 4][id 32]                    the answer to ASK_HASH

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A block's id: the BLAKE2b-256 of its bytes. `crypto/blake2b` takes
 *  `[outLen][keyLen][key][msg]` and is ungated, a transform rather than a grant (seedkernel
 *  §12.1). */
function blockId(bytes) {
  const arg = new Uint8Array(2 + bytes.length);
  arg[0] = 32;
  arg.set(bytes, 2);
  return host.call("crypto/blake2b", arg);
}

/** The room a frame names, in hex. */
function roomOf(frame) {
  return toHex(frame.subarray(1, 33));
}

/** It has two callers.
 *
 *  A PEER's frame is passed to the view when it is from someone the relay lists in the room
 *  it names, with the sender the channel authenticated in front. A block is hashed first,
 *  so the view files it under what it is rather than what it was asked for as.
 *
 *  The SHELL's two ops are the node's context, and an ask from this app's own view. A frame
 *  the view casts goes to the linked members of its room; one it tells goes to a single
 *  member. Both are fire-and-forget, and neither is answered: the view has already applied
 *  what it sent. A peer that cannot be reached is not reached, and the rest still are. */
async function handle(arg) {
  const { fromHost, caller, body } = callerOf(arg);
  if (!fromHost) {
    if (body.length < 33 || !inRoom(roomOf(body), toHex(caller))) return EMPTY;
    if (body[0] !== BLOCK) return concat([[RENDER_FRAME], caller, body]);
    const bytes = body.subarray(33);
    return concat([[RENDER_BLOCK], caller, body.subarray(1, 33), await blockId(bytes), bytes]);
  }
  const { op, args } = readOp(body);
  if (op === OP_CONTEXT) return setContext(args);
  if (op !== OP_UI || args.length < 1) return EMPTY;
  const ask = args[0], rest = args.subarray(1);
  if (ask === ASK_HASH && rest.length >= 4) {
    return concat([[RENDER_HASH], rest.subarray(0, 4), await blockId(rest.subarray(4))]);
  }
  if (ask === ASK_CAST && rest.length >= 33) {
    const room = roomOf(rest);
    const members = (await netPeers()).filter((p) => inRoom(room, p));
    await Promise.all(members.map((p) => netSend(fromHex(p), JAM, rest).catch(() => {})));
  }
  if (ask === ASK_TELL && rest.length >= 65) {
    const to = rest.subarray(0, 32), frame = rest.subarray(32);
    if (inRoom(roomOf(frame), toHex(to))) await netSend(to, JAM, frame).catch(() => {});
  }
  return EMPTY;
}
