import { SimpleStore } from "../utils/simple-store";
import { parseCodingMode, type CodingMode } from "../../shared/coding-types";
import { CODING_MODES_SCHEMA_VERSION } from "../file-access/store-migration";

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
const SCHEMA_VERSION_KEY = "schemaVersion";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createCodingModeStore(
  backing: KeyValueBacking,
): CodingModeStore {
  /**
   * The persisted map — but only out of a file that declares the schema
   * version. Anything else reads as empty, which means `off` everywhere.
   *
   * Before the directory-id fix the keys of this file were a 12-byte prefix of
   * the project path, so every project under one home directory shared a key: a
   * stored `propose-run` belonged to whichever of them was granted last, and
   * which one can no longer be established. The ruling is to discard those
   * modes and let the user grade again.
   *
   * The gate is HERE and not only in the migration that rewrites the file,
   * because a rewrite that could not land (a read-only userData, a full disk)
   * would otherwise leave the ambiguous keys in force — the fail-open
   * direction. A missing, low or non-numeric version is "not migrated", never
   * "unknown, carry on": the defect being guarded against IS an absent field.
   */
  const readModes = (): Record<string, unknown> => {
    const version = backing.get(SCHEMA_VERSION_KEY, 0);
    if (typeof version !== "number" || !(version >= CODING_MODES_SCHEMA_VERSION)) {
      return {};
    }
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
      // Read BEFORE the version is stamped: under an unversioned file readModes
      // answers {}, so the ambiguous old keys are dropped here rather than
      // merged forward into a file that would then be trusted. Re-parsed on
      // write too, so a mistyped caller can never persist a bad value.
      const next = { ...readModes(), [directoryId]: parseCodingMode(mode) };
      // Either write landing alone fails closed: modes without the marker read
      // as empty, and the marker without modes reads as empty as well.
      backing.set(SCHEMA_VERSION_KEY, CODING_MODES_SCHEMA_VERSION);
      backing.set(MODES_KEY, next);
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
