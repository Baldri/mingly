/**
 * The consent channel for a finding inside the agent loop.
 *
 * The loop guard can end a step with a `consent` outcome: sensitive data in a
 * tool result that the upload-permission manager will not decide on its own.
 * Until now that killed the run, because the non-interactive guard path had
 * nobody to ask. This file is that somebody.
 *
 * Three separate pieces, deliberately not one:
 *   buildConsentRequest   what the user is shown — type and risk level, never a value
 *   ConsentBroker         the untrusted edge: an answer arriving over IPC
 *   resolveConsentChoice  what then happens to the content
 *
 * The broker's publisher is injected, so a test can answer without a renderer
 * and the Electron import stays lazy. Pure orchestration otherwise: the
 * anonymizer and the sensitive-data detector arrive as deps, which keeps the
 * privacy/NER module graph out of the agent executor's static graph.
 */
import { randomUUID } from "node:crypto";
import {
  parseCodingConsentChoice,
  type CodingConsentChoice,
  type CodingConsentRequest,
} from "../../shared/coding-types";
import type { SensitiveScan } from "../security/request-guard";
import type { ToolResultOrigin } from "../agent/loop-guard";
import type { PrivacyMode } from "../privacy/pii-types";
import { getGuardDeps } from "../security/request-guard-deps";
import { IPC_CHANNELS } from "../../shared/types";

/**
 * Sensitive-data types the PIIAnonymizer actually replaces.
 *
 * The finding comes from the SensitiveDataDetector, which also matches
 * credentials; the anonymizer replaces PII. An `API_KEY=` would survive
 * anonymisation unchanged, and the user would have clicked "send anonymised"
 * and shipped the key — so a type is listed here only when a PII category with
 * a real replacement corresponds to it:
 *   email        -> EMAIL
 *   phone        -> PHONE
 *   credit-card  -> CREDIT_CARD
 *   ip-address   -> IP_ADDRESS
 * Not listed, and why:
 *   api-key, password  no PII category at all
 *   file-path          no PII category at all
 *   ssn                the detector's pattern is the US form; the PII side
 *                      knows only the Swiss AHV number
 *   url                no built-in detector pattern produces it, so it can only
 *                      arrive from a user-defined pattern whose content is
 *                      unknown
 *   custom             unknown by definition
 * This list decides what is OFFERED. It is not the safety net: that is the
 * re-scan in resolveConsentChoice, which has the last word.
 */
export const ANONYMIZABLE_SENSITIVE_TYPES: readonly string[] = [
  "email",
  "phone",
  "credit-card",
  "ip-address",
];

/** Who withheld the content. Decides what the notice may truthfully say. */
export type ConsentDecidedBy = "user" | "system";

/**
 * The notice that replaces withheld content, for the agent to read.
 *
 * It names who withheld, because it travels on in the conversation the provider
 * sees: "by user" on a question nobody answered would be a false statement. It
 * carries no value derived from the content — only tool, path and a fixed reason.
 */
function withheldNotice(
  origin: ToolResultOrigin,
  decidedBy: ConsentDecidedBy,
  reason?: string,
): string {
  const where = origin.filePath
    ? `${origin.toolName} ${origin.filePath}`
    : origin.toolName;
  const who = decidedBy === "user" ? "by user" : "by the system";
  return reason
    ? `[Content withheld ${who}: ${where} (${reason})]`
    : `[Content withheld ${who}: ${where}]`;
}

/** May every finding in this scan be anonymized away? */
export function isFullyAnonymizable(scan: SensitiveScan): boolean {
  return (
    scan.matches.length > 0 &&
    scan.matches.every((m) => ANONYMIZABLE_SENSITIVE_TYPES.includes(m.type))
  );
}

/**
 * Build the question for one flagged tool result.
 *
 * `matches` is rebuilt field by field rather than spread: a spread would carry
 * `value` (and `fullValue`, on the concrete detector's shape) along with it,
 * and that is the one thing this object must never contain.
 */
