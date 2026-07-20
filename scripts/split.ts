#!/usr/bin/env bun
/**
 * One-time seeder.
 *
 * Splits an aggregated registry file (Hawk's data/registry.yaml, generated from
 * awesome-tuis) into per-app source files under apps/ plus categories.yaml.
 * After running this, apps/ becomes the source of truth and this script is no
 * longer needed for normal operation.
 *
 * Usage:
 *   bun run scripts/split.ts [path-to-aggregated-registry.yaml]
 *
 * Default source: ../hawk/data/registry.yaml (sibling checkout).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import type { AppEntry, CategoryDef } from "./types.ts";

interface Aggregated {
  categories?: CategoryDef[];
  entries?: AppEntry[];
}

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "apps");
const CATEGORIES_FILE = join(ROOT, "categories.yaml");

function defaultSource(): string {
  // Prefer a sibling ~/projects/hawk checkout.
  const sibling = join(homedir(), "projects", "hawk", "data", "registry.yaml");
  return sibling;
}

/** Remove undefined fields and normalize key order for stable diffs. */
function cleanEntry(e: AppEntry): AppEntry {
  const out: AppEntry = {
    id: e.id,
    name: e.name,
    description: e.description,
    categories: e.categories,
    binaries: e.binaries,
  };
  if (e.tags?.length) out.tags = e.tags;
  if (e.language) out.language = e.language;
  if (e.homepage) out.homepage = e.homepage;
  if (e.repo) out.repo = e.repo;
  if (e.popularity !== undefined) out.popularity = e.popularity;
  if (e.packages) out.packages = e.packages;
  if (e.install) out.install = e.install;
  return out;
}

/** Filesystem-safe file name for an app id. */
function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function main(): void {
  const src = process.argv[2] ?? defaultSource();
  if (!existsSync(src)) {
    process.stderr.write(`Source not found: ${src}\n`);
    process.exit(1);
  }

  const data = parse(readFileSync(src, "utf8")) as Aggregated;
  const categories = data.categories ?? [];
  const entries = data.entries ?? [];

  if (categories.length === 0 || entries.length === 0) {
    process.stderr.write("Source has no categories or entries.\n");
    process.exit(1);
  }

  // Write categories.yaml.
  writeFileSync(
    CATEGORIES_FILE,
    stringify({ categories }, { lineWidth: 0 }),
  );

  // Write per-app files.
  if (!existsSync(APPS_DIR)) mkdirSync(APPS_DIR, { recursive: true });
  const used = new Set<string>();
  let written = 0;
  for (const entry of entries) {
    let base = safeName(entry.id);
    let name = base;
    let n = 1;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    writeFileSync(join(APPS_DIR, `${name}.yaml`), stringify(cleanEntry(entry), { lineWidth: 0 }));
    written++;
  }

  console.log(
    `Split ${written} apps into apps/ and wrote ${categories.length} categories to categories.yaml`,
  );
}

main();
