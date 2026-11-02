/**
 * Where audio may be transcribed.
 *
 * A transcription target is a registry candidate exactly like an LLM
 * provider: it carries a `ProviderOrigin`, so the policy core decides over it
 * with the vocabulary it already has and learns nothing new.
 *
 * The order is a preference. `resolveTarget` takes the first target the
 * policy permits, so the one where nothing leaves the device comes first.
 *
 * Residency is ours to declare (I2) and lives here, in code. A workspace
 * stores a protection LEVEL; it never stores, and can never change, where a
 * target runs.
 */

import type { RegistryEntry } from '../routing/provider-registry'

/**
 * Task fitness (code, creative, analysis, conversation) is an LLM notion and
 * none of it applies to transcription; the policy core does not read it
 * either. Zero rather than a guess, so an entry from this list can never win
 * a chat routing decision by accident.
 */
const NO_TASK_FITNESS = { code: 0, creative: 0, analysis: 0, conversation: 0 } as const

export const TRANSCRIPTION_TARGETS: RegistryEntry[] = [
  {
    config: {
      id: 'local',
      name: 'Local transcription (on-device)',
      type: 'custom',
      apiKeyRequired: false,
      supportsStreaming: false,
      models: []
    },
    // Same origin the registry gives Ollama: inference on the user's own
    // machine, nothing leaves it, and so no agreement exists to be signed.
    origin: {
      residency: 'on-device',
      operator: 'on-device',
      weightsLicense: 'open',
      hostingMode: 'local',
      dpaStatus: 'not-applicable'
    },
    capabilities: { ...NO_TASK_FITNESS }
  },
  {
    config: {
      id: 'ch-endpoint',
      name: 'Swiss transcription endpoint (CH)',
      type: 'custom',
      apiKeyRequired: true,
      supportsStreaming: false,
      models: []
    },
    // DEBT: static slot - residency, operator and agreement are all unverified → replace with a real endpoint's verified origin before any code outside this file and its tests names 'ch-endpoint'
    //
    // Of those three, `residency` is the one that acts: the policy core decides
    // on it (`evaluate` over these targets), so an unverified `'CH'` is not a
    // label but the claim the whole residency promise rests on. The marker used
    // to name only operator and agreement, which read as if the country were
    // the settled part.
    //
    // `dpaStatus: 'none'` is the cautious reading, not a finding: whether a
    // Swiss endpoint offers Whisper at all, and under which agreement, is
    // still open (spec section 11). A rule that later requires a signed
    // agreement therefore excludes this slot until someone has checked.
    // `weightsLicense` follows the model served here, Whisper (MIT).
    origin: {
      residency: 'CH',
      operator: 'Swiss endpoint (operator not yet determined)',
      weightsLicense: 'open',
      hostingMode: 'rented',
      dpaStatus: 'none'
    },
    capabilities: { ...NO_TASK_FITNESS }
  }
]
