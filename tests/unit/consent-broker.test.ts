/**
 * The consent channel for a finding inside the agent loop.
 *
 * Three things are under test and they are deliberately separate functions:
 *   buildConsentRequest  — what the user is shown (and what must NOT be in it)
 *   createConsentBroker  — the untrusted edge: an answer arriving over IPC
 *   resolveConsentChoice — what actually happens to the content afterwards
 *
 * The broker is built with an injected publisher, so every case here runs
 * without Electron and without a renderer.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildConsentRequest,
  createConsentBroker,
  defaultResolutionDeps,
  resolveConsentChoice,
  type ConsentResolutionDeps,
} from '../../src/main/coding/consent-broker'
import type { SensitiveScan } from '../../src/main/security/request-guard'
import type { CodingConsentRequest } from '../../src/shared/coding-types'

// The value a dialog must never carry. Every assertion about leakage below
// looks for this exact string.
const SECRET = 'sk-live-abc123'
const CREDENTIAL = `API_KEY=${SECRET}`

const CREDENTIAL_SCAN: SensitiveScan = {
  hasSensitiveData: true,
  matches: [{ type: 'api-key', value: SECRET, riskLevel: 'critical' }],
  overallRiskLevel: 'critical',
}

const EMAIL_SCAN: SensitiveScan = {
  hasSensitiveData: true,
  matches: [{ type: 'email', value: 'an***@example.com', riskLevel: 'low' }],
  overallRiskLevel: 'low',
}

/** One anonymizable match and one that is not: the mixed case must fail closed. */
const MIXED_SCAN: SensitiveScan = {
  hasSensitiveData: true,
  matches: [
    { type: 'email', value: 'an***@example.com', riskLevel: 'low' },
    { type: 'api-key', value: SECRET, riskLevel: 'critical' },
  ],
  overallRiskLevel: 'critical',
}

const ORIGIN = { toolName: 'read_file', filePath: 'src/config.ts' }

function requestFor(scan: SensitiveScan): CodingConsentRequest {
  return buildConsentRequest({ runId: 'run-1', stepNumber: 2, origin: ORIGIN, scan })
}

/** Resolution deps that anonymize to a fixed text and re-scan with a double. */
function makeResolutionDeps(over: Partial<ConsentResolutionDeps> = {}): ConsentResolutionDeps {
  return {
    anonymize: async (_sessionId: string, text: string) => text,
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    ...over,
  }
}

// ── What the user is shown ──────────────────────────────────

describe('buildConsentRequest', () => {
  it('offers anonymize only when every match is anonymizable', () => {
    // A credential is found by the sensitive-data detector but is not PII the
    // anonymizer replaces: anonymizing would ship the key unchanged.
    expect(requestFor(CREDENTIAL_SCAN).offers).not.toContain('anonymize')
    // One un-anonymizable match among anonymizable ones is enough.
    expect(requestFor(MIXED_SCAN).offers).not.toContain('anonymize')
    // Positive control: an all-PII finding does get the offer, or the two
    // assertions above would hold for a function that never offers anything.
    expect(requestFor(EMAIL_SCAN).offers).toContain('anonymize')
  })

  it('always offers send and drop-file', () => {
    for (const scan of [CREDENTIAL_SCAN, EMAIL_SCAN, MIXED_SCAN]) {
      expect(requestFor(scan).offers).toContain('send')
      expect(requestFor(scan).offers).toContain('drop-file')
    }
  })

  it('never puts a match value into the request', () => {
    const req = requestFor(CREDENTIAL_SCAN)
    expect(JSON.stringify(req)).not.toContain(SECRET)
    expect(JSON.stringify(requestFor(MIXED_SCAN))).not.toContain(SECRET)
  })

  it('carries type and risk level for every match', () => {
    // The control for the test above: a request that simply dropped `matches`
    // would also contain no value, and the dialog would have nothing to show.
    const req = requestFor(MIXED_SCAN)
    expect(req.matches).toEqual([
      { type: 'email', riskLevel: 'low' },
      { type: 'api-key', riskLevel: 'critical' },
    ])
    expect(req.runId).toBe('run-1')
    expect(req.stepNumber).toBe(2)
    expect(req.toolName).toBe('read_file')
    expect(req.filePath).toBe('src/config.ts')
  })
})

// ── What happens to the content ─────────────────────────────

