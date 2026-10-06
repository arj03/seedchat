// What any view does the same way: bytes as hex, and the door to the shell, which is
// postMessage and nothing else (browser/app-api.js). A view names this file in a script tag
// ahead of its own, by its path from the page (`../view-lib/app.js`), and the builder puts
// it into the page like any other (scripts/app-source.mjs `readView`). It is view SOURCE,
// signed into each bundle that names it: to a view what assembly/guest-lib is to a guest.
//
// The door, whatever the app's guest:
//
//   app.ready()                    this view is listening: the node's context comes first,
//                                  then what arrived while the page loaded
//   app.call(...parts)             bytes for this app's guest, and a promise of its answer
//   app.onRender(fn)               fn(bytes): what the guest answered a peer's frame
//   app.onContext(fn)              fn(ctx): the node's context, which a guest passes on as
//                                  render type 0 (guest-lib/context.js)
//   app.conv({ room } | { to })    the conversation open, by id in hex, or none: a call
//                                  started from the shell is with it
//   app.contact(peer)              make a peer a contact, so the link to it outlives any
//                                  shared room
//
// And the view's half of guest-lib/room-pipe.js, for an app whose guest is that pipe or
// builds on it:
//
//   app.cast(room, ...parts)       a frame to every linked member of a room
//   app.tell(room, to, ...parts)   a frame to one member of it
//   app.onFrame(fn)                fn(from, room, body): a peer's frame, from a member of
//                                  the room it names
//
// Rooms and peers are named by id in hex, as the context names them.

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}
/** The parts end to end, in a buffer of its own. A part is bytes, or an array of them. */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const app = (() => {
  /** The renders guest-lib speaks: the context (context.js), and a peer's frame
   *  (room-pipe.js), `[from 32][room 32][body]`. Every other is the app's own. */
  const RENDER_CONTEXT = 0, RENDER_FRAME = 1;
  /** room-pipe.js's two asks: `[frame]`, and `[to 32][frame]`, a frame `[room 32][body]`. */
  const ASK_CAST = 1, ASK_TELL = 2;

  const dec = new TextDecoder();
  const bytesOf = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
  const post = (msg) => window.parent.postMessage(msg, "*");

  /** Who listens for what. `onContext` and `onFrame` each take one kind of render out of
   *  what `onRender` hears. */
  const heard = { render: null, context: null, frame: null };
  /** The calls not yet answered, by the id each went out under. */
  const calls = new Map();
  let nextCall = 1;

  /** Hand this app's guest the parts as one run of bytes (its `ui` op). The shell answers
   *  every call, so the promise settles: with what the guest answered, which may be
   *  nothing, or with why it failed. */
  function call(...parts) {
    const bytes = concat(...parts);
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      calls.set(id, { resolve, reject });
      window.parent.postMessage({ type: "call", id, bytes }, "*", [bytes.buffer]);
    });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "answer") {
      const waiting = calls.get(msg.id);
      if (!waiting) return;
      calls.delete(msg.id);
      if (msg.payload === undefined) waiting.reject(new Error(String(msg.error ?? "the app's guest did not answer")));
      else waiting.resolve(bytesOf(msg.payload));
      return;
    }
    if (msg.type !== "render") return;
    const p = bytesOf(msg.payload);
    if (p[0] === RENDER_CONTEXT && heard.context) heard.context(JSON.parse(dec.decode(p.subarray(1))));
    else if (p[0] === RENDER_FRAME && p.length >= 65 && heard.frame) {
      heard.frame(toHex(p.subarray(1, 33)), toHex(p.subarray(33, 65)), p.subarray(65));
    } else if (heard.render) heard.render(p);
  });

  return {
    ready: () => post({ type: "ready" }),
    call,
    onRender: (fn) => { heard.render = fn; },
    onContext: (fn) => { heard.context = fn; },
    conv: (open = {}) => post({ type: "conv", room: open.room, to: open.to }),
    contact: (peer) => post({ type: "contact", peer }),
    // Fire-and-forget, as the pipe is: neither is answered with anything, and a guest that
    // failed has said so in the shell's Diagnostics.
    cast: (room, ...parts) => { call([ASK_CAST], fromHex(room), ...parts).catch(() => {}); },
    tell: (room, to, ...parts) => { call([ASK_TELL], fromHex(to), fromHex(room), ...parts).catch(() => {}); },
    onFrame: (fn) => { heard.frame = fn; },
  };
})();
