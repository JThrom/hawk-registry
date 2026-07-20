/**
 * Inference helpers.
 *
 * Extract structured metadata (language, install commands, package names,
 * tags, and the installation section) from a project's README markdown.
 * Heuristic but conservative — only emit a field when reasonably confident.
 */

import type { PackageManagerId } from "./types.ts";

/**
 * Redact secret-like tokens from README text before it is stored. Example
 * tokens sometimes appear in project READMEs; we must never commit them
 * (GitHub push protection blocks them, and it's poor hygiene regardless).
 */
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style keys
  /[MNO][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}/g, // Discord bot/user tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<REDACTED>");
  return out;
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

/**
 * Parse both ATX (`## Title`) and setext (`Title\n---`) headings.
 * Emoji/decoration in titles is tolerated.
 */
function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(atx);
    if (m) {
      headings.push({ line: i, level: m[1]!.length, text: m[2]! });
      continue;
    }
    // Setext: a non-empty text line followed by === (h1) or --- (h2).
    const next = lines[i + 1];
    if (next && line.trim().length > 0 && !line.startsWith("#")) {
      if (/^=+\s*$/.test(next)) headings.push({ line: i, level: 1, text: line.trim() });
      else if (/^-{2,}\s*$/.test(next)) headings.push({ line: i, level: 2, text: line.trim() });
    }
  }
  return headings;
}

/** Extract the "Installation" (or similar) section of a README, if present. */
export function extractInstallSection(readme: string): string | undefined {
  const lines = readme.split("\n");
  const headings = parseHeadings(lines);
  if (headings.length === 0) return undefined;

  // Prefer a heading specifically about installation; fall back to
  // getting-started/setup.
  const strong = headings.find((h) => /install/i.test(h.text));
  const weak = headings.find((h) => /(getting started|setup|building|from source)/i.test(h.text));
  const chosen = strong ?? weak;
  if (!chosen) return undefined;

  // End at the next heading of the same or higher level.
  const after = headings.filter((h) => h.line > chosen.line && h.level <= chosen.level);
  const end = after.length > 0 ? after[0]!.line : lines.length;

  const section = lines.slice(chosen.line, end).join("\n").trim();
  return section.length > 4000 ? section.slice(0, 4000) + "\n…" : section;
}

