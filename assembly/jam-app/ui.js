// Jam's UI. Loaded into a sandboxed iframe by the shell.
//
// With the shell (browser/app-api.js), by postMessage:
//   us → shell: { type: "ready" }
//   us → shell: { type: "call", bytes }        an ask of this app's guest
//   us → shell: { type: "conv", room: hex }    the room open, which a call is then with
//   shell → us: { type: "render", payload }    what this app's guest answered
//
// With this app's guest (guest.js), as bytes the shell does not read. An ask is [ask u8][..]:
//   [1][frame]           cast: to every linked member of the frame's room
//   [2][to 32][frame]    tell: to one member of it
//   [3][tag 4][bytes]    hash: what a block of these bytes is called
// and a render is one of:
//   [0][JSON]                             the node's context
//   [1][from 32][frame]                   a peer's frame, from someone in its room
//   [2][from 32][room 32][id 32][bytes]   a peer's block, under the id our guest gave it
//   [3][tag 4][id 32]                     the answer to a hash
//
// A FRAME is [type u8][room 32][body], and there are four. One carries what the room
// agrees on; three move audio:
//   1 DOC    JSON, a part of the room's state (below), or all of it
//   2 WANT   block ids, 32 bytes each: send me these
//   3 NACK   block ids: I do not have these
//   4 BLOCK  the bytes of one block
//
// THE ROOM'S STATE is one document, and every change to it is a smaller document of the
// same shape, merged the same way whoever it comes from and however often:
//   msgs    [{ by, id, n, at, text }]         added, never changed
//   reacts  [{ t, e, by, on, n }]             per (target, emoji, peer), the latest `n` wins
//   tracks  [{ id, by, n, title, codec, rate, ch, size, head, blocks, lens, pre, pos, gone, v, vBy }]
//                                             what a track is never changes; where it sits
//                                             (`pos`) goes to the latest (v, vBy), and
//                                             `gone` once set stays set
//   play    { v, by, id, pos, on }            what is playing, the latest (v, by) wins
// `n` and `v` are a clock the room shares: each change takes one more than the highest this
// node has seen. So a newcomer is caught up by being sent the state, a peer that hears a
// change twice is unchanged by the second, and two that change the same thing at once end
// up agreeing on one of them. Three more fields are about the sender rather than the room:
// `hello` asks for the state, `synced` ends an answer to that, and `have` lists the tracks
// the sender holds every block of.
//
// Nothing here is signed. A frame is attributed by the channel it arrived on, and the guest
// passes on only those from members of the room, so the state is the members' to write:
// any of them may reorder the list, and what one relays of another's is its own word.
//
// AUDIO is the file's own bytes, never a copy made of them. A FLAC or Ogg Vorbis file is cut
// where its format lets a piece be decoded without the rest (formats.js), and each piece is
// a block, named by the BLAKE2b-256 of its bytes. A track lists its blocks, how many samples
// each holds (`lens`), the block every piece is decoded behind (`head`), and for Ogg Vorbis
// how much of the piece before goes in front of each when it is decoded (`pre`). So a block
// needs no trust in who sent it: our guest hashes what arrives, and one that is not the
// block asked for is not kept. Whoever added a track serves it from the file on disk, and
// everyone who has fetched a track serves it too.
//
// PLAYING is the room's, and listening is each node's own. `play` says which track, from
// where, and whether it is running. A node that has tuned in asks for the piece the room
// has reached and the ones after it, and holds its own sound to where the room is. It does
// not wait for the whole track, only for enough of it ahead of the room that it will not
// run dry: the room's clock does not stop for a node whose blocks are slow, so a node
// starts once what it holds, and what is still arriving, will carry it through.
const RENDER_CONTEXT = 0, RENDER_FRAME = 1, RENDER_BLOCK = 2, RENDER_HASH = 3;
const ASK_CAST = 1, ASK_TELL = 2, ASK_HASH = 3;
const DOC = 1, WANT = 2, NACK = 3, BLOCK = 4;

/** The largest file taken. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** How far ahead of where it is sounding a node keeps its track decoded, in seconds. */
const AHEAD_S = 8;
/** The least of its track a node holds ahead of the room before it starts sounding, in
 *  seconds: what carries it over a link that stutters. */
const CUSHION_S = 4;
/** How much of the speed blocks have been arriving at is counted on to last. */
const COUNT_ON = 0.8;
/** How long the room waits before a track someone starts begins, when not everyone holds
 *  it yet, in seconds: time for the others to fetch its opening. */
const LEAD_IN_S = 1.5;
/** Blocks asked for and not yet here, across every peer: fewer until one has come and said
 *  how fast they do, since what is asked for cannot be called back, and a slow link has to
 *  deliver all of it before anything asked for after. And how long one is waited for. */
const WINDOW = 4;
const WINDOW_BLIND = 2;
const WANT_TIMEOUT_MS = 15000;
/** A block smaller than this says nothing of how fast blocks arrive: its wait is the trip,
 *  not the bytes. */
const FLOW_MIN_BYTES = 16 * 1024;
/** A peer that let a block time out is not asked again for this long. */
const STRIKE_MS = 8000;
/** A peer that has not answered `hello` is asked again after this long. */
const HELLO_RETRY_MS = 3000;
/** A state answer is cut into documents of about this many characters. */
const DOC_CHARS = 200000;
/** The most a room keeps, and the longest a peer's text is taken. */
const MAX = { msgs: 300, text: 2000, tracks: 500, blocks: 4096, title: 160, emoji: 24, emojis: 40 };

const EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "👀", "😍", "🤩", "😎", "🥳", "😭", "😮", "🙏", "👏", "💯", "✨",
  "🎵", "🎶", "🎸", "🥁", "🎹", "🎷", "🎺", "🎤", "🎧", "💃", "🕺", "🤘", "🙌", "😴", "🤔", "😅",
  "🙃", "😇", "🥲", "😡", "💔", "💜", "🧡", "💚", "⭐", "🌈", "☕", "🍕", "🍻", "🚀", "👎", "🤝"];

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5l9 7-9 7zM16 5h2v14h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 5l-9 7 9 7zM6 5h2v14H6z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 7l-7 9h14z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 17l7-9H5z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM5 18h14v2H5z"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>',
  react: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2a7 7 0 110 14 7 7 0 010-14zM9 9.2a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm6 0a1.3 1.3 0 100 2.6 1.3 1.3 0 000-2.6zm-6.6 4.6c.7 1.6 2 2.5 3.6 2.5s2.9-.9 3.6-2.5l-1.4-.6c-.5 1-1.2 1.6-2.2 1.6s-1.7-.6-2.2-1.6z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const main = $("main"), tabs = $("tabs"), logs = $("logs"), emptyNote = $("empty");
const roomSelect = $("room"), hereLabel = $("here"), meLabel = $("me");
const form = $("form"), msgInput = $("msg"), emojiBtn = $("emoji");
const side = $("side"), player = $("player"), npTitle = $("np-title"), npSub = $("np-sub");
const seek = $("seek"), seekFill = $("seek-fill"), npPos = $("np-pos"), npDur = $("np-dur");
const prevBtn = $("prev"), playBtn = $("play"), nextBtn = $("next"), listenBtn = $("listen"), volume = $("volume");
const listEl = $("list"), listCount = $("list-count"), addBtn = $("add"), aloneNote = $("alone"), fileInput = $("file");
const picker = $("picker"), toasts = $("toasts");

// ── bytes ───────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Block ids as they ride in a WANT or a NACK, back to hex. */
function idsOf(body) {
  const out = [];
  for (let o = 0; o + 32 <= body.length; o += 32) out.push(toHex(body.subarray(o, o + 32)));
  return out;
}
const randomHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

// What a peer sends is read as what it claims to be only once it has that shape.
const isHex = (v, bytes) => typeof v === "string" && v.length === bytes * 2 && /^[0-9a-f]*$/.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isSpan = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const listOf = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
/** Whether the change (v, by) is later than (v0, by0): the clock, then the key. */
const later = (v, by, v0, by0) => v > v0 || (v === v0 && by > by0);

