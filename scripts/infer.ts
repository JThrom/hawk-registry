/**
 * Inference helpers.
 *
 * Extract structured metadata (language, install commands, package names,
 * tags, and the installation section) from a project's README markdown.
 * Heuristic but conservative — only emit a field when reasonably confident.
 */

import type { LaunchArg, PackageManagerId } from "./types.ts";

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
/**
 * Patterns anchor to the manager's install verb and capture the remainder of
 * the command line (arguments). The real package identifier is then resolved
 * from those arguments by `resolvePackage`, which skips flags. Capturing only
 * the first token (the previous behaviour) picked up flags like `--locked` as
 * the package name and truncated the stored command (e.g. producing a bare
 * `cargo install --locked` with no crate).
 */
const INSTALL_PATTERNS: Array<{
  manager: PackageManagerId;
  /** Matches the install verb; group 1 = the rest of the command line. */
  re: RegExp;
}> = [
  { manager: "brew", re: /\bbrew\s+install\s+(.+)/i },
  { manager: "cargo", re: /\bcargo\s+install\s+(.+)/i },
  { manager: "go", re: /\bgo\s+install\s+(.+)/i },
  { manager: "pipx", re: /\bpipx\s+install\s+(.+)/i },
  { manager: "pip", re: /\bpip3?\s+install\s+(.+)/i },
  { manager: "npm", re: /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+(.+)/i },
  { manager: "bun", re: /\bbun\s+(?:install|add)\s+(?:-g|--global)\s+(.+)/i },
  { manager: "pacman", re: /\bpacman\s+-S\s+(.+)/i },
  { manager: "apt", re: /\bapt(?:-get)?\s+install\s+(.+)/i },
  { manager: "dnf", re: /\bdnf\s+install\s+(.+)/i },
];

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  // cargo
  "--version",
  "--git",
  "--branch",
  "--tag",
  "--rev",
  "--path",
  "--root",
  "--index",
  "--registry",
  "--features",
  "--target",
  "--bin",
  "--example",
  "-F",
  // pip / pipx
  "-r",
  "--requirement",
  "-e",
  "--editable",
  "--python",
  "-p",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--prefix",
]);

/**
 * A resolved positional that is not actually an installable package name:
 * local paths, requirement files, VCS URLs, and the like.
 */
function isNonPackage(token: string): boolean {
  return (
    token === "." ||
    token === ".." ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("http://") ||
    token.startsWith("https://") ||
    token.startsWith("git+") ||
    /\.(txt|toml|whl|tar\.gz|zip|git)$/i.test(token)
  );
}

/**
 * Resolve the package identifier from an argument list, skipping flags and any
 * values they consume. Returns the first positional argument (the crate /
 * formula / package name), or undefined when the command has none (e.g.
 * `cargo install --path .`, which builds a local checkout and has no
 * installable package name).
 */
function resolvePackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      // `--flag=value` carries its own value; a bare value-flag eats the next.
      if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    // Stop at shell operators that end the install invocation.
    if (arg === "&&" || arg === "||" || arg === ";" || arg === "|") break;
    if (isNonPackage(arg)) continue;
    return arg;
  }
  return undefined;
}

/** Tokenize a command tail, stopping at shell chaining operators. */
function splitArgs(rest: string): string[] {
  const cleaned = rest.split(/\s*(?:&&|\|\||;|\|)\s*/)[0]!.trim();
  return cleaned.length > 0 ? cleaned.split(/\s+/) : [];
}

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
      if (!m) continue;

      const args = splitArgs(m[1] ?? "");
      const pkg = resolvePackage(args);
      // Skip commands with no installable package (e.g. `cargo install
      // --path .`) — a bare install verb + flags is not runnable standalone.
      if (!pkg) continue;

      // Store the full command exactly as written (up to any shell chaining),
      // preserving flags in their original order.
      const cmd = m[0]
        .slice(0, m[0].length - (m[1] ?? "").length)
        .concat(args.join(" "))
        .trim();
      install[pat.manager] = cmd;

      // Normalize package name for detection. Strip a trailing @version /
      // @latest, but preserve a leading npm scope (e.g. `@scope/pkg`), whose
      // leading `@` must not be treated as a version separator.
      const scoped = pkg.startsWith("@");
      const withoutVersion = scoped
        ? pkg.replace(/(?<=.)@[^/]*$/, "") // strip @version only if not the scope marker
        : pkg.replace(/@.*$/, "");
      const simple = withoutVersion.split("/").pop()!; // last path segment (go modules, taps)
      packages[pat.manager] = simple;
    }
  }
  return { install, packages };
}

/* ---- launch-argument inference --------------------------------------- */

/**
 * Positional tokens that are structural, not real user-supplied arguments.
 * These appear in usage strings but must never become launch prompts.
 */
const USAGE_NOISE = new Set([
  "options",
  "option",
  "opts",
  "opt",
  "flags",
  "flag",
  "args",
  "arg",
  "arguments",
  "command",
  "commands",
  "cmd",
  "cmds",
  "subcommand",
  "subcommands",
  "subcmd",
]);

/** Fenced-block bodies from the README (reuses the install code-fence scan). */
function fencedBlocks(readme: string): string[] {
  const out: string[] = [];
  const fenceRe = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(readme))) out.push(m[1]!);
  return out;
}

/**
 * Turn a usage-string positional token into a launch arg, or null if it is
 * structural noise / an options placeholder.
 *
 * Convention (clap / argparse / docopt):
 *   <NAME>  -> required positional
 *   [NAME]  -> optional positional
 *   NAME    -> treated as optional positional (loose)
 * A trailing `...` (variadic) is stripped.
 */