describe('resolveConsentChoice', () => {
  const base = { runId: 'run-1', origin: ORIGIN, content: CREDENTIAL, decidedBy: 'user' as const }

  it('send keeps the content as it is', async () => {
    const res = await resolveConsentChoice({ ...base, choice: 'send' }, makeResolutionDeps())
    expect(res.effect).toBe('sent')
    expect(res.content).toBe(CREDENTIAL)
  })

  it('drop-file replaces the content with a notice naming tool and file', async () => {
    const res = await resolveConsentChoice({ ...base, choice: 'drop-file' }, makeResolutionDeps())
    expect(res.effect).toBe('withheld')
    expect(res.content).toContain('Content withheld by user')
    expect(res.content).toContain('read_file')
    expect(res.content).toContain('src/config.ts')
    expect(res.content).not.toContain(SECRET)
  })

  it('says the system withheld the content when nobody answered', async () => {
    // A question that settles itself (timeout, aborted run, undeliverable
    // request) is withheld by the system. "by user" would be a false statement
    // that travels on to the provider.
    const res = await resolveConsentChoice(
      { ...base, choice: 'drop-file', decidedBy: 'system' },
      makeResolutionDeps(),
    )
    expect(res.effect).toBe('withheld')
    expect(res.content).not.toContain('by user')
    expect(res.content).toContain('by the system')
    expect(res.content).toContain('read_file')
    expect(res.content).toContain('src/config.ts')
    expect(res.content).not.toContain(SECRET)
  })

  it('says the system withheld the content when anonymising failed', async () => {
    // The user chose "anonymize"; withholding is then the system's decision.
    const deps = makeResolutionDeps({
      anonymize: async () => {
        throw new Error('NER model missing')
      },
    })
    const res = await resolveConsentChoice({ ...base, choice: 'anonymize' }, deps)
    expect(res.content).not.toContain('by user')
    expect(res.content).toContain('by the system')
  })

  it('falls back to drop-file when a re-scan still finds the match after anonymizing', async () => {
    // The anonymizer leaves credentials untouched, so its output still carries
    // the key. The second scan is what notices; the first decision is never
    // trusted.
    const deps = makeResolutionDeps({
      anonymize: async () => `API_KEY=${SECRET} for Thomas Mueller`,
      scanSensitive: (text: string) =>
        text.includes('sk-live')
          ? CREDENTIAL_SCAN
          : { hasSensitiveData: false, matches: [], overallRiskLevel: 'none' },
    })

    const res = await resolveConsentChoice({ ...base, choice: 'anonymize' }, deps)

    expect(res.effect).toBe('withheld')
    expect(res.content).toContain('Content withheld by the system')
    expect(res.content).not.toContain(SECRET)
  })

  it('sends the anonymised text when the re-scan is clean', async () => {
    // Positive control for the case above: with a re-scan that finds nothing,
    // the anonymised text travels. Otherwise 'anonymize' could be hard-wired
    // to withhold and both tests would pass.
    const deps = makeResolutionDeps({
      anonymize: async () => 'owner: Thomas Mueller',
      scanSensitive: (text: string) =>
        text.includes('sk-live')
          ? CREDENTIAL_SCAN
          : { hasSensitiveData: false, matches: [], overallRiskLevel: 'none' },
    })

    const res = await resolveConsentChoice(
      { ...base, choice: 'anonymize', content: 'owner: Peter Real' },
      deps,
    )

    expect(res.effect).toBe('anonymized')
    expect(res.content).toBe('owner: Thomas Mueller')
  })

  it('uses the runId as the anonymizer session id', async () => {
    const anonymize = vi.fn(async (_sessionId: string, text: string) => text)
    await resolveConsentChoice(
      { ...base, choice: 'anonymize', content: 'owner: Peter Real' },
      makeResolutionDeps({ anonymize }),
    )
    expect(anonymize).toHaveBeenCalledWith('run-1', 'owner: Peter Real')
  })

  it('withholds when anonymizing throws', async () => {
    const deps = makeResolutionDeps({
      anonymize: async () => {
        throw new Error('NER model missing')
      },
    })

    const res = await resolveConsentChoice({ ...base, choice: 'anonymize' }, deps)

    expect(res.effect).toBe('withheld')
    expect(res.content).not.toContain(SECRET)
  })
})

// ── The untrusted edge ─────────────────────────────────────