// ── the shell, and our guest ────────────────────────────────────────────
function ask(bytes) {
  window.parent.postMessage({ type: "call", bytes }, "*", [bytes.buffer]);
}
function cast(room, type, body) {
  ask(concat([ASK_CAST, type], room.idBytes, body));
}
function tell(room, to, type, body) {
  ask(concat([ASK_TELL], fromHex(to), [type], room.idBytes, body));
}
const castDoc = (room, doc) => cast(room, DOC, enc.encode(JSON.stringify(doc)));
const tellDoc = (room, to, doc) => tell(room, to, DOC, enc.encode(JSON.stringify(doc)));

/** What a block of `bytes` is called. Our guest's to say, so a view and a guest never name
 *  one block two ways. */
const hashing = new Map(); // tag → { resolve, timer }
let nextTag = 1;
function hashOf(bytes) {
  return new Promise((resolve, reject) => {
    const tag = nextTag++;
    const head = new Uint8Array(5);
    head[0] = ASK_HASH;
    new DataView(head.buffer).setUint32(1, tag);
    const timer = setTimeout(() => { hashing.delete(tag); reject(new Error("the app did not answer")); }, 20000);
    hashing.set(tag, { resolve, timer });
    ask(concat(head, bytes));
  });
}

// ── who, and where ──────────────────────────────────────────────────────
// All of it the shell's, heard in the context: this node's key and nick, each peer's nick,
// who is linked, and the rooms this node is in.
let me = "";
let myNick = "";
let nicks = new Map();
let linked = new Set();
/** The rooms this node is in, by id in hex, and the one open. */
const rooms = new Map();
let active = null;

/** The blocks this node holds, by id in hex, whatever room wants them: a slice of a file
 *  it was given, or bytes a peer sent. */
const store = new Map();
/** The blocks asked of a peer and not yet here: id → { room, t, peer, at }. `asked` is
 *  every id ever asked for, so one that arrives late is still kept. */
const pending = new Map();
const asked = new Set();
/** Peers not to ask for a while, by key: a time on `performance.now()`. */
const strikes = new Map();
/** How fast blocks have been arriving, in this run of asking: the bytes that came and the
 *  seconds they took, each a sum that forgets, so the latest blocks count most; and when
 *  the last one came, or when the asking began. A run that starts after a lull starts from
 *  nothing (`pump`): what came before came from other peers, or over a link that has since
 *  changed. */
const flow = { bytes: 0, seconds: 0, since: 0 };
/** Files being read in, each { room, name, done }. */
const uploads = [];
/** The tracks whose file the user asked for, and that are not all here yet. */
const saving = new Set();
/** Whether this node plays what its room is playing. */
let listening = false;

function newRoom(id) {
  const log = document.createElement("div");
  log.hidden = true;
  logs.appendChild(log);
  return {
    id, idBytes: fromHex(id), name: "", members: new Set(),
    clock: 0,
    msgs: new Map(),    // key → { key, by, id, n, at, text }
    reacts: new Map(),  // target → emoji → peer → { on, n }
    tracks: new Map(),  // id → track; one with no `blocks` is known of and not yet described
    play: { v: 0, by: "", id: null, pos: 0, on: false, at: 0 },
    blocks: new Set(),  // every block id a track here lists: what this room may be asked for
    peers: new Map(),   // the linked members: key → { synced, asked, tries }
    holders: new Map(), // track id → the peers that say they hold all of it
    aim: null,          // where this node asks from while it waits to start: { v, at, known } (`aimOf`)
    log, els: new Map(),
  };
}

const short = (id) => id.slice(0, 8);
function nameOf(id) {
  return (id === me ? myNick : nicks.get(id)) || short(id);
}
const hueOf = (id) => parseInt(id.slice(0, 4), 16) % 360;
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
function fmtSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ── the room's state ────────────────────────────────────────────────────
/** The tracks in the list, in order. */
function liveTracks(room) {
  return [...room.tracks.values()].filter((t) => t.blocks && !t.gone)
    .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
}
/** Whether this node holds every block of `t`. */
function whole(t) {
  if (!t.whole && t.blocks && store.has(t.head) && t.blocks.every((b) => store.has(b))) t.whole = true;
  return t.whole === true;
}
/** Which piece of `t` the place `seconds` into it falls in. */
function pieceAt(t, seconds) {
  const sample = Math.floor(seconds * t.rate);
  let lo = 0, hi = t.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid + 1] > sample) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function holdersOf(room, id) {
  let set = room.holders.get(id);
  if (!set) room.holders.set(id, set = new Set());
  return set;
}
/** The members jamming here besides this node: the linked ones that have answered. A
 *  room-mate that does not run this app is in the room and never answers. */
function jamming(room) {
  return [...room.peers].filter(([, peer]) => peer.synced).map(([id]) => id);
}
/** The linked members that hold `t`. One that just let a block time out is left out while
 *  another can be asked instead. */
function sources(room, t, now) {
  const all = [...holdersOf(room, t.id)].filter((p) => room.peers.has(p));
  const prompt = all.filter((p) => !(strikes.get(p) > now));
  return prompt.length > 0 ? prompt : all;
}
/** How many seconds of `t` this node holds from the place `at` on, with no gap. */
function heldFrom(t, at) {
  if (!store.has(t.head)) return 0;
  if (whole(t)) return t.dur - at;
  let k = pieceAt(t, at);
  while (k < t.blocks.length && store.has(t.blocks[k])) k++;
  return Math.max(0, t.starts[k] / t.rate - at);
}
/** How many seconds of `t` arrive in a second, going by how fast blocks have been coming
 *  and counting on a part of that. Before any has come there is nothing to go by, and it is
 *  taken to be fast. */
function speedOf(t) {
  if (flow.seconds <= 0) return Infinity;
  return ((flow.bytes / flow.seconds) * COUNT_ON) / (t.size / t.dur);
}
/** How much of `t` a node must hold from `at` on before it starts sounding there. Where
 *  blocks come faster than the track plays, a few seconds, against a link that stutters.
 *  Where they come slower, sound once started would run dry and the room would not wait:
 *  so enough that the rest arrives before it is needed, all the way to the track's end. */
function cushion(t, at) {
  const left = t.dur - at, speed = speedOf(t);
  return Math.min(left, speed >= 1 ? CUSHION_S : Math.max(CUSHION_S, (1 - speed) * left));
}
/** Where in its track this node asks for pieces from: where the room is, as a rule. But a
 *  node that is silent, holds nothing where the room is, and has a link too slow to start
 *  at once, would be asking for pieces the room has passed by the time they came. So it
 *  aims ahead, at the place the room will have reached when enough is here to start, asks
 *  from there, and lets the room come to it. */
function aimOf(room, t) {
  const at = Math.max(0, playPos(room));
  if (!room.play.on || soundingAt() >= 0) {
    room.aim = null;
    return at;
  }
  const aim = room.aim && room.aim.v === room.play.v ? room.aim : null;
  if (aim && aim.at >= at) return aim.at;            // the room has yet to come to it
  // The room is where this node aimed, or past it, or it has not aimed yet. What it holds
  // from here is worth adding to if it is gaining on the room, or if it planned for here
  // knowing its speed and is only a little short.
  const speed = speedOf(t), held = heldFrom(t, at);
  if (held > 0 && (speed >= 1 || (aim && aim.known))) return at;
  const lead = speed >= 1 ? CUSHION_S / speed : (1 - speed) * (t.dur - at) + CUSHION_S;
  room.aim = { v: room.play.v, at: Math.min(at + lead, t.dur), known: speed !== Infinity };
  return room.aim.at;
}
/** Where the room is in its track, in seconds. Below zero, the track has yet to begin. */
function playPos(room) {
  const p = room.play;
  return p.on ? p.pos + (performance.now() - p.at) / 1000 : p.pos;
}
function currentTrack(room) {
  const t = room.play.id ? room.tracks.get(room.play.id) : undefined;
  return t && t.blocks && !t.gone ? t : null;
}

/** Whether `t` describes a track: what it is called, how it is coded, and its pieces. */
function describes(t) {
  const n = Array.isArray(t.blocks) ? t.blocks.length : 0;
  return isHex(t.by, 32) && isCount(t.n) && typeof t.title === "string" && isCount(t.size)
    && (t.codec === "flac" || t.codec === "vorbis")
    && isCount(t.rate) && t.rate >= 8000 && t.rate <= 384000 && isCount(t.ch) && t.ch >= 1 && t.ch <= 8
    && isHex(t.head, 32) && n >= 1 && n <= MAX.blocks && t.blocks.every((b) => isHex(b, 32))
    && Array.isArray(t.lens) && t.lens.length === n && t.lens.every((len) => isCount(len) && len > 0 && len <= t.rate * 60)
    && (t.pre === undefined || (Array.isArray(t.pre) && t.pre.length === n && t.pre.every((p) => isCount(p) && p <= 0x100000)));
}

