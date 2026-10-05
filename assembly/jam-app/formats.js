// What jam knows of audio files: where one may be cut so that each piece decodes on its
// own. Nothing here changes a byte of a file, or decodes one. `indexAudio` reads a file
// front to back and answers where its pieces are; the pieces themselves are slices of the
// file, and what a peer is sent is those slices, exactly as they are on disk.
//
// A piece is played by decoding the file's HEAD followed by the piece, as if the two were a
// short file of their own (ui.js). Two formats can be cut that way:
//
//   FLAC         A stream of frames after a header. Every frame decodes without any other,
//                so a piece is whole frames and the head is the stream's STREAMINFO. Where a
//                frame ends is not written down: it is where the next begins, which is
//                found by its sync code and proved by the checksum each frame ends with.
//   Ogg Vorbis   A stream of pages, each saying how long it is and how many samples the
//                stream has reached. A piece is whole pages, cut where no packet runs over,
//                and the head is the pages holding Vorbis's three header packets. A Vorbis
//                packet is decoded against the one before it, so a piece is decoded with the
//                end of the piece before it in front (`pre`), and those samples dropped.
//
// Plain script, put in front of ui.js in the view. It touches no page and no network, only
// a File.

/** A piece is closed once it holds this many bytes, or this many seconds. */
const CUT_BYTES = 256 * 1024;
const CUT_SECONDS = 5;
/** A file is read this much at a time. */
const READ_BYTES = 4 * 1024 * 1024;
/** The largest head taken, since it travels as one block. */
const MAX_HEAD_BYTES = 1024 * 1024;

/** A file read front to back, a window at a time. `buf` is the bytes from file offset
 *  `base` on that have been read and not yet let go of. */
class Feed {
  constructor(file) {
    this.file = file;
    this.buf = new Uint8Array(0);
    this.base = 0;
    this.next = 0;
  }
  get eof() { return this.next >= this.file.size; }
  /** Read one more window onto the end of `buf`. False at the end of the file. */
  async more() {
    if (this.eof) return false;
    const add = new Uint8Array(await this.file.slice(this.next, this.next + READ_BYTES).arrayBuffer());
    this.next += add.length;
    const buf = new Uint8Array(this.buf.length + add.length);
    buf.set(this.buf);
    buf.set(add, this.buf.length);
    this.buf = buf;
    return add.length > 0;
  }
  /** Have `n` bytes read from `buf[i]` on. False if the file ends first. */
  async need(i, n) {
    while (this.buf.length < i + n) if (!(await this.more())) return false;
    return true;
  }
  /** Let go of the first `n` bytes of `buf`. */
  drop(n) {
    this.buf = this.buf.subarray(n);
    this.base += n;
  }
  /** Go on from file offset `at`, without reading what lies between. */
  seek(at) {
    if (at <= this.base + this.buf.length) this.drop(at - this.base);
    else {
      this.buf = new Uint8Array(0);
      this.base = this.next = Math.min(at, this.file.size);
    }
  }
}

const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;

/** Tags as Vorbis comments hold them, in a FLAC file and an Ogg one alike: a vendor string,
 *  then `KEY=value` entries. Answers them by key in lowercase, the first of each. */
function readComments(b, o) {
  const tags = {};
  if (o + 4 > b.length) return tags;
  o += 4 + u32le(b, o);
  if (o + 4 > b.length) return tags;
  let count = u32le(b, o);
  o += 4;
  for (; count > 0 && o + 4 <= b.length; count--) {
    const len = u32le(b, o);
    o += 4;
    // A picture rides as a comment too, and is not read.
    if (len <= 512 && o + len <= b.length) {
      const entry = new TextDecoder().decode(b.subarray(o, o + len));
      const eq = entry.indexOf("=");
      if (eq > 0) tags[entry.slice(0, eq).toLowerCase()] ??= entry.slice(eq + 1);
    }
    o += len;
  }
  return tags;
}

/** Pieces being made as frames or pages are found: `add` takes the next run of bytes that
 *  must stay together and the samples it holds, and starts a new piece when this one is
 *  full. */
function cutter(rate) {
  const cuts = [];
  let cur = null;
  return {
    cuts,
    add(start, end, samples) {
      if (cur && (end - cur.start > CUT_BYTES || (cur.samples + samples) / rate > CUT_SECONDS)) cur = null;
      if (!cur) cuts.push(cur = { start, end, samples: 0, pre: 0 });
      cur.end = end;
      cur.samples += samples;
    },
  };
}

// ── FLAC ────────────────────────────────────────────────────────────────

