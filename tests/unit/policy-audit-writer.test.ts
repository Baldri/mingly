import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

import { logRoutingDecision } from '../../src/main/policy/audit-writer'
import { dbRun } from '../../src/main/database/index'

describe('logRoutingDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a routing.decision row', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'critical',
      reason: 'AHV (swiss) at critical',
      bySource: { regex: 1, swiss: 2, ner: 0, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: 'sensitive-stays-ch',
      allowedProviders: ['infomaniak'],
      chosenProvider: 'infomaniak',
      residency: 'CH',
      model: 'apertus'
    })

    expect(dbRun).toHaveBeenCalledOnce()
    const [sql] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sql).toContain('INSERT INTO activity_log')
  })

  it('records hit counts per detector source (I3)', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'high',
      reason: 'PERSON (ner) at high',
      bySource: { regex: 0, swiss: 1, ner: 3, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: 'sensitive-stays-ch',
      allowedProviders: ['infomaniak'],
      chosenProvider: 'infomaniak',
      residency: 'CH',
      model: 'apertus'
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    const details = JSON.parse(params[6] as string)
    expect(details.bySource).toEqual({ regex: 0, swiss: 1, ner: 3, custom: 0 })
  })

  it('never writes prompt or response text', () => {
    logRoutingDecision({
      actorId: 'local',
      conversationId: 'conv_1',
      level: 'low',
      reason: 'workspace class low',
      bySource: { regex: 0, swiss: 0, ner: 0, custom: 0 },
      policyVersion: '2026-08-26.1',
      appliedRule: null,
      allowedProviders: ['anthropic'],
      chosenProvider: 'anthropic',
      residency: 'US',
      model: 'claude-sonnet-4-6'
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    const serialised = JSON.stringify(params)
    expect(serialised).not.toContain('content')
    expect(serialised).not.toContain('prompt')
  })
})
