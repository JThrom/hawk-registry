#!/usr/bin/env bun
/**
 * README enrichment.
 *
 * For every app with a GitHub repo, fetch the README (via
 * raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md — no API rate limit),
 * save it as a sidecar `readmes/<id>.readme.md`, and infer metadata
 * (language, install commands, package names, tags, install section) into the
 * app's `apps/<id>.yaml`.
 *
 * Usage:
 *   bun run scripts/enrich.ts [--force] [--limit N] [--only <id>]
 *
 *   --force   re-fetch READMEs even if a sidecar already exists
 *   --limit   process at most N apps (for testing)
 *   --only    process a single app id
 *
 * Idempotent + resumable: existing sidecars are skipped unless --force.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { AppEntry } from "./types.ts";
import {
  extractInstallSection,
  inferInstalls,
  inferLanguage,
  inferLaunch,
  inferTags,
  redactSecrets,
} from "./infer.ts";

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "apps");
const READMES_DIR = join(ROOT, "readmes");

const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15_000;
const README_CANDIDATES = ["README.md", "readme.md", "README.markdown", "README.rst", "README"];

interface Args {
  force: boolean;
  limit: number | null;
  only: string | null;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const force = a.includes("--force");
  const limIdx = a.indexOf("--limit");
  const onlyIdx = a.indexOf("--only");
  return {
    force,
    limit: limIdx >= 0 ? Number(a[limIdx + 1]) : null,
    only: onlyIdx >= 0 ? (a[onlyIdx + 1] ?? null) : null,
  };
}

/** owner/repo from a github URL, or null. */
function ghSlug(repo: string): { owner: string; name: string } | null {
  try {
    const u = new URL(repo);
    if (!/github\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function fetchReadme(owner: string, name: string): Promise<{ text: string; url: string } | null> {
  for (const file of README_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${file}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 0) return { text, url };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

interface Stats {
  processed: number;
  fetched: number;
  skipped: number;
  failed: number;
  installsAdded: number;
}

function sidecarPath(id: string): string {
  return join(READMES_DIR, `${id}.readme.md`);
}

async function enrichOne(file: string, args: Args, stats: Stats): Promise<void> {
  const full = join(APPS_DIR, file);
  let entry: AppEntry;
  try {
    entry = parse(readFileSync(full, "utf8")) as AppEntry;
  } catch {
    stats.failed++;
    return;
  }
  if (args.only && entry.id !== args.only) return;
  if (!entry.repo) return;
  const slug = ghSlug(entry.repo);
  if (!slug) return;

  stats.processed++;

  const sidecar = sidecarPath(entry.id);
  let readme: string | null = null;
  let readmeUrl = entry.readmeUrl;

  if (!args.force && existsSync(sidecar)) {
    readme = readFileSync(sidecar, "utf8");
    stats.skipped++;
  } else {
    const fetched = await fetchReadme(slug.owner, slug.name);
    if (!fetched) {
      stats.failed++;
      return;
    }
    if (!existsSync(READMES_DIR)) mkdirSync(READMES_DIR, { recursive: true });
    const safe = redactSecrets(fetched.text);
    writeFileSync(sidecar, safe);
    readme = safe;
    readmeUrl = fetched.url;
    stats.fetched++;
  }

  // Infer metadata (do not overwrite existing curated values).
  const { install, packages } = inferInstalls(readme);
  const language = entry.language ?? inferLanguage(readme);
  const installSection = extractInstallSection(readme);
  const tags = inferTags(entry.name, entry.description, entry.tags ?? []);
  const launchArgs = inferLaunch(readme, entry.binaries ?? []);

  const merged: AppEntry = {
    ...entry,
    language: language ?? entry.language,
    tags: tags.length ? tags : entry.tags,
    install: { ...install, ...entry.install }, // curated install wins
    packages: { ...packages, ...entry.packages },
    installNotes: installSection ?? entry.installNotes, // README is source of truth
    readmeUrl: readmeUrl ?? entry.readmeUrl,
    // Curated launch spec wins; otherwise use inferred positionals.
    launch: entry.launch ?? (launchArgs.length ? { args: launchArgs } : undefined),
  };
  if (!merged.launch) delete merged.launch;

  // Drop empty maps to keep files clean.
  if (merged.install && Object.keys(merged.install).length === 0) delete merged.install;
  if (merged.packages && Object.keys(merged.packages).length === 0) delete merged.packages;
  if (merged.install && Object.keys(merged.install).length > 0) stats.installsAdded++;

  writeFileSync(full, stringify(merged, { lineWidth: 0 }));
}

async function main(): Promise<void> {
  const args = parseArgs();
  let files = readdirSync(APPS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (args.limit) files = files.slice(0, args.limit);

  const stats: Stats = { processed: 0, fetched: 0, skipped: 0, failed: 0, installsAdded: 0 };

  // Simple concurrency pool.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      await enrichOne(file, args, stats);
      if (stats.processed > 0 && stats.processed % 25 === 0) {
        process.stdout.write(
          `\r  processed ${stats.processed} | fetched ${stats.fetched} | skipped ${stats.skipped} | failed ${stats.failed} | installs ${stats.installsAdded}   `,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  process.stdout.write("\n");
  console.log(
    `Done. processed=${stats.processed} fetched=${stats.fetched} skipped=${stats.skipped} failed=${stats.failed} installsAdded=${stats.installsAdded}`,
  );
}

main();
