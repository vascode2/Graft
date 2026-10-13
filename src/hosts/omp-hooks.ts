/**
 * omp host hooks — the install half of Graft's omp integration.
 *
 * The omp extension (`src/omp/hooks.ts`) is compiled into the package at
 * `dist/omp/hooks.js`. omp discovers extensions from two places:
 *
 *   - project: `<repo>/.omp/extensions`
 *   - user:    `~/.omp/agent/extensions`
 *
 * The project-level wiring is what `graft omp-init` writes: a tiny `.mts` entry
 * that re-exports the installed package's compiled factory. That keeps the repo
 * wiring byte-stable across upgrades (the shim re-resolves at import time) and
 * means a teammate sees the same `.omp/extensions` file after pulling the
 * committed wiring, without graft being a repo dependency.
 *
 * `ompHookTargets()` is the pure "which files would this touch" half (for
 * `--dry-run` and the picker); `installOmpHooks()` does the writes. Both mirror
 * `src/hosts/antigravity.ts`'s shape, which is the closest existing template —
 * a global-style skill, an idempotent installer, and a ConfigWrite report.
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { distRootDir } from "../claude/paths.js";
import type { PlannedWrite } from "./plan.js";
import type { ConfigWrite } from "./config-write.js";

/** The omp extension entry path, inside the repo's `.omp/`. */
function hookPathFor(repo: string): string {
  return join(repo, ".omp", "extensions", "graft-hooks.mts");
}

/** The shim omp loads. omp resolves `.mts`/`.ts`/`.js` extension entry points;
 * this file re-exports the compiled factory from the installed package, so the
 * wiring survives a graft upgrade with no re-run. `distDir` is baked in at
 * install time from the package's own location, exactly like
 * `hooksShim()`'s Claude/Codex/Cursor pattern. POSIX slashes: Bun on Windows
 * rejects a bare `C:\...` specifier — no scheme, and every separator reads as
 * part of one path segment. A `C:/` (or `file:///C:/`) URL imports cleanly. */
function ompHooksShim(distDir: string): string {
  const url = `file:///${distDir.replace(/\\/g, "/")}/omp/hooks.js`;
  return `// installed by graft — managed; re-exports the compiled omp adapter from the
// installed @nanonets/graft package. Run \`graft omp-init\` to refresh.
import graftHooks from "${url}";
export default graftHooks;
`;
}

/** The files installing omp's hooks would touch — pure, no writes. */
export function ompHookTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: "omp",
      id: "omp-hook-shim",
      path: hookPathFor(repo),
      scope: "repo",
      kind: "hook",
      what: "session / prompt / tool / stop lifecycle adapter",
    },
  ];
}

/** Write the omp extension shim idempotently; report each file's action. */
export function installOmpHooks(repo: string): ConfigWrite[] {
  const path = hookPathFor(repo);
  const content = ompHooksShim(distRootDir());
  const existed = existsSync(path);
  if (existed && readFileSync(path, "utf8") === content) {
    return [{ id: "omp-hook-shim", path, action: "unchanged" }];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return [{ id: "omp-hook-shim", path, action: existed ? "updated" : "created" }];
}