function positionalToArg(token: string): LaunchArg | null {
  let t = token.trim().replace(/\.\.\.$/, ""); // strip variadic marker
  if (!t) return null;

  let required = false;
  if (t.startsWith("<") && t.endsWith(">")) {
    required = true;
    t = t.slice(1, -1);
  } else if (t.startsWith("[") && t.endsWith("]")) {
    required = false;
    t = t.slice(1, -1);
  } else {
    // Bare token: only accept ALL-CAPS placeholders (e.g. FILE, PATH); reject
    // anything that looks like a literal subcommand or flag.
    if (!/^[A-Z][A-Z0-9_]*$/.test(t)) return null;
  }

  t = t.replace(/\.\.\.$/, "").replace(/^[<[]|[>\]]$/g, "").trim();
  // Optional-nested brackets like `[<FILE>]`.
  t = t.replace(/^[<[]+|[>\]]+$/g, "").trim();
  if (!t) return null;

  const key = t.toLowerCase();
  if (USAGE_NOISE.has(key)) return null;
  if (t.startsWith("-")) return null; // a flag slipped through

  const name = key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) return null;

  return { name, required, placeholder: t };
}

/**
 * Parse a `Usage: <bin> ...` line into positional launch args.
 * Only tokens after the program name are considered. Stops at `[--` option
 * groups but keeps positional placeholders.
 */
function parseUsageLine(line: string, binaries: string[]): LaunchArg[] {
  // Strip a leading "Usage:" / "usage:" label + program name up to first space.
  const usage = line.replace(/^\s*usage:\s*/i, "").trim();
  if (!usage) return [];

  // Split into top-level groups, treating bracketed regions as single units so
  // that argparse-style option-with-value groups (e.g. `[-p PLAY [PLAY ...]]`)
  // stay intact and are discarded wholesale rather than leaking `PLAY`.
  const groups: string[] = [];
  let depthAngle = 0;
  let depthSquare = 0;
  let buf = "";
  const flush = () => {
    const g = buf.trim();
    if (g) groups.push(g);
    buf = "";
  };
  for (const ch of usage) {
    if (ch === "<") depthAngle++;
    if (ch === "[") depthSquare++;
    if (ch === ">" && depthAngle > 0) depthAngle--;
    if (ch === "]" && depthSquare > 0) depthSquare--;
    if (/\s/.test(ch) && depthAngle === 0 && depthSquare === 0) {
      flush();
    } else {
      buf += ch;
    }
  }
  flush();

  const binSet = new Set(binaries.map((b) => b.toLowerCase()));
  const args: LaunchArg[] = [];
  let seenProgram = false;

  for (const group of groups) {
    if (!seenProgram) {
      // Skip the program name + any leading lowercase subcommand words.
      if (binSet.has(group.toLowerCase()) || /^[a-z][a-z0-9._-]*$/.test(group)) {
        continue;
      }
      seenProgram = true;
    }

    // A group that contains a flag (starts with '-', or bracket wrapping a
    // flag) is an option/option-value group, not a positional — discard it.
    const inner = group.replace(/^[<[]+|[>\]]+$/g, "");
    if (inner.startsWith("-")) continue;
    if (/[<[]?-/.test(group) && /^[<[]/.test(group)) continue;
    // Groups with internal spaces after bracket-stripping are option groups.
    if (inner.trim().includes(" ")) continue;
    if (group.includes("|")) continue; // mutually-exclusive flag group

    const arg = positionalToArg(group);
    if (arg) args.push(arg);
  }

  // Deduplicate by name (variadic usages repeat the same placeholder, e.g.
  // `timg <FILE> [<FILE>...]`). Keep the first occurrence.
  const seen = new Set<string>();
  return args.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

/**
 * Extract per-argument descriptions from a clap/argparse `Arguments:` block:
 *   Arguments:
 *     <OWNER>   GitHub repository owner ...
 *     [REPO]    Repository name ...
 * Returns a map keyed by the normalized arg name.
 */
function parseArgumentDescriptions(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split("\n");
  let current: string | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // A new argument entry: leading indent then <NAME> / [NAME].
    const head = line.match(/^\s+[<[]([A-Za-z0-9_.-]+)[>\]]\s*(.*)$/);
    if (head) {
      const name = head[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      current = name;
      const desc = head[2]!.trim();
      if (desc) out[name] = desc;
      continue;
    }
    // Continuation lines (further indented prose) for the current arg.
    if (current && /^\s{2,}\S/.test(line) && !/^\s+[-<[]/.test(line)) {
      const extra = line.trim();
      if (extra && !out[current]) out[current] = extra;
    }
  }
  return out;
}

/**
 * Infer launch arguments from a README's usage documentation.
 *
 * Strategy: find a fenced block containing a `Usage:` line for one of the app's
 * binaries, parse its positional placeholders, and enrich them with
 * descriptions from an accompanying `Arguments:` section. Conservative — emits
 * nothing unless a clear usage string with positionals is found.
 */
export function inferLaunch(readme: string, binaries: string[]): LaunchArg[] {
  const blocks = fencedBlocks(readme);
  for (const block of blocks) {
    const usageLine = block
      .split("\n")
      .find((l) => /^\s*usage:\s/i.test(l));
    if (!usageLine) continue;

    const args = parseUsageLine(usageLine, binaries);
    if (args.length === 0) continue;

    // Enrich with descriptions if the block documents its Arguments.
    const descs = parseArgumentDescriptions(block);
    for (const a of args) {
      const d = descs[a.name];
      if (d) {
        // Trim to a single concise sentence/line.
        a.description = d.split(/[.\n]/)[0]!.trim().slice(0, 120) || d.slice(0, 120);
      }
    }
    return args;
  }
  return [];
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