/** Merge a document into the room's state, and answer what changed, for `refresh`. The
 *  same for this node's own change, a peer's, and a whole state: nothing here depends on
 *  who sent it or how often. */
function merge(room, doc) {
  const changed = { msgs: [], added: [], reacts: new Set(), list: false, play: false };
  const seen = (n) => { if (n > room.clock) room.clock = n; };

  for (const m of listOf(doc.msgs, MAX.msgs)) {
    if (!m || !isHex(m.by, 32) || !isHex(m.id, 8) || !isCount(m.n) || typeof m.text !== "string" || m.text === "") continue;
    seen(m.n);
    const key = `m:${m.by}:${m.id}`;
    if (room.msgs.has(key)) continue;
    room.msgs.set(key, { key, by: m.by, id: m.id, n: m.n, at: isCount(m.at) ? m.at : 0, text: m.text.slice(0, MAX.text) });
    changed.msgs.push(key);
  }

  for (const r of listOf(doc.reacts, 4096)) {
    if (!r || typeof r.t !== "string" || r.t.length > 90 || typeof r.e !== "string" || r.e === ""
      || r.e.length > MAX.emoji || !isHex(r.by, 32) || !isCount(r.n)) continue;
    seen(r.n);
    let byEmoji = room.reacts.get(r.t);
    if (!byEmoji) room.reacts.set(r.t, byEmoji = new Map());
    let byPeer = byEmoji.get(r.e);
    if (!byPeer) {
      if (byEmoji.size >= MAX.emojis) continue;
      byEmoji.set(r.e, byPeer = new Map());
    }
    const had = byPeer.get(r.by);
    if (had && had.n >= r.n) continue;
    byPeer.set(r.by, { on: r.on === true, n: r.n });
    changed.reacts.add(r.t);
  }

  for (const t of listOf(doc.tracks, MAX.tracks)) {
    if (!t || !isHex(t.id, 8) || !isCount(t.v) || !isHex(t.vBy, 32)) continue;
    seen(t.v);
    let have = room.tracks.get(t.id);
    if (!have) {
      // A full room forgets the oldest track that was removed, and takes no more once
      // every one it knows of is still in the list.
      if (room.tracks.size >= MAX.tracks) {
        const oldest = [...room.tracks.values()].filter((o) => o.gone).sort((a, b) => a.v - b.v)[0];
        if (!oldest) continue;
        room.tracks.delete(oldest.id);
      }
      room.tracks.set(t.id, have = { id: t.id, blocks: null, pos: 0, gone: false, goneAt: 0, v: 0, vBy: "" });
    }
    // What a track is never changes, so the first description of it stands.
    if (!have.blocks && !have.gone && t.gone !== true && describes(t)) {
      seen(t.n);
      // Where each piece starts, in samples, and so how long the track is.
      const starts = [0];
      for (const len of t.lens) starts.push(starts[starts.length - 1] + len);
      Object.assign(have, {
        by: t.by, n: t.n, title: t.title.slice(0, MAX.title) || "untitled", size: t.size,
        codec: t.codec, rate: t.rate, ch: t.ch, head: t.head, blocks: t.blocks.slice(), lens: t.lens.slice(),
        pre: t.pre ? t.pre.slice() : null, starts, dur: starts[starts.length - 1] / t.rate,
      });
      room.blocks.add(have.head);
      for (const b of have.blocks) room.blocks.add(b);
      changed.added.push(t.id);
      changed.list = true;
    }
    if (t.gone === true && !have.gone) {
      have.gone = true;
      have.goneAt = performance.now();
      forgetTrack(have);
      changed.list = true;
    }
    if (later(t.v, t.vBy, have.v, have.vBy)) {
      if (typeof t.pos === "number" && Number.isFinite(t.pos)) have.pos = t.pos;
      have.v = t.v;
      have.vBy = t.vBy;
      changed.list = true;
    }
  }

  const p = doc.play;
  if (p && isCount(p.v) && isHex(p.by, 32) && (p.id === null || isHex(p.id, 8))
    && typeof p.pos === "number" && Number.isFinite(p.pos) && p.pos >= -60) {
    seen(p.v);
    if (later(p.v, p.by, room.play.v, room.play.by)) {
      room.play = { v: p.v, by: p.by, id: p.id, pos: p.pos, on: p.on === true, at: performance.now() };
      changed.play = true;
    }
  }

  // The oldest messages go once there are too many, and what was said of them.
  if (room.msgs.size > MAX.msgs) {
    const oldest = [...room.msgs.values()].sort((a, b) => a.n - b.n).slice(0, room.msgs.size - MAX.msgs);
    for (const m of oldest) {
      room.msgs.delete(m.key);
      room.reacts.delete(m.key);
      room.els.get(m.key)?.remove();
      room.els.delete(m.key);
    }
  }
  return changed;
}

/** A track as it rides in a document. One that is gone, or not yet described, is its id
 *  and where it stands. */
function wireTrack(t) {
  if (!t.blocks || t.gone) return { id: t.id, pos: t.pos, gone: t.gone, v: t.v, vBy: t.vBy };
  return { id: t.id, by: t.by, n: t.n, title: t.title, codec: t.codec, rate: t.rate, ch: t.ch, size: t.size,
    head: t.head, blocks: t.blocks, lens: t.lens, ...(t.pre ? { pre: t.pre } : {}),
    pos: t.pos, gone: false, v: t.v, vBy: t.vBy };
}

/** The room's whole state, as the documents a newcomer is sent: cut so no frame is large,
 *  with what is playing, what this node holds, and `synced` in the last. */
function stateDocs(room) {
  const docs = [];
  let doc = {}, chars = 0;
  const put = (field, item) => {
    const size = JSON.stringify(item).length;
    if (chars > 0 && chars + size > DOC_CHARS) { docs.push(doc); doc = {}; chars = 0; }
    (doc[field] ??= []).push(item);
    chars += size;
  };
  for (const { by, id, n, at, text } of room.msgs.values()) put("msgs", { by, id, n, at, text });
  for (const [t, byEmoji] of room.reacts) {
    for (const [e, byPeer] of byEmoji) for (const [by, r] of byPeer) put("reacts", { t, e, by, on: r.on, n: r.n });
  }
  for (const t of room.tracks.values()) put("tracks", wireTrack(t));
  const p = room.play;
  // Where the room is NOW, since the reader starts its own clock when this arrives.
  if (p.v > 0) doc.play = { v: p.v, by: p.by, id: p.id, pos: playPos(room), on: p.on };
  doc.have = liveTracks(room).filter(whole).map((t) => t.id);
  doc.synced = true;
  docs.push(doc);
  return docs;
}

/** Make a change of this node's own: here first, then to the room. */
function apply(room, doc) {
  refresh(room, merge(room, doc));
  castDoc(room, doc);
}

/** A peer's document. What it says of the room is merged; what it says of itself is kept
 *  beside the room, under the key the channel gave. */
function onDoc(room, from, doc) {
  if (!doc || typeof doc !== "object") return;
  refresh(room, merge(room, doc), from);
  if (Array.isArray(doc.have)) {
    for (const id of listOf(doc.have, MAX.tracks)) if (isHex(id, 8)) holdersOf(room, id).add(from);
    drawStates();
    pump();
  }
  const peer = room.peers.get(from);
  if (doc.synced === true && peer && !peer.synced) {
    peer.synced = true;
    drawHeader();
  }
  if (doc.hello === true) {
    for (const d of stateDocs(room)) tellDoc(room, from, d);
    // It runs this app after all, so it is worth asking again.
    if (peer && !peer.synced) { peer.tries = 0; greet(room); }
  }
}

/** Ask each linked member that has not answered for the room's state. A member is asked
 *  until it answers, since it may not yet have heard that this node is in the room. */
