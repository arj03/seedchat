// The contract between this shell and the apps it hosts, in one place: what an app's signed
// manifest tells the shell, what the shell lets an app reach, and the doors between the two.
// The browser shell (shell.js) gates and drives every bundle through it,
// scripts/build-app-bundle.mjs refuses to sign what it would refuse to run, and
// scripts/smoke.mjs replays it headlessly.
//
// Nothing here is about any one app. An app is a signed bundle (seedkernel §12.4) in three
// parts, and the shell deals with each in one way:
//
//   the GUEST   is the app's behaviour. The shell hands it bytes and never reads what
//               comes back: a peer's frame under a protocol the app claims, the node's
//               context (`ctx`), and whatever the app's own view sent (`ui`). Each answer
//               goes to the view: to a peer's frame and to the context it is render bytes,
//               and to the view's own bytes it is the answer to that call.
//   the VIEW    is the app's UI, an HTML page the shell runs in a sandboxed iframe. It
//               reaches the shell only with postMessage: `ready`, `call` (bytes for its
//               guest), and two requests about things that are the shell's, `conv` and
//               `contact`. The shell sends it two messages: `render`, and the `answer` to
//               a `call`.
//   MODULES     are pure compute the guest drives by name. The shell never sees them, and
//               an app may have none.
//
// So the format of a frame, of a render and of what a view asks its guest is the app's own,
// and a new version of an app changes all three without this shell changing.
//
// What is the SHELL's, and so the same for every app, is who this node is linked to and
// what they are called: its rooms, peers and contacts, and each one's nick. An app is told
// them (the context) and does not keep its own.
//
// A call is the shell's too, because a view cannot hold one: its sandbox gives it an opaque
// origin, which a browser grants no camera or microphone. The shell holds the media
// (media-rtc.js), and a view says only which conversation is open (`conv`).
//
// No imports: the shell's vendored runtime and the offline builder both load this file, and
// the hash a consent names is passed in (`bundleDigest`) rather than reached for.

/** The version of this contract. An app's manifest names the one it was built for
 *  (`guest.config.shell.api`), and the shell runs no other: a bundle from before a change
 *  to the doors below is refused by name instead of installed and left silent. */
export const APP_API = 2;

/** The local service name the transport bundle serves (the `_net` of the bundled
 *  composition; no host semantics attach to the spelling). Named here rather than
 *  imported so this file keeps its no-imports property: it is the one string in the
 *  runtime's vocabulary the shell has to spell, and `smoke.mjs` asserts it against the
 *  transport bundle's own `services` claim. */
export const NET_PROTO = "_net";

/** Everything an app may reach (`manifest.guest.requires`, §12.2, §12.10), with the words a
 *  consent row says it in. A bundle naming anything else is not installed.
 *
 *  `_net` is how an app sends: the host has no send, the transport is a guest serving that
 *  name, and a frame reaches a peer by an app CALLING it. `fs` is a keyspace scoped to the
 *  app's label, and `timer` is one wake. What is left out is what would make an app more
 *  than an app: `link` is being the network, and `node` is signing as this node. Nor may
 *  it name another co-resident guest, which this shell would know nothing about.
 *
 *  An Offer arrives from a peer and is installed on one click, and `guest.requires` is the
 *  only place a bundle's reach is written down, so this list is the most that click can
 *  grant, and the row shows which of it this bundle asks for. */
export const APP_GRANTS = {
    [NET_PROTO]: "the network",
    fs: "its own storage",
    timer: "a timer",
};

/** The shell's two loopback ops into an app's guest, framed with seedkernel's op-frame as
 *  `[zero 32][opLen u8][op][bytes]`. NAMES rather than bytes: an op a guest does not
 *  implement then fails by name instead of landing on a neighbouring case.
 *
 *    ctx   the node's context as ASCII JSON (`contextJson`): who this node is, the rooms
 *          it is in and who is in each, the linked peers, the contacts, and what each
 *          is called. Sent after the install, when it changes, and when the app's view
 *          says it is ready.
 *    ui    bytes from the app's own view (its `call`), unread by the shell. What the
 *          guest answers goes back to the view as the `answer` to that call, under the id
 *          the view gave it, so a view can ask its guest something and wait for it.
 *
 *  `ctx` answers render bytes for the view, as a peer's frame does, or nothing. */
