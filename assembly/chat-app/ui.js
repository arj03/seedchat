// chat-app v2 UI. Loaded into a sandboxed iframe by the shell.
//
// With the shell (browser/app-api.js), through view-lib/app.js, which the page names ahead
// of this file:
//   app.ready()                    this view is listening
//   app.call(...)                  a frame for this app's guest, which sends it and answers
//                                  it drawn as this node's own
//   app.conv({ room } | { to })    the conversation now open, which is who a call started
//                                  from the shell is with
//   app.contact(peer)              make a peer a contact, ahead of a direct message to it
//   app.onContext, app.onRender    what this app's guest answered the context, and a
//                                  peer's frame
//
// With this app's guest (guest.js), as bytes the shell does not read. A frame is
// [type u8][body], and the guest knows who each type goes to. What it answers is one of:
//   [0][JSON]      the node's context, ids in hex:
//                  { me, nick, rooms: [{ id, name, members }], linked, contacts, nicks }
//   [type u8][pk_len u8][pk ..][body ..]
//                  a frame as the module drew it: a peer's, as a render, or this node's
//                  own, as the answer to the call that sent it
//
// What a peer is called is not in a frame. A nick is the shell's: this node's own is set
// on its Network tab, and every peer's arrives in the context.
//
// Conversations. A ROOM message (type 5/6) names its room in its body and goes to that
// room's members; the guest draws one only from a peer who is in that room. A DIRECT chat
// (type 3/4) goes to one peer only and names that peer in its body, so the sender's own
// echo can be filed under the right conversation. The body is not secret from the shell
// or the relay's peer, but only the addressee is sent it.
const CHAT_TYPE_DIRECT_TEXT  = 0x03;
const CHAT_TYPE_DIRECT_IMAGE = 0x04;
const CHAT_TYPE_ROOM_TEXT    = 0x05;
const CHAT_TYPE_ROOM_IMAGE   = 0x06;

// Resize images to this width before sending so the JPEG-encoded bytes stay
// under the 64 KB envelope cap.
const IMAGE_MAX_WIDTH    = 600;
const IMAGE_TARGET_BYTES = 50 * 1024;

const logHost = document.getElementById("log");
const form = document.getElementById("form");
const msgInput = document.getElementById("msg");
const meLabel = document.getElementById("me");
const imageBtn = document.getElementById("image-btn");
const imageFile = document.getElementById("image-file");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const side = document.getElementById("side");
const roomList = document.getElementById("room-list");
const directList = document.getElementById("direct-list");
const convName = document.getElementById("conv-name");
const leaveBtn = document.getElementById("leave-btn");
const menuBtn = document.getElementById("menu-btn");
const emptyNote = document.getElementById("empty");
let myPk = null;
// What this node calls itself, as the context says: "" for nothing.
let myNick = "";

const enc = new TextEncoder();
const dec = new TextDecoder();

function shortPk(pk) { return toHex(pk.slice(0, 4)); }
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── who we know ─────────────────────────────────────────────────────────
// pk hex → { id, pk, nick, linked, contact }. Fed by the node's context, and by a render
// from someone it does not list.
const people = new Map();
function person(pk) {
  const id = toHex(pk);
  let p = people.get(id);
  if (!p) { p = { id, pk, nick: "", linked: false, contact: false }; people.set(id, p); }
  return p;
}
// The rooms this node is in, as the context says: room id hex → { id, name, members },
// `members` the key hex of everyone the relay lists there.
const rooms = new Map();
function personName(p) { return p.nick ? `${p.nick} (${shortPk(p.pk)})` : shortPk(p.pk); }
function nameOfId(id) {
  const p = people.get(id);
  return p ? personName(p) : id.slice(0, 8);
}

// ── conversations ───────────────────────────────────────────────────────
// key "r:<room id hex>" or "d:<pk hex>" → { key, kind, name, el, unread }, `name` the id
// after the prefix. `active` is the one open, or null while there is none to show.
const convs = new Map();
let active = null;

function roomKey(id) { return "r:" + id; }
function directKey(id) { return "d:" + id; }

