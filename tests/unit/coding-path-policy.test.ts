import { describe, it, expect } from "vitest";
import {
  CODING_BLOCKED_PATTERNS,
  CODING_BLOCKED_DATA_BASENAMES,
  CODING_CODE_EXTENSIONS,
  CODING_DOC_EXTENSIONS,
  compileBlockedPattern,
  resolvePathSegments,
  CODING_READ_EXTENSIONS,
  isBlockedPath,
  isReadableExtension,
  isProbablyBinary,
} from "../../src/main/coding/path-policy";

describe("coding path policy: blocklist", () => {
  it("exposes exactly the agreed patterns", () => {
    expect([...CODING_BLOCKED_PATTERNS]).toEqual([
      ".env*",
      "*.pem",
      "*.key",
      "*.p12",
      "id_rsa*",
      ".git/config",
      "*.sqlite",
      "*.pfx",
      "id_ed25519*",
      "id_ecdsa*",
      "id_dsa*",
      "credentials.json",
      ".npmrc",
      ".netrc",
      "*.db",
      ".git",
      "service-account*.json",
      ".docker/config.json",
      ".yarnrc.yml",
    ]);
  });

  it("blocks secrets regardless of depth or mode", () => {
    for (const p of [
      ".env",
      ".env.local",
      "deep/nested/.env.production",
      "certs/server.pem",
      "a.key",
      "x.p12",
      ".ssh/id_rsa",
      ".git/config",
      "data/app.sqlite",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
  });

  it("does not block ordinary source files", () => {
    for (const p of [
      "src/index.ts",
      "README.md",
      "keyboard.ts",
    ]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("does not block names that merely contain a pattern as a substring", () => {
    for (const p of [
      "src/environment.ts",
      "src/my.env.ts",
      "docs/pem.md",
      "src/monkey.ts",
      "src/keyring.ts",
      "src/git/config.ts",
      "gitconfig.md",
      "sqlite/README.md",
      "lib/sqlite.ts",
      "src/ids_helper_notes.md",
    ]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("matches case-insensitively because the filesystem does", () => {
    // macOS APFS (default) resolves .ENV, .Env and A.PEM to the same file
    // as .env and a.pem; the rule must not hold for one spelling only.
    for (const p of [
      ".ENV",
      ".Env",
      ".ENV.LOCAL",
      "a/B.PEM",
      "A.KEY",
      "X.P12",
      "ID_RSA",
      ".GIT/CONFIG",
      ".Git/Config",
      "DATA/APP.SQLITE",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
  });

  it("documents the measured APFS Kelvin-sign behaviour (not evidence for NFKC)", () => {
    // Measured on APFS: "a.\u212aey" (Kelvin sign) opens a.key. This does NOT
    // prove the NFKC step: "\u212a".toLowerCase() is already "k", so the case
    // fold alone passes it. The NFKC decision is tested below.
    expect(isBlockedPath("a.\u212aey")).toBe(true);
  });

  it("applies compatibility normalisation where it alone decides", () => {
    // The patterns are ASCII, so canonical NFC/NFD differences cannot decide
    // anything (an NFD "u\u0308.pem" is blocked by *.pem under any fold, which
    // is why it is not asserted here). Fullwidth forms are different: they
    // match a basename family only after NFKC.
    expect(isBlockedPath("\uff0eenv")).toBe(true);
    expect(isBlockedPath("\uff0e\uff45\uff4e\uff56")).toBe(true);
    expect(isBlockedPath("\uff49\uff44\u005f\uff52\uff53\uff41")).toBe(true); // id_rsa
    expect(isBlockedPath("\uff43redentials.json")).toBe(true);
    expect(isBlockedPath("\uff33ECRETS.json")).toBe(true);
    // Neighbour: fullwidth letters in an unrelated name stay allowed.
    expect(isBlockedPath("\uff4bey.ts")).toBe(false);
  });

  it("ignores ./ and .. segments, so one file cannot hide behind a detour", () => {
    for (const p of [
      "./.env",
      "src/./.env",
      "src/../.env",
      "a/b/../../.env.local",
      ".git/./config",
      ".git/x/../config",
      "./.git//config",
      ".git/config/",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
    // A detour that lands on an ordinary file stays allowed.
    expect(isBlockedPath("src/../README.md")).toBe(false);
    // `.git` is blocked as a segment even when a later `..` cancels it: the
    // detour is over-cautious by design, never a way in.
    expect(isBlockedPath(".git/../config.ts")).toBe(true);
  });

  it("treats a backslash as a separator", () => {
    expect(isBlockedPath("deep\\nested\\.env")).toBe(true);
    expect(isBlockedPath(".git\\config")).toBe(true);
    expect(isBlockedPath("src\\index.ts")).toBe(false);
  });

  it("strips trailing dots and spaces that Windows ignores", () => {
    for (const p of [".env.", ".env ", "a.pem.", "a.key ", ".git./config", ".git/config. "]) {
      expect(isBlockedPath(p), JSON.stringify(p)).toBe(true);
    }
  });

  it("ignores invisible format characters inside a name", () => {
    expect(isBlockedPath(".e\u200bnv")).toBe(true);
    expect(isBlockedPath("a.p\u200dem")).toBe(true);
  });

  it("blocks a pattern hit on any segment, including directories", () => {
    expect(isBlockedPath(".env/settings.ts")).toBe(true);
    expect(isBlockedPath("backup.pem/readme.md")).toBe(true);
    expect(isBlockedPath("a/.git/config")).toBe(true);
  });

  it("blocks the whole .env family, documentation names included", () => {
    // The plan's own example `.env.example.md` was corrected: it belongs to
    // the .env family and is refused. A doc can be renamed; a secret that was
    // read cannot be un-read.
    for (const p of [
      ".env.example",
      ".env.development.local",
      ".envrc",
      ".env.md",
      ".env.example.txt",
      ".env.example.md",
      "docs/.env.local.md",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
  });

  it("blocks the extended secret names and lets their neighbours through", () => {
    const blocked = [
      "a.pfx", "certs/A.PFX",
      "id_ed25519", "id_ed25519.pub", ".ssh/ID_ED25519",
      "id_ecdsa", "id_ecdsa.pub",
      "id_dsa", "id_dsa.pub",
      "credentials.json", "cfg/Credentials.JSON",
      "secrets.yaml", "secrets.yml", "secrets.json", "secrets.toml", "deploy/SECRETS.YML",
      ".npmrc", "pkg/.NPMRC",
      ".netrc",
      "app.db", "data/APP.DB",
    ];
    for (const p of blocked) expect(isBlockedPath(p), p).toBe(true);
    const allowed = [
      "src/pfx.ts", "pfx-notes.md",
      "src/id_generator.ts", "src/my_id_ed25519.ts", "src/id_ecdsa_notes".replace("id_ecdsa_", "ids_") + ".md",
      "src/id_dsa.ts".replace("id_dsa", "ids_dsa"),
      "src/credentials.ts", "docs/credentials.md", "credentials.json.md",
      "src/secret.ts", "secrets-guide.md", "src/secretsmanager.ts",
      "npmrc.md", ".npmignore",
      "netrc.ts",
      "src/db.ts", "db/schema.ts", "docs/mydb.md",
    ];
    for (const p of allowed) expect(isBlockedPath(p), p).toBe(false);
  });

  it("matches the whole segment, not the whole string as a substring", () => {
    expect(isBlockedPath("pre.env")).toBe(false);
    expect(isBlockedPath("x.pem.ts")).toBe(false);
    expect(isBlockedPath("id_rsa")).toBe(true);
    expect(isBlockedPath("id_rsa.pub")).toBe(true);
    expect(isBlockedPath("my_id_rsa")).toBe(false);
  });

  it("fails closed on a name it cannot classify", () => {
    for (const p of ["a\0b.ts", "src/\n.ts", "src/.../x.ts", "src/. /x.ts", ""]) {
      expect(isBlockedPath(p), JSON.stringify(p)).toBe(true);
    }
    for (const bad of [undefined, null, 42, {}, ["a"]]) {
      expect(isBlockedPath(bad as unknown as string)).toBe(true);
    }
  });

  it("scans absolute paths segment by segment instead of refusing them", () => {
    expect(isBlockedPath("/home/u/proj/.env")).toBe(true);
    expect(isBlockedPath("/home/u/proj/src/index.ts")).toBe(false);
  });

  it("keeps a leading .. visible and still scans the rest", () => {
    expect(isBlockedPath("../../.env")).toBe(true);
    // Escaping the root is the containment check's verdict, not this one's.
    expect(isBlockedPath("../outside.ts")).toBe(false);
  });
});

describe("coding path policy: fix round 2", () => {
  it("blocks the whole .git directory at any depth, but not .gitignore", () => {
    for (const p of [
      ".git/config",
      ".git/config.worktree",
      ".git/modules/sub/config",
      "vendor/lib/.git/modules/x/config",
      ".git/HEAD",
      ".git/hooks/pre-commit",
      ".GIT/Config",
      "sub/.git",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
    for (const p of [
      ".gitignore",
      ".gitattributes",
      "src/.gitkeep",
      "docs/git/config.md",
      "src/gitconfig.ts",
      ".github/workflows/ci.yml",
    ]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("blocks credential files by family and lets neighbours through", () => {
    for (const p of [
      "secrets.json",
      "secrets.toml",
      "cfg/Secrets.TOML",
      "service-account.json",
      "service-account-prod.json",
      "keys/SERVICE-ACCOUNT-ci.JSON",
      ".docker/config.json",
      "home/.Docker/Config.json",
      ".yarnrc.yml",
      "pkg/.YARNRC.YML",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
    for (const p of [
      "service-account-docs.md",
      "src/service-account.ts",
      "docker/config.json",
      ".docker/compose.yml",
      "src/docker/config.json",
      "yarnrc.md",
      ".yarn/releases/yarn.cjs",
      ".yarnrc",
    ]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("refuses a colon in a project-relative path (NTFS alternate streams)", () => {
    for (const p of [
      "a.key::$DATA",
      "a.pem:stream",
      "src/a.ts:x",
      ".env:Zone.Identifier",
      "C:/proj/src/index.ts",
      "C:\\proj\\a.ts",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
    expect(isBlockedPath("src/a.ts")).toBe(false);
  });

  it("resolves .. lexically and keeps unresolvable leading .. visible", () => {
    expect(resolvePathSegments("a/b/../c")).toEqual(["a", "c"]);
    expect(resolvePathSegments("../x")).toEqual(["..", "x"]);
    // Two leading .. must stay two: the second may not pop the first.
    expect(resolvePathSegments("../../x")).toEqual(["..", "..", "x"]);
    expect(resolvePathSegments("a/../..")).toEqual([".."]);
    expect(resolvePathSegments("./a//b/")).toEqual(["a", "b"]);
    expect(resolvePathSegments("a\\b")).toEqual(["a", "b"]);
    expect(resolvePathSegments("a\u0000b")).toBeNull();
    expect(resolvePathSegments("")).toBeNull();
    expect(resolvePathSegments("a/.../b")).toBeNull();
  });

  it("rejects glob syntax it cannot classify instead of matching nothing", () => {
    for (const bad of ["a?b", "[ab].pem", "{a,b}.key", "x/[y]"]) {
      expect(() => compileBlockedPattern(bad), bad).toThrow(/Unsupported glob/);
    }
    const [re] = compileBlockedPattern("*.pem");
    expect(re.test("a.pem")).toBe(true);
    expect(re.test("a.pem.ts")).toBe(false);
    expect(compileBlockedPattern(".docker/config.json")).toHaveLength(2);
  });
});

describe("coding path policy: fix round 3 (secrets is a data file, not a code file)", () => {
  it("blocks a data file named secrets, however it is spelled", () => {
    for (const p of [
      "secrets",
      "config/secrets",
      "secrets.json",
      "secrets.toml",
      "secrets.yaml",
      "secrets.yml",
      "secrets.ini",
      "secrets.env",
      "secrets.txt",
      "SECRETS.JSON",
      "Secrets",
      "secrets.local.json",
      "deploy/secrets.prod.yaml",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
  });

  it("leaves code and documentation named secrets readable", () => {
    for (const p of [
      "src/secrets.ts",
      "secrets.test.ts",
      "src/secrets.py",
      "src/Secrets.tsx",
      "docs/secrets.md",
      "secrets-guide.md",
      "src/secretsmanager.ts",
      "src/secret.ts",
    ]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("blocks secrets with any extension that is not code or prose (fail closed)", () => {
    for (const p of [
      "secrets.conf",
      "secrets.cfg",
      "secrets.properties",
      "secrets.xml",
      "secrets.bak",
      "secrets.enc",
      "secrets.somethingnew",
      "secrets.csv",
      "secrets.lock",
      "secrets.svg",
      "secrets.",
      "dir/Secrets.BAK",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
  });

  it("treats sql as data (often a dump), while hand-written markup stays exempt", () => {
    // Exemption line: extensions whose purpose is human-authored source or
    // prose. A .sql file is frequently a generated dump, so secrets.sql is
    // refused; ordinary SQL elsewhere in a project stays readable.
    expect(isBlockedPath("secrets.sql")).toBe(true);
    expect(isBlockedPath("db/Secrets.SQL")).toBe(true);
    for (const p of ["migrations/001_init.sql", "schema.sql", "secrets.html", "secrets.css"]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
    expect(isReadableExtension("migrations/001_init.sql")).toBe(true);
    expect(CODING_CODE_EXTENSIONS).not.toContain("sql");
    expect(CODING_READ_EXTENSIONS).toContain("sql");
  });

  it("applies the code/prose exemption to the file name only, never to a directory", () => {
    // secrets.ts/ is not source code, it is a folder named like one.
    for (const p of [
      "secrets.d/api.json",
      "secrets.prod/token.yaml",
      "secrets.ts/api.json",
      "secrets.md/key.txt",
      "src/secrets.ts/api.json",
      "secrets/api.json",
      "secrets.ts/",
      "secrets.ts\\",
      "secrets.ts/.",
      "src/secrets.ts/..",
      "secrets.ts/../x.ts",
    ]) {
      expect(isBlockedPath(p), p).toBe(true);
    }
    for (const p of ["src/secrets.ts", "docs/secrets.md", "secrets.test.ts", "src/secrets.py"]) {
      expect(isBlockedPath(p), p).toBe(false);
    }
  });

  it("derives the exemption from the code and prose lists, one source", () => {
    expect([...CODING_DOC_EXTENSIONS]).toEqual(["md", "mdx"]);
    for (const e of [...CODING_CODE_EXTENSIONS, ...CODING_DOC_EXTENSIONS]) {
      expect(CODING_READ_EXTENSIONS).toContain(e);
      expect(isBlockedPath(`secrets.${e}`), e).toBe(false);
    }
    // Data and config stay refused: not in either list.
    for (const e of ["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "csv", "tsv", "lock", "xml", "svg", "txt"]) {
      expect(CODING_CODE_EXTENSIONS).not.toContain(e);
      expect(CODING_DOC_EXTENSIONS).not.toContain(e);
      expect(isBlockedPath(`secrets.${e}`), e).toBe(true);
    }
  });
});

describe("coding path policy: read extensions", () => {
  it("allows common source, config and doc files", () => {
    for (const p of ["a.ts", "a.tsx", "x/y.py", "m.md", "c.json", "s.yml", "q.sql", "s.sh", "Dockerfile", "Makefile", ".gitignore"]) {
      expect(isReadableExtension(p), p).toBe(true);
    }
  });

  it("is case-insensitive and ignores trailing dots and spaces", () => {
    expect(isReadableExtension("A.TS")).toBe(true);
    expect(isReadableExtension("a.ts.")).toBe(true);
    expect(isReadableExtension("a.ts ")).toBe(true);
    expect(isReadableExtension("DOCKERFILE")).toBe(true);
  });

  it("refuses unknown, missing and binary extensions (fail closed)", () => {
    for (const p of ["a.exe", "a.png", "a.zip", "a.db", "a.pfx", "a.sqlite3", "noextension", "a.", ".npmrc", "id_ed25519", "a.ts.bak", "", ".env"]) {
      expect(isReadableExtension(p), JSON.stringify(p)).toBe(false);
    }
    for (const bad of [undefined, null, 1, {}]) {
      expect(isReadableExtension(bad as unknown as string)).toBe(false);
    }
  });

  it("does not read a bare dotfile name as an extension", () => {
    // ".ts" is a file called ".ts", not a TypeScript file with an empty name.
    for (const p of [".ts", ".md", ".json", "dir/.py"]) {
      expect(isReadableExtension(p), p).toBe(false);
    }
    expect(isReadableExtension("a.ts")).toBe(true);
  });

  it("judges by the last segment only", () => {
    expect(isReadableExtension("dir.ts/binary.exe")).toBe(false);
    expect(isReadableExtension("dir.exe/file.ts")).toBe(true);
  });

  it("keeps every listed extension lower-case, dotless and unique", () => {
    for (const e of CODING_READ_EXTENSIONS) {
      expect(e).toBe(e.toLowerCase());
      expect(e.startsWith(".")).toBe(false);
      expect(e.length).toBeGreaterThan(0);
    }
    expect(new Set(CODING_READ_EXTENSIONS).size).toBe(CODING_READ_EXTENSIONS.length);
  });

  it("never lists an extension the blocklist targets", () => {
    for (const e of ["pem", "key", "p12", "sqlite"]) {
      expect(CODING_READ_EXTENSIONS).not.toContain(e);
    }
  });
});

describe("coding path policy: binary sniff", () => {
  it("detects a null byte in the head as binary", () => {
    expect(isProbablyBinary(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(true);
    expect(isProbablyBinary(Buffer.from("export const a = 1", "utf8"))).toBe(false);
  });

  it("looks only at the first 8000 bytes", () => {
    const late = Buffer.alloc(9000, 0x61);
    late[8000] = 0;
    expect(isProbablyBinary(late)).toBe(false);
    const edge = Buffer.alloc(9000, 0x61);
    edge[7999] = 0;
    expect(isProbablyBinary(edge)).toBe(true);
  });

  it("treats an empty buffer as text and a non-buffer as binary", () => {
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false);
    expect(isProbablyBinary(undefined as unknown as Buffer)).toBe(true);
    expect(isProbablyBinary("text" as unknown as Buffer)).toBe(true);
  });
});
