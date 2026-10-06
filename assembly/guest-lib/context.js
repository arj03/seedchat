// What any guest whose frames are written to rooms does with the node's context: the
// shell's two loopback ops by name, the rooms this node is in, the context passed on to the
// app's own view, and the one entrypoint, which tells a guest's callers apart so that a
// guest is written as what it does with each. Guest SOURCE like net.js beside it, which it
// follows in an app.json's `guest` list: signed into each bundle that names it, not a module
// anything imports.

const EMPTY = new Uint8Array(0);

/** The shell's two loopback ops (browser/app-api.js): the node's context, and bytes from
 *  this app's own view. */
const OP_CONTEXT = "ctx";
const OP_UI = "ui";

/** The rooms this node is in, by id in hex, each the set of keys the relay lists there. */
let rooms = new Map();

/** The `ctx` op: keep the part of the context a guest decides with, and answer all of it
 *  for the view as render type 0, `[0][the same JSON]`. The view hears of rooms, linked
 *  peers, contacts and names only this way, so it and the guest never hold two different
 *  pictures. The JSON is ASCII, so it reads one character per byte: a realm has no
 *  TextDecoder. */
function setContext(json) {
  let text = "";
  for (let i = 0; i < json.length; i++) text += String.fromCharCode(json[i]);
  rooms = new Map(JSON.parse(text).rooms.map((r) => [r.id, new Set(r.members)]));
  const out = new Uint8Array(1 + json.length);
  out.set(json, 1);
  return out;
}

/** Whether `peer` is in the joined room `room`. Who is linked is not who is in a room. */
function inRoom(room, peer) {
  const members = rooms.get(room);
  return members !== undefined && members.has(peer);
}

/** What this guest does with the two things that reach it besides the context, each a
 *  function that answers bytes, or `EMPTY` for nothing:
 *
 *    guest.peer(caller, frame)   a PEER's frame under a protocol the app claims, `caller`
 *                                the 32-byte key the channel authenticated. The answer is
 *                                render bytes: the page that installed the app reads them
 *                                off its own load's onInbound (seedkernel §12.10) and hands
 *                                them to the view.
 *    guest.view(bytes)           what this app's own VIEW sent with `call`. The answer goes
 *                                back to the view as the answer to that call.
 *
 *  A guest sets each, and one it leaves alone answers nothing. The last to set one is the
 *  one called, so a guest that follows a library in its `guest` list builds on what the
 *  library set, as jam's does on room-pipe.js. */
const guest = { peer: () => EMPTY, view: () => EMPTY };

/** The one entrypoint (seedkernel §12.2). A peer's frame arrives with its sender in front,
 *  and the shell's two ops with the host's id there and the op's name behind it. The
 *  answers are awaited: the seedkernel seam is uniformly asynchronous, and the await is
 *  what makes the bytes returned real bytes rather than a pending Promise. */
async function handle(arg) {
  const { fromHost, caller, body } = callerOf(arg);
  if (!fromHost) return await guest.peer(caller, body);
  const { op, args } = readOp(body);
  if (op === OP_CONTEXT) return setContext(args);
  return op === OP_UI ? await guest.view(args) : EMPTY;
}
