// Remove every build artifact so the next build starts from nothing.
//
// The build scripts overwrite in place rather than wiping their output dirs, so a
// stale file from an earlier build — or a different branch — can linger and get
// served. `npm run clean` is the escape hatch: delete both output dirs, then
// `npm run build` regenerates them. Use it whenever the shell behaves like it's
// running old code and `-c-1` (see `npm run serve`) has already ruled out the
// browser cache.
//
//   npm run clean          →  removes build/ and browser/vendor/
//   npm run clean && npm run build
//
// rmSync retries through the transient Windows/Defender file locks that make a
// plain delete flaky right after a server or the browser touched the dir.

import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let removed = 0;
for (const rel of ["build", "browser/vendor"]) {
  const dir = join(root, rel);
  if (!existsSync(dir)) continue;
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log(`clean: removed ${rel}/`);
  removed++;
}

console.log(removed === 0
  ? "clean: nothing to do — both output dirs already absent."
  : "clean: run `npm run build` to regenerate.");