export function buildConsentRequest(args: {
  runId: string;
  stepNumber: number;
  origin: ToolResultOrigin;
  scan: SensitiveScan;
}): CodingConsentRequest {
  const offers: CodingConsentChoice[] = isFullyAnonymizable(args.scan)
    ? ["send", "anonymize", "drop-file"]
    : ["send", "drop-file"];

  return {
    requestId: randomUUID(),
    runId: args.runId,
    stepNumber: args.stepNumber,
    toolName: args.origin.toolName,
    ...(args.origin.filePath === undefined
      ? {}
      : { filePath: args.origin.filePath }),
    matches: args.scan.matches.map((m) => ({
      type: m.type,
      riskLevel: m.riskLevel,
    })),
    offers,
  };
}

// ── Applying the answer ─────────────────────────────────────

/** What became of the flagged result. */
export type ConsentEffect = "sent" | "anonymized" | "withheld";

export interface ConsentResolution {
  effect: ConsentEffect;
  /** The content this result contributes to the conversation from here on. */
  content: string;
}

export interface ConsentResolutionDeps {
  /** `sessionId` is the runId — the anonymizer's replacements stay consistent
   *  within one run without leaking across runs. */
  anonymize(sessionId: string, text: string): Promise<string>;
  /** The second scan. The first decision is never trusted. */
  scanSensitive(text: string): SensitiveScan;
}

/**
 * Turn a choice into the content that travels.
 *
 * `anonymize` is re-scanned afterwards: the anonymizer is a PII tool, and a
 * finding it does not know stays in the text. If the second scan still finds
 * something, the choice fails closed and is treated as `drop-file` with a
 * notice to the agent. Anything unexpected ends up there too — an unknown
 * choice is not a reason to send.
 */
export async function resolveConsentChoice(
  args: {
    choice: CodingConsentChoice;
    runId: string;
    origin: ToolResultOrigin;
    content: string;
    /**
     * Who made the choice. `system` when the question settled itself (timeout,
     * aborted run, undeliverable request): the notice must not say a user
     * withheld what nobody decided.
     */
    decidedBy: ConsentDecidedBy;
  },
  deps: ConsentResolutionDeps = defaultResolutionDeps(),
): Promise<ConsentResolution> {
  switch (args.choice) {
    case "send":
      return { effect: "sent", content: args.content };

    case "anonymize": {
      let anonymized: string;
      try {
        anonymized = await deps.anonymize(args.runId, args.content);
      } catch (error) {
        // A failed anonymisation is not an approval to send the original.
        //
        // The message is logged, not put in the notice: the notice travels to
        // the provider, and an error from a text-processing pipeline can quote
        // the text it choked on — which is the content being withheld.
        console.warn(
          `[Consent] anonymisation failed for run ${args.runId}:`,
          (error as Error).message,
        );
        return {
          effect: "withheld",
          content: withheldNotice(args.origin, "system", "anonymisation failed"),
        };
      }

      if (deps.scanSensitive(anonymized).hasSensitiveData) {
        return {
          effect: "withheld",
          content: withheldNotice(
            args.origin,
            "system",
            "anonymisation still left sensitive data",
          ),
        };
      }
      return { effect: "anonymized", content: anonymized };
    }

    case "drop-file":
    default:
      return { effect: "withheld", content: withheldNotice(args.origin, args.decidedBy) };
  }
}

/**
 * The mode this path anonymizes with, fixed on purpose.
 *
 * The conversation's configured mode IS reachable from here — the privacy IPC
 * handlers export their per-session anonymizers, keyed by the conversation id
 * the loop guard carries — and is deliberately not used. A button labelled
 * "send anonymised" must not be weakened by a display preference: under
 * `transparent` the anonymizer returns the text unchanged, so the button would
 * send the original and lie about it.
 *
 * `vault` rather than `shield`, for two reasons:
 *   - This content travels one way to the provider and is never rehydrated,
 *     so shield's reversible fake values buy nothing here, while `[CATEGORY]`
 *     is unambiguous about what was removed.
 *   - `shield` carries a carve-out: MEDICAL entities are detected and left in
 *     place. No detector labels anything MEDICAL today, so the carve-out is
 *     unreachable — but the category and its UI label exist, and a future
 *     medical detector would silently open it on this very path. `vault`
 *     replaces every category without exception.
 */