function greet(room) {
  const now = performance.now();
  for (const [id, peer] of room.peers) {
    if (peer.synced || peer.tries >= 20 || now - peer.asked < HELLO_RETRY_MS) continue;
    peer.asked = now;
    peer.tries++;
    tellDoc(room, id, { hello: true });
  }
}

/** Let go of a track's audio: each block no track still in a list names. */
function forgetTrack(t) {
  if (session && session.t === t) hush();
  saving.delete(t);
  t.whole = false;
  if (!t.blocks) return;
  const kept = new Set();
  for (const room of rooms.values()) {
    for (const other of room.tracks.values()) {
      if (other === t || !other.blocks || other.gone) continue;
      kept.add(other.head);
      for (const b of other.blocks) kept.add(b);
    }
  }
  for (const b of [t.head, ...t.blocks]) if (!kept.has(b)) { store.delete(b); pending.delete(b); }
}

function leaveRoom(room) {
  rooms.delete(room.id);
  for (const t of room.tracks.values()) forgetTrack(t);
  for (const [id, w] of pending) if (w.room === room) pending.delete(id);
  room.log.remove();
}

// ── this node's own changes ─────────────────────────────────────────────
function post(room, text) {
  apply(room, { msgs: [{ by: me, id: randomHex(8), n: ++room.clock, at: Date.now(), text }] });
}

/** Put this node's `emoji` on `target`, or take it off. */
function react(room, target, emoji) {
  const on = room.reacts.get(target)?.get(emoji)?.get(me)?.on !== true;
  apply(room, { reacts: [{ t: target, e: emoji, by: me, on, n: ++room.clock }] });
}

function setPlay(room, id, pos, on) {
  apply(room, { play: { v: ++room.clock, by: me, id, pos, on } });
}

/** Start a track for the room. Whoever starts one is listening. Unless everyone jamming
 *  holds the track already, it begins a moment from now rather than now, so that the others
 *  have its opening by the time it sounds. */
function start(room, id) {
  tuneIn();
  const t = room.tracks.get(id);
  const held = t && whole(t) && jamming(room).every((peer) => holdersOf(room, id).has(peer));
  setPlay(room, id, held ? 0 : -LEAD_IN_S, true);
}

function togglePlay() {
  const room = active;
  if (!room) return;
  const t = currentTrack(room);
  if (!t) {
    const first = liveTracks(room)[0];
    if (first) start(room, first.id);
    return;
  }
  const pos = playPos(room);
  if (room.play.on) { setPlay(room, t.id, Math.max(0, Math.min(pos, t.dur)), false); return; }
  tuneIn();
  setPlay(room, t.id, pos >= t.dur - 0.5 ? 0 : pos, true);
}

/** The next track, or the one before. Back from well into a track is back to its start. */
function step(dir) {
  const room = active;
  if (!room) return;
  const order = liveTracks(room);
  const i = order.findIndex((t) => t.id === room.play.id);
  if (dir < 0 && i >= 0 && playPos(room) > 3) { start(room, order[i].id); return; }
  const to = i < 0 ? order[dir > 0 ? 0 : order.length - 1] : order[i + dir];
  if (to) start(room, to.id);
}

/** Move a track one place up or down: to between the two it lands between. */
function move(room, t, dir) {
  const order = liveTracks(room);
  const i = order.indexOf(t);
  const a = order[dir < 0 ? i - 2 : i + 1], b = order[dir < 0 ? i - 1 : i + 2];
  if (i < 0 || (dir < 0 ? !b : !a)) return;
  const pos = a && b ? (a.pos + b.pos) / 2 : a ? a.pos + 1 : b.pos - 1;
  apply(room, { tracks: [{ id: t.id, pos, gone: false, v: ++room.clock, vBy: me }] });
}

function removeTrack(room, t) {
  apply(room, { tracks: [{ id: t.id, pos: t.pos, gone: true, v: ++room.clock, vBy: me }] });
}

/** Whether this node is the one to move the room on when a track ends: the highest key
 *  there. The others wait a little, and take over only if it does not. */
function leads(room) {
  return jamming(room).every((id) => id < me);
}

/** Move the room on once its track is over, or gone from the list. Every node works this
 *  out from the same state, so they agree on what is next; they say so one after another
 *  rather than all at once. */
function moveOn(room) {
  const p = room.play;
  if (!p.on || !p.id) return;
  // A track this node has not heard of yet is not one it can say is over: a newcomer is
  // told what is playing before it has the whole list.
  const t = room.tracks.get(p.id);
  if (!t || (!t.blocks && !t.gone)) return;
  const over = t.gone ? (performance.now() - Math.max(p.at, t.goneAt)) / 1000 : playPos(room) - t.dur;
  if (over < (leads(room) ? 0.25 : 2.5)) return;
  const next = liveTracks(room).find((o) => o.pos > t.pos || (o.pos === t.pos && o.id > t.id));
  if (next) setPlay(room, next.id, 0, true);
  else setPlay(room, null, 0, false);
}

// ── audio in: files ─────────────────────────────────────────────────────
/** Check that this browser plays a file the way it was cut: its first piece, decoded on its
 *  own behind the head, as every piece will be. A FLAC piece holds exactly the samples its
 *  frames say, so anything else means the cut is wrong. */
async function proves(ix, file) {
  const first = ix.cuts[0];
  let buf;
  try {
    const bytes = await new Blob([ix.head, file.slice(first.start, first.end)]).arrayBuffer();
    buf = await new OfflineAudioContext(ix.channels, 1, ix.rate).decodeAudioData(bytes);
  } catch { throw new Error("this browser cannot play it"); }
  if (ix.codec === "flac" && buf.length !== first.samples) throw new Error("it does not decode the way it was cut");
}

/** Add files to the room's list, one at a time and in the order they were given, however
 *  many are given at once or while others are still being read. */
let adding = Promise.resolve();
function addFiles(room, files) {
  for (const file of files) {
    const up = { room, name: file.name, done: 0 };
    uploads.push(up);
    adding = adding.then(() => addFile(room, file, up));
  }
  drawSoon();
}

/** Add one file. It is cut where its format allows (formats.js) and stays on disk as it
 *  is: a block in the store is a slice of the file, read when a peer asks for it, so what a
 *  peer is sent is the file's own bytes. */
async function addFile(room, file, up) {
  try {
    if (liveTracks(room).length >= MAX.tracks) throw new Error("the list is full");
    if (file.size > MAX_FILE_BYTES) throw new Error(`it is over ${fmtSize(MAX_FILE_BYTES)}`);
    // Half the work is finding where to cut, and half naming the pieces.
    const ix = await indexAudio(file, (part) => { up.done = part / 2; drawStates(); });
    if (ix.cuts.length > MAX.blocks) throw new Error("it is too long");
    await proves(ix, file);
    const head = await hashOf(ix.head);
    store.set(head, new Blob([ix.head]));
    const blocks = [];
    for (const piece of ix.cuts) {
      const part = file.slice(piece.start, piece.end);
      const id = await hashOf(new Uint8Array(await part.arrayBuffer()));
      store.set(id, part);
      blocks.push(id);
      up.done = 0.5 + blocks.length / ix.cuts.length / 2;
      drawStates();
    }
    if (rooms.get(room.id) !== room) return;   // the room was left meanwhile
    const n = ++room.clock;
    const last = Math.max(0, ...[...room.tracks.values()].map((t) => t.pos));
    const id = randomHex(8);
    const { title, artist } = ix.tags;
    apply(room, {
      tracks: [{
        id, by: me, n, size: file.size,
        title: title ? (artist ? `${artist} – ${title}` : title) : file.name.replace(/\.[^.]+$/, "") || file.name,
        codec: ix.codec, rate: ix.rate, ch: ix.channels, head, blocks, lens: ix.cuts.map((c) => c.samples),
        ...(ix.codec === "vorbis" ? { pre: ix.cuts.map((c) => c.pre) } : {}),
        pos: last + 1, gone: false, v: n, vBy: me,
      }],
      have: [id],
    });
  } catch (err) {
    toast(`${file.name} was not added: ${err.message}.`);
  } finally {
    uploads.splice(uploads.indexOf(up), 1);
    drawSoon();
  }
}

// ── audio across: blocks ────────────────────────────────────────────────
/** A track's head and its pieces from `k` on, each as `[track, block id]`. */
function* piecesFrom(t, k) {
  yield [t, t.head];
  for (let i = k; i < t.blocks.length; i++) yield [t, t.blocks[i]];
}