export const APP_OP_CONTEXT = "ctx";
export const APP_OP_UI = "ui";

/** What the shell reads off a verified manifest, or the reason it will not run the bundle,
 *  thrown. It is all in the SIGNED manifest, under `guest.config.shell`:
 *
 *    api           the contract version the app was built for
 *    name, version, description   what its row says
 *    ui            its view, an HTML page; an app without one runs with nothing to show
 *
 *  so nothing is read out of a module, and an app needs none. Text an author wrote is cut
 *  to what a row can hold. */
export function appFacts(manifest) {
    const s = manifest.guest.config?.shell;
    if (typeof s !== "object" || s === null || Array.isArray(s))
        throw new Error("this bundle is not an app for this shell: its manifest has no `shell` entry");
    if (s.api !== APP_API)
        throw new Error(`this app was built for shell API ${JSON.stringify(s.api)}, and this shell speaks ${APP_API}`);
    for (const r of manifest.guest.requires) {
        if (!Object.hasOwn(APP_GRANTS, r))
            throw new Error(`this app reaches ${JSON.stringify(r)}, which this shell grants no app`);
    }
    // What it will SERVE, checked beside what it may reach. A `services` claim is a name a
    // co-resident guest calls, and the shell hosts apps that serve peers, not each other.
    if ((manifest.services ?? []).length > 0)
        throw new Error("this app serves a local service, which this shell hosts no app for");
    const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    return {
        name: text(s.name, 64) || manifest.app,
        version: text(s.version, 32),
        description: text(s.description, 200),
        ui: typeof s.ui === "string" && s.ui !== "" ? s.ui : null,
        // A claim IS the routing (§12.10): installing the bundle points each of these at it.
        protocols: [...(manifest.protocols ?? [])],
        requires: [...manifest.guest.requires],
    };
}

/** What a consent names: the whole verified bundle, as one hash over its author, manifest,
 *  guest and every module. `hash` is seedkernel's `genesisHash` with its crypto bound.
 *
 *  The whole of it because the guest is where an app's behaviour is: a hash of a module
 *  alone would read a bundle with new guest code as the one already running, and would let
 *  a consent to one guest admit another beside the same module. */
export function bundleDigest(v, hash) {
    const enc = new TextEncoder();
    const parts = [v.author, enc.encode(JSON.stringify(v.manifest)), enc.encode(v.guestSource),
        ...v.modules.map((m) => m.wasm)];
    const all = new Uint8Array(32 * parts.length);
    parts.forEach((p, i) => all.set(hash(p), 32 * i));
    return hash(all);
}

/** The shell's admission gate, the one predicate `bootShell` takes as `admit` (seedkernel
 *  §12.5). `pins` are the shell's own boot bundles, each `{ author, app }` with the author in
 *  hex: bytes the deployment shipped, loaded before any dialog could run, so there is
 *  nothing there for a click to decide. Every other bundle is one the user consented to:
 *  `consents` holds the digest of each (`bundleDigest`, in hex), and admitting a bundle
 *  takes its consent, so one consent is one install. */
export function admitGate(pins, consents, hash) {
    const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (v) => pins.some((p) => p.author === hex(v.author) && p.app === v.manifest.app)
        || consents.delete(hex(bundleDigest(v, hash)));
}

/** The context as the `ctx` op carries it: JSON with every key and id in lowercase hex.
 *
 *    { api, me, nick, rooms: [{ id, name, members: [key] }], linked: [key],
 *      contacts: [key], nicks: { [key]: nick } }
 *
 *  `nick` is what this node calls itself, empty for nothing, and `nicks` what each peer
 *  that has said calls itself. A nick is a peer's own word, not proof of who it is: the
 *  key is what the channel authenticated.
 *
 *  ASCII only, anything else escaped, because a guest's realm has no TextDecoder: it reads
 *  one character per byte and parses. A contact's secret is never in it. */
export function contextJson(context) {
    return JSON.stringify({ api: APP_API, ...context })
        .replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
