/**
 * Coding path policy: which files the coding tools may touch at all.
 *
 * Three pure, synchronous questions, kept free of the filesystem on purpose:
 *   - isBlockedPath        the absolute blocklist, asked FIRST, before any
 *                          path is resolved, so that a refusal reveals nothing
 *                          about what exists on disk.
 *   - isReadableExtension  the coding read allowlist.
 *   - isProbablyBinary     a sniff on the head of a file whose extension lies.
 *
 * Containment (is the real path inside the granted directory?) is NOT decided
 * here; see src/main/file-access/real-path-guard.ts. Symlinks therefore are
 * not this module's business either.
 *
 * Every decision fails closed: input that cannot be classified is refused.
 */

/**
 * Absolute. No mode, dialog or consent lifts it. Documentation of the rule
 * set; the matcher below is compiled from exactly these strings.
 */
export const CODING_BLOCKED_PATTERNS: readonly string[] = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "id_rsa*",
  ".git/config",
  "*.sqlite",
  // Added in fix round 1. Siblings of the originals, plus names that carry
  // credentials by content. Not generalised to `id_*` (id_generator.ts).
  "*.pfx",
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  "credentials.json",
  ".npmrc",
  ".netrc",
  "*.db",
  // Added in fix round 2, by family. (`secrets` is a data-file family kept in
  // CODING_BLOCKED_DATA_* below, not a glob: `src/secrets.ts` is code.)
  // `.git` blocks the whole directory at any
  // depth (config, config.worktree, modules/*/config, hooks): an agent reads
  // git state through git commands, not as files. Deliberate: the blocklist
  // runs BEFORE path resolution, so `.git/../config.ts` is refused because it
  // contains `.git` as written. A path shape nobody writes by hand; not a bug. It does not touch
  // `.gitignore` or `.gitattributes`: the match is on the whole segment.
  ".git",
  "service-account*.json",
  ".docker/config.json",
  ".yarnrc.yml",
];

/**
 * Extension groups (lower-case, no dot). CODE and DOC are the only ones a
 * file named like a CODING_BLOCKED_DATA_BASENAMES entry may carry and still be
 * readable; everything else (data, config, markup-as-data, unknown) is not
 * exempt.
 *
 * Exemption line: extensions whose purpose is human-authored source or
 * prose. Deliberately NOT in CODE/DOC although readable: `sql` (often a
 * generated dump; a user table dump leaks hashes, and the content guard would
 * only offer to anonymise the emails), `xml` and `svg` (data
 * formats), `txt` (a plain text file named secrets is what people actually
 * write secrets into), and everything under DATA.
 */
export const CODING_CODE_EXTENSIONS: readonly string[] = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "dart", "ex", "exs",
  "sh", "bash", "zsh", "graphql", "gql", "proto", "gradle",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
];
export const CODING_DOC_EXTENSIONS: readonly string[] = ["md", "mdx"];
const CODING_DATA_EXTENSIONS: readonly string[] = [
  "xml", "svg",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "csv", "tsv", "lock",
  // sql is data wearing a code extension (often a generated dump).
  "sql",
  "txt",
];

/**
 * A file named like one of these is blocked: the bare name, or the name
 * followed by anything, UNLESS the final extension is a code or documentation
 * extension (`secrets`, `secrets.json`, `secrets.conf`, `secrets.bak`,
 * `secrets.whatever` are blocked; `secrets.ts`, `secrets.test.ts`,
 * `secrets.md` stay readable: a guard that false-alarms on the module that
 * reads secrets gets switched off). An allowlist of what is exempt, so a
 * format nobody has thought of yet is refused.
 */
export const CODING_BLOCKED_DATA_BASENAMES: readonly string[] = ["secrets"];

/** Extensions (lower-case, no dot) the coding tools may read. */
export const CODING_READ_EXTENSIONS: readonly string[] = [
  ...CODING_CODE_EXTENSIONS,
  ...CODING_DOC_EXTENSIONS,
  ...CODING_DATA_EXTENSIONS,
];

const SECRETS_EXEMPT_EXTENSIONS = new Set([
  ...CODING_CODE_EXTENSIONS,
  ...CODING_DOC_EXTENSIONS,
]);

/**
 * Files that carry no extension but are ordinary project text. Exact,
 * case-folded basenames; anything else without a known extension is refused.
 */
