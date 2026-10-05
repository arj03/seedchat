// What any guest whose frames are written to rooms does with the node's context: the
// shell's two loopback ops by name, the rooms this node is in, and the context passed on to
// the app's own view. Guest SOURCE like net.js beside it, which it follows in an app.json's
// `guest` list: signed into each bundle that names it, not a module anything imports.

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