/** The blocks this node wants, soonest needed first. For a node that listens: the piece it
 *  aims at, which is the one the room has reached unless its link is slow (`aimOf`), and
 *  the rest of that track; then the track after it. While nothing is on, the first track in
 *  the list. Then, listening or not, the tracks being downloaded (`saving`), which nothing
 *  is waiting to sound. And last what came before in the track that is on, so that the node
 *  ends up holding all of it and can serve it. */
function* wants() {
  const room = active;
  if (!room) return;
  const order = liveTracks(room);
  const cur = listening ? currentTrack(room) : null;
  const k = cur ? pieceAt(cur, aimOf(room, cur)) : 0;
  if (cur) {
    yield* piecesFrom(cur, k);
    const next = order[order.indexOf(cur) + 1];
    if (next) yield* piecesFrom(next, 0);
  } else if (listening && order[0]) yield* piecesFrom(order[0], 0);
  for (const t of saving) if (room.tracks.get(t.id) === t) yield* piecesFrom(t, 0);
  if (cur) for (let i = 0; i < k; i++) yield [cur, cur.blocks[i]];
}

/** Ask for blocks until a window of them is on its way, spread over the peers that hold
 *  each one's track. Called whenever there may be room: a block arrived, a peer appeared,
 *  a wait ran out, the room moved. */
let turn = 0;
function pump() {
  const room = active;
  if (!room) return;
  const now = performance.now();
  // With nothing on its way a run of asking is over, and the next is measured by itself:
  // forgotten here, ahead of anything that goes by how fast blocks come.
  if (pending.size === 0) {
    flow.bytes = flow.seconds = 0;
    flow.since = now;
  }
  // Where to ask from is settled every time, room to ask or not: on a slow link there
  // seldom is room, and that is when it matters.
  const cur = listening ? currentTrack(room) : null;
  if (cur) aimOf(room, cur);
  let free = (flow.seconds > 0 ? WINDOW : WINDOW_BLIND) - pending.size;
  if (free <= 0) return;
  const from = new Map(), asks = new Map();
  for (const [t, id] of wants()) {
    if (free <= 0) break;
    if (store.has(id) || pending.has(id)) continue;
    if (!from.has(t)) from.set(t, sources(room, t, now));
    const peers = from.get(t);
    if (peers.length === 0) continue;
    const peer = peers[turn++ % peers.length];
    pending.set(id, { room, t, peer, at: now });
    asked.add(id);
    asks.set(peer, [...(asks.get(peer) ?? []), id]);
    free--;
  }
  for (const [peer, ids] of asks) tell(room, peer, WANT, fromHex(ids.join("")));
}

/** A block a peer sent, named by our own guest. Kept if it is one this node asked for. */
function onBlock(from, id, bytes) {
  if (!asked.has(id) || store.has(id)) return;
  const w = pending.get(id);
  pending.delete(id);
  store.set(id, new Blob([bytes]));
  if (w) {
    const now = performance.now();
    if (bytes.length >= FLOW_MIN_BYTES) {
      flow.bytes = flow.bytes * 0.8 + bytes.length;
      flow.seconds = flow.seconds * 0.8 + (now - flow.since) / 1000;
      flow.since = now;
    }
    // A peer that is delivering is not one to give up on, however slowly: what else was
    // asked of it is waited for from now.
    for (const other of pending.values()) if (other.peer === from) other.at = now;
  }
  // Holding all of a track is news for the room: this node can now serve it.
  for (const room of rooms.values()) {
    for (const t of room.tracks.values()) {
      if (t.blocks && !t.gone && !t.told && (w ? t === w.t : t.head === id || t.blocks.includes(id)) && whole(t)) {
        t.told = true;
        castDoc(room, { have: [t.id] });
      }
    }
  }
  for (const t of saving) if (whole(t)) void save(t);
  syncAudio();
  drawStates();
  drawPlayer();
  pump();
}

/** A peer does not have blocks it was asked for: it is not a holder of those tracks. */
function onNack(room, from, ids) {
  for (const id of ids) {
    const w = pending.get(id);
    if (!w || w.peer !== from) continue;
    pending.delete(id);
    holdersOf(w.room, w.t.id).delete(from);
  }
  drawStates();
  pump();
}

/** Send a member the blocks it asked for, of the ones a track in this room lists. */
async function serve(room, from, ids) {
  const lacking = [];
  for (const id of ids.slice(0, 16)) {
    const blob = room.blocks.has(id) ? store.get(id) : undefined;
    try {
      if (!blob) throw new Error("not held");
      tell(room, from, BLOCK, new Uint8Array(await blob.arrayBuffer()));
    } catch { lacking.push(id); }   // not held, or its file can no longer be read
  }
  if (lacking.length > 0) tell(room, from, NACK, fromHex(lacking.join("")));
}

// ── audio back out: a file ──────────────────────────────────────────────
/** Hand the user a track as a file. One this node does not hold all of is fetched first,
 *  whether or not the node listens (`wants`), and saved when its last block is here. */
function download(room, t) {
  if (whole(t)) { void save(t); return; }
  if (sources(room, t, performance.now()).length === 0) {
    toast(`${t.title} cannot be downloaded: nobody here has it.`);
    return;
  }
  saving.add(t);
  drawStates();
  pump();
}

/** Save a track this node holds all of: its head and then its pieces, end to end. The
 *  pieces are the bytes of the file that was added, so the audio is that file's, untouched.
 *  An Ogg Vorbis track comes out as the file itself. A FLAC track comes out as the file's
 *  frames behind the head its pieces are decoded behind, now saying how long the stream is
 *  (formats.js): what the file held besides audio, its tags and pictures, no peer was sent.
 *
 *  The view saves it itself, as a link to a blob, which is the one thing its sandbox lets
 *  it hand the user (`allow-downloads`, shell.js). */