export const CODING_READ_BASENAMES: readonly string[] = [
  "dockerfile",
  "makefile",
  "license",
  "procfile",
  "gemfile",
  "rakefile",
  "codeowners",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".nvmrc",
  ".npmignore",
  ".dockerignore",
];

// ---------------------------------------------------------------------------
// Spelling normalisation
//
// Case: the development and target platform is macOS, where APFS is
// case-insensitive by default. `.ENV` and `.Env` open the same file as `.env`,
// so the rule is case-INSENSITIVE. Measured on APFS: even the Kelvin sign
// ("a.\u212aey") opens `a.key`, so folding is NFKC followed by lower-casing,
// not an ASCII-only lower-case. The price is a false positive on Linux, where
// `.ENV` is a different file; for a secrets blocklist that is the right side
// to err on.
// ---------------------------------------------------------------------------

/** Format characters (zero-width joiners and friends) and control characters. */
const FORMAT_CHARS = /\p{Cf}/gu;
const CONTROL_CHARS = /\p{Cc}/u;
/** Trailing dots and spaces are ignored by Windows name resolution. */
const TRAILING_DOTS_SPACES = /[. ]+$/;

/** One path segment, folded to the spelling the patterns are written in. */
function foldSegment(segment: string): string {
  return segment
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .toLowerCase()
    .replace(TRAILING_DOTS_SPACES, "");
}

type Fold =
  | { kind: "ok"; segments: string[]; resolved: string[]; endsWithName: boolean }
  | { kind: "unclassifiable" };

/**
 * Split on both separators and fold every segment. `segments` is every named
 * segment as written; `resolved` has `.` removed and `..` applied lexically
 * (a `..` that cannot pop is kept, so it stays visible).
 */
function foldPath(input: unknown): Fold {
  if (typeof input !== "string" || input.length === 0) {
    return { kind: "unclassifiable" };
  }
  if (CONTROL_CHARS.test(input)) return { kind: "unclassifiable" };
  // A project-relative path has no legitimate colon on any platform this
  // ships to, and on NTFS `a.key::$DATA` or `a.pem:stream` opens the data
  // stream of the blocked file. Refuse outright; this also refuses `C:\x`.
  if (input.includes(":")) return { kind: "unclassifiable" };

  const segments: string[] = [];
  const resolved: string[] = [];
  const tokens = input.split(/[\\/]/);
  // The last token names a FILE only when it is a real name: a trailing
  // separator, `.` or `..` means the path ends in a directory.
  const last = tokens[tokens.length - 1];
  const endsWithName = last !== "" && last !== "." && last !== "..";
  for (const raw of tokens) {
    if (raw === "") continue; // "a//b", leading or trailing slash
    if (raw === ".") continue;
    if (raw === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else {
        resolved.push("..");
      }
      continue;
    }
    const folded = foldSegment(raw);
    // "...", ". " and the like fold to nothing: a name we cannot classify.
    if (folded === "") return { kind: "unclassifiable" };
    segments.push(folded);
    resolved.push(folded);
  }
  return { kind: "ok", segments, resolved, endsWithName };
}

// ---------------------------------------------------------------------------
// Pattern matcher, compiled once from CODING_BLOCKED_PATTERNS
// ---------------------------------------------------------------------------

