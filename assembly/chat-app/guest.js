// Chat's guest: rooms and direct chats, text and images. It holds the chat wire protocol's
// vocabulary and the whole of what chat does with a frame: decide whether a peer's is for
// this node, send its own to the peers it is for, and have the app's module draw it.
//
// app.json names two libraries in front of it: guest-lib/net.js, the way onto the network,
// and guest-lib/context.js, the node's context, the rooms a guest reads out of it, and the
// entrypoint that tells its two callers apart (`guest.peer`, `guest.view`).

/** The wire protocol every chat app speaks (§12.10), the one id in app.json `protocols`.
 *  It names the conversation, not the code: two peers running different versions, or
 *  different authors' chat apps, interoperate because both claim it, and a frame says only
 *  which protocol it is. */
const CHAT = "chat";

/** This app's module, by its name in app.json `modules`: a pure transform from
 *  `[sender 32][frame]` to the render bytes the view draws (index.ts). */
const MODULE = "chat";

/** A chat frame is `[type u8][body]`, the same bytes on the wire, from the view and into
 *  the module. A room frame's body starts with the room's 32-byte id on the relay, and a
 *  direct one's with the key of the peer it is for. There is no frame for a name: what a
 *  peer calls itself is the shell's, and reaches a view in the node's context. */
const DIRECT_TEXT = 3;   // [to 32][utf-8 text]
const DIRECT_IMAGE = 4;  // [to 32][jpeg]
const ROOM_TEXT = 5;     // [room 32][utf-8 text]
const ROOM_IMAGE = 6;    // [room 32][jpeg]
const isDirect = (type) => type === DIRECT_TEXT || type === DIRECT_IMAGE;
const isRoom = (type) => type === ROOM_TEXT || type === ROOM_IMAGE;

/** This node's key, which the host writes (seedkernel §12.3). */
const ME = fromHex(HOST.identity);

/** The id in front of a frame's body, in hex: its room, or its addressee. */
function headOf(frame) {
  return frame.length >= 33 ? toHex(frame.subarray(1, 33)) : "";
}

/** Whether a peer's frame is for this node: a room frame from someone in the room it
 *  names, or a direct one addressed to this node. The decision is made here, on the
 *  receiving side, whatever the sender's guest chose to send. */
function isForMe(from, frame) {
  if (isRoom(frame[0])) return inRoom(headOf(frame), from);
  if (isDirect(frame[0])) return headOf(frame) === HOST.identity;
  return false;
}

/** The peers this node's own frame goes to, by key hex. A room frame goes to the linked
 *  members of its room. A direct one goes to its addressee, linked or not: the transport
 *  dials a contact it has an address for, and the view asks the shell to make it one. */
async function audienceOf(frame) {
  if (isDirect(frame[0])) return [headOf(frame)];
  const room = headOf(frame);
  return (await netPeers()).filter((p) => inRoom(room, p));
}

/** Have the module draw `frame` as `sender`'s. A peer's frame and this node's own echo go
 *  the same way, so the view cannot tell them apart but by the key. */
function render(sender, frame) {
  const input = new Uint8Array(32 + frame.length);
  input.set(sender, 0);
  input.set(frame, 32);
  return host.call(MODULE, input);
}

/** A PEER's frame is drawn when it is for this node, which a frame of a type chat does not
 *  speak never is. The render bytes ARE the answer. */
guest.peer = (caller, frame) => (isForMe(toHex(caller), frame) ? render(caller, frame) : EMPTY);

/** A frame from this app's own VIEW is sent to the peers it is for, fire-and-forget, and
 *  then drawn here as this node's own: the local echo, by the same module a peer's frame
 *  goes to, and the answer to the view's call. A peer that cannot be reached is not
 *  reached, and the rest still are. */
guest.view = async (frame) => {
  if (frame.length < 33 || !(isRoom(frame[0]) || isDirect(frame[0]))) return EMPTY;
  await Promise.all((await audienceOf(frame)).map((p) => netSend(fromHex(p), CHAT, frame).catch(() => {})));
  return render(ME, frame);
};
