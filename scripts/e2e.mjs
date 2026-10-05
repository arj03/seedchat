// End-to-end test in a real browser: does the SHELL still work?
//
// scripts/smoke.mjs replays the host and the apps' guests headlessly, which is everything
// but the page: browser/shell.js and each app's view only run in a browser. This
// drives two tabs of one — two nodes, since the identity is per tab — with a real
// seedrelay between them, through what a person would do: drop a bundle, join a room, set
// a nick, offer the app, install the offer, write, replace an app in place, write to one
// peer, start a call, remove an app, reload. Then the jam app beside chat: a message, a reaction,
// a FLAC file added in one tab, downloaded in the other and streamed to it, a seek, the
// list moved on, a peer held to a slow uplink, the list reordered and trimmed, a reload
// that gets the room and its music back from the other tab, and a tab left alone in the
// room. Run it after a change to the shell or a view:
//
//   npm run e2e            (after `npm run build`)
//
// It needs Chrome, Edge or Chromium installed; E2E_BROWSER is the path of one that lives
// somewhere this script does not look. The browser runs headless under a profile directory of its
// own and is driven over the DevTools pipe, so it joins no browser already running and
// opens no debugging port. The page is served from browser/ and the relay is the
// `seedrelay` dependency, each on a free local port.
//
// It stops at the first step that fails, printing both tabs' Diagnostics and whatever the
// pages logged as an error, and exits non-zero.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── what it runs against ──────────────────────────────────────────────────────

/** A Chromium-family browser: the one E2E_BROWSER names, else the first usual place that
 *  holds one. They all take the same flags and speak the same DevTools protocol. */
