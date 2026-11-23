import { describe, it, expect } from "vitest";
import {
  CODING_MODE_ORDER,
  parseCodingMode,
} from "../../src/shared/coding-types";
import { atLeast, SENSITIVITY_ORDER } from "../../src/main/policy/policy-types";

describe("coding mode vocabulary", () => {
  it("an unknown mode value falls to off", () => {
    for (const raw of [
      "auto",
      "AUTO",
      "Off",
      "",
      null,
      undefined,
      3,
      {},
      ["propose"],
    ]) {
      expect(parseCodingMode(raw)).toBe("off");
    }
  });

  it("inherited object keys do not parse as a mode", () => {
    for (const raw of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(parseCodingMode(raw)).toBe("off");
    }
  });

  it("the four known modes parse to themselves", () => {
    for (const m of ["off", "read-only", "propose", "propose-run"] as const) {
      expect(parseCodingMode(m)).toBe(m);
    }
  });

  it("has exactly four modes, ordered off < read-only < propose < propose-run", () => {
    expect(CODING_MODE_ORDER).toEqual({
      off: 0,
      "read-only": 1,
      propose: 2,
      "propose-run": 3,
    });
  });

  it("atLeast orders coding modes", () => {
    expect(atLeast(CODING_MODE_ORDER, "propose", "read-only")).toBe(true);
    expect(atLeast(CODING_MODE_ORDER, "read-only", "propose")).toBe(false);
  });

  it("atLeast still orders PII sensitivity", () => {
    expect(atLeast(SENSITIVITY_ORDER, "critical", "high")).toBe(true);
    expect(atLeast(SENSITIVITY_ORDER, "medium", "high")).toBe(false);
  });
});
