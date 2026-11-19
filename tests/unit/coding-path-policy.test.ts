import { describe, it, expect } from "vitest";
import {
  CODING_BLOCKED_PATTERNS,
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
      "secrets.yaml",
      "secrets.yml",
      ".npmrc",
      ".netrc",
      "*.db",
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

  it("folds Unicode case variants that APFS treats as the same name", () => {
    // Measured on APFS: "a.Key" (Kelvin sign) opens a.key.
    expect(isBlockedPath("a.Key")).toBe(true);
    // NFD spelling of an umlaut name resolves to the NFC file.
    expect(isBlockedPath("ü.pem")).toBe(true);
    // Fullwidth full stop and letters normalise (NFKC) to .env.
    expect(isBlockedPath("．env")).toBe(true);
    expect(isBlockedPath("．ｅｎｖ")).toBe(true);
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
    expect(isBlockedPath(".git/../config.ts")).toBe(false);
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
    expect(isBlockedPath(".e​nv")).toBe(true);
    expect(isBlockedPath("a.p‍em")).toBe(true);
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
      "secrets.yaml", "secrets.yml", "deploy/SECRETS.YML",
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
      "src/secrets.ts", "secrets.yaml.md", "secrets.yamls.md",
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
