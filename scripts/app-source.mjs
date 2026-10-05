// Read one app's source directory into what `authorBundle` signs. The offline builder
// (scripts/build-app-bundle.mjs) and scripts/smoke.mjs both assemble an app with it, so the
// headless test signs the bytes the builder would rather than a copy of them.
//
// An app is a directory with an `app.json` beside its sources. Every path in it is relative
// to that file:
//
//   app           the label it installs under, which is also its fs and signing scope
//   api           the shell contract it was built for (browser/app-api.js `APP_API`)
//   name, version, description   what its row in the shell says
//   protocols     the protocol ids it claims, so peers' frames under them reach it
//   requires      everything its guest reaches: `_net`, `fs`, `timer`
//   guest         its guest's source files, joined in order behind seedkernel's op-frame.
//                 A library two apps share is one more path in the list.
//   ui            its view, an HTML page; left out for an app with nothing to show. The
//                 stylesheets and scripts it names beside it are put into it (`readView`)
//   modules       its pure wasm modules, by the name the guest calls each; may be empty

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appFacts } from "../browser/app-api.js";

/** The label names the version file beside the author key, so it is held to what is safe
 *  in a filename on every platform. */
const APP_LABEL = /^[A-Za-z0-9_-]{1,64}$/;

/** An app's view as the one page that is signed. The shell loads a view from a `blob:` URL
 *  into a sandbox, where there is no file beside it to fetch, so what the page at `rel`
 *  names with `<link rel="stylesheet" href>` and `<script src>` is put into it here: a view
 *  is written as a page with its CSS and JS in files of their own, and travels as one.
 *  Each is a path relative to the page. `text` reads a file of the app as LF text. */
function readView(rel, text) {
  const beside = (ref, close) => {
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(ref))
      throw new Error(`${rel}: "${ref}" must be a file beside the view, which is all a view can carry`);
    const body = text(join(dirname(rel), ref));
    // Its text goes between a pair of tags, so it must not hold the one that ends them.
    if (body.toLowerCase().includes(close))
      throw new Error(`${rel}: ${ref} contains "${close}", which would end it early inside the page`);
    return body.endsWith("\n") ? body : body + "\n";
  };
  return text(rel)
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag) || !href) return tag;
      return `<style>\n${beside(href, "</style")}</style>`;
    })
    .replace(/<script\b([^>]*?)\s*\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      (tag, before, src, after) => `<script${before}${after}>\n${beside(src, "</script")}</script>`);
}

/** Everything `authorBundle` takes for the app in `appDir` but its version, which is the
 *  author's count to keep. `guestOpFraming` is seedkernel's, from `/bundle-author`. */
export function readAppSource(appDir, guestOpFraming) {
  // LF everywhere: these bytes are signed, and a checkout's line endings are the machine's.
  const text = (rel) => readFileSync(join(appDir, rel), "utf8").replace(/\r\n/g, "\n");
  const app = JSON.parse(text("app.json"));
  if (typeof app.app !== "string" || !APP_LABEL.test(app.app))
    throw new Error(`${appDir}/app.json: "app" must be 1-64 chars of [A-Za-z0-9_-]`);
  if (!Array.isArray(app.guest) || app.guest.length === 0)
    throw new Error(`${appDir}/app.json: "guest" must list the guest's source files`);

  const source = {
    app: app.app,
    protocols: app.protocols ?? [],
    modules: Object.entries(app.modules ?? {})
      .map(([name, rel]) => ({ name, wasm: new Uint8Array(readFileSync(join(appDir, rel))) })),
    guestSource: [guestOpFraming(), ...app.guest.map(text)].join("\n"),
    guestRequires: app.requires ?? [],
    // What the shell reads (browser/app-api.js `appFacts`) rides in the SIGNED manifest, so
    // an app's name and its view are vouched for by the same key as its code.
    guestConfig: {
      shell: {
        api: app.api,
        name: app.name ?? app.app,
        version: app.version ?? "",
        description: app.description ?? "",
        ...(app.ui ? { ui: readView(app.ui, text) } : {}),
      },
    },
  };
  // Refuse to sign what the shell would refuse to run, with the shell's own words for why.
  appFacts({ app: source.app, protocols: source.protocols, guest: { requires: source.guestRequires, config: source.guestConfig } });
  return source;
}
