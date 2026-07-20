#!/usr/bin/env bun
/**
 * Registry build.
 *
 * Reads `categories.yaml` (taxonomy) and every `apps/<id>.yaml` (per-app
 * source), validates them, and writes the compiled `dist/index.yaml` that Hawk
 * fetches via jsDelivr.
 *
 * Usage:
 *   bun run scripts/build.ts          # build dist/index.yaml
 *   bun run scripts/build.ts --check  # validate only, no write (CI/PR gate)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { AppEntry, CategoryDef, RegistryIndex } from "./types.ts";

const INDEX_VERSION = 1;

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "apps");
const CATEGORIES_FILE = join(ROOT, "categories.yaml");
const DIST_DIR = join(ROOT, "dist");
const OUT_FILE = join(DIST_DIR, "index.yaml");

const VALID_MANAGERS = new Set([
  "brew", "apt", "pacman", "cargo", "npm", "bun", "pipx", "pip", "dnf",
]);

class BuildError extends Error {}

function loadCategories(): CategoryDef[] {
  if (!existsSync(CATEGORIES_FILE)) {
    throw new BuildError(`Missing categories.yaml at ${CATEGORIES_FILE}`);
  }
  const parsed = parse(readFileSync(CATEGORIES_FILE, "utf8")) as
    | { categories?: CategoryDef[] }
    | CategoryDef[];
  const cats = Array.isArray(parsed) ? parsed : parsed.categories;
  if (!cats || cats.length === 0) {
    throw new BuildError("categories.yaml has no categories");
  }
  for (const c of cats) {
    if (!c.id || !c.name) {
      throw new BuildError(`Category missing id/name: ${JSON.stringify(c)}`);
    }
  }
  return cats;
}

function validateEntry(entry: AppEntry, categoryIds: Set<string>, file: string): void {
  const req = (cond: boolean, msg: string) => {
    if (!cond) throw new BuildError(`${file}: ${msg}`);
  };
  req(Boolean(entry.id), "missing id");
  req(Boolean(entry.name), "missing name");
  req(Boolean(entry.description), "missing description");
  req(Array.isArray(entry.categories) && entry.categories.length > 0, "missing categories");
  req(Array.isArray(entry.binaries) && entry.binaries.length > 0, "missing binaries");

  for (const cat of entry.categories) {
    req(categoryIds.has(cat), `unknown category "${cat}" (add it to categories.yaml)`);
  }
  for (const map of [entry.install, entry.packages]) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      req(VALID_MANAGERS.has(key), `unknown package manager "${key}"`);
    }
  }
}

function loadApps(categoryIds: Set<string>): AppEntry[] {
  if (!existsSync(APPS_DIR)) {
    throw new BuildError(`Missing apps/ directory at ${APPS_DIR}`);
  }
  const files = readdirSync(APPS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const entries: AppEntry[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const full = join(APPS_DIR, file);
    let entry: AppEntry;
    try {
      entry = parse(readFileSync(full, "utf8")) as AppEntry;
    } catch (err) {
      throw new BuildError(`${file}: invalid YAML — ${err instanceof Error ? err.message : err}`);
    }
    validateEntry(entry, categoryIds, file);
    if (seen.has(entry.id)) {
      throw new BuildError(`Duplicate app id "${entry.id}" (in ${file})`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");

  const categories = loadCategories();
  const categoryIds = new Set(categories.map((c) => c.id));
  const entries = loadApps(categoryIds);

  const index: RegistryIndex = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    categories,
    entries,
  };

  if (checkOnly) {
    console.log(`OK: ${entries.length} apps across ${categories.length} categories validated.`);
    return;
  }

  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(OUT_FILE, stringify(index, { lineWidth: 0 }));
  console.log(`Wrote ${entries.length} apps across ${categories.length} categories to dist/index.yaml`);
}

try {
  main();
} catch (err) {
  if (err instanceof BuildError) {
    process.stderr.write(`Build failed: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
