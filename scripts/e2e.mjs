// End-to-end test in a real browser: does the SHELL still work?
//
// scripts/smoke.mjs replays the host and the apps' guests headlessly, which is everything
// but the page: browser/shell.js and each app's view only run in a browser. This
// drives two tabs of one — two nodes, since the identity is per tab — with a real
// seedrelay between them, through what a person would do: drop a bundle, join a room, set
// a nick, write, upgrade an app in place, offer it, install the offer, write to one peer,
// start a call, remove an app, reload. Run it after a change to the shell or a view:
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
  [join(root, "bundle", "chat-app-v2.skb"), "run `npm run build` first"],
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

// The browser. A fake camera and microphone, granted without a prompt, let a call start.
const profile = mkdtempSync(join(tmpdir(), "seedchat-e2e-"));
const browser = spawn(browserPath, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
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
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {}
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

// What the pages logged as an error, and the frames that run in a process of their own.
const errors = [];
const frames = new Map(); // tab session → sessions of its out-of-process frames
listeners.push((m) => {
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
    frames.set(m.sessionId, [...(frames.get(m.sessionId) ?? []), m.params.sessionId]);
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
/** Write a message in the app's view and send it. Both chat versions have this form. */
const say = (tab, message) => view(tab, `document.getElementById('msg').value = ${JSON.stringify(message)}; document.getElementById('form').requestSubmit()`);
const logOf = (tab) => view(tab, text("log"));
/** v2's conversation list names the room once its view has heard the context. */
const roomsInView = (tab) => view(tab, text("room-list"));

// A whole run takes well under a minute; a browser that hangs must not hang the caller.
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

  // 2. install chat v1 by dropping its bundle; the row says what the bundle serves and
  //    reaches, read off its signed manifest
  for (const tab of [A, B]) {
    await drop(tab, "chat-app-v1.skb");
    await waitFor(`${tab.name}: chat v1 installs from a dropped .skb`, async () => (await appShown(tab)) === "Chat v1");
  }
  const row = await page(A, text("app-list"));
  check(/serves “chat”/.test(row) && /reaches the network/.test(row) && /bundle [0-9a-f]{12}/.test(row),
    "A: the app's row says what it serves and reaches");

  // 3. join one room on the relay; each app's view hears of it from its own guest
  for (const tab of [A, B]) {
    await page(tab, `document.getElementById('relay-url').value = 'ws://127.0.0.1:${relayPort}'; document.getElementById('relay-room').value = 'e2e'; ${click("join-room")}`);
  }
  for (const tab of [A, B]) await waitFor(`${tab.name}: linked to the other tab`, async () => /^1 peer/.test(await peerPill(tab)));
  for (const tab of [A, B]) {
    await waitFor(`${tab.name}: v1's view hears of the room`, async () => (await view(tab, "document.getElementById('room').options.length")) === 1);
  }

  // 4. a nick is the shell's: set on A's Network tab, told to B's page, shown by B's
  //    shell and handed to B's app in its context, with no app carrying it
  await setNick(A, "ann");
  await waitFor("B: the shell names A by its nick", async () => (await page(B, text("room-list"))).includes("ann"));

  // 5. v1: a room message, drawn at the far end and echoed at the near one
  await say(A, "hello from A on v1");
  await waitFor("B: v1 draws A's room message under its nick", async () => /#e2e ann \([0-9a-f]{8}\):hello from A on v1/.test(await logOf(B)));
  await waitFor("A: v1 draws its own echo", async () => (await logOf(A)).includes("hello from A on v1"));

  // 6. upgrade A to v2 by dropping it: a new guest, module and view under the same label,
  //    and the same shell. The two versions still speak room text to each other.
  await drop(A, "chat-app-v2.skb");
  await waitFor("A: chat v2 replaces v1 in place", async () => (await appShown(A)) === "Chat v2");
  check((await frameCount(A)) === 1, "A: v1's view is gone, and v2 has the one frame");
  await waitFor("A: v2's view hears of the room", async () => (await roomsInView(A)).includes("e2e"));
  await say(A, "v2 to v1");
  await waitFor("B: v1 draws a room message from a v2 peer", async () => (await logOf(B)).includes("v2 to v1"));

  // 7. A offers v2 through the offers app; B's row for it shows what Install grants
  await page(A, clickButton("app-list", "Offer to peers"));
  await waitFor("B: the offer arrives", async () => (await page(B, "document.querySelectorAll('#offer-list .offer-row').length")) === 1);
  const offer = await page(B, text("offer-list"));
  check(/serves “chat”/.test(offer) && /reaches the network/.test(offer) && offer.includes(keyA.slice(0, 8)),
    "B: the offer's row says what it serves and reaches, and who it is from");
  await page(B, clickButton("offer-list", "Install"));
  await waitFor("B: chat v2 installs from the offer", async () => (await appShown(B)) === "Chat v2");
  await waitFor("B: v2's view hears of the room", async () => (await roomsInView(B)).includes("e2e"));

  // 8. v2 reads the same nick out of the same context; a change is news it announces
  await waitFor("A: v2's view says who this node is", async () => /^ann \([0-9a-f]{8}\)$/.test(await view(A, text("me"))));
  await say(A, "room message on v2");
  await waitFor("B: v2 draws A's room message under its nick", async () => /ann \([0-9a-f]{8}\):room message on v2/.test(await logOf(B)));
  await setNick(A, "annie");
  await waitFor("B: v2 announces A's new nick", async () => (await logOf(B)).includes("is now known as annie"));
  await waitFor("A: v2 announces its own new nick", async () => (await logOf(A)).includes("is now known as annie"));

  // 9. a direct message, which makes its addressee a contact: the view asks the shell,
  //    and the shell tells the other end
  await view(A, "document.querySelector('#direct-list button').click()");
  await say(A, "psst, just you");
  await waitFor("B: v2 draws A's direct message", async () => (await logOf(B)).includes("psst, just you"));
  await waitFor("A: B is a contact, as the view asked", async () => (await contactsOf(A)).includes(keyB));
  await waitFor("B: and lists A as its peer too", async () => (await contactsOf(B)).includes(keyA));

  // 10. a bundle that is not an app for this shell (a boot bundle has no `shell` entry) is
  //     refused, saying why, and changes nothing
  await drop(A, "offers.skb");
  await waitFor("A: a bundle that is not an app is refused, saying why", async () => /not an app for this shell/.test(await page(A, text("apps-notice"))));
  check((await appShown(A)) === "Chat v2", "A: the refused bundle changed nothing");
  await page(A, click("tab-app"));

  // 11. a call is the shell's, with the conversation the app's view said is open: its
  //     signals ride the pages' channel, and the media a connection of the page's own
  await page(A, click("call-start"));
  await waitFor("A: a call starts", async () => /in call/.test(await page(A, text("call-status"))));
  await waitFor("B: receives A's media", async () => /receiving from 1 peer/.test(await page(B, text("call-status"))), 30000);
  await page(A, click("call-end"));
  await waitFor("B: the call ends when A hangs up", async () => (await page(B, text("call-status"))) === "idle");

  // 12. removing an app takes its view with it, and it installs again
  await page(B, clickButton("app-list", "Remove"));
  await waitFor("B: the app is removed, and its view", async () => (await appShown(B)) === "no app loaded" && (await frameCount(B)) === 0);
  await drop(B, "chat-app-v2.skb");
  await waitFor("B: and installs again", async () => (await appShown(B)) === "Chat v2");
  await waitFor("B: the new view hears of the room", async () => (await roomsInView(B)).includes("e2e"));

  check(errors.length === 0, "neither page has logged an error or thrown");

  // 13. a reload: the app set, the app shown, the nick and the rooms all come back, and
  //     the two nodes link again
  await send("Page.reload", {}, A.sid);
  await waitFor("A: chat v2 is back after a reload, and shown", async () => (await appShown(A)) === "Chat v2");
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
