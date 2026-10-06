// Jam's guest: a room's chat, its emoji reactions and the playlist it keeps and plays
// together. What a room holds, and how two nodes' copies of it are brought to agree, is the
// view's (ui.js). What is the guest's is the part a view cannot be trusted with or cannot
// do: who a frame goes to, whether a peer's frame is from someone in the room it names, and
// what a block of audio is called.
//
// The first two are guest-lib/room-pipe.js, which app.json names in front of this file: a
// frame the view casts goes to the linked members of its room, one it tells goes to a single
// member, and a peer's frame is passed to the view only from a member of the room it names.
// The third is all that is here.
//
// The split follows seedstore's two planes. The control plane is small frames the view
// reads; the bulk plane is blocks of a file, each named by the hash of its bytes, so a block
// needs no signature and no trust in whoever sent it. A view asks for a block by its id, and
// this guest hashes what arrives before the view sees it: the id in a block's render is this
// node's own word for those bytes, never the sender's.
//
// It needs no module, and reaches nothing but the network.

/** A jam frame is the pipe's, `[room 32][body]`, and its body is `[type u8][..]`. The guest
 *  knows one type by name: a block of a file, which it hashes on the way in. The rest are
 *  the view's vocabulary. */
const BLOCK = 4;         // [bytes]

/** What this app's view asks beside the pipe's cast and tell. */
const ASK_HASH = 3;      // [bytes]   the block id of these bytes, which is the answer

/** A render beside the pipe's, for the view. */
const RENDER_BLOCK = 2;  // [from 32][room 32][id 32][bytes]  a peer's block, with its id

/** A block's id: the BLAKE2b-256 of its bytes. `crypto/blake2b` takes
 *  `[outLen][keyLen][key][msg]` and is ungated, a transform rather than a grant (seedkernel
 *  §12.1). */
function blockId(bytes) {
  const arg = new Uint8Array(2 + bytes.length);
  arg[0] = 32;
  arg.set(bytes, 2);
  return host.call("crypto/blake2b", arg);
}

/** A PEER's block is hashed before it is passed on, so the view files it under what it is
 *  rather than what it was asked for as. Any other frame is the pipe's to pass on. */
guest.peer = async (caller, frame) => {
  if (!fromMember(caller, frame) || frame[32] !== BLOCK) return pipePeer(caller, frame);
  const bytes = frame.subarray(33);
  return concat([[RENDER_BLOCK], caller, frame.subarray(0, 32), await blockId(bytes), bytes]);
};

/** The VIEW also asks what a block is called, so that it and this guest never name one
 *  block two ways. Any other ask is the pipe's. */
guest.view = (ask) => (ask[0] === ASK_HASH ? blockId(ask.subarray(1)) : pipeView(ask));