async function save(t) {
  saving.delete(t);
  const flac = t.codec === "flac";
  // Taken now: a track removed while the head is read lets go of its blocks.
  const parts = [t.head, ...t.blocks].map((b) => store.get(b));
  if (flac) parts[0] = flacFileHead(new Uint8Array(await parts[0].arrayBuffer()), t.starts[t.blocks.length]);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(parts, { type: flac ? "audio/flac" : "audio/ogg" }));
  link.download = `${t.title}.${flac ? "flac" : "ogg"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// ── audio out ───────────────────────────────────────────────────────────
// A track sounds a piece at a time. Each piece is decoded on its own, behind the track's
// head, into the samples it holds, and the pieces are set down end to end on the audio
// clock, each starting on the sample the one before it stopped at. So a node needs only the
// piece the room has reached to start sounding, holds a few seconds decoded however long
// the track is, and what it sounds is the file's own samples.
//
// Web Audio does the decoding, not an <audio> element, which cannot be given the bytes:
// this page is sandboxed into an origin of its own, and a media element there never loads a
// blob: URL. It is the same wall that keeps a view from the microphone. The context runs at
// the track's own sample rate, so nothing here resamples.
let audioCtx = null;
let gain = null;
/** The sample rate `audioCtx` was made for. */
let ctxRate = 0;
/** What this node is sounding, or null while it is silent:
 *
 *    t       the track
 *    zero    when sample 0 of the track falls on the context's clock, in samples
 *    k       the next piece to decode
 *    until   the sample the pieces set down so far run to
 *    busy    whether a piece is being decoded
 *    from    when the first piece set down starts, on the context's clock; null before one is
 *    nodes   the source nodes set down and not yet over
 *    out     what they play into, which fades the whole of it in and out */
let session = null;

/** Have the audio context run at `rate`, in place of one that runs at another. */
function tune(rate) {
  if (audioCtx && ctxRate === rate) return;
  hush();
  if (audioCtx) void audioCtx.close();
  // A rate the browser will not run a context at is left to it to convert.
  try { audioCtx = new AudioContext({ sampleRate: rate }); } catch { audioCtx = new AudioContext(); }
  ctxRate = rate;
  gain = audioCtx.createGain();
  gain.gain.value = Number(volume.value);
  gain.connect(audioCtx.destination);
}

/** Start listening. Always behind a click, which is when a browser lets a page that has
 *  made no sound yet make some. */
function tuneIn() {
  listening = true;
  const t = active ? currentTrack(active) : null;
  tune(t ? t.rate : ctxRate || 44100);
  if (audioCtx.state !== "running") void audioCtx.resume();
}

/** Stop sounding: fade out over a moment rather than cut a wave off mid-swing. */
function hush() {
  const s = session;
  if (!s) return;
  session = null;
  const now = audioCtx.currentTime;
  s.out.gain.cancelScheduledValues(now);
  s.out.gain.setValueAtTime(s.out.gain.value, now);
  s.out.gain.linearRampToValueAtTime(0, now + 0.015);
  for (const node of s.nodes) {
    node.onended = null;
    try { node.stop(now + 0.02); } catch {}
  }
  setTimeout(() => s.out.disconnect(), 200);
}

/** Where this node's own audio is in its track, in seconds, or -1 while it is silent. */
function soundingAt() {
  const s = session;
  if (!s || s.from === null || s.nodes.size === 0 || audioCtx.currentTime < s.from) return -1;
  return audioCtx.currentTime - s.zero / s.t.rate;
}

/** Set a decoded piece down on the clock. `buf` is piece `k` as it decoded: its own samples
 *  are the last `lens[k]` of it, since a lead-in decodes in front of them, and a piece that
 *  came out short is short at its start. What of it is already in the past is left off, so
 *  the rest falls where it belongs. Every start is a whole number of samples from the
 *  session's zero, which is what joins one piece to the next without a seam. */
function setDown(s, k, buf) {
  const t = s.t;
  const scale = buf.sampleRate / t.rate;                       // 1, unless the context could not run at the track's rate
  const own = Math.min(buf.length, Math.round(t.lens[k] * scale));
  const starts = (s.zero + t.starts[k + 1]) / t.rate - own / buf.sampleRate;
  const late = Math.max(0, Math.ceil((audioCtx.currentTime + 0.03 - starts) * buf.sampleRate));
  s.until = t.starts[k + 1];
  if (late >= own) return;
  let piece = buf;
  if (own - late !== buf.length) {
    piece = audioCtx.createBuffer(buf.numberOfChannels, own - late, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) piece.copyToChannel(buf.getChannelData(ch).subarray(buf.length - own + late), ch);
  }
  const when = starts + late / buf.sampleRate;
  const node = audioCtx.createBufferSource();
  node.buffer = piece;
  node.connect(s.out);
  node.onended = () => s.nodes.delete(node);
  node.start(when);
  s.nodes.add(node);
  if (s.from !== null) return;
  s.from = when;
  // Coming in partway through a track, fade in: a wave joined mid-swing clicks.
  if (when - s.zero / t.rate > 0.05) {
    s.out.gain.setValueAtTime(0, when);
    s.out.gain.linearRampToValueAtTime(1, when + 0.015);
  }
}

/** Decode the session's next piece once it is near enough to be needed, and set it down.
 *  One at a time and in order. A Vorbis piece is decoded with the end of the piece before
 *  it in front, if this node holds that one (formats.js). */
function feed() {
  const s = session, t = s.t, k = s.k;
  if (s.busy || k >= t.blocks.length || !store.has(t.blocks[k])) return;
  if (t.starts[k] / t.rate > audioCtx.currentTime - s.zero / t.rate + AHEAD_S) return;
  s.busy = true;
  const parts = [store.get(t.head)];
  const before = k > 0 && t.pre && t.pre[k] > 0 ? store.get(t.blocks[k - 1]) : undefined;
  if (before && before.size >= t.pre[k]) parts.push(before.slice(before.size - t.pre[k]));
  parts.push(store.get(t.blocks[k]));
  const ctx = audioCtx;
  new Blob(parts).arrayBuffer().then((bytes) => ctx.decodeAudioData(bytes)).then((buf) => {
    if (session !== s) return;
    s.busy = false;
    s.k = k + 1;
    setDown(s, k, buf);
    feed();
  }, () => {
    if (session !== s) return;
    // A piece that will not decode is a silence its own length, and the track goes on.
    s.busy = false;
    s.k = k + 1;
    s.until = t.starts[k + 1];
    if (!t.bad) toast(`This browser cannot play part of ${t.title}.`);
    t.bad = true;
    feed();
  });
}

/** Hold this node's audio to where its room is: the room's track, from the room's place in
 *  it, sounding if the room is running and this node listens. Called on every change and on
 *  a tick, which is what decodes the next piece in time and corrects any drift.
 *
 *  It does not start until this node holds enough ahead of the room (`cushion`), which is
 *  what keeps slow blocks from stalling it. Sound that runs dry all the same stops rather
 *  than waits, since the room does not wait, and starts again where the room then is, once
 *  enough is here again. */
function syncAudio() {
  const room = active;
  const t = room && listening && room.play.on ? currentTrack(room) : null;
  const at = t ? playPos(room) : 0;
  if (!t || at >= t.dur) {
    hush();
    return;
  }
  if (session && session.t === t) {
    const here = audioCtx.currentTime - session.zero / t.rate;
    const dry = !session.busy && session.k < t.blocks.length && here * t.rate >= session.until;
    if (Math.abs(here - at) < 0.3 && !dry) {
      feed();
      return;
    }
  }
  hush();
  // The room may be a moment before the track's start: then this is set down ahead of time.
  const from = Math.max(0, at);
  if (heldFrom(t, from) < cushion(t, from) - 0.001) return;   // on its way: `pump` has asked
  const k = pieceAt(t, from);
  tune(t.rate);
  if (audioCtx.state !== "running") {
    void audioCtx.resume();   // sounding starts on the tick after it has
    return;
  }
  const out = audioCtx.createGain();
  out.connect(gain);
  session = { t, zero: Math.round((audioCtx.currentTime - at) * t.rate), k, until: t.starts[k], busy: false, from: null, nodes: new Set(), out };
  feed();
}

// ── drawing ─────────────────────────────────────────────────────────────
function button(cls, label, html, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label);
  if (html) b.innerHTML = html;
  b.addEventListener("click", onClick);
  return b;
}

/** The reactions on `target`: one chip an emoji, with how many, lit if one is ours. */
function chips(room, target) {
  const row = document.createElement("div");
  row.className = "chips";
  for (const [emoji, byPeer] of room.reacts.get(target) ?? []) {
    const who = [...byPeer].filter(([, r]) => r.on).map(([id]) => id);
    if (who.length === 0) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${who.includes(me) ? " mine" : ""}`;
    chip.title = who.map(nameOf).join(", ");
    chip.addEventListener("click", () => react(room, target, emoji));
    const count = document.createElement("b");
    count.textContent = who.length;
    chip.append(emoji, count);
    row.appendChild(chip);
  }
  return row;
}

const atBottom = () => logs.scrollHeight - logs.scrollTop - logs.clientHeight < 40;

/** Put a line in a room's log where its clock says it goes. Nearly always the end. */
function place(room, el, n, key) {
  el.dataset.n = n;
  el.dataset.key = key;
  let before = null;
  for (let c = room.log.lastElementChild; c; c = c.previousElementSibling) {
    const cn = Number(c.dataset.n);
    if (cn < n || (cn === n && c.dataset.key < key)) break;
    before = c;
  }
  const stick = room === active && atBottom();
  room.log.insertBefore(el, before);
  room.els.set(key, el);
  if (stick) logs.scrollTop = logs.scrollHeight;
}

function whoSpan(id) {
  const who = document.createElement("span");
  who.className = "who";
  who.dataset.who = id;
  who.style.color = `hsl(${hueOf(id)} 70% 72%)`;
  who.textContent = nameOf(id);
  return who;
}

function drawMessage(room, m) {
  const el = document.createElement("div");
  el.className = "msg";
  // A message of nothing but a few emoji is drawn large.
  if (m.text.length <= 12 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u.test(m.text) && /\p{Extended_Pictographic}/u.test(m.text)) el.classList.add("big");
  const head = document.createElement("div");
  head.className = "msg-head";
  head.appendChild(whoSpan(m.by));
  if (m.at > 0) {
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.appendChild(when);
  }
  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = m.text;
  const reactBtn = button("react icon ghost", "React", ICON.react, () => openPicker(reactBtn, (emoji) => react(room, m.key, emoji)));
  el.append(head, text, chips(room, m.key), reactBtn);
  place(room, el, m.n, m.key);
}

