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

/** The whole authority a chat app holds (§12.2): none. Its own module map is not a
 *  grant — a bare `host.call` name is a primitive, the bundle's own code, ungated
 *  like `crypto` (seedkernel §12.1) — so the manifest declares an empty `requires` set.
 *  Authored into every bundle this shell builds, and required of every bundle it
 *  accepts — see `peekMeta`. */
export const CHAT_APP_REQUIRES = [];

/** The wire protocol every chat app speaks (§12.10) — one id, claimed by every
 *  bundle this shell authors and required of every bundle it accepts.
 *
 *  It is deliberately NOT the app id. The id names the app (and its module); this
 *  names the conversation, and the whole point is that it is the same string for
 *  everyone: two peers running different authors' chat apps interoperate because
 *  both claim `chat`, and a frame says only which protocol it is. An app that
 *  claimed its own id would be a chat app nobody else could talk to.
 *
 *  Claiming it is what routes it: the load that admits a chat bundle makes it this
 *  node's `chat` app, and installing another one takes the id over (§12.10) — which
 *  is exactly the swap this demo exists to show, and is why the Apps panel reads the
 *  claim off the manifest instead of offering a bind button. */
export const CHAT_PROTO = "chat";

/** The one-line guest every chat app ships. Its `handle` entrypoint forwards its
 *  input to the app's own module — named directly on the same `host.call` seam every
 *  other capability uses (§12.2) — and returns the render bytes. That is the whole app.
 *
 *  Interpolating the id into a string literal is safe because `assertAppId` already
 *  held it to `[A-Za-z0-9_-]`: nothing to escape, no quote to break out of, and no
 *  `/`, which is what keeps it a module name rather than a host name. */
export function chatGuestSource(appId) {
    assertAppId(appId);
    return `register("handle", (input) => host.call("${appId}", input));`;
}

/** Does a verified manifest describe a chat app this shell will run? The demo's
 *  apps are one module driven by the forwarding guest, and — the load-bearing half
 *  — they hold no capability at all.
 *
 *  The requires check is not decoration. An Offer arrives from a peer and is
 *  installed on one click of a row showing a name, a version and an author; the
 *  manifest's `guest.requires` are the only place the bundle's authority is
 *  written down, and nothing else on this path reads them. Without this, a peer
 *  could offer an app whose guest holds `net/send`, `node/sign` or `fs/*` and the
 *  consent prompt would look exactly the same. */
export function isChatApp(manifest) {
    if (manifest.modules.length !== 1)
        return false;
    // What it will SERVE, checked beside what it may do. A bundle's claim is now the
    // routing (§12.10) — installing it points `chat` at it — so the claim is part of
    // what the consent prompt is agreeing to, and an offered bundle claiming ids this
    // shell knows nothing about would take those over on one click.
    const protocols = manifest.protocols ?? [];
    if (protocols.length !== 1 || protocols[0] !== CHAT_PROTO)
        return false;
    const requires = manifest.guest.requires;
    return requires.length === CHAT_APP_REQUIRES.length
        && requires.every((r) => CHAT_APP_REQUIRES.includes(r));
}
