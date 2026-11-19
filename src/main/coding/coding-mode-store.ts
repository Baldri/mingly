import { SimpleStore } from "../utils/simple-store";
import { parseCodingMode, type CodingMode } from "../../shared/coding-types";

/** Per-directory coding mode. Unknown or unreadable means `off`. */
export interface CodingModeStore {
  getMode(directoryId: string): CodingMode;
  setMode(directoryId: string, mode: CodingMode): void;
  /**
   * Forget the stored mode of a directory, so the next reader sees `off`.
   *
   * Called when the grant goes away. The directory id is derived from the
   * path, so granting the same directory again produces the same id: a mode
   * that outlived its grant would come back with it, `propose-run` included,
   * without the user choosing a level again.
   */
  forgetMode(directoryId: string): void;
}

/** The get/set shape of SimpleStore, so tests can supply a plain double. */
export interface KeyValueBacking {
  get(key: string, defaultValue?: unknown): unknown;
  set(key: string, value: unknown): void;
}

const MODES_KEY = "modes";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createCodingModeStore(
  backing: KeyValueBacking,
): CodingModeStore {
  /** The persisted map, or an empty one when what is stored is not a map. */
  const readModes = (): Record<string, unknown> => {
    const stored = backing.get(MODES_KEY, {});
    return isPlainRecord(stored) ? stored : {};
  };

  return {
    getMode(directoryId: string): CodingMode {
      const modes = readModes();
      // A value on disk is an input, not a fact: it goes through the parser,
      // and only own keys count (a directory id must not reach the prototype).
      if (!Object.prototype.hasOwnProperty.call(modes, directoryId))
        return "off";
      return parseCodingMode(modes[directoryId]);
    },

    setMode(directoryId: string, mode: CodingMode): void {
      // Re-parse on write too, so a mistyped caller can never persist a bad value.
      backing.set(MODES_KEY, {
        ...readModes(),
        [directoryId]: parseCodingMode(mode),
      });
    },

    forgetMode(directoryId: string): void {
      const modes = readModes();
      // Own keys only, as in getMode: a directory id must not reach the
      // prototype, and `delete` on an inherited name would do nothing anyway.
      if (!Object.prototype.hasOwnProperty.call(modes, directoryId)) return;
      const next = { ...modes };
      delete next[directoryId];
      backing.set(MODES_KEY, next);
    },
  };
}

let instance: CodingModeStore | null = null;

export function getCodingModeStore(): CodingModeStore {
  if (!instance) {
    instance = createCodingModeStore(SimpleStore.create("coding-modes.json"));
  }
  return instance;
}