function drawAdded(room, t) {
  const el = document.createElement("div");
  el.className = "event";
  const title = document.createElement("b");
  title.textContent = t.title;
  el.append("♪ ", whoSpan(t.by), " added ", title);
  place(room, el, t.n, `t:${t.id}`);
}

/** Draw what a merge changed. `from` is the peer whose document it was, for the chat tab's
 *  dot. */
function refresh(room, changed, from) {
  for (const key of changed.msgs) drawMessage(room, room.msgs.get(key));
  for (const id of changed.added) drawAdded(room, room.tracks.get(id));
  for (const target of changed.reacts) {
    if (target.startsWith("t:")) { changed.list = true; continue; }
    room.els.get(target)?.querySelector(".chips")?.replaceWith(chips(room, target));
  }
  if (from && changed.msgs.length > 0 && room === active && main.dataset.tab !== "chat") {
    tabs.querySelector('[data-tab="chat"]').classList.add("dot");
  }
  if (room !== active) return;
  emptyNote.hidden = room.log.childElementCount > 0;
  if (changed.list || changed.play) {
    drawSoon();
    syncAudio();
    pump();
  }
}

/** The list's rows as drawn, each { t, li, sub, fill }, and each file being read in with
 *  its row's line of text. Kept so that what only moves, how much of a track is here, is
 *  written into the rows that are there: a list rebuilt under a click loses the click. */
let rows = [];

/** Why a track is not ready to play here, or nothing if it is. */
function trackState(room, t) {
  if (whole(t)) return "";
  const held = t.blocks.filter((b) => store.has(b)).length;
  const part = `${Math.floor((100 * held) / t.blocks.length)}%`;
  if (!saving.has(t) && (held > 0 || t.blocks.some((b) => pending.has(b)))) return part;
  if (sources(room, t, performance.now()).length === 0) return "nobody here has it";
  return saving.has(t) ? `downloading… ${part}` : "";
}

function drawList() {
  const room = active;
  listEl.replaceChildren();
  listCount.textContent = "";
  rows = [];
  if (!room) return;
  const order = liveTracks(room);
  if (order.length > 0) {
    listCount.textContent = `${order.length} track${order.length === 1 ? "" : "s"} · ${fmtTime(order.reduce((s, t) => s + t.dur, 0))}`;
  }
  order.forEach((t, i) => {
    const li = document.createElement("li");
    const current = room.play.id === t.id;
    li.className = `track${current ? " current" : ""}${current && room.play.on ? " playing" : ""}`;
    li.dataset.id = t.id;
    const startBtn = button("start icon ghost", `Play ${t.title}`, current && room.play.on ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : ICON.play,
      () => start(room, t.id));
    const mainEl = document.createElement("div");
    mainEl.className = "t-main";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = t.title;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    mainEl.append(title, sub, chips(room, `t:${t.id}`));
    const acts = document.createElement("div");
    acts.className = "t-acts";
    const reactBtn = button("icon ghost", "React", ICON.react, () => openPicker(reactBtn, (emoji) => react(room, `t:${t.id}`, emoji)));
    const up = button("icon ghost", "Move up", ICON.up, () => move(room, t, -1));
    const down = button("icon ghost", "Move down", ICON.down, () => move(room, t, 1));
    up.disabled = i === 0;
    down.disabled = i === order.length - 1;
    acts.append(reactBtn, up, down, button("icon ghost", "Download", ICON.save, () => download(room, t)),
      button("icon ghost", "Remove", ICON.remove, () => removeTrack(room, t)));
    const fill = document.createElement("div");
    fill.className = "t-fill";
    li.append(startBtn, mainEl, acts, fill);
    listEl.appendChild(li);
    rows.push({ t, li, sub, fill });
  });
  for (const up of uploads) {
    if (up.room !== room) continue;
    const li = document.createElement("li");
    li.className = "track away";
    const mainEl = document.createElement("div");
    mainEl.className = "t-main";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = up.name;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    up.sub = sub;
    mainEl.append(title, sub);
    li.appendChild(mainEl);
    listEl.appendChild(li);
  }
  if (listEl.childElementCount === 0) {
    const li = document.createElement("li");
    li.className = "none note";
    li.textContent = "No music yet. Add some, or drop audio files here: everyone in the room gets the list, and can play it.";
    listEl.appendChild(li);
  }
  drawStates();
}

/** Write into the rows what moves while audio does: how much of each track is here, and how
 *  far each file has been read. */
function drawStates() {
  const room = active;
  if (!room) return;
  for (const { t, li, sub, fill } of rows) {
    const state = trackState(room, t);
    li.classList.toggle("away", state === "nobody here has it");
    sub.textContent = [fmtTime(t.dur), nameOf(t.by), fmtSize(t.size), state].filter(Boolean).join(" · ");
    fill.hidden = whole(t);
    fill.style.width = `${(100 * t.blocks.filter((b) => store.has(b)).length) / t.blocks.length}%`;
  }
  for (const up of uploads) if (up.sub) up.sub.textContent = `reading… ${Math.floor(up.done * 100)}%`;
}

function drawPlayer() {
  const room = active;
  const t = room ? currentTrack(room) : null;
  const on = !!t && room.play.on;
  player.classList.toggle("playing", on);
  // On a narrow page the player is behind a tab, which then says the room is playing.
  tabs.querySelector('[data-tab="side"]').classList.toggle("on", on);
  npTitle.textContent = t ? t.title : "Nothing playing";
  let sub = "";
  if (t) {
    const at = playPos(room);
    if (on && at < 0) sub = "starting…";
    else if (listening && on && at < t.dur && soundingAt() < 0) {
      // A node that listens and hears nothing is waiting to hold enough, and on a slow link
      // knows about when that will be.
      const wait = (room.aim ? room.aim.at : at) - at;
      sub = sources(room, t, performance.now()).length === 0 && !whole(t) ? "nobody here has it"
        : wait > 3 ? `buffering… joins in ${fmtTime(wait)}` : "buffering…";
    } else sub = `${on ? "started" : "paused"} by ${nameOf(room.play.by)}`;
  } else if (room && liveTracks(room).length > 0) sub = "press play to start the room";
  npSub.textContent = sub;
  const label = on ? "Pause for everyone" : "Play for everyone";
  if (playBtn.title !== label) {
    playBtn.innerHTML = on ? ICON.pause : ICON.play;
    playBtn.title = label;
    playBtn.setAttribute("aria-label", label);
  }
  const any = !!room && liveTracks(room).length > 0;
  playBtn.disabled = prevBtn.disabled = nextBtn.disabled = !any;
  listenBtn.textContent = listening ? "🔊 Listening" : "🔇 Tune in";
  listenBtn.classList.toggle("on", listening);
  // Something is on and this node is not hearing it.
  listenBtn.classList.toggle("nudge", on && !listening);
  listenBtn.setAttribute("aria-pressed", String(listening));
  volume.hidden = !listening;
  // Music is added to a room, and is for whoever else is in it. Where there is no room, or
  // nobody else in it is linked, the list says so: a button that only greys out does not
  // say why. Linked, not jamming: a peer that has yet to answer `hello` is there all the same.
  addBtn.hidden = !room;
  const alone = !room ? "Not connected to a room. Join one on the Network tab to add music."
    : room.peers.size > 0 ? ""
    : "Nobody else is connected here yet: music you add is shared once someone joins.";
  aloneNote.textContent = alone;
  aloneNote.hidden = alone === "";
  drawProgress();
}

function drawProgress() {
  const room = active;
  const t = room ? currentTrack(room) : null;
  const pos = t ? Math.max(0, Math.min(playPos(room), t.dur)) : 0;
  const part = t ? pos / t.dur : 0;
  seekFill.style.width = `${part * 100}%`;
  seek.setAttribute("aria-valuenow", String(Math.round(part * 100)));
  npPos.textContent = fmtTime(pos);
  npDur.textContent = t ? fmtTime(t.dur) : "";
  // Where this node's own audio is, for whoever looks from outside: only while it sounds.
  const at = soundingAt();
  if (at >= 0) player.dataset.at = at.toFixed(2);
  else delete player.dataset.at;
}