/** Compile one glob segment. Only `*` is a wildcard; anything else is literal. */
function compileSegment(glob: string): RegExp {
  if (/[?[\]{}]/.test(glob)) {
    // A pattern we cannot classify must not silently match nothing.
    throw new Error(`Unsupported glob syntax in blocked pattern: ${glob}`);
  }
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+^$()|\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

/**
 * Compile one blocked pattern (segments separated by `/`) to one RegExp per
 * segment. Throws on glob syntax other than `*`. Exported so the throw can be
 * tested: the constant list can never trigger it.
 */
export function compileBlockedPattern(pattern: string): readonly RegExp[] {
  return pattern.split("/").map(compileSegment);
}

const COMPILED_PATTERNS: readonly (readonly RegExp[])[] =
  CODING_BLOCKED_PATTERNS.map(compileBlockedPattern);

/**
 * The folded, lexically resolved segments of a path (`.` removed, `..`
 * applied, a `..` that cannot pop is kept), or null when the path cannot be
 * classified. Exposed for the tests and for a second blocklist pass on a
 * resolved real path.
 */
export function resolvePathSegments(path: string): string[] | null {
  const folded = foldPath(path);
  return folded.kind === "ok" ? folded.resolved : null;
}

const MULTI_SEGMENT_PATTERNS = COMPILED_PATTERNS.filter((p) => p.length > 1);

/**
 * `.env*` is deliberately wide (.env.local, .env.production.local, .envrc,
 * .env.example.md) and has NO exemption: the list is absolute. A name from
 * the .env family is refused even if it is documentation; a doc can be
 * renamed, a secret that was read cannot be un-read.
 */
/**
 * `isFileName` is true only for the LAST segment of a path that ends in a
 * name. The code/prose exemption is correct for a file (`src/secrets.ts` is a
 * module) and wrong for a directory (`secrets.ts/api.json`, `secrets.d/`,
 * `secrets.prod/`): an exemption that is right in one case must not leak into
 * another case that reaches the same state. A directory gets no exemption.
 */
function isBlockedDataName(segment: string, isFileName: boolean): boolean {
  for (const base of CODING_BLOCKED_DATA_BASENAMES) {
    if (segment === base) return true;
    if (segment.startsWith(`${base}.`)) {
      const ext = segment.slice(segment.lastIndexOf(".") + 1);
      if (!isFileName || !SECRETS_EXEMPT_EXTENSIONS.has(ext)) return true;
    }
  }
  return false;
}

function segmentIsBlocked(segment: string, isFileName: boolean): boolean {
  return (
    isBlockedDataName(segment, isFileName) ||
    COMPILED_PATTERNS.some(
      (pattern) => pattern.length === 1 && pattern[0].test(segment),
    )
  );
}

/** True when `pattern` matches `resolved` at some position (consecutive). */
function sequenceMatches(
  pattern: readonly RegExp[],
  resolved: readonly string[],
): boolean {
  for (let start = 0; start + pattern.length <= resolved.length; start++) {
    if (pattern.every((re, k) => re.test(resolved[start + k]))) return true;
  }
  return false;
}

/**
 * True when the path names a file the coding tools must never touch.
 *
 * Absolute: no mode and no dialog lifts it. Pure and synchronous, and it does
 * not touch the filesystem, so asking it first reveals nothing about disk.
 *
 * Single-segment patterns are checked against EVERY segment (a directory
 * named `.env` or `x.pem` blocks everything below it; over-blocking is the
 * accepted error). Multi-segment patterns (`.docker/config.json`) are checked against
 * the lexically resolved path, at any depth.
 *
 * Expects a path relative to the granted directory. An absolute path is not
 * refused here, only scanned segment by segment; whether it lies inside the
 * grant is the containment check's verdict. Symlinks are not followed.
 * Unclassifiable input (non-string, empty, control characters, a segment that
 * folds to nothing) is blocked.
 */
export function isBlockedPath(relativePath: string): boolean {
  const folded = foldPath(relativePath);
  if (folded.kind === "unclassifiable") return true;

  // Every segment as written, including ones a later `..` cancels: a detour
  // through `.env/` is not an excuse.
  const lastIndex = folded.segments.length - 1;
  if (
    folded.segments.some((seg, i) =>
      segmentIsBlocked(seg, folded.endsWithName && i === lastIndex),
    )
  ) {
    return true;
  }
  return MULTI_SEGMENT_PATTERNS.some((p) => sequenceMatches(p, folded.resolved));
}

// ---------------------------------------------------------------------------
// Read allowlist and binary sniff
// ---------------------------------------------------------------------------

const READ_EXTENSIONS = new Set(CODING_READ_EXTENSIONS);
const READ_BASENAMES = new Set(CODING_READ_BASENAMES);

/**
 * True when the last path segment has an extension on the coding read list
 * (or is a known extension-less project file). Case-insensitive, same
 * folding as the blocklist. Unknown, missing or unclassifiable: false.
 * Does not consult the blocklist; callers ask that first.
 */
export function isReadableExtension(relativePath: string): boolean {
  const folded = foldPath(relativePath);
  if (folded.kind === "unclassifiable") return false;
  const name = folded.segments[folded.segments.length - 1];
  if (name === undefined) return false;
  if (READ_BASENAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return READ_EXTENSIONS.has(name.slice(dot + 1));
}

const BINARY_SNIFF_BYTES = 8000;

/**
 * A null byte in the first 8000 bytes. Crude and cheap, meant for the case
 * where an extension lies. A non-Buffer is treated as binary (fail closed);
 * an empty buffer is an empty text file. UTF-16 text contains null bytes and
 * is refused as well.
 */
export function isProbablyBinary(head: Buffer): boolean {
  if (!Buffer.isBuffer(head)) return true;
  const end = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}