/** The checksums of a frame: CRC-8 over its header (x^8 + x^2 + x + 1), and CRC-16 over
 *  all of it (x^16 + x^15 + x^2 + 1). */
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let n = 0; n < 256; n++) {
  let c8 = n, c16 = n << 8;
  for (let bit = 0; bit < 8; bit++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[n] = c8;
  CRC16[n] = c16;
}

/** What a frame header's codes stand for, where it says rather than leaving it to the
 *  stream's header: bits per sample, and sample rate. */
const FLAC_BITS = [0, 8, 12, 0, 16, 20, 24, 32];
const FLAC_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

/** A FLAC STREAMINFO block's 34 bytes. */
function flacInfo(b) {
  return {
    rate: (b[10] << 12) | (b[11] << 4) | (b[12] >> 4),
    channels: ((b[12] >> 1) & 7) + 1,
    bits: (((b[12] & 1) << 4) | (b[13] >> 4)) + 1,
  };
}

/** Read a frame header at `b[i]`: answers `{ size, samples, number, variable }`, or null for
 *  bytes that are not one. A header is at most 16 bytes, and ends in its own checksum; one
 *  that disagrees with the stream about channels, sample size or rate is not this stream's. */
function flacHeader(b, i, info) {
  if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return null;
  const size = b[i + 2] >> 4, rate = b[i + 2] & 15, chan = b[i + 3] >> 4, bits = (b[i + 3] >> 1) & 7;
  if (size === 0 || rate === 15 || chan > 10 || bits === 3 || (b[i + 3] & 1) !== 0) return null;
  if ((chan < 8 ? chan + 1 : 2) !== info.channels) return null;
  if (bits !== 0 && FLAC_BITS[bits] !== info.bits) return null;
  if (rate >= 1 && rate <= 11 && FLAC_RATES[rate] !== info.rate) return null;
  // Which frame this is, or which sample it starts at, coded the way UTF-8 codes a character.
  let o = i + 4;
  const first = b[o++];
  let more = 0, number = first;
  if (first >= 0x80) {
    for (let mask = 0x40; first & mask; mask >>= 1) more++;
    if (more === 0 || more > 6) return null;
    number = first & (0x3f >> more);
    for (let n = 0; n < more; n++) {
      const c = b[o++];
      if ((c & 0xc0) !== 0x80) return null;
      number = number * 64 + (c & 0x3f);
    }
  }
  let samples;
  if (size === 1) samples = 192;
  else if (size <= 5) samples = 576 << (size - 2);
  else if (size === 6) samples = b[o++] + 1;
  else if (size === 7) { samples = ((b[o] << 8) | b[o + 1]) + 1; o += 2; }
  else samples = 256 << (size - 8);
  if (rate === 12) o += 1;
  else if (rate === 13 || rate === 14) o += 2;
  let crc = 0;
  for (let j = i; j < o; j++) crc = CRC8[crc ^ b[j]];
  if (crc !== b[o]) return null;
  return { size: o + 1 - i, samples, number, variable: (b[i + 1] & 1) === 1 };
}

/** Whether `next` is the header of the frame after `hdr`'s: numbered one on, or starting at
 *  the sample `hdr`'s frame ends on. */
function flacFollows(hdr, next) {
  return next.variable === hdr.variable && next.number === (hdr.variable ? hdr.number + hdr.samples : hdr.number + 1);
}

function crc16(b, from, to) {
  let crc = 0;
  for (let j = from; j < to; j++) crc = CRC16[(crc >> 8) ^ b[j]] ^ ((crc & 0xff) << 8);
  return crc;
}

async function indexFlac(feed, progress) {
  const cutShort = new Error("it ends inside its header");
  if (!(await feed.need(0, 10))) throw cutShort;
  // Some files carry an ID3v2 tag in front, which says how long it is.
  if (ascii(feed.buf, 0, 3) === "ID3") {
    const b = feed.buf;
    const size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
    feed.seek(10 + size + (b[5] & 0x10 ? 10 : 0));
  }
  if (!(await feed.need(0, 4)) || ascii(feed.buf, 0, 4) !== "fLaC") throw new Error("only FLAC and Ogg Vorbis files can be added");
  feed.drop(4);

  // The metadata blocks: `[last 1 bit][type 7][length 24]`, then that many bytes. The first
  // is STREAMINFO; comments are read for a title; the rest, pictures among them, are
  // stepped over unread.
  let info = null, infoBytes = null, tags = {};
  for (let last = false; !last;) {
    if (!(await feed.need(0, 4))) throw cutShort;
    const type = feed.buf[0] & 127, len = (feed.buf[1] << 16) | (feed.buf[2] << 8) | feed.buf[3];
    last = (feed.buf[0] & 128) !== 0;
    feed.drop(4);
    if ((type === 0 && len === 34) || (type === 4 && len <= MAX_HEAD_BYTES)) {
      if (!(await feed.need(0, len))) throw cutShort;
      if (type === 0) {
        infoBytes = feed.buf.slice(0, 34);
        info = flacInfo(infoBytes);
      } else tags = readComments(feed.buf.subarray(0, len), 0);
    }
    feed.seek(feed.base + len);
  }
  if (!info || info.rate === 0) throw new Error("it has no stream header");

  // The head every piece is decoded behind: the marker and STREAMINFO alone, saying it is
  // the last block. How many samples the stream holds, and their MD5, are true of the whole
  // file and of no piece, so they are left as unknown.
  const head = new Uint8Array(42);
  head.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  head.set(infoBytes, 8);
  head[8 + 13] &= 0xf0;
  head.fill(0, 8 + 14);

  // The frames. `f` is where the one being measured starts in `buf`, `i` the place being
  // tried as its end, and `crc` the CRC-16 of `buf[f, done)`. A frame ends where the bytes
  // so far check out against the two before `i` AND a header that follows on starts at `i`:
  // a sync code turns up inside audio now and then, and even a whole header can.
  if (!(await feed.need(0, 16))) throw new Error("it has no audio in it");
  let hdr = flacHeader(feed.buf, 0, info);
  if (!hdr) throw new Error("its audio does not start where its header ends");
  const out = cutter(info.rate);
  let f = 0, i = hdr.size + 2, crc = 0, done = 0;
  for (;;) {
    if (feed.buf.length < i + 16 && !feed.eof) {
      feed.drop(f);
      i -= f;
      done -= f;
      f = 0;
      await feed.more();
      progress?.(feed.base / feed.file.size);
      continue;
    }
    const b = feed.buf;
    const atEnd = i >= b.length;
    if (atEnd || (b[i] === 0xff && (b[i + 1] & 0xfe) === 0xf8)) {
      const end = Math.min(i, b.length);
      while (done < end - 2) crc = CRC16[(crc >> 8) ^ b[done++]] ^ ((crc & 0xff) << 8);
      if (end - 2 >= f + hdr.size && crc === ((b[end - 2] << 8) | b[end - 1])) {
        const next = atEnd ? null : flacHeader(b, i, info);
        if (atEnd || (next && flacFollows(hdr, next))) {
          out.add(feed.base + f, feed.base + end, hdr.samples);
          if (atEnd) break;
          f = i;
          hdr = next;
          i = f + hdr.size + 2;
          crc = 0;
          done = f;
          continue;
        }
      }
    }
    if (atEnd) {
      // The last frame does not check out to the end of the file. An ID3v1 tag after it is
      // stepped back over; anything else, and the frame is left out.
      const tag = b.length - 128;
      if (tag - 2 >= f + hdr.size && ascii(b, tag, 3) === "TAG" && crc16(b, f, tag - 2) === ((b[tag - 2] << 8) | b[tag - 1])) {
        out.add(feed.base + f, feed.base + tag, hdr.samples);
      }
      break;
    }
    i++;
  }
  if (out.cuts.length === 0) throw new Error("it has no audio in it");
  return { codec: "flac", rate: info.rate, channels: info.channels, head, cuts: out.cuts, tags };
}

/** The head a FLAC track's pieces are decoded behind, as a file of the whole track starts:
 *  the same bytes, with how many samples the stream holds written back in, which is what
 *  tells a player how long it is. Their MD5 stays unknown. A head that is not the 42 bytes
 *  `indexFlac` makes, or a count STREAMINFO's 36 bits cannot hold, is answered as it is. */
function flacFileHead(head, samples) {
  const out = head.slice();
  if (out.length !== 42 || samples >= 0x1000000000) return out;
  out[8 + 13] = (out[8 + 13] & 0xf0) | Math.floor(samples / 0x100000000);
  new DataView(out.buffer).setUint32(8 + 14, samples % 0x100000000);
  return out;
}

// ── Ogg Vorbis ──────────────────────────────────────────────────────────

/** Read the Ogg page at `buf[i]`: answers `{ size, continued, ends, granule, serial, body,
 *  lacing }` with the page fully read, or null where the file ends or stops being pages.
 *  `granule` is how many samples the stream has reached with the last packet that ends on
 *  the page, -1 if none does; `ends` is whether its last packet ends on it. */
async function oggPage(feed, i) {
  if (!(await feed.need(i, 27)) || ascii(feed.buf, i, 4) !== "OggS") return null;
  const segs = feed.buf[i + 26];
  if (!(await feed.need(i, 27 + segs))) return null;
  let body = 0;
  for (let s = 0; s < segs; s++) body += feed.buf[i + 27 + s];
  if (!(await feed.need(i, 27 + segs + body))) return null;
  const b = feed.buf;
  const low = u32le(b, i + 6), high = u32le(b, i + 10);
  return {
    size: 27 + segs + body,
    continued: (b[i + 5] & 1) !== 0,
    ends: segs > 0 && b[i + 26 + segs] < 255,
    granule: low === 0xffffffff && high === 0xffffffff ? -1 : high * 0x100000000 + low,
    serial: u32le(b, i + 14),
    lacing: b.subarray(i + 27, i + 27 + segs),
    body: i + 27 + segs,
  };
}

async function indexVorbis(feed, progress) {
  // The head: every page up to the one Vorbis's third header packet ends on. The first
  // packet says what the stream is, the second holds its tags, and the third its codebooks.
  let i = 0, packets = 0, packet = [], info = null, tags = {}, serial = 0;
  while (packets < 3) {
    const page = await oggPage(feed, i);
    if (!page) throw new Error("it ends inside its header");
    if (i === 0) serial = page.serial;
    let o = page.body;
    for (const len of page.lacing) {
      if (packets < 2) packet.push(feed.buf.slice(o, o + len));
      o += len;
      if (len === 255) continue;
      // A packet ends with a segment that is not full.
      const whole = new Uint8Array(packet.reduce((n, p) => n + p.length, 0));
      packet.reduce((at, p) => (whole.set(p, at), at + p.length), 0);
      packet = [];
      if (packets === 0) {
        if (whole[0] !== 1 || ascii(whole, 1, 6) !== "vorbis") throw new Error("only FLAC and Ogg Vorbis files can be added");
        info = { channels: whole[11], rate: u32le(whole, 12) };
      } else if (packets === 1) tags = readComments(whole, 7);
      packets++;
    }
    i += page.size;
    if (i > MAX_HEAD_BYTES) throw new Error("its tags are too large to pass on");
  }
  if (!info || info.rate === 0 || info.channels === 0) throw new Error("it has no stream header");
  const head = feed.buf.slice(0, i);

  // The audio pages. A piece may end on a page whose last packet ends on it, which is also
  // where the stream says how many samples it has reached. The piece after it is decoded
  // with this one's last pages in front, from the last page that starts with a new packet.
  const cuts = [];
  let cur = null, reached = 0, pre = 0;
  const close = (granule) => {
    cuts.push({ start: cur.start, end: cur.end, samples: granule - reached, pre });
    pre = cur.end - cur.fresh;
    reached = granule;
    cur = null;
  };
  for (;;) {
    // A page that has been measured is not needed again: a piece is offsets into the file.
    if (i > READ_BYTES) {
      feed.drop(i);
      i = 0;
      progress?.(feed.base / feed.file.size);
    }
    const page = await oggPage(feed, i);
    if (!page) break;
    if (page.serial !== serial) throw new Error("it holds more than one stream");
    const start = feed.base + i;
    if (!cur) cur = { start, end: start, fresh: start, granule: -1 };
    if (!page.continued) cur.fresh = start;
    cur.end = start + page.size;
    i += page.size;
    if (!page.ends || page.granule <= reached) continue;
    cur.granule = page.granule;
    if (cur.end - cur.start >= CUT_BYTES || (page.granule - reached) / info.rate >= CUT_SECONDS) close(page.granule);
  }
  if (cur && cur.granule > reached) close(cur.granule);
  if (cuts.length === 0) throw new Error("it has no audio in it");
  return { codec: "vorbis", rate: info.rate, channels: info.channels, head, cuts, tags };
}

/** Find where an audio file may be cut. Answers
 *
 *    { codec, rate, channels, head, cuts: [{ start, end, samples, pre }], tags }
 *
 *  `head` is the bytes every piece is decoded behind. Each cut is a piece: the file's bytes
 *  `[start, end)`, the samples it adds, and how many bytes off the end of the piece before
 *  it go in front of it when it is decoded. Throws, saying why, for a file that is neither
 *  format or cannot be cut. `progress` is called with how much of the file has been read. */
async function indexAudio(file, progress) {
  const feed = new Feed(file);
  if (!(await feed.need(0, 4))) throw new Error("it is empty");
  if (ascii(feed.buf, 0, 4) === "OggS") return indexVorbis(feed, progress);
  return indexFlac(feed, progress);
}
