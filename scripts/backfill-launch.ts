#!/usr/bin/env bun
/**
 * Backfill launch arguments into existing app entries.
 *
 * Registry apps historically carried no `launch` spec, so any app that needs a
 * required positional argument (e.g. gitv `[OWNER] [REPO]`) launched bare and
 * exited immediately. This infers launch positionals from each app's cached
 * README (Usage / Arguments sections) and writes them into apps/<id>.yaml.
 *
 * Existing curated `launch` specs are preserved. Only apps that currently have
 * no launch spec are backfilled.
 *
 * Usage:
 *   bun run scripts/backfill-launch.ts          # apply
 *   bun run scripts/backfill-launch.ts --dry     # report only
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { AppEntry } from "./types.ts";
import { inferLaunch } from "./infer.ts";

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "apps");
const READMES_DIR = join(ROOT, "readmes");

const dry = process.argv.includes("--dry");

let filesChanged = 0;
let withRequired = 0;
const summary: string[] = [];

for (const file of readdirSync(APPS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const full = join(APPS_DIR, file);
  let entry: AppEntry;
  try {
    entry = parse(readFileSync(full, "utf8")) as AppEntry;
  } catch {
    continue;
  }

  // Never clobber a curated launch spec.
  if (entry.launch && entry.launch.args && entry.launch.args.length > 0) continue;

  const sidecar = join(READMES_DIR, `${entry.id}.readme.md`);
  if (!existsSync(sidecar)) continue;

  const args = inferLaunch(readFileSync(sidecar, "utf8"), entry.binaries ?? []);
  if (args.length === 0) continue;

  entry.launch = { args };
  filesChanged++;
  if (args.some((a) => a.required)) withRequired++;

  const desc = args.map((a) => `${a.required ? "<" : "["}${a.name}${a.required ? ">" : "]"}`).join(" ");
  summary.push(`${entry.id}: ${desc}`);

  if (!dry) writeFileSync(full, stringify(entry, { lineWidth: 0 }));
}

for (const s of summary.sort()) console.log(s);
console.log(
  `\n${dry ? "[dry] " : ""}${filesChanged} apps backfilled with launch args ` +
    `(${withRequired} have at least one required arg).`,
);
