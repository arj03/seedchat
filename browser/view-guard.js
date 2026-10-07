// The wall around an app's view. A view is any author's page, and the sandbox the shell
// loads it into (shell.js `mountView`) keeps it from this page: an opaque origin, with no
// DOM of ours, no keys and no storage. It does not keep a view from the network. A blob:
// document inherits the policy of the page that made it, and this page's policy has to let
// the page itself open a WebSocket to whatever relay the user names; so a view could open
// one to any server, and send it what it is shown, every message and the node's context.
//
// A view is granted nothing. What an app reaches is what its GUEST reaches, which is in its
// signed manifest and on its consent row (app-api.js `APP_GRANTS`), and a view's only way
// out is the door to the shell. `guardView` holds a view to that, with two things it puts
// into the view's page before the page is loaded:
//
//   a POLICY   of the view's own, ahead of everything else in it. Both policies apply, the
//              page's and this one, so it can only take away: no request of any kind, no
//              frame but an empty one, no form sent, no script but the prelude and what the
//              prelude runs. It is two policies (`VIEW_POLICY`, `VIEW_SCRIPT_POLICY`),
//              since one cannot say both which scripts run and that none names a file.
//   a PRELUDE  the one script the policy lets the parser run, named by its hash. It takes
//              WebRTC out of the realm, which is the one way onto the network no policy
//              governs: a peer connection asks whatever STUN or TURN server its script
//              names. (The `webrtc` directive that would stop it is one Chromium does not
//              know, and logs as an error.) Then it runs the view's own scripts, in their
//              places and in order.
//
// The view's scripts are held back for the prelude to run (`HELD`) rather than left for the
// parser, and that is what makes taking WebRTC out a wall and not a courtesy. Under
// 'strict-dynamic' a script runs only if the parser found it and it is the prelude, or if a
// script already running made it. So in any document this policy reaches, the prelude runs
// first: in the view, in a frame the view makes (a `srcdoc` one inherits the policy, and is
// not stopped by `frame-src`), and in a blob the view navigates itself to. There is no
// realm a view can get to with WebRTC still in it. A `javascript:` URL and an inline
// handler (`onclick="…"`) are the parser's too, and do not run: a view listens with
// `addEventListener`.
//
// What is left is a hint: `<link rel="preconnect">` and `dns-prefetch` open a connection to,
// or look up, a name the view chooses, and no policy stops either. Nothing is sent on it but
// the name, and the name is the view's to choose: so a view can tell a server it names a
// little at a time, and hears nothing back.
//
// Browser only: it parses the view with DOMParser, and hashes with WebCrypto.

/** The type a view's script carries while it is held for the prelude, and the attribute
 *  that keeps the type its author gave it. */
const HELD = "application/x-view-script";
const HELD_TYPE = "data-view-type";

/** The script types a browser runs (HTML's "prepare the script element"): none given, a
 *  JavaScript MIME type, a module, an import map. Any other is a block of data, which the
 *  policy has nothing to say about, and is left as its author wrote it. */
const RUNS = new Set(["", "module", "importmap", "application/ecmascript", "application/javascript",
  "application/x-ecmascript", "application/x-javascript", "text/ecmascript", "text/javascript",
  "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3",
  "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript"]);

/** The prelude. A realm it cannot take WebRTC out of runs none of the view's scripts.
 *
 *  A held script is put back as a script of the type its author gave it, made by this one
 *  and so allowed to run. The parser stops for the microtasks at each script's end, which is
 *  when the observer hears of it, so a script runs where it stood, before what follows it is
 *  parsed. Once the page is parsed there are no more to come.
 *
 *  Its text is what the policy names, so it holds nothing that ends a script element. */
const PRELUDE = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    delete globalThis[name];
    if (name in globalThis) return;
  }
  const run = (held) => {
    const live = document.createElement("script");
    for (const a of held.attributes) {
      if (a.name !== "type" && a.name !== ${JSON.stringify(HELD_TYPE)}) live.setAttribute(a.name, a.value);
    }
    const type = held.getAttribute(${JSON.stringify(HELD_TYPE)});
    if (type !== null) live.setAttribute("type", type);
    live.text = held.text;
    held.replaceWith(live);
  };
  const sweep = () => {
    for (const held of document.querySelectorAll(${JSON.stringify(`script[type="${HELD}"]`)})) run(held);
  };
  const parsing = new MutationObserver(sweep);
  parsing.observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => { sweep(); parsing.disconnect(); }, { once: true });
})();`;

const preludeHash = btoa(String.fromCharCode(
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRELUDE)))));

/** A view's policy. `default-src 'none'` is every request there is: fetch, XHR, WebSocket,
 *  WebTransport, a beacon, an image, a stylesheet, a font, a prefetch. What is given back is
 *  what a page needs to be a page and reaches nothing: its own inline styles, images and
 *  media it holds as `data:` or `blob:`, and fonts as `data:`. The page's own policy applies
 *  too, so what is given back here it has to allow as well (shell.html). A worker made from
 *  a blob inherits this policy, and has no WebRTC of its own. */
export const VIEW_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${preludeHash}' 'strict-dynamic' 'wasm-unsafe-eval'`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A second policy, for what the first cannot say. Under 'strict-dynamic' a script that is
 *  running may make one that names any file, and the first policy lets it: `import()` and a
 *  worker's `importScripts` likewise. The page's own policy would be all that stood in the
 *  way, and it has to let the page load its scripts from its own server, so a view could
 *  ask that server for anything, with what it is shown in the address. This one names no
 *  server, and a script has to pass both: so one a view makes runs if it carries its code,
 *  and loads nothing. `worker-src` is said again because a policy without it reads
 *  `script-src` for a worker, which here has no `blob:`. */
export const VIEW_SCRIPT_POLICY = "script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:";

/** An app's view as the page the shell loads: the author's own, with the policy and the
 *  prelude first in its head, and each script the parser would have run held for the
 *  prelude. A script that names a file (`src`) is left as it is and refused by the policy,
 *  since there is nothing beside a view to load: the builder puts a view's scripts into its
 *  page (scripts/app-source.mjs `readView`).
 *
 *  The page is parsed here to find its scripts, in a document that runs none of them, and
 *  written out again. A script this misses is not one that gets out: the parser finds it
 *  where the policy refuses it. */
export function guardView(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const script of doc.querySelectorAll("script:not([src])")) {
    if (!(script instanceof HTMLScriptElement)) continue;
    const type = script.getAttribute("type");
    if (!RUNS.has((type ?? "").trim().toLowerCase())) continue;
    if (type !== null) script.setAttribute(HELD_TYPE, type);
    script.setAttribute("type", HELD);
  }
  // The page is written out as UTF-8 (`mountView`), and says so before the prelude pushes
  // the author's own word for it past where a browser looks.
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  // One element for each policy: a second in the same element would be read as part of
  // the first.
  const policies = [VIEW_POLICY, VIEW_SCRIPT_POLICY].map((content) => {
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = content;
    return policy;
  });
  const prelude = doc.createElement("script");
  prelude.text = PRELUDE;
  doc.head.prepend(charset, ...policies, prelude);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}
