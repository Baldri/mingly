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

  it("a value on disk is an input: unrecognised modes read as off", () => {
    const store = createCodingModeStore(
      memoryBacking({
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
      const store = createCodingModeStore(memoryBacking({ modes: bad }));
      expect(store.getMode("dir-1")).toBe("off");
    }
  });

  it("a directory id that names an inherited key is off", () => {
    const store = createCodingModeStore(memoryBacking({ modes: {} }));
    expect(store.getMode("toString")).toBe("off");
    expect(store.getMode("__proto__")).toBe("off");
  });

  it("setMode over a malformed container replaces it instead of throwing", () => {
    const backing = memoryBacking({ modes: "garbage" });
    const store = createCodingModeStore(backing);
    store.setMode("dir-1", "read-only");
    expect(store.getMode("dir-1")).toBe("read-only");
  });

  it("getCodingModeStore returns a singleton", () => {
    expect(getCodingModeStore()).toBe(getCodingModeStore());
  });
});