function getConv(key) {
  let c = convs.get(key);
  if (c) return c;
  const el = document.createElement("div");
  el.hidden = true;
  logHost.appendChild(el);
  c = { key, kind: key[0] === "r" ? "room" : "direct", name: key.slice(2), el, unread: 0 };
  convs.set(key, c);
  renderSide();
  return c;
}

function convLabel(c) {
  return c.kind === "room" ? (rooms.get(c.name)?.name ?? "(left)") : nameOfId(c.name);
}

/** Open one conversation, and tell the shell which: a call started now is with it. */
function openConv(key) {
  const c = getConv(key);
  if (active) active.el.hidden = true;
  active = c;
  c.unread = 0;
  c.el.hidden = false;
  emptyNote.hidden = true;
  scrollToBottom();
  // A room is left on the shell's Network tab, not closed here.
  leaveBtn.hidden = c.kind === "room";
  side.classList.remove("open");
  app.conv(c.kind === "room" ? { room: c.name } : { to: c.name });
  renderSide();
}

/** Drop a conversation. With the open one gone, the first room takes its place. */
function closeConv(c) {
  c.el.remove();
  convs.delete(c.key);
  if (active !== c) { renderSide(); return; }
  active = null;
  const first = [...rooms.keys()][0];
  if (first) { openConv(roomKey(first)); return; }
  emptyNote.hidden = false;
  leaveBtn.hidden = true;
  app.conv();
  renderSide();
}

function convButton(key, label, unread) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "conv" + (active && active.key === key ? " active" : "");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  b.appendChild(name);
  if (unread > 0) {
    const u = document.createElement("span");
    u.className = "unread";
    u.textContent = unread > 99 ? "99+" : String(unread);
    b.appendChild(u);
  }
  b.addEventListener("click", () => openConv(key));
  return b;
}

function sideNote(list, text) {
  const none = document.createElement("div");
  none.className = "sys";
  none.style.padding = "0.2em 0.8em";
  none.textContent = text;
  list.appendChild(none);
}

function renderSide() {
  roomList.replaceChildren();
  directList.replaceChildren();
  const joined = [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const room of joined) {
    const id = toHex(room.id), c = convs.get(roomKey(id));
    roomList.appendChild(convButton(roomKey(id), room.name, c ? c.unread : 0));
  }
  if (joined.length === 0) sideNote(roomList, "no room joined");
  // Every contact and everyone linked is one click from a direct chat, as well as everyone
  // we have one with.
  const ids = new Set();
  for (const p of people.values()) if (p.linked || p.contact) ids.add(p.id);
  for (const c of convs.values()) if (c.kind === "direct") ids.add(c.name);
  const rows = [...ids].map(id => ({ id, label: nameOfId(id) }));
  rows.sort((a, b) => a.label.localeCompare(b.label));
  for (const { id, label } of rows) {
    const c = convs.get(directKey(id));
    directList.appendChild(convButton(directKey(id), label, c ? c.unread : 0));
  }
  if (rows.length === 0) sideNote(directList, "no one linked yet");
  convName.textContent = active ? convLabel(active) : "";
}

// ── log rendering ───────────────────────────────────────────────────────
function isAtBottom() {
  // 32px slop so floaty scroll positions still count as "at bottom".
  return logHost.scrollHeight - logHost.scrollTop - logHost.clientHeight < 32;
}
function scrollToBottom() { logHost.scrollTop = logHost.scrollHeight; }

function appendLine(c, node) {
  const stick = c === active && isAtBottom();
  c.el.appendChild(node);
  if (c === active) { if (stick) scrollToBottom(); }
  else { c.unread++; renderSide(); }
}

function print(text, cls, c = active) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  appendLine(c, line);
}

// The author is a click target for a direct chat with them (not for ourselves).
function authorSpan(pk, tag) {
  const author = document.createElement("span");
  author.className = "line-author";
  author.textContent = tag + ":";
  if (!(myPk && arraysEqual(pk, myPk))) {
    author.classList.add("clickable");
    author.title = "Direct message";
    author.addEventListener("click", () => openConv(directKey(toHex(pk))));
  }
  return author;
}

