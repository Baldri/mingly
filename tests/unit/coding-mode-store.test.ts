import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/main/utils/simple-store", () => ({
  SimpleStore: {
    create: () => ({
      get: (_k: string, d?: unknown) => d,
      set: () => undefined,
    }),
  },
}));

import {
  createCodingModeStore,
  getCodingModeStore,
} from "../../src/main/coding/coding-mode-store";
import { CODING_MODES_SCHEMA_VERSION } from "../../src/main/file-access/store-migration";

/**
 * Pinned as a LITERAL, not read from the module: the two sides of this gate —
 * the migration that stamps the file and the reader that requires the stamp —
 * must agree on one number, and a test that read it from either of them could
 * not notice them drifting apart.
 */
const VERSIONED = { schemaVersion: 2 };

/** Plain in-memory double with the get/set shape of SimpleStore. */
function memoryBacking(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    get: (key: string, defaultValue?: unknown) =>
      key in data ? data[key] : defaultValue,
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

describe("coding mode store", () => {
  it("an unknown directory is off", () => {
    expect(createCodingModeStore(memoryBacking()).getMode("dir-1")).toBe("off");
  });

  it("returns what setMode stored, per directory", () => {
    const store = createCodingModeStore(memoryBacking());
    store.setMode("dir-1", "propose");
    store.setMode("dir-2", "read-only");
    expect(store.getMode("dir-1")).toBe("propose");
    expect(store.getMode("dir-2")).toBe("read-only");
    expect(store.getMode("dir-3")).toBe("off");
  });

  it("persists through the backing store", () => {
    const backing = memoryBacking();
    createCodingModeStore(backing).setMode("dir-1", "propose-run");
    expect(createCodingModeStore(backing).getMode("dir-1")).toBe("propose-run");
  });

  it("the schema version the migration stamps is the one this store requires", () => {
    expect(CODING_MODES_SCHEMA_VERSION).toBe(VERSIONED.schemaVersion);
  });

  it("stored modes WITHOUT the schema marker are ignored: everything is off", () => {
    // The pre-migration file. Its keys were a 12-byte prefix of the project
    // path, so a stored `propose-run` belonged to whichever of the colliding
    // projects was granted last and which one cannot be established. The gate
    // lives here and not only in the migration, so a migration whose write
    // never landed cannot leave the old keys in force.
    const store = createCodingModeStore(
      memoryBacking({ modes: { a: "propose-run", b: "propose", c: "read-only" } }),
    );
    expect(store.getMode("a")).toBe("off");
    expect(store.getMode("b")).toBe("off");
    expect(store.getMode("c")).toBe("off");
  });

  it("a schema version below the required one is ignored too", () => {
    const store = createCodingModeStore(
      memoryBacking({ schemaVersion: 1, modes: { a: "propose-run" } }),
    );
    expect(store.getMode("a")).toBe("off");
  });

  it("a version that is not a number is ignored (fail closed)", () => {
    for (const bad of ["2", null, {}, true, NaN]) {
      const store = createCodingModeStore(
        memoryBacking({ schemaVersion: bad, modes: { a: "propose-run" } }),
      );
      expect(store.getMode("a")).toBe("off");
    }
  });

  it("setMode drops the old ambiguous keys instead of merging them forward", () => {
    // Even if the migration never deleted them: the first level the user
    // chooses upgrades the file, and what it writes holds only the new key.
    const backing = memoryBacking({ modes: { "L1VzZXJzL2hvbGdl": "propose-run" } });
    createCodingModeStore(backing).setMode("ae25e3b553a1bc27", "read-only");
    expect(backing.data.modes).toEqual({ "ae25e3b553a1bc27": "read-only" });
    expect(backing.data.schemaVersion).toBe(VERSIONED.schemaVersion);
    expect(createCodingModeStore(backing).getMode("L1VzZXJzL2hvbGdl")).toBe("off");
  });

  it("a value on disk is an input: unrecognised modes read as off", () => {
    const store = createCodingModeStore(
      memoryBacking({
        ...VERSIONED,
        modes: { a: "auto", b: "PROPOSE", c: 7, d: null, e: "propose" },
      }),
    );
    expect(store.getMode("a")).toBe("off");
    expect(store.getMode("b")).toBe("off");
    expect(store.getMode("c")).toBe("off");
    expect(store.getMode("d")).toBe("off");
    expect(store.getMode("e")).toBe("propose");
  });

  it("a malformed persisted container reads as off, never throws", () => {
    for (const bad of ["garbage", 5, null, ["propose"], true]) {
      const store = createCodingModeStore(memoryBacking({ ...VERSIONED, modes: bad }));
      expect(store.getMode("dir-1")).toBe("off");
    }
  });

  it("a directory id that names an inherited key is off", () => {
    const store = createCodingModeStore(memoryBacking({ ...VERSIONED, modes: {} }));
    expect(store.getMode("toString")).toBe("off");
    expect(store.getMode("__proto__")).toBe("off");
  });

  it("setMode over a malformed container replaces it instead of throwing", () => {
    const backing = memoryBacking({ ...VERSIONED, modes: "garbage" });
    const store = createCodingModeStore(backing);
    store.setMode("dir-1", "read-only");
    expect(store.getMode("dir-1")).toBe("read-only");
  });

  it("forgetMode clears one directory and persists the removal", () => {
    const backing = memoryBacking();
    const store = createCodingModeStore(backing);
    store.setMode("a", "propose-run");
    store.setMode("b", "read-only");

    store.forgetMode("a");

    expect(store.getMode("a")).toBe("off");
    expect(store.getMode("b")).toBe("read-only");
    // Gone from the backing store, not only from this instance's view.
    expect(createCodingModeStore(backing).getMode("a")).toBe("off");
    expect(createCodingModeStore(backing).getMode("b")).toBe("read-only");
  });

  it("forgetMode on an unknown, inherited or malformed entry does nothing", () => {
    const backing = memoryBacking({ ...VERSIONED, modes: "garbage" });
    const store = createCodingModeStore(backing);
    expect(() => store.forgetMode("nobody")).not.toThrow();
    expect(() => store.forgetMode("__proto__")).not.toThrow();
    expect(() => store.forgetMode("toString")).not.toThrow();
    expect(store.getMode("nobody")).toBe("off");
  });

  it("getCodingModeStore returns a singleton", () => {
    expect(getCodingModeStore()).toBe(getCodingModeStore());
  });
});