function findBrowser() {
  if (process.env.E2E_BROWSER) return process.env.E2E_BROWSER;
  const env = process.env;
  const candidates = process.platform === "win32" ? [
    join(env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
    join(env.ProgramFiles ?? "", "Microsoft/Edge/Application/msedge.exe"),
    join(env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
    join(env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
    join(env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const browserPath = findBrowser();
if (!browserPath || !existsSync(browserPath)) {
  console.error(browserPath
    ? `e2e: E2E_BROWSER names ${browserPath}, which does not exist`
    : "e2e: no Chrome, Edge or Chromium found — set E2E_BROWSER to the path of one");
  process.exit(2);
}
const relayPath = join(root, "node_modules", "seedrelay", "server.mjs");
for (const [path, why] of [
  [join(root, "bundle", "chat.skb"), "run `npm run build` first"],
  [join(root, "bundle", "jam.skb"), "run `npm run build` first"],
  [join(root, "browser", "vendor", "host"), "run `npm run build` first"],
  [relayPath, "run `npm install` first"],
]) {
  if (!existsSync(path)) { console.error(`e2e: ${path} not found — ${why}`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// The page, served from browser/ with caching off, as `npm run serve` does.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const path = join(root, "browser", decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// The relay. It answers a page only from an origin it allows, and its defaults are the
// usual local ports, so this one is told the port the page was just given.
const relayPort = await freePort();
const procs = [spawn(process.execPath, [relayPath, "--port", String(relayPort), "--allow-origin", origin], { stdio: "ignore" })];
for (let i = 0; ; i++) {
  const up = await new Promise((resolve) => {
    const s = net.connect(relayPort, "127.0.0.1", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  if (up) break;
  if (i > 50) { console.error("e2e: the relay did not start"); process.exit(2); }
  await sleep(100);
}

// The browser. A fake camera and microphone, granted without a prompt, let a call start,
// and a page may play audio without a click first, since nothing here is a person's click.
const profile = mkdtempSync(join(tmpdir(), "seedchat-e2e-"));
/** Where the browser puts a file a view saves, each under the id its download was given. */
const saved = mkdtempSync(join(tmpdir(), "seedchat-e2e-saved-"));
const browser = spawn(browserPath, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
browser.on("error", (err) => {
  console.error(`e2e: could not start ${browserPath}: ${err.message}`);
  void cleanup().then(() => process.exit(2));
});
// A browser that went away is reported above, or by the step waiting on it, not by a
// write to its closed pipe.
browser.stdio[3].on("error", () => {});
procs.push(browser);

async function cleanup() {
  for (const p of procs) { try { p.kill(); } catch {} }
  server.close();
  await sleep(500);
  for (const dir of [profile, saved]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {}
  }
}

// ── the DevTools protocol, over the browser's pipe ────────────────────────────
//
// One JSON message per NUL-terminated chunk, each way. A command names the session (a tab,
// or a frame in its own process) it is for; an event names the one it came from.
let nextId = 0;
const pending = new Map();
const listeners = [];
let inbox = Buffer.alloc(0);
browser.stdio[4].on("data", (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  for (let end; (end = inbox.indexOf(0)) >= 0; inbox = inbox.subarray(end + 1)) {
    const m = JSON.parse(inbox.subarray(0, end).toString("utf8"));
    if (m.id === undefined) { for (const l of listeners) l(m); continue; }
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  }
});
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

// What the pages logged as an error, the frames that run in a process of their own, and
// the files a view saved.
const errors = [];
const frames = new Map(); // tab session → sessions of its out-of-process frames
const downloads = new Map(); // download id → { name, done }
listeners.push((m) => {
  if (m.method === "Browser.downloadWillBegin") downloads.set(m.params.guid, { name: m.params.suggestedFilename, done: false });
  if (m.method === "Browser.downloadProgress" && m.params.state === "completed" && downloads.has(m.params.guid)) downloads.get(m.params.guid).done = true;
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
    frames.set(m.sessionId, [...(frames.get(m.sessionId) ?? []), m.params.sessionId]);
    // What a view logs as an error counts as its page's.
    for (const domain of ["Runtime", "Log"]) void send(`${domain}.enable`, {}, m.params.sessionId).catch(() => {});
  }
  if (m.method === "Target.detachedFromTarget") {
    for (const [tab, list] of frames) frames.set(tab, list.filter((s) => s !== m.params.sessionId));
  }
  // A confirm() is answered yes: removing an app asks.
  if (m.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
});

async function evaluate(sessionId, expression, contextId) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Open the shell in a new tab: a node of its own. */
async function openTab(name) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const domain of ["Page", "Runtime", "Log", "DOM"]) await send(`${domain}.enable`, {}, sessionId);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await send("Page.navigate", { url: `${origin}/shell.html` }, sessionId);
  return { name, sid: sessionId };
}

/** Evaluate in the shell's own page. */
const page = (tab, expression) => evaluate(tab.sid, expression);

/** Evaluate in the tab's app view, the sandboxed iframe of its one installed app. The view
 *  is another origin, so the page cannot be asked: the frame is reached as its own target
 *  when the browser gave it a process, and otherwise through an isolated world in it, which
 *  shares its DOM, so a click or a form submit there reaches the app's own listeners. */
async function view(tab, expression) {
  const own = frames.get(tab.sid) ?? [];
  if (own.length > 0) return evaluate(own[own.length - 1], expression);
  const kids = (await send("Page.getFrameTree", {}, tab.sid)).frameTree.childFrames ?? [];
  if (kids.length === 0) throw new Error("no app view");
  const { executionContextId } = await send("Page.createIsolatedWorld",
    { frameId: kids[kids.length - 1].frame.id, worldName: "e2e" }, tab.sid);
  return evaluate(tab.sid, expression, executionContextId);
}

/** Evaluate in one of the tab's app views, the one whose page has this title: for a tab
 *  with two apps installed. Reached the way `view` reaches the only one. */
async function viewTitled(tab, title, expression) {
  const isIt = `document.title === ${JSON.stringify(title)}`;
  for (const sid of frames.get(tab.sid) ?? []) {
    if (await evaluate(sid, isIt).catch(() => false)) return evaluate(sid, expression);
  }
  const kids = (await send("Page.getFrameTree", {}, tab.sid)).frameTree.childFrames ?? [];
  for (const kid of kids) {
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: kid.frame.id, worldName: "e2e" }, tab.sid);
    if (await evaluate(tab.sid, isIt, executionContextId)) return evaluate(tab.sid, expression, executionContextId);
  }
  throw new Error(`no ${title} view`);
}

// ── the steps ─────────────────────────────────────────────────────────────────

const ok = (what) => console.log(`  OK   ${what}`);
class Failed extends Error {}
function check(cond, what) {
  if (!cond) throw new Failed(what);
  ok(what);
}
/** Wait until `fn` answers true, since everything here is a page reacting to a network. */
async function waitFor(what, fn, ms = 20000) {
  for (const start = Date.now(); ; await sleep(150)) {
    try { if (await fn()) { ok(what); return; } } catch {}
    if (Date.now() - start > ms) throw new Failed(`${what} (timed out)`);
  }
}

const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
const click = (id) => `document.getElementById(${JSON.stringify(id)}).click()`;
const clickButton = (list, label) =>
  `[...document.querySelectorAll('#${list} button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`;

/** Pick a bundle in the Apps tab's file field, which is what dropping it does. */
async function drop(tab, file) {
  const { root: doc } = await send("DOM.getDocument", {}, tab.sid);
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.nodeId, selector: "#app-file" }, tab.sid);
  await send("DOM.setFileInputFiles", { files: [join(root, "bundle", file)], nodeId }, tab.sid);
}
const appShown = (tab) => page(tab, text("app-status"));
const frameCount = (tab) => page(tab, "document.querySelectorAll('iframe.app-frame').length");
const peerPill = (tab) => page(tab, text("peer-pill-text"));
const contactsOf = (tab) => page(tab, "sessionStorage.getItem('chat.contacts') ?? ''");
const keyOf = (tab) => page(tab, "JSON.parse(sessionStorage.getItem('chat.identity')).pk.map((b) => b.toString(16).padStart(2, '0')).join('')");
const setNick = (tab, nick) => page(tab, `document.getElementById('nick').value = ${JSON.stringify(nick)}; ${click("set-nick")}`);
/** Write a message in chat's view and send it. */
const say = (tab, message) => view(tab, `document.getElementById('msg').value = ${JSON.stringify(message)}; document.getElementById('form').requestSubmit()`);
const logOf = (tab) => view(tab, text("log"));
/** Chat's conversation list names the room once its view has heard the context. */
const roomsInView = (tab) => view(tab, text("room-list"));

/** Evaluate in the tab's jam view, which stands beside its chat view. */
const jam = (tab, expression) => viewTitled(tab, "Jam", expression);
const jamSay = (tab, message) => jam(tab, `document.getElementById('msg').value = ${JSON.stringify(message)}; document.getElementById('form').requestSubmit()`);
/** The titles in jam's playlist, in order. */
const jamList = (tab) => jam(tab, "[...document.querySelectorAll('#list .t-title')].map((e) => e.textContent).join(' | ')");
/** What jam's playlist says of there being nobody to play to, or nothing if it says none. */
const jamAlone = (tab) => jam(tab, "(() => { const note = document.getElementById('alone'); return note.hidden ? '' : note.textContent; })()");
/** Where the tab's own audio is in its track, in seconds, or -1 while it makes no sound. */
const jamAudio = (tab) => jam(tab, "Number(document.getElementById('player').dataset.at ?? -1)");
/** Click a button on a track's row in jam's playlist, by the track's title. */
const jamTrack = (tab, title, label) => jam(tab, `[...document.querySelectorAll('#list .track')].find((li) => li.querySelector('.t-title').textContent === ${JSON.stringify(title)})
  .querySelector(${JSON.stringify(`button[title^="${label}"]`)}).click()`);
/** A FLAC file of a tone `seconds` long, as bytes: 16-bit mono at 44.1 or 96 kHz, every
 *  subframe VERBATIM, which is the samples as they are and so needs no compressor to
 *  write. Run in the view, not here: it is passed over as its own source, so it leans on
 *  nothing outside itself.
 *
 *  Inside the audio of each frame it plants the header of the frame that follows, checksum
 *  and all. A FLAC frame does not say how long it is, so jam finds where one ends by the
 *  next one's header, and only the frame's own CRC-16 tells these from the real thing: a
 *  file cut at one would not decode to the samples its list says. */
function makeFlac(seconds, rate = 44100) {
  const block = 4096, total = Math.round(seconds * rate);
  const crc8 = (bytes) => {
    let crc = 0;
    for (const x of bytes) {
      crc ^= x;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
  };
  const crc16 = (bytes, n) => {
    let crc = 0;
    for (let j = 0; j < n; j++) {
      crc ^= bytes[j] << 8;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  };
  // [sync][block size, rate][mono, 16 bits][frame number, as UTF-8][block size - 1, if not 4096][CRC-8]
  const headerOf = (num, count) => {
    const h = [0xff, 0xf8, ((count === block ? 12 : 7) << 4) | (rate === 96000 ? 11 : 9), 4 << 1, ...(num < 0x80 ? [num] : [0xc0 | (num >> 6), 0x80 | (num & 63)])];
    if (count !== block) h.push((count - 1) >> 8, (count - 1) & 255);
    h.push(crc8(h));
    return h;
  };
  const pcm = new Int16Array(total);
  for (let n = 0; n < total; n++) pcm[n] = Math.round(Math.sin((n * 2 * Math.PI * 440) / rate) * 6000);
  const frames = [];
  for (let n = 0, num = 0; n < total; n += block, num++) {
    const count = Math.min(block, total - n);
    if (count === block && n + block < total) {
      const decoy = headerOf(num + 1, Math.min(block, total - n - block));
      for (let k = 0; k + 1 < decoy.length; k += 2) pcm[n + 300 + k / 2] = (((decoy[k] << 8) | decoy[k + 1]) << 16) >> 16;
    }
    const head = headerOf(num, count);
    const frame = new Uint8Array(head.length + 1 + count * 2 + 2);
    frame.set(head);
    let o = head.length;
    frame[o++] = 0x02;   // one VERBATIM subframe
    for (let i = 0; i < count; i++) {
      frame[o++] = (pcm[n + i] >> 8) & 255;
      frame[o++] = pcm[n + i] & 255;
    }
    const crc = crc16(frame, o);
    frame[o++] = crc >> 8;
    frame[o++] = crc & 255;
    frames.push(frame);
  }
  // "fLaC", then STREAMINFO as the only metadata block
  const out = new Uint8Array(42 + frames.reduce((size, f) => size + f.length, 0));
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, block >> 8, block & 255, block >> 8, block & 255]);
  out.set([rate >> 12, (rate >> 4) & 255, (rate & 15) << 4, 15 << 4, (total >>> 24) & 255, (total >>> 16) & 255, (total >>> 8) & 255, total & 255], 18);
  let at = 42;
  for (const frame of frames) {
    out.set(frame, at);
    at += frame.length;
  }
  return out;
}

/** Give jam's file field a file, as picking one would. `bytes` is an expression for what
 *  the file holds, evaluated in the view. */
const jamPick = (tab, name, bytes) => jam(tab, `(() => {
  const picked = new DataTransfer();
  picked.items.add(new File([${bytes}], ${JSON.stringify(name)}));
  const field = document.getElementById("file");
  field.files = picked.files;
  field.dispatchEvent(new Event("change"));
})()`);
/** Give it a FLAC file of this many seconds: at a megabyte for twelve, several of the pieces
 *  jam cuts a file into. */
const jamAddFlac = (tab, name, seconds, rate = 44100) => jamPick(tab, name, `(${makeFlac})(${seconds}, ${rate})`);
/** Hold a tab's jam to sending audio at `rate` bytes a second, as a thin uplink would, or
 *  with 0 let it go again. This is the one place the test reaches inside a view, because
 *  nothing outside one can make a peer slow: it puts in place of the view's `tell` one that
 *  sends each block only when those before it have had their time on the wire. */
const jamUplink = (tab, rate) => jam(tab, `(() => {
  const script = document.createElement("script");
  script.textContent = ${JSON.stringify(`(() => {
    if (typeof tell !== "function" || typeof BLOCK !== "number") throw new Error("jam's view has no tell to hold back");
    const send = window.tellAtFullSpeed ??= tell;
    let line = Promise.resolve();
    tell = ${rate} === 0 ? send : (room, to, type, body) => {
      if (type !== BLOCK) return send(room, to, type, body);
      line = line.then(() => new Promise((sent) => setTimeout(sent, (body.length / ${rate}) * 1000))).then(() => send(room, to, type, body));
    };
    document.documentElement.dataset.uplink = "${rate}";
  })();`)};
  document.body.appendChild(script);
  return document.documentElement.dataset.uplink;
})()`);
/** Click jam's seek bar this far along it. */
const jamSeek = (tab, part) => jam(tab, `(() => {
  const bar = document.getElementById("seek"), box = bar.getBoundingClientRect();
  bar.dispatchEvent(new MouseEvent("click", { clientX: box.left + box.width * ${part}, bubbles: true }));
})()`);

// A whole run takes about a minute; a browser that hangs must not hang the caller.
setTimeout(() => { console.error("\ne2e: gave up after 5 minutes"); void cleanup().then(() => process.exit(1)); }, 300000).unref();

let A, B;
let failure = null;
try {
  // 1. the shell boots in two tabs: two nodes
  A = await openTab("A");
  B = await openTab("B");
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: the shell boots`, async () => /^id [0-9a-f]{8}$/.test(await page(tab, text("identity-pill"))));
  }
  const [keyA, keyB] = [await keyOf(A), await keyOf(B)];

  // 2. A installs chat by dropping its bundle; the row says what the bundle serves and
  //    reaches, read off its signed manifest
  await drop(A, "chat.skb");
  await waitFor("A: chat installs from a dropped .skb", async () => (await appShown(A)) === "Chat v2");
  const row = await page(A, text("app-list"));
  check(/serves “chat”/.test(row) && /reaches the network/.test(row) && /bundle [0-9a-f]{12}/.test(row),
    "A: the app's row says what it serves and reaches");

  // 3. join one room on the relay, which takes no app; an app's view hears of the room
  //    from its own guest
  for (const tab of [A, B]) {
    await page(tab, `document.getElementById('relay-url').value = 'ws://127.0.0.1:${relayPort}'; document.getElementById('relay-room').value = 'e2e'; ${click("join-room")}`);
  }
  for (const tab of [A, B]) await waitFor(`${tab.name}: linked to the other tab`, async () => /^1 peer/.test(await peerPill(tab)));
  await waitFor("A: chat's view hears of the room", async () => (await roomsInView(A)).includes("e2e"));

  // 4. a nick is the shell's: set on A's Network tab, told to B's page and shown by B's
  //    shell, with no app carrying it. B has none yet
  await setNick(A, "ann");
  await waitFor("B: the shell names A by its nick", async () => (await page(B, text("room-list"))).includes("ann"));

  // 5. A offers chat through the offers app; B's row for it shows what Install grants,
  //    and installing it is how B comes by the app
  await page(A, clickButton("app-list", "Offer to peers"));
  await waitFor("B: the offer arrives", async () => (await page(B, "document.querySelectorAll('#offer-list .offer-row').length")) === 1);
  const offer = await page(B, text("offer-list"));
  check(/serves “chat”/.test(offer) && /reaches the network/.test(offer) && offer.includes(keyA.slice(0, 8)),
    "B: the offer's row says what it serves and reaches, and who it is from");
  await page(B, clickButton("offer-list", "Install"));
  await waitFor("B: chat installs from the offer", async () => (await appShown(B)) === "Chat v2");
  await waitFor("B: chat's view hears of the room", async () => (await roomsInView(B)).includes("e2e"));

  // 6. a room message, drawn at the far end under the nick its view read out of the
  //    context, and echoed at the near one
  await waitFor("A: chat's view says who this node is", async () => /^ann \([0-9a-f]{8}\)$/.test(await view(A, text("me"))));
  await say(A, "hello from A");
  await waitFor("B: chat draws A's room message under its nick", async () => /ann \([0-9a-f]{8}\):hello from A/.test(await logOf(B)));
  await waitFor("A: chat draws its own echo", async () => (await logOf(A)).includes("hello from A"));

  // 7. a bundle dropped over an app already installed replaces it in place, which is how
  //    an app is upgraded: a new guest, module and view under the same label, in the one
  //    frame, and the same shell
  await drop(A, "chat.skb");
  await waitFor("A: the dropped bundle replaces chat in place, and its view starts afresh", async () =>
    (await frameCount(A)) === 1 && !(await logOf(A)).includes("hello from A") && (await roomsInView(A)).includes("e2e"));
  await say(A, "and from its replacement");
  await waitFor("B: chat draws a room message from the app that replaced it", async () => (await logOf(B)).includes("and from its replacement"));

  // 8. a nick that changes is news chat announces
  await setNick(A, "annie");
  await waitFor("B: chat announces A's new nick", async () => (await logOf(B)).includes("is now known as annie"));
  await waitFor("A: chat announces its own new nick", async () => (await logOf(A)).includes("is now known as annie"));

  // 9. a direct message, which makes its addressee a contact: the view asks the shell,
  //    and the shell tells the other end
  await view(A, "document.querySelector('#direct-list button').click()");
  await say(A, "psst, just you");
  await waitFor("B: chat draws A's direct message", async () => (await logOf(B)).includes("psst, just you"));
  await waitFor("A: B is a contact, as the view asked", async () => (await contactsOf(A)).includes(keyB));
  await waitFor("B: and lists A as its peer too", async () => (await contactsOf(B)).includes(keyA));

  // 10. a bundle that is not an app for this shell (a boot bundle has no `shell` entry) is
  //     refused, saying why, and changes nothing
  await drop(A, "offers.skb");
  await waitFor("A: a bundle that is not an app is refused, saying why", async () => /not an app for this shell/.test(await page(A, text("apps-notice"))));
  check((await appShown(A)) === "Chat v2", "A: the refused bundle changed nothing");
  await page(A, click("tab-app"));

  // 11. a call is the shell's, with the conversation the app's view said is open: its
  //     signals ride the pages' channel, and the media a connection of the page's own. The
  //     peer called is only told so, and gets nothing of the call until it accepts. Each
  //     end enters with its microphone and camera on, asked for together; a mute silences
  //     the microphone, and the camera is let go of when turned off and asked for again
  //     when turned back on. A call hung up on, or turned down, rings no more
  await page(A, `(() => {
    const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.asked = [];
    navigator.mediaDevices.getUserMedia = (what) => { window.asked.push(Object.keys(what).join("+")); return ask(what); };
  })()`);
  const asked = () => page(A, "window.asked.join(' ')");
  const tileOf = (sel) => `(() => {
    const t = document.querySelector('#video-tiles .tile${sel}');
    return !t ? "none" : t.classList.contains("no-video") ? "label" : t.querySelector("video").videoWidth > 0 ? "video" : "blank";
  })()`;
  const mic = "(([t]) => t.readyState + (t.enabled ? ' on' : ' off'))(document.querySelector('#tile-local video').srcObject.getAudioTracks())";
  await page(A, click("call-start"));
  await waitFor("A: a call starts", async () => /in call/.test(await page(A, text("call-status"))));
  await waitFor("B: is told A is calling, and offered the call", async () =>
    (await page(B, text("call-status"))) === "annie is calling" && (await page(B, text("call-start"))) === "Accept call");
  await waitFor("A: its own tile shows its camera", async () => (await page(A, tileOf(".local"))) === "video");
  check((await asked()) === "audio+video", "A: asked for its microphone and camera together");
  check((await page(A, text("call-mute"))) === "Mute" && (await page(A, text("call-cam"))) === "Stop video", "A: and offers to turn each off");
  await sleep(1500);
  check((await page(B, tileOf(""))) === "none" && (await page(A, text("call-status"))) === "in call (waiting for peers)",
    "B: gets nothing of a call it has not accepted, and A nobody in it");
  await page(B, click("call-start"));
  await waitFor("B: accepts, and is in the call with A", async () =>
    (await page(B, text("call-status"))) === "in call · 1 peer" && (await page(A, text("call-status"))) === "in call · 1 peer");
  await waitFor("B: sees A's camera once it has accepted", async () => (await page(B, tileOf(":not(.local)"))) === "video", 30000);
  await waitFor("A: and A sees B's", async () => (await page(A, tileOf(":not(.local)"))) === "video", 30000);
  await page(A, click("call-mute"));
  check((await page(A, mic)) === "live off" && (await page(A, text("call-mute"))) === "Unmute", "A: a mute silences its microphone");
  await page(A, click("call-mute"));
  check((await page(A, mic)) === "live on" && (await page(A, text("call-mute"))) === "Mute", "A: and an unmute brings it back");
  await page(A, click("call-cam"));
  await waitFor("B: A's tile is its label once A stops its video", async () => (await page(B, tileOf(":not(.local)"))) === "label");
  check((await page(A, tileOf(".local"))) === "label" && (await page(A, text("call-cam"))) === "Start video", "A: and so is its own");
  await page(A, click("call-cam"));
  await waitFor("B: and sees A's camera again when it is back on", async () => (await page(B, tileOf(":not(.local)"))) === "video", 30000);
  check((await asked()) === "audio+video video", "A: asked for the camera alone, and nothing else since the call started");
  await page(A, click("call-end"));
  await waitFor("B: A is gone from the call when it hangs up", async () =>
    (await page(B, tileOf(":not(.local)"))) === "none" && (await page(B, text("call-status"))) === "in call (waiting for peers)");
  check((await page(A, text("call-status"))) === "idle" && (await page(A, text("call-start"))) === "Start call",
    "A: the call it hung up on does not ring, with B still in it");
  await page(B, click("call-end"));
  await waitFor("B: the call ends", async () => (await page(B, text("call-status"))) === "idle");
  await page(B, click("call-start"));
  await waitFor("A: is told B is calling", async () =>
    /is calling/.test(await page(A, text("call-status"))) && (await page(A, text("call-start"))) === "Accept call");
  await page(A, click("call-decline"));
  check((await page(A, text("call-status"))) === "idle" && (await page(A, text("call-start"))) === "Start call", "A: a call turned down rings no more");
  await sleep(1500);
  check((await page(A, tileOf(""))) === "none" && (await page(B, text("call-status"))) === "in call (waiting for peers)",
    "A: and gets nothing of it");
  await page(B, click("call-end"));
  await waitFor("B: the call ends", async () => (await page(B, text("call-status"))) === "idle");

  // 12. removing an app takes its view with it, and it installs again
  await page(B, clickButton("app-list", "Remove"));
  await waitFor("B: the app is removed, and its view", async () => (await appShown(B)) === "no app loaded" && (await frameCount(B)) === 0);
  await drop(B, "chat.skb");
  await waitFor("B: and installs again", async () => (await appShown(B)) === "Chat v2");
  await waitFor("B: the new view hears of the room", async () => (await roomsInView(B)).includes("e2e"));

  check(errors.length === 0, "neither page has logged an error or thrown");

  // 13. a reload: the app set, the app shown, the nick and the rooms all come back, and
  //     the two nodes link again
  await send("Page.reload", {}, A.sid);
  await waitFor("A: chat is back after a reload, and shown", async () => (await appShown(A)) === "Chat v2");
  check((await page(A, "document.getElementById('nick').value")) === "annie", "A: its nick is kept");
  await waitFor("A: links to B again", async () => /^1 peer/.test(await peerPill(A)));
  await waitFor("A: the restored view hears of the room", async () => (await roomsInView(A)).includes("e2e"));
  await waitFor("B: is told A's nick again", async () => (await page(B, text("room-list"))).includes("annie"));
  await say(B, "welcome back");
  await waitFor("A: draws B's message", async () => (await logOf(A)).includes("welcome back"));
  // B's links to the tab that went away close, which its transport reports as an error line
  // (and its last dial of the old tab fails). Anything else is a real one.
  const expected = /^\[transport\] link \d+ .*down: |^WebSocket connection to .*splice=/;
  check(errors.every((e) => expected.test(e)), "a reload logs nothing but the old tab's links going down");

  // 14. jam installs beside chat: another label and another protocol, so both stand, each
  //     with a view of its own, in the shell that until now hosted only chat
  for (const tab of [A, B]) {
    await drop(tab, "jam.skb");
    await waitFor(`${tab.name}: jam installs beside chat`, async () => (await appShown(tab)) === "Jam v1" && (await frameCount(tab)) === 2);
    await page(tab, click("tab-app"));
  }
  const jamRow = await page(A, text("app-list"));
  check(/serves “jam”/.test(jamRow) && /serves “chat”/.test(jamRow), "A: the Apps tab lists both apps, each with its own claim");
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: jam's view hears of the room and who is in it`, async () =>
      (await jam(tab, "document.getElementById('room').selectedOptions[0]?.textContent")) === "# e2e" && (await jam(tab, text("here"))) === "2 here");
  }

  // 15. a message, and emoji on it: one chip an emoji, counting who put it there
  await jamSay(A, "shall we jam?");
  await waitFor("B: jam draws A's message under its nick", async () => /annie.*shall we jam\?/.test(await jam(B, text("logs"))));
  const chip = "document.querySelector('.msg .chip')?.textContent";
  await jam(B, "document.querySelector('.msg .react').click(); document.querySelector('#picker button').click()");
  await waitFor("A: B's reaction is on A's message", async () => (await jam(A, chip)) === "👍1");
  await jam(A, "document.querySelector('.msg .chip').click()");
  await waitFor("B: the same emoji from A is counted on the one chip", async () => (await jam(B, chip)) === "👍2");
  await jam(B, "document.querySelector('.msg .chip').click()");
  await waitFor("A: B takes its own off, and A's stays", async () => (await jam(A, chip)) === "👍1"
    && (await jam(A, "document.querySelector('.msg .chip').classList.contains('mine')")));

  // 16. A adds two tracks, FLAC files, and is refused one that is neither FLAC nor Ogg
  //     Vorbis. A file is cut into pieces and not changed: its audio stays with A, and what
  //     the room gets is the list
  await jamPick(A, "notes.wav", `new TextEncoder().encode("RIFF____WAVEfmt ")`);
  await waitFor("A: a file that is not FLAC or Ogg Vorbis is refused, saying so", async () =>
    /notes\.wav was not added: only FLAC and Ogg Vorbis files can be added/.test(await jam(A, text("toasts"))));
  await jamAddFlac(A, "first.flac", 12);
  await jamAddFlac(A, "second.flac", 4);
  await waitFor("A: both tracks are in its list", async () => (await jamList(A)) === "first | second");
  await waitFor("B: the list reaches B, and the chat says who added what", async () => (await jamList(B)) === "first | second"
    && /annie added second/.test(await jam(B, text("logs"))));
  check((await jam(B, text("list-count"))) === "2 tracks · 0:16", "B: each track's length came with it, counted off its frames");

  //     a track is a file to keep, too. B was given none of the second and is not
  //     listening: it fetches every piece from A, and saves them end to end behind the head
  await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: saved, eventsEnabled: true });
  await jamTrack(B, "second", "Download");
  await waitFor("B: downloads a track it was never given the file of", async () => [...downloads.values()].some((d) => d.done));
  const [savedAs, download] = [...downloads].find(([, d]) => d.done);
  check(download.name === "second.flac" && Buffer.from(makeFlac(4)).equals(readFileSync(join(saved, savedAs))),
    "B: the file is named for the track, and is the one A added, byte for byte");

  // 17. B starts the first track for the room. B asks A for its pieces, each checked against
  //     its name by B's own guest, and sounds them as they come; A is told what is on, and
  //     hears it once it tunes in, at the place the room has reached
  await jamTrack(B, "first", "Play");
  await waitFor("B: plays a track it was never given the file of", async () => (await jamAudio(B)) > 0.2);
  await waitFor("A: is told what the room is playing, and by whom", async () => (await jam(A, text("np-title"))) === "first"
    && /^started by [0-9a-f]{8}$/.test(await jam(A, text("np-sub"))));
  check((await jamAudio(A)) === -1 && (await jam(A, "document.getElementById('listen').classList.contains('nudge')")),
    "A: hears nothing until it tunes in, and is nudged to");
  await jam(A, click("listen"));
  await waitFor("A: tunes in, and plays", async () => (await jamAudio(A)) > 0.2);
  const [atA, atB] = [await jamAudio(A), await jamAudio(B)];
  check(Math.abs(atA - atB) < 1.5, `the two tabs are at the same place in the track (${atA.toFixed(2)}s and ${atB.toFixed(2)}s)`);

  // 18. where the room is in a track is the room's too. A moves it halfway through, and each
  //     tab picks up from the piece that place falls in, without the ones before it
  await jamSeek(A, 0.5);
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: sounds from where A moved the room to`, async () => {
      const at = await jamAudio(tab);
      return at >= 6 && at < 9;
    });
  }
  await jam(A, click("play"));
  await waitFor("B: A's pause stops B's audio", async () => (await jamAudio(B)) === -1 && /^paused by annie/.test(await jam(B, text("np-sub"))));
  await jam(B, click("play"));
  await waitFor("A: B's play starts A's audio again", async () => (await jamAudio(A)) > 0);

  //     and the list moves on by itself when a track ends: B is moved near the end of the
  //     first, and already holds the start of the second
  await jamSeek(B, 0.9);
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: the room moves on to the second track, and plays it`, async () =>
      (await jam(tab, text("np-title"))) === "second" && (await jamAudio(tab)) > 0.2, 30000);
  }
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: and stops after the last`, async () => (await jam(tab, text("np-title"))) === "Nothing playing", 30000);
  }

  // 19. a slow peer. A is held to sending 140 KB of audio a second and adds a track that
  //     plays at 192, so nobody can fetch it as fast as it plays, and a node that started
  //     at once would run dry and stall. B does not: it finds out how fast the blocks
  //     come, aims at a place further on that it can play from to the end, says when that
  //     is, and from there sounds without a break
  check((await jamUplink(A, 140 * 1024)) === String(140 * 1024), "A: is held to a slow uplink");
  await jamAddFlac(A, "third.flac", 20, 96000);
  await waitFor("B: the third track is listed", async () => (await jamList(B)) === "first | second | third", 30000);
  await jamTrack(B, "third", "Play");
  const heard = { said: false, from: null, to: null, breaks: 0 };
  for (const began = Date.now(); Date.now() - began < 60000; await sleep(120)) {
    const [title, sub, at, part] = JSON.parse(await jam(B, `JSON.stringify([document.getElementById("np-title").textContent,
      document.getElementById("np-sub").textContent, document.getElementById("player").dataset.at ?? null,
      parseFloat(document.getElementById("seek-fill").style.width) / 100])`));
    if (title !== "third") break;
    if (/^buffering… joins in /.test(sub)) heard.said = true;
    if (at !== null) heard.to = Number(at), heard.from ??= Number(at);
    // silent after it has started, with the room still well inside the track
    else if (heard.from !== null && part * 20 < 19) heard.breaks++;
  }
  check(heard.said, "B: finds its blocks come slower than the track plays, and says when it will join");
  check(heard.from !== null && heard.from > 4 && heard.from < 17, `B: holds off, and joins partway through (at ${heard.from?.toFixed(1)}s of 20)`);
  check(heard.breaks === 0 && heard.to > 19, `B: sounds from there to the end without a break (to ${heard.to?.toFixed(1)}s)`);
  await jamUplink(A, 0);
  await jamTrack(A, "third", "Remove");
  await waitFor("B: the track is gone again", async () => (await jamList(B)) === "first | second");

  // 20. the list is everyone's to reorder and trim
  await jamTrack(B, "second", "Move up");
  await waitFor("A: B's reordering reaches A", async () => (await jamList(A)) === "second | first");
  await jamTrack(A, "first", "Remove");
  await waitFor("B: A's removal reaches B", async () => (await jamList(B)) === "second");

  // 21. A reloads, and so loses the room's state and the files it added. It gets the chat,
  //     the reactions and the list back from B, and the music too: B fetched the track to
  //     play it, so B now serves it
  await send("Page.reload", {}, A.sid);
  await waitFor("A: jam is back after a reload, and shown", async () => (await appShown(A)) === "Jam v1");
  await waitFor("A: the room's chat, reactions and list come back from B", async () => (await jamList(A)) === "second"
    && /shall we jam\?/.test(await jam(A, text("logs"))) && (await jam(A, chip)) === "👍1", 30000);
  await jamTrack(A, "second", "Play");
  await waitFor("A: plays a track whose file it no longer has, fetched from B", async () => (await jamAudio(A)) > 0.2, 30000);

  // 22. music is added to a room, for whoever else is in it. B leaves: A is told nobody
  //     else is there, and may still add music for whoever comes; B is told it is in no
  //     room, in place of a button to add music with
  await waitFor("with both in the room, neither says it is alone", async () => (await jamAlone(A)) === "" && (await jamAlone(B)) === "");
  await page(B, clickButton("room-list", "Leave"));
  await waitFor("A: says nobody else is connected, and still offers to add music", async () =>
    /^Nobody else is connected here/.test(await jamAlone(A)) && !(await jam(A, "document.getElementById('add').hidden")));
  await waitFor("B: says it is in no room, in place of offering to add music", async () =>
    /^Not connected to a room/.test(await jamAlone(B)) && (await jam(B, "document.getElementById('add').hidden")));
  check(errors.every((e) => expected.test(e)), "jam logged no error in either tab");
} catch (err) {
  failure = err;
}

if (failure) {
  console.log(`  FAIL ${failure instanceof Failed ? failure.message : `the run stopped: ${failure.message}`}`);
  for (const tab of [A, B]) {
    if (!tab) continue;
    const lines = await page(tab, "[...document.querySelectorAll('#shell-log div')].map((d) => d.textContent)").catch(() => []);
    console.log(`\n  ${tab.name}'s Diagnostics:\n${lines.map((l) => `      ${l}`).join("\n")}`);
  }
  if (errors.length > 0) console.log(`\n  logged as errors by the pages:\n${[...new Set(errors)].map((e) => `      ${e}`).join("\n")}`);
}
await cleanup();
console.log(failure ? "\ne2e: FAILED" : "\ne2e: all checks passed");
process.exit(failure ? 1 : 0);