function printMessage(c, pk, tag, text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.appendChild(authorSpan(pk, tag));
  line.appendChild(document.createTextNode(text));
  appendLine(c, line);
}

function appendImage(c, pk, tag, imageBytes, cls) {
  const wrap = document.createElement("div");
  if (cls) wrap.className = cls;
  const head = document.createElement("div");
  head.appendChild(authorSpan(pk, tag));
  head.appendChild(document.createTextNode("[image]"));
  wrap.appendChild(head);
  const blob = new Blob([imageBytes], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.src = url;
  img.alt = "image";
  img.addEventListener("click", () => {
    lightboxImg.src = url;
    lightbox.classList.add("open");
  });
  wrap.appendChild(img);
  appendLine(c, wrap);
}

lightbox.addEventListener("click", () => {
  lightbox.classList.remove("open");
  lightboxImg.src = "";
});

/** Hand this app's guest one frame written in `c`, [type][body]. It knows who each type is
 *  for, sends it, and answers the frame drawn as this node's own: the local echo. */
function send(c, chatType, body) {
  app.call([chatType], body).then(onFrame, (err) => {
    if (convs.has(c.key)) print(`Not sent: ${err.message}`, "err", c);
  });
}

// Send text or an image into one conversation: the frame's body starts with the room's
// id, or the key of the peer it is for.
function sendInto(c, isImage, content) {
  const head = fromHex(c.name);
  if (c.kind === "room") {
    send(c, isImage ? CHAT_TYPE_ROOM_IMAGE : CHAT_TYPE_ROOM_TEXT, concat(head, content));
  } else {
    // A direct message makes its addressee a contact, so the link to it outlives any
    // shared room. Contacts are the shell's, so it is asked, ahead of the frame.
    app.contact(c.name);
    send(c, isImage ? CHAT_TYPE_DIRECT_IMAGE : CHAT_TYPE_DIRECT_TEXT, concat(head, content));
  }
}

// Work out which conversation a render belongs to, and what its content is. Returns
// null for a frame this page has nowhere to file: a room message for a room this node is
// not in, and a direct message addressed to somebody else. Whether a peer may write to a
// room is not asked here: the guest draws a room message only from a peer who is in it.
function route(type, pk, body, isMe) {
  switch (type) {
    case CHAT_TYPE_ROOM_TEXT:
    case CHAT_TYPE_ROOM_IMAGE: {
      if (body.length < 32) return null;
      const id = toHex(body.slice(0, 32));
      if (!rooms.has(id)) return null;
      return { c: getConv(roomKey(id)), image: type === CHAT_TYPE_ROOM_IMAGE, content: body.slice(32) };
    }
    case CHAT_TYPE_DIRECT_TEXT:
    case CHAT_TYPE_DIRECT_IMAGE: {
      if (body.length < 32) return null;
      const to = body.slice(0, 32);
      let other;
      if (isMe) other = to;
      else if (myPk && arraysEqual(to, myPk)) other = pk;
      else return null;                           // addressed to someone else
      return { c: getConv(directKey(toHex(other))), image: type === CHAT_TYPE_DIRECT_IMAGE, content: body.slice(32) };
    }
  }
  return null;
}

/** Say that `id` has a new nick, in every conversation it is part of: the rooms it is in,
 *  and a direct chat with it. */
function sayNick(id, nick, isMe) {
  const said = nick ? `${id.slice(0, 8)} is now known as ${nick}` : `${id.slice(0, 8)} no longer has a nick`;
  for (const [roomId, room] of rooms) {
    if (isMe || room.members.has(id)) print(said, "sys", getConv(roomKey(roomId)));
  }
  const direct = convs.get(directKey(id));
  if (direct) print(said, "sys", direct);
}

/** The node's context: who this node is and what it calls itself, the rooms it is in and
 *  who is in each, the linked peers, the contacts, and what each peer calls itself. */
function onContext(ctx) {
  // The first context is where things stand, not news: nobody's nick is announced for it.
  const first = !myPk;
  if (first) {
    myPk = fromHex(ctx.me);
    emptyNote.textContent = `You are ${shortPk(myPk)}. Join a room on the Network tab, or add a contact, to start chatting.`;
  }
  rooms.clear();
  for (const r of ctx.rooms) rooms.set(r.id, { id: fromHex(r.id), name: r.name, members: new Set(r.members) });
  for (const p of people.values()) p.linked = p.contact = false;
  for (const id of ctx.linked) person(fromHex(id)).linked = true;
  for (const id of ctx.contacts) person(fromHex(id)).contact = true;
  // Nicks are the shell's, a peer's and this node's own alike.
  for (const id of Object.keys(ctx.nicks)) person(fromHex(id));
  for (const p of people.values()) {
    const nick = ctx.nicks[p.id] ?? "";
    if (nick === p.nick) continue;
    p.nick = nick;
    if (!first) sayNick(p.id, nick, false);
  }
  if (ctx.nick !== myNick) {
    myNick = ctx.nick;
    if (!first) sayNick(ctx.me, myNick, true);
  }
  meLabel.textContent = myNick ? `${myNick} (${shortPk(myPk)})` : `${shortPk(myPk)} — set a nick on the Network tab`;
  // A room this node left takes its conversation with it.
  for (const c of [...convs.values()]) if (c.kind === "room" && !rooms.has(c.name)) closeConv(c);
  if (!active && rooms.size > 0) openConv(roomKey([...rooms.keys()][0]));
  else renderSide();
}

/** One frame as the module drew it, a peer's or this node's own. */
function onFrame(payload) {
  if (payload.length < 2) return;
  let p = 0;
  const type  = payload[p++];
  const pkLen = payload[p++];
  if (p + pkLen > payload.length) return;
  const pk = payload.slice(p, p + pkLen); p += pkLen;
  const body = payload.slice(p);
  const isMe = !!myPk && arraysEqual(pk, myPk);
  // The sender's nick is the context's, whoever drew the frame.
  const nick = isMe ? myNick : person(pk).nick;
  const tag = nick ? `${nick} (${shortPk(pk)})` : shortPk(pk);
  const cls = isMe ? "me" : "peer";
  const r = route(type, pk, body, isMe);
  if (!r) return;
  if (r.image) appendImage(r.c, pk, tag, r.content, cls);
  else printMessage(r.c, pk, tag, dec.decode(r.content), cls);
}

app.onContext(onContext);
app.onRender(onFrame);

leaveBtn.addEventListener("click", () => { if (active) closeConv(active); });
menuBtn.addEventListener("click", () => side.classList.toggle("open"));

imageBtn.addEventListener("click", () => imageFile.click());
imageFile.addEventListener("change", async () => {
  const file = imageFile.files && imageFile.files[0];
  imageFile.value = "";
  if (!file) return;
  const target = active;
  if (!target) return;
  try {
    const bitmap = await createImageBitmap(file);
    const targetW = bitmap.width <= IMAGE_MAX_WIDTH ? bitmap.width : IMAGE_MAX_WIDTH;
    const targetH = Math.round(bitmap.height * (targetW / bitmap.width));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, targetW, targetH);
    let bytes = null;
    for (const q of [0.7, 0.5, 0.35, 0.25]) {
      const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
      if (!blob) continue;
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (buf.length <= IMAGE_TARGET_BYTES) { bytes = buf; break; }
      bytes = buf;
    }
    if (!bytes) { print("Image encode failed.", "err", target); return; }
    if (bytes.length > IMAGE_TARGET_BYTES) {
      print(`Image is ${bytes.length} bytes — sending anyway, may exceed 64 KB envelope.`, "err", target);
    }
    // Into the conversation the picture was picked in, even if the user has moved on.
    if (convs.has(target.key)) sendInto(target, true, bytes);
  } catch (err) {
    print(`Image failed: ${err.message}`, "err", target);
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value;
  if (!text || !active) return;
  sendInto(active, false, enc.encode(text));
  msgInput.value = "";
  msgInput.focus();
});

leaveBtn.hidden = true;
renderSide();
app.ready();
msgInput.focus();