/** Collect fenced code blocks + inline-command lines from markdown. */
function commandLines(readme: string): string[] {
  const out: string[] = [];
  const fenceRe = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(readme))) {
    for (const line of m[1]!.split("\n")) {
      const t = line.trim().replace(/^\$\s*/, "");
      if (t) out.push(t);
    }
  }
  // Also inline `code` spans that look like install commands.
  const inlineRe = /`([^`]+)`/g;
  while ((m = inlineRe.exec(readme))) {
    const t = m[1]!.trim();
    if (/\b(install|add)\b/i.test(t)) out.push(t);
  }
  return out;
}

interface InferredInstall {
  install: Partial<Record<PackageManagerId, string>>;
  packages: Partial<Record<PackageManagerId, string>>;
}

/**
 * Patterns that map a command line to (manager, install command, package name).
 * Ordered; first match per manager wins.
 */
const INSTALL_PATTERNS: Array<{
  manager: PackageManagerId;
  re: RegExp;
  /** Group index that holds the package identifier. */
  pkgGroup: number;
}> = [
  { manager: "brew", re: /\bbrew\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "cargo", re: /\bcargo\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "go", re: /\bgo\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "pipx", re: /\bpipx\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "pip", re: /\bpip3?\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "npm", re: /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "bun", re: /\bbun\s+(?:install|add)\s+(?:-g|--global)\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "pacman", re: /\bpacman\s+-S\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "apt", re: /\bapt(?:-get)?\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
  { manager: "dnf", re: /\bdnf\s+install\s+([^\s&|;]+)/i, pkgGroup: 1 },
];

const VALID_MANAGERS = new Set<PackageManagerId>([
  "brew", "cargo", "go", "pipx", "pip", "npm", "bun", "pacman", "apt", "dnf",
]);

/** Infer install commands + package names from README command lines. */
export function inferInstalls(readme: string): InferredInstall {
  const install: Partial<Record<PackageManagerId, string>> = {};
  const packages: Partial<Record<PackageManagerId, string>> = {};
  const cmds = commandLines(readme);

  for (const line of cmds) {
    for (const pat of INSTALL_PATTERNS) {
      if (!VALID_MANAGERS.has(pat.manager)) continue;
      if (install[pat.manager]) continue; // keep first
      const m = line.match(pat.re);
      if (m) {
        const cmd = m[0].trim();
        const pkg = m[pat.pkgGroup];
        install[pat.manager] = cmd;
        if (pkg) {
          // Normalize package name for detection (strip version/paths).
          const simple = pkg
            .replace(/@.*$/, "") // strip @version / @latest
            .split("/")
            .pop()!; // last path segment (go modules, taps)
          packages[pat.manager] = simple;
        }
      }
    }
  }
  return { install, packages };
}

/** Language inference from README content + explicit hints. */
export function inferLanguage(readme: string): string | undefined {
  const checks: Array<[RegExp, string]> = [
    [/cargo\s+install|Cargo\.toml|crates\.io|\bRust\b/i, "Rust"],
    [/go\s+install|\bgolang\b|\bGo\b(?!\s*ogle)/i, "Go"],
    [/pip3?\s+install|pipx\s+install|\bPython\b|requirements\.txt/i, "Python"],
    [/npm\s+install|package\.json|\bNode\.js\b|\bTypeScript\b|\bJavaScript\b/i, "JavaScript"],
    [/\bRuby\b|gem\s+install/i, "Ruby"],
    [/\bHaskell\b|\bcabal\b|\bstack\b/i, "Haskell"],
    [/\bC\+\+\b|CMakeLists/i, "C++"],
  ];
  for (const [re, lang] of checks) {
    if (re.test(readme)) return lang;
  }
  return undefined;
}

/** Common stopwords excluded from tag inference. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "that", "this", "from", "into",
  "terminal", "tui", "cli", "app", "application", "tool", "written", "made",
  "using", "based", "simple", "fast", "modern", "interface", "user", "console",
  "command", "line", "run", "runs", "running", "manage", "management", "view",
  "viewer", "client", "support", "supports", "allow", "allows", "can", "will",
  "are", "has", "have", "its", "their", "when", "how", "what", "all", "use",
]);

/**
 * Infer a few function/synonym tags from the description + install section.
 * Conservative: short list of salient nouns, plus explicit domain keywords.
 */
export function inferTags(name: string, description: string, existing: string[] = []): string[] {
  const tags = new Set(existing.map((t) => t.toLowerCase()));

  // Domain keyword synonyms — expand searchability for common functions.
  const DOMAINS: Array<[RegExp, string[]]> = [
    [/\baws\b|amazon web services|\bs3\b|\bec2\b|\becs\b|cloudwatch/i, ["aws", "cloud"]],
    [/kubernetes|\bk8s\b|\bkubectl\b/i, ["kubernetes", "k8s"]],
    [/\bdocker\b|container/i, ["docker", "containers"]],
    [/calculat|arithmetic/i, ["calculator", "math"]],
    [/\bgit\b|version control/i, ["git", "vcs"]],
    [/music|audio|\bmp3\b|spotify|player/i, ["music", "audio"]],
    [/\bchess\b/i, ["chess", "game"]],
    [/file manager|file browser/i, ["file manager", "files"]],
    [/monitor|htop|\bcpu\b|memory|process/i, ["monitor", "system"]],
    [/database|\bsql\b|postgres|mysql|sqlite/i, ["database", "sql"]],
    [/\bhttp\b|\brest\b|\bapi\b/i, ["http", "api"]],
    [/\bemail\b|\bmail\b/i, ["email", "mail"]],
    [/\bchat\b|messaging|\birc\b|matrix/i, ["chat", "messaging"]],
    [/\brss\b|feed|news/i, ["rss", "news"]],
    [/network|\bping\b|bandwidth|packet/i, ["network"]],
  ];
  const hay = `${name} ${description}`;
  for (const [re, add] of DOMAINS) {
    if (re.test(hay)) add.forEach((t) => tags.add(t));
  }

  // Salient nouns from the description (length-filtered, stopword-filtered).
  for (const raw of description.toLowerCase().split(/[^a-z0-9+]+/)) {
    if (raw.length < 4 || raw.length > 16) continue;
    if (STOPWORDS.has(raw)) continue;
    tags.add(raw);
    if (tags.size >= existing.length + 12) break;
  }

  return [...tags];
}
