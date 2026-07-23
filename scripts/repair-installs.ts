#!/usr/bin/env bun
/**
 * One-off repair for malformed install / packages entries.
 *
 * A parser bug captured the first token after an install verb as the package
 * name, so flags like `--locked`, `--cask`, `-y`, `--user` were stored as the
 * package (and the install command was truncated, e.g. a bare
 * `cargo install --locked` with no crate). This re-infers install metadata
 * from the cached README sidecars using the corrected parser and overwrites
 * only the affected manager entries.
 *
 * Usage:
 *   bun run scripts/repair-installs.ts          # apply fixes
 *   bun run scripts/repair-installs.ts --dry     # report only, no writes
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { AppEntry, PackageManagerId } from "../src/catalog/types.ts";
import { inferInstalls } from "./infer.ts";

/** Derive the package name from a single, already-well-formed install command. */
function packageFromCommand(cmd: string): string | undefined {
  const fence = "```bash\n" + cmd + "\n```";
  const { packages } = inferInstalls(fence);
  const vals = Object.values(packages);
  return vals.length > 0 ? vals[0] : undefined;
}

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "apps");
const READMES_DIR = join(ROOT, "readmes");

const dry = process.argv.includes("--dry");

/** A stored package name is malformed when it is a flag or empty. */
function isBadValue(value: string | undefined): boolean {
  return !value || value.startsWith("-");
}

/** An install command is malformed when it lacks a positional after flags. */
function isBadInstall(cmd: string | undefined): boolean {
  if (!cmd) return true;
  const rest = cmd.split(/\s+/).slice(2); // drop `<mgr> install`
  for (const tok of rest) {
    if (tok.startsWith("-")) continue;
    if (tok === "install" || tok === "add" || tok === "-S") continue;
    return false; // found a positional -> ok
  }
  return true;
}

/** Managers whose README-inferred install is reliable enough to auto-apply. */
const CONFIDENT_MANAGERS = new Set<PackageManagerId>(["cargo", "brew", "npm", "bun"]);

/** Normalize a name for fuzzy comparison (drop separators/suffixes). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@[^/]+\//, "") // drop npm scope
    .replace(/[-_.]/g, "")
    .replace(/(tui|term|cli|rs|chat)$/i, "");
}

/**
 * A re-inferred package is trusted only when it plausibly refers to the app
 * itself (matches the id or one of its binaries), guarding against picking up
 * dependency/tooling install lines from the README (e.g. `cargo-make`,
 * `pipenv`, `libasound2-dev`).
 */
function isTrustedPackage(entry: AppEntry, pkg: string): boolean {
  const target = norm(pkg);
  if (!target) return false;
  const names = [entry.id, entry.name, ...(entry.binaries ?? [])].map(norm);
  return names.some((n) => n && (n === target || n.includes(target) || target.includes(n)));
}

interface Change {
  id: string;
  manager: string;
  before: string;
  after: string;
}

const changes: Change[] = [];
let filesChanged = 0;

for (const file of readdirSync(APPS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const full = join(APPS_DIR, file);
  let entry: AppEntry;
  try {
    entry = parse(readFileSync(full, "utf8")) as AppEntry;
  } catch {
    continue;
  }

  const sidecar = join(READMES_DIR, `${entry.id}.readme.md`);
  if (!existsSync(sidecar)) continue;

  const inferred = inferInstalls(readFileSync(sidecar, "utf8"));
  const install = { ...(entry.install ?? {}) } as Record<string, string>;
  const packages = { ...(entry.packages ?? {}) } as Record<string, string>;
  let touched = false;

  const managers = new Set<string>([
    ...Object.keys(install),
    ...Object.keys(packages),
  ]);

  for (const mgr of managers) {
    const m = mgr as PackageManagerId;
    const badPkg = isBadValue(packages[mgr]);
    const badCmd = isBadInstall(install[mgr]);
    if (!badPkg && !badCmd) continue;

    // Command is fine; only the package name is missing/malformed. Recompute it
    // from the existing command rather than re-scanning the README (which may
    // pick an unrelated line). This preserves valid entries like scoped npm
    // packages whose `packages` value was left empty.
    if (!badCmd) {
      const derived = packageFromCommand(install[mgr]!);
      if (derived) {
        changes.push({ id: entry.id, manager: mgr, before: `${install[mgr]} (pkg: ${packages[mgr] ?? "∅"})`, after: `pkg: ${derived}` });
        packages[mgr] = derived;
        touched = true;
        continue;
      }
    }

    const newCmd = inferred.install[m];
    const newPkg = inferred.packages[m];

    const trustworthy =
      newCmd &&
      newPkg &&
      CONFIDENT_MANAGERS.has(m) &&
      isTrustedPackage(entry, newPkg);

    if (trustworthy) {
      changes.push({ id: entry.id, manager: mgr, before: install[mgr] ?? "(none)", after: newCmd! });
      install[mgr] = newCmd!;
      packages[mgr] = newPkg!;
    } else {
      // Cannot confidently repair (noisy README line, dependency/tooling
      // command, or unreliable manager); drop the malformed entry so nothing
      // broken ships. A curator can add a correct command later.
      changes.push({ id: entry.id, manager: mgr, before: install[mgr] ?? packages[mgr] ?? "(none)", after: "(removed)" });
      delete install[mgr];
      delete packages[mgr];
    }
    touched = true;
  }

  if (!touched) continue;
  filesChanged++;

  if (Object.keys(install).length > 0) entry.install = install as AppEntry["install"];
  else delete entry.install;
  if (Object.keys(packages).length > 0) entry.packages = packages as AppEntry["packages"];
  else delete entry.packages;

  if (!dry) writeFileSync(full, stringify(entry, { lineWidth: 0 }));
}

for (const c of changes) {
  console.log(`${c.id} [${c.manager}]: ${c.before}  ->  ${c.after}`);
}
console.log(`\n${dry ? "[dry] " : ""}${changes.length} entries repaired across ${filesChanged} files.`);