describe('createConsentBroker', () => {
  it('publishes the request and resolves with the answer', async () => {
    const published: CodingConsentRequest[] = []
    const broker = createConsentBroker({ publish: (req) => published.push(req) })
    const req = requestFor(EMAIL_SCAN)

    const pending = broker.ask(req)
    expect(published).toEqual([req])
    expect(broker.respond('run-1', req.requestId, 'anonymize')).toBe(true)

    await expect(pending).resolves.toBe('anonymize')
  })

  it('refuses a choice the request never offered', async () => {
    // A credential finding offers send and drop-file only. A renderer that
    // answers 'anonymize' anyway must not get it.
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(CREDENTIAL_SCAN)
    const pending = broker.ask(req)

    broker.respond('run-1', req.requestId, 'anonymize')

    await expect(pending).resolves.toBe('drop-file')
  })

  it('refuses send when send was not offered', async () => {
    // Nothing in Phase 1 builds such a request, but the rule is the offers
    // list, not the choice's name: validating against the request is what
    // keeps a later narrower offer set honest.
    const broker = createConsentBroker({ publish: () => undefined })
    const req: CodingConsentRequest = { ...requestFor(CREDENTIAL_SCAN), offers: ['drop-file'] }
    const pending = broker.ask(req)

    broker.respond('run-1', req.requestId, 'send')

    await expect(pending).resolves.toBe('drop-file')
  })

  it('treats an unparseable answer as drop-file', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(EMAIL_SCAN)
    const pending = broker.ask(req)

    broker.respond('run-1', req.requestId, { choice: 'send' })

    await expect(pending).resolves.toBe('drop-file')
  })

  it('ignores an answer for a runId with no pending request', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(EMAIL_SCAN)
    const pending = broker.ask(req)

    expect(broker.respond('run-other', req.requestId, 'send')).toBe(false)
    // The real request is untouched and still answerable.
    expect(broker.respond('run-1', req.requestId, 'send')).toBe(true)
    await expect(pending).resolves.toBe('send')
  })

  it('resolves a pending request to drop-file when the run is cancelled', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(EMAIL_SCAN)
    const pending = broker.ask(req)

    broker.cancel('run-1')

    await expect(pending).resolves.toBe('drop-file')
    // The entry is gone: a late answer finds nothing to settle.
    expect(broker.respond('run-1', req.requestId, 'send')).toBe(false)
  })

  it('leaves no pending request behind when a run asks twice', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const firstReq = requestFor(EMAIL_SCAN)
    const secondReq = requestFor(EMAIL_SCAN)
    const first = broker.ask(firstReq)
    const second = broker.ask(secondReq)

    await expect(first).resolves.toBe('drop-file')

    expect(broker.respond('run-1', secondReq.requestId, 'send')).toBe(true)
    await expect(second).resolves.toBe('send')
  })

  it('resolves to drop-file when the request cannot be published', async () => {
    // Nobody can answer a request that never arrived, and the run timeout is
    // suspended while one is open — so a silent hang is the failure mode this
    // prevents.
    const broker = createConsentBroker({
      publish: () => {
        throw new Error('no window')
      },
    })

    await expect(broker.ask(requestFor(EMAIL_SCAN))).resolves.toBe('drop-file')
  })

  it('settles an unanswered request to drop-file once the answer timeout passes', async () => {
    // The run timeout is SUSPENDED while a dialog is open, so an unanswered
    // dialog hangs the run forever. A renderer with no consent listener is the
    // reachable case: publish() succeeds, the IPC goes out, nobody replies.
    // Not answering must withhold the one file, not kill the run.
    vi.useFakeTimers()
    try {
      const broker = createConsentBroker({
        publish: () => undefined,
        answerTimeoutMs: 60_000,
      })
      const req = requestFor(EMAIL_SCAN)
    const pending = broker.ask(req)

      vi.advanceTimersByTime(60_000)

      await expect(pending).resolves.toBe('drop-file')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an answered question expire into the next one', async () => {
    // The deadline of a question that was already answered must not settle a
    // LATER question for the same run.
    vi.useFakeTimers()
    try {
      const broker = createConsentBroker({
        publish: () => undefined,
        answerTimeoutMs: 60_000,
      })
      const firstReq = requestFor(EMAIL_SCAN)
      const first = broker.ask(firstReq)
      expect(broker.respond('run-1', firstReq.requestId, 'send')).toBe(true)
      await expect(first).resolves.toBe('send')

      vi.advanceTimersByTime(30_000)
      const secondReq = requestFor(EMAIL_SCAN)
      const second = broker.ask(secondReq)
      // Past the FIRST question's deadline, while the second one is open.
      vi.advanceTimersByTime(30_001)

      expect(broker.respond('run-1', secondReq.requestId, 'anonymize')).toBe(true)
      await expect(second).resolves.toBe('anonymize')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createConsentBroker - an answer belongs to ONE question', () => {
  it('gives every request its own id, generated in the main process', () => {
    const a = requestFor(EMAIL_SCAN)
    const b = requestFor(EMAIL_SCAN)
    expect(typeof a.requestId).toBe('string')
    expect(a.requestId.length).toBeGreaterThan(0)
    expect(a.requestId).not.toBe(b.requestId)
  })

  it('refuses a late answer to question A while question B is open', async () => {
    // The double click: the answer to file A arrives after B was asked. It must
    // not decide B, and B must stay open for its own answer.
    const broker = createConsentBroker({ publish: () => undefined })
    const reqA = requestFor(EMAIL_SCAN)
    const pendingA = broker.ask(reqA)
    expect(broker.respond('run-1', reqA.requestId, 'send')).toBe(true)
    await expect(pendingA).resolves.toBe('send')

    const reqB = requestFor(EMAIL_SCAN)
    const pendingB = broker.ask(reqB)

    expect(broker.respond('run-1', reqA.requestId, 'send')).toBe(false)

    expect(broker.respond('run-1', reqB.requestId, 'drop-file')).toBe(true)
    await expect(pendingB).resolves.toBe('drop-file')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not a string', 42],
    ['an object', { id: 'x' }],
    ['unknown', 'not-the-request-id'],
  ])('refuses an answer whose id is %s', async (_label, badId) => {
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(EMAIL_SCAN)
    const pending = broker.ask(req)

    expect(broker.respond('run-1', badId, 'send')).toBe(false)

    // Still open and answerable with the right id.
    expect(broker.respond('run-1', req.requestId, 'anonymize')).toBe(true)
    await expect(pending).resolves.toBe('anonymize')
  })
})

describe('createConsentBroker - who decided', () => {
  it('reports the user when the user answered', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(EMAIL_SCAN)
    const pending = broker.askWithSource(req)
    broker.respond('run-1', req.requestId, 'drop-file')
    await expect(pending).resolves.toEqual({ choice: 'drop-file', decidedBy: 'user' })
  })

  it('reports the system when the answer timeout expired', async () => {
    vi.useFakeTimers()
    try {
      const broker = createConsentBroker({ publish: () => undefined, answerTimeoutMs: 1000 })
      const pending = broker.askWithSource(requestFor(EMAIL_SCAN))
      vi.advanceTimersByTime(1000)
      await expect(pending).resolves.toEqual({ choice: 'drop-file', decidedBy: 'system' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the system when the run was cancelled', async () => {
    const broker = createConsentBroker({ publish: () => undefined })
    const pending = broker.askWithSource(requestFor(EMAIL_SCAN))
    broker.cancel('run-1')
    await expect(pending).resolves.toEqual({ choice: 'drop-file', decidedBy: 'system' })
  })

  it('reports the system when the request could not be published', async () => {
    const broker = createConsentBroker({
      publish: () => {
        throw new Error('no window')
      },
    })
    await expect(broker.askWithSource(requestFor(EMAIL_SCAN))).resolves.toEqual({
      choice: 'drop-file',
      decidedBy: 'system',
    })
  })

  it('reports the system when the answer was a choice that was never offered', async () => {
    // The refusal of an unoffered choice is the system overriding, not the user
    // withholding: the user asked for something we refuse.
    const broker = createConsentBroker({ publish: () => undefined })
    const req = requestFor(CREDENTIAL_SCAN)
    const pending = broker.askWithSource(req)
    broker.respond('run-1', req.requestId, 'anonymize')
    await expect(pending).resolves.toEqual({ choice: 'drop-file', decidedBy: 'system' })
  })
})

describe('the anonymisation mode of the consent path', () => {
  it('redacts rather than substituting plausible fake data', async () => {
    // `vault` replaces every entity with [CATEGORY] and has no carve-out.
    // `shield` would substitute a plausible fake address here, and keeps
    // MEDICAL entities unreplaced entirely - a carve-out no detector reaches
    // today, but one this path must not inherit if a detector ever does.
    // Regex detection covers EMAIL, so this runs without the NER model.
    const out = await defaultResolutionDeps().anonymize(
      'run-1',
      'write to anna.muster@example.com today',
    )

    expect(out).toContain('[EMAIL]')
    expect(out).not.toContain('anna.muster@example.com')
  })
})