export const CONSENT_ANONYMIZATION_MODE: PrivacyMode = "vault";

/**
 * The real anonymizer and detector, loaded on demand.
 *
 * `await import` on purpose: a static import would pull the PII pipeline (and
 * its NER worker) into the module graph of everything that reaches the agent
 * executor, for a path most runs never take.
 */
export function defaultResolutionDeps(): ConsentResolutionDeps {
  const mode: PrivacyMode = CONSENT_ANONYMIZATION_MODE;
  return {
    anonymize: async (sessionId, text) => {
      const { PIIAnonymizer } = await import("../privacy/anonymizer");
      const result = await new PIIAnonymizer(sessionId, mode).anonymize(text);
      return result.anonymizedText;
    },
    // getGuardDeps is the same wiring the loop guard scanned with, so the
    // re-scan cannot be a laxer detector than the one that raised the alarm.
    scanSensitive: (text) => getGuardDeps().scanSensitive(text),
  };
}

// ── The untrusted edge ──────────────────────────────────────

/** A settled question: the choice, and who made it. */
export interface ConsentDecision {
  choice: CodingConsentChoice;
  decidedBy: ConsentDecidedBy;
}

export interface ConsentBroker {
  /**
   * Put the question and wait for the answer.
   *
   * Resolves with a choice from `req.offers`, or `drop-file`. It always
   * resolves: a cancelled run, an unparseable answer, a choice that was never
   * offered and a request that could not even be delivered all land on
   * `drop-file`. A promise that never settles would turn a cancelled run into
   * a leaked dialog, and the run timeout is suspended while one is open.
   */
  ask(req: CodingConsentRequest): Promise<CodingConsentChoice>;
  /** Like `ask`, and says whether a person or the system settled it. */
  askWithSource(req: CodingConsentRequest): Promise<ConsentDecision>;
  /**
   * Settle the pending request of `runId`, if `requestId` is the one open.
   * Returns false when there is no open question, or the id is missing,
   * malformed or belongs to another question: such an answer is refused, and
   * the open question stays open.
   */
  respond(runId: string, requestId: unknown, choice: unknown): boolean;
  /** Settle the pending request of `runId` to `drop-file` (run aborted). */
  cancel(runId: string): void;
}

/**
 * How long a question may stay open before it settles itself.
 *
 * The run timeout is suspended while a dialog is open, so an unanswered
 * question would hang the run with no deadline at all. The reachable case is
 * not a slow reader: it is a renderer with no consent listener, where
 * `publish` succeeds, the IPC goes out and nobody ever replies.
 *
 * Expiry settles to `drop-file`, it does not abort the run. Killing the run
 * would teach the user to click without reading, which is the opposite of what
 * asking is for; withholding the one unanswered file is the conservative
 * option and lets the run carry on.
 */
export const DEFAULT_CONSENT_ANSWER_TIMEOUT_MS = 300_000;

export interface ConsentBrokerDeps {
  /**
   * Hand the request to whoever can answer it. A thrown error or a rejected
   * promise means nobody received it, and the request then fails closed.
   */
  publish(req: CodingConsentRequest): void | Promise<void>;
  /** Upper bound per question. Defaults to DEFAULT_CONSENT_ANSWER_TIMEOUT_MS. */
  answerTimeoutMs?: number;
}

interface PendingRequest {
  /** The only id an incoming answer may carry. */
  requestId: string;
  /** The offers actually made — what an incoming answer is validated against. */
  offers: readonly CodingConsentChoice[];
  settle: (decision: ConsentDecision) => void;
  /** Cleared on settle, so an answered question leaves no live deadline. */
  timer?: ReturnType<typeof setTimeout>;
}

