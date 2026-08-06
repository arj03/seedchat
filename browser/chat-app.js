// The chat app SHAPE, in one place: what a chat app's id may be, what its guest
// program is, and how much authority it holds. Both the browser shell (which
// authors bundles and peeks received ones) and scripts/smoke.mjs (which authors
// one headlessly) read it here, so the guest source that gets SIGNED is written
// once. Two hand-copies of signed source would be two things to keep in step, and
// the one that drifts is the one an author's key vouches for.
//
// No imports: this is pure text and one regex, so it loads identically under the
// browser's importmap and Node's resolver.

/** A chat app's id, which is also its one module's manifest name. The §12.4 name
 *  grammar, applied HERE rather than trusted from the wasm: the id is read out of
 *  an `app_meta` custom section, so on any bundle that did not come from this
 *  shell it is attacker-chosen text. `chatGuestSource` interpolates it into JS
 *  that the local key then signs, and the manifest's own name check happens later
 *  — after the injection would already be inside the signed guest. So the rule the
 *  guest's comment relies on has to be enforced before the template, not after. */
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Throw unless `id` is a legal app id. Callers author bundles from it. */
export function assertAppId(id) {
    if (typeof id !== "string" || !APP_ID.test(id))
        throw new Error(`invalid app id ${JSON.stringify(id)}: expected 1-64 chars of [A-Za-z0-9_-] (§12.4)`);
}

/** The whole authority a chat app holds (§12.2): its own module map, and no other
 *  backend. Authored into every bundle this shell builds, and required of every
 *  bundle it accepts — see `peekMeta`. */
export const CHAT_APP_CAPS = ["module"];

/** The ~5-line guest every chat app ships. Its `handle` entrypoint forwards its
 *  input to the app's own module by name through `module/call` (§12.2) and returns
 *  the render bytes — the whole app is this forwarding guest.
 *
 *  charCodeAt rather than TextEncoder: a zero-authority realm has none (§12.3),
 *  and an id that passed `assertAppId` is pure ASCII, so the spread frames
 *  module/call's `[name_len u8][name][input..]` directly. */
export function chatGuestSource(appId) {
    assertAppId(appId);
    return `register("handle", (input) => {
  const name = Array.from("${appId}", (c) => c.charCodeAt(0));
  return host.call("module/call", new Uint8Array([name.length, ...name, ...input]));
});`;
}

/** Does a verified manifest describe a chat app this shell will run? The demo's
 *  apps are one module driven by the forwarding guest, and — the load-bearing half
 *  — they hold `module` and nothing else.
 *
 *  The caps check is not decoration. An Offer arrives from a peer and is installed
 *  on one click of a row showing a name, a version and an author; the manifest's
 *  `guest.caps` are the only place the bundle's authority is written down, and
 *  nothing else on this path reads them. Without this, a peer could offer an app
 *  whose guest holds `net`, `node` or `fs` and the consent prompt would look
 *  exactly the same. */
export function isChatApp(manifest) {
    if (manifest.modules.length !== 1)
        return false;
    const caps = manifest.guest.caps;
    return caps.length === CHAT_APP_CAPS.length && caps.every((c) => CHAT_APP_CAPS.includes(c));
}