/** Redraw the list and the player once, after whatever is changing them has finished. */
let drawing = false;
function drawSoon() {
  if (drawing) return;
  drawing = true;
  queueMicrotask(() => {
    drawing = false;
    drawList();
    drawPlayer();
  });
}

function drawHeader() {
  roomSelect.replaceChildren();
  const sorted = [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const room of sorted) roomSelect.add(new Option(`# ${room.name}`, room.id, false, room === active));
  if (sorted.length === 0) roomSelect.add(new Option("no room", ""));
  roomSelect.disabled = sorted.length === 0;
  const here = active ? [me, ...jamming(active)] : [];
  hereLabel.textContent = active ? `${here.length} here` : "";
  hereLabel.title = here.map(nameOf).join(", ");
  meLabel.textContent = me ? (myNick ? `${myNick} (${short(me)})` : `${short(me)} — set a nick on the Network tab`) : "";
  msgInput.disabled = !active;
  emptyNote.hidden = !!active && active.log.childElementCount > 0;
  emptyNote.textContent = active ? "Say something, or add some music."
    : "Join a room on the Network tab: a room is who you jam with.";
  for (const el of document.querySelectorAll("[data-who]")) el.textContent = nameOf(el.dataset.who);
}

/** Open one room, and tell the shell which: a call started now is with it. */
function openRoom(room) {
  if (active) active.log.hidden = true;
  active = room;
  if (room) {
    room.log.hidden = false;
    logs.scrollTop = logs.scrollHeight;
  }
  window.parent.postMessage(room ? { type: "conv", room: room.id } : { type: "conv" }, "*");
  drawHeader();
  drawSoon();
  syncAudio();
  pump();
}

// ── the emoji picker ────────────────────────────────────────────────────
let picked = null;
for (const emoji of EMOJI) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emoji;
  b.addEventListener("click", () => {
    const done = picked;
    closePicker();
    done?.(emoji);
  });
  picker.appendChild(b);
}
function openPicker(anchor, onPick) {
  picked = onPick;
  picker.hidden = false;
  const a = anchor.getBoundingClientRect(), p = picker.getBoundingClientRect();
  const left = Math.max(6, Math.min(a.left, window.innerWidth - p.width - 6));
  const top = a.top - p.height - 6 >= 6 ? a.top - p.height - 6 : Math.min(a.bottom + 6, window.innerHeight - p.height - 6);
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(6, top)}px`;
}
function closePicker() {
  picker.hidden = true;
  picked = null;
}
document.addEventListener("pointerdown", (e) => {
  if (!picker.hidden && !picker.contains(e.target)) closePicker();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });

// ── what the shell hands us ─────────────────────────────────────────────
/** The node's context. Its rooms are ours to keep a state for, and each one's linked
 *  members are who that state is shared with. */
function onContext(ctx) {
  me = ctx.me;
  myNick = ctx.nick;
  nicks = new Map(Object.entries(ctx.nicks));
  linked = new Set(ctx.linked);
  const ids = new Set(ctx.rooms.map((r) => r.id));
  for (const room of [...rooms.values()]) if (!ids.has(room.id)) leaveRoom(room);
  for (const r of ctx.rooms) {
    let room = rooms.get(r.id);
    if (!room) rooms.set(r.id, room = newRoom(r.id));
    room.name = r.name;
    room.members = new Set(r.members);
    // A member that is no longer linked takes what it said of itself with it: when it is
    // back it is asked again, and says again what it holds.
    for (const id of [...room.peers.keys()]) {
      if (linked.has(id) && room.members.has(id)) continue;
      room.peers.delete(id);
      for (const set of room.holders.values()) set.delete(id);
    }
    for (const id of room.members) {
      if (id !== me && linked.has(id) && !room.peers.has(id)) room.peers.set(id, { synced: false, asked: -Infinity, tries: 0 });
    }
    greet(room);
  }
  if (!active || !rooms.has(active.id)) openRoom([...rooms.values()].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null);
  else { drawHeader(); drawSoon(); pump(); }
}

function onFrame(from, frame) {
  if (frame.length < 33) return;
  const room = rooms.get(toHex(frame.subarray(1, 33)));
  if (!room) return;
  const body = frame.subarray(33);
  if (frame[0] === DOC) {
    let doc;
    try { doc = JSON.parse(dec.decode(body)); } catch { return; }
    onDoc(room, from, doc);
  } else if (frame[0] === WANT) void serve(room, from, idsOf(body));
  else if (frame[0] === NACK) onNack(room, from, idsOf(body));
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window.parent) return;
  const msg = ev.data;
  if (!msg || msg.type !== "render") return;
  const p = msg.payload instanceof Uint8Array ? msg.payload : new Uint8Array(msg.payload);
  if (p[0] === RENDER_CONTEXT) onContext(JSON.parse(dec.decode(p.subarray(1))));
  else if (p[0] === RENDER_FRAME && p.length >= 33) onFrame(toHex(p.subarray(1, 33)), p.subarray(33));
  else if (p[0] === RENDER_BLOCK && p.length >= 97) onBlock(toHex(p.subarray(1, 33)), toHex(p.subarray(65, 97)), p.subarray(97));
  else if (p[0] === RENDER_HASH && p.length === 37) {
    const tag = new DataView(p.buffer, p.byteOffset + 1, 4).getUint32(0);
    const waiting = hashing.get(tag);
    if (!waiting) return;
    hashing.delete(tag);
    clearTimeout(waiting.timer);
    waiting.resolve(toHex(p.subarray(5)));
  }
});

// ── what the user does ──────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !active) return;
  post(active, text);
  msgInput.value = "";
  logs.scrollTop = logs.scrollHeight;
  msgInput.focus();
});
emojiBtn.addEventListener("click", () => openPicker(emojiBtn, (emoji) => {
  const at = msgInput.selectionStart ?? msgInput.value.length;
  msgInput.setRangeText(emoji, at, msgInput.selectionEnd ?? at, "end");
  msgInput.focus();
}));

roomSelect.addEventListener("change", () => openRoom(rooms.get(roomSelect.value) ?? null));
for (const b of tabs.querySelectorAll("button")) {
  b.addEventListener("click", () => {
    main.dataset.tab = b.dataset.tab;
    for (const other of tabs.querySelectorAll("button")) other.classList.toggle("active", other === b);
    b.classList.remove("dot");
  });
}

prevBtn.innerHTML = ICON.prev;
nextBtn.innerHTML = ICON.next;
playBtn.addEventListener("click", togglePlay);
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
listenBtn.addEventListener("click", () => {
  if (listening) {
    listening = false;
    void audioCtx.suspend();
  } else tuneIn();
  drawSoon();
  syncAudio();
  pump();
});
volume.addEventListener("input", () => { if (gain) gain.gain.value = Number(volume.value); });

/** Move the room to a place in its track. */
function seekTo(part) {
  const room = active;
  const t = room ? currentTrack(room) : null;
  if (t) setPlay(room, t.id, Math.max(0, Math.min(1, part)) * t.dur, room.play.on);
}
seek.addEventListener("click", (e) => {
  const box = seek.getBoundingClientRect();
  seekTo((e.clientX - box.left) / box.width);
});
seek.addEventListener("keydown", (e) => {
  const t = active ? currentTrack(active) : null;
  if (!t || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  seekTo((playPos(active) + (e.key === "ArrowLeft" ? -5 : 5)) / t.dur);
});

addBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  if (active && files.length > 0) addFiles(active, files);
});
// A file dropped anywhere on the page is for the list, never a place to navigate to.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  side.classList.add("dragover");
});
window.addEventListener("dragleave", () => side.classList.remove("dragover"));
window.addEventListener("drop", (e) => {
  e.preventDefault();
  side.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (active && files.length > 0) addFiles(active, files);
});

// What only time changes: a block that never came, a peer that never answered, a track
// that ran out, sound that drifted from the room, and the progress bar.
setInterval(() => {
  const now = performance.now();
  for (const [id, w] of pending) {
    if (now - w.at < WANT_TIMEOUT_MS) continue;
    pending.delete(id);
    strikes.set(w.peer, now + STRIKE_MS);
  }
  for (const room of rooms.values()) {
    greet(room);
    moveOn(room);
  }
  pump();
  syncAudio();
  drawStates();
  drawPlayer();
}, 250);

drawHeader();
drawList();
drawPlayer();
window.parent.postMessage({ type: "ready" }, "*");