export function createConsentBroker(deps: ConsentBrokerDeps): ConsentBroker {
  const pending = new Map<string, PendingRequest>();

  /**
   * Settle and forget in one step, so no entry can be answered twice.
   *
   * `expected` pins the settle to ONE entry: a publish that fails late must not
   * close a question that has meanwhile been replaced by a newer one.
   */
  const settle = (
    runId: string,
    choice: CodingConsentChoice,
    decidedBy: ConsentDecidedBy,
    expected?: PendingRequest,
  ): boolean => {
    const entry = pending.get(runId);
    if (!entry) return false;
    if (expected && entry !== expected) return false;
    pending.delete(runId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.settle({ choice, decidedBy });
    return true;
  };

  return {
    askWithSource(req: CodingConsentRequest): Promise<ConsentDecision> {
      // The loop asks one question per run at a time. If an older entry is
      // still there, it belongs to a question nobody is going to answer any
      // more: settle it closed rather than leave a promise hanging.
      settle(req.runId, "drop-file", "system");

      return new Promise<ConsentDecision>((resolve) => {
        const entry: PendingRequest = {
          requestId: req.requestId,
          offers: req.offers,
          settle: resolve,
        };
        pending.set(req.runId, entry);

        // Armed BEFORE publishing: a publish that fails synchronously settles
        // the entry at once, and settle is what clears the deadline. The
        // settle is pinned to THIS entry, so an expiry can never close a
        // question that has meanwhile been replaced by a newer one.
        entry.timer = setTimeout(() => {
          console.warn(
            `[Consent] no answer for run ${req.runId}, withholding the file`,
          );
          settle(req.runId, "drop-file", "system", entry);
        }, deps.answerTimeoutMs ?? DEFAULT_CONSENT_ANSWER_TIMEOUT_MS);

        const failClosed = (error: Error): void => {
          console.warn(
            `[Consent] could not publish the request for run ${req.runId}:`,
            error.message,
          );
          settle(req.runId, "drop-file", "system", entry);
        };

        try {
          void Promise.resolve(deps.publish(req)).catch(failClosed);
        } catch (error) {
          failClosed(error as Error);
        }
      });
    },

    ask(req: CodingConsentRequest): Promise<CodingConsentChoice> {
      return this.askWithSource(req).then((d) => d.choice);
    },

    respond(runId: string, requestId: unknown, choice: unknown): boolean {
      const entry = pending.get(runId);
      // An answer for a run with no open question is ignored, not applied to
      // whatever else may be pending.
      if (!entry) return false;
      // The answer must quote the identity of the question that is open NOW.
      // A missing, malformed or stale id is refused and the question stays
      // open: a late answer for file A must never decide file B.
      if (typeof requestId !== "string" || requestId !== entry.requestId) {
        return false;
      }

      const parsed = parseCodingConsentChoice(choice);
      // The renderer is an input. A choice that was never offered for THIS
      // request is refused, however well-formed it is — the offers list is the
      // rule, not the choice's name. That refusal is the system's decision.
      return entry.offers.includes(parsed)
        ? settle(runId, parsed, "user")
        : settle(runId, "drop-file", "system");
    },

    cancel(runId: string): void {
      settle(runId, "drop-file", "system");
    },
  };
}

/**
 * Publish to the focused window.
 *
 * Electron is imported lazily for the same reason the anonymizer is: this
 * module is reachable from the agent executor, which unit tests load without an
 * Electron runtime.
 */
async function publishToWindow(req: CodingConsentRequest): Promise<void> {
  const { BrowserWindow } = await import("electron");
  const win = BrowserWindow.getAllWindows()[0];
  // No window means no answer is coming. Rejecting lets `ask` fail the request
  // closed instead of leaving the run waiting — its timeout is suspended.
  if (!win || win.isDestroyed()) throw new Error("no window to ask");
  win.webContents.send(IPC_CHANNELS.CODING_CONSENT_REQUEST, req);
}

let instance: ConsentBroker | null = null;

export function getConsentBroker(): ConsentBroker {
  if (!instance) {
    instance = createConsentBroker({ publish: publishToWindow });
  }
  return instance;
}
