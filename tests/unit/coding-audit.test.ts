/**
 * Coding audit (Task 13): the trail a regulated customer hands to a compliance
 * officer. Two properties carry it: an entry can never hold file content, and
 * the CSV export is safe to open in a spreadsheet and bounded as a whole.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeRow {
  id: string
  createdAt: string
  actorType: string
  actorId: string
  action: string
  entityType: string
  entityId: string
  details: Record<string, unknown> | null
}

const store = vi.hoisted(() => ({ rows: [] as unknown[], queries: [] as unknown[] }))

vi.mock('../../src/main/audit/activity-logger', () => ({
  getActivityLogger: () => ({
    log(entry: Omit<FakeRow, 'id' | 'createdAt'>) {
      const n = store.rows.length
      store.rows.push({ ...entry, id: `id-${n}`, createdAt: new Date(Date.UTC(2026, 10, 18, 12, 0, n)).toISOString() })
    },
    query(filter: { entityType?: string; action?: string; since?: string; limit?: number }) {
      store.queries.push(filter)
      const rows = (store.rows as FakeRow[])
        .filter((r) => (filter.entityType ? r.entityType === filter.entityType : true))
        .filter((r) => (filter.action ? r.action === filter.action : true))
        .filter((r) => (filter.since ? r.createdAt >= filter.since : true))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return rows.slice(0, filter.limit ?? 100)
    }
  })
}))

import {
  logCodingChange,
  logCodingChangeRejected,
  logCodingGuardBlocked,
  logCodingRunUndone,
  exportCodingAudit,
  recordRunAuditContext,
  markGuardRedirected,
  markGuardBlocked,
  getRunAuditContext,
  resolveRunAuditContext,
  CODING_AUDIT_COLUMNS,
  CODING_EXPORT_MAX_BYTES,
  UNKNOWN,
  type CodingAuditDetails
} from '../../src/main/coding/coding-audit'
import { IPC_CHANNELS } from '../../src/shared/types'

const SECRET_LINE = 'const API_KEY = "sk-live-4242424242424242"'

function details(overrides: Partial<CodingAuditDetails> = {}): CodingAuditDetails {
  return {
    projectPath: '/Users/dev/project',
    filePath: 'src/a.ts',
    addedLines: 3,
    removedLines: 1,
    provider: 'anthropic',
    model: 'claude-opus-5',
    policyVersion: '2026-08-26.1',
    guardRedirected: false,
    guardBlocked: false,
    ...overrides
  }
}

function logged(): FakeRow[] {
  return store.rows as FakeRow[]
}

/** Minimal RFC 4180 parser: the test reads the CSV the way a spreadsheet does. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += c
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function col(name: string): number {
  const i = (CODING_AUDIT_COLUMNS as readonly string[]).indexOf(name)
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}

beforeEach(() => {
  store.rows.length = 0
  store.queries.length = 0
})

describe('logCodingChange', () => {
  it('writes one entry per applied change with provider, model and policy version', () => {
    logCodingChange('run1', details())
    expect(logged()).toHaveLength(1)
    expect(logged()[0]).toMatchObject({
      action: 'coding.change_applied',
      entityType: 'coding_run',
      entityId: 'run1',
      details: {
        projectPath: '/Users/dev/project',
        filePath: 'src/a.ts',
        addedLines: 3,
        removedLines: 1,
        provider: 'anthropic',
        model: 'claude-opus-5',
        policyVersion: '2026-08-26.1',
        guardRedirected: false,
        runContextKnown: false
      }
    })
  })

  it('does not store guardBlocked on a change entry: it could only mean "context lost", and says runContextKnown instead', () => {
    logCodingChange('run1', details({ guardBlocked: true, runContextKnown: true }))
    const entry = logged()[0].details as Record<string, unknown>
    expect('guardBlocked' in entry).toBe(false)
    expect(entry.runContextKnown).toBe(true)
  })

  it('never writes file content into the audit entry', () => {
    // A caller (or a later change) that hands over more than the entry type
    // allows must not be able to put it in the log: the entry is built from a
    // fixed list of fields, whatever the object carries.
    const hostile = {
      ...details(),
      content: SECRET_LINE,
      oldText: SECRET_LINE,
      newText: SECRET_LINE,
      diff: `+${SECRET_LINE}`,
      foundValue: 'sk-live-4242424242424242'
    } as unknown as CodingAuditDetails
    logCodingChange('run1', hostile)
    const serialised = JSON.stringify(logged())
    expect(serialised).not.toContain(SECRET_LINE)
    expect(serialised).not.toContain('sk-live-4242')
    expect(Object.keys(logged()[0].details ?? {}).sort()).toEqual(
      [
        'addedLines',
        'filePath',
        'guardRedirected',
        'model',
        'policyVersion',
        'projectPath',
        'provider',
        'removedLines',
        'runContextKnown'
      ].sort()
    )
  })

  it('does not let a value in a field typed for a name or a number carry text', () => {
    const hostile = details({
      provider: SECRET_LINE,
      model: `claude\n${SECRET_LINE}`,
      policyVersion: SECRET_LINE,
      addedLines: SECRET_LINE as unknown as number,
      removedLines: -4,
      guardRedirected: 'yes' as unknown as boolean
    })
    logCodingChange('run1', hostile)
    const entry = logged()[0].details as Record<string, unknown>
    expect(JSON.stringify(logged())).not.toContain('sk-live')
    // Fail closed: what cannot be vouched for says so, it is not guessed.
    expect(entry.provider).toBe(UNKNOWN)
    expect(entry.model).toBe(UNKNOWN)
    expect(entry.policyVersion).toBe(UNKNOWN)
    expect(entry.addedLines).toBe(0)
    expect(entry.removedLines).toBe(0)
    // A flag that is not a boolean takes the stricter side: assume the guard acted.
    expect(entry.guardRedirected).toBe(true)
  })

  it('records a path outside what the callers hold as unknown instead of free text', () => {
    for (const project of ['project', SECRET_LINE, '', '=cmd']) {
      store.rows.length = 0
      logCodingChange('run1', details({ projectPath: project }))
      expect((logged()[0].details as Record<string, string>).projectPath).toBe(UNKNOWN)
    }
    for (const file of ['/etc/passwd', '../outside.ts', '..', 'src//a.ts', 'src/../a.ts', '', '=HYPERLINK("http://x","y")']) {
      store.rows.length = 0
      logCodingChange('run1', details({ filePath: file }))
      expect((logged()[0].details as Record<string, string>).filePath).toBe(UNKNOWN)
    }
    store.rows.length = 0
    logCodingChange('run1', details({ filePath: 'src/-dash/a.ts', projectPath: '/abs/ok' }))
    expect(logged()[0].details).toMatchObject({ filePath: 'src/-dash/a.ts', projectPath: '/abs/ok' })
  })

  it('strips hidden and direction-changing characters from a stored path', () => {
    logCodingChange('run1', details({ filePath: 'src/\u202Eevil\u200B.ts' }))
    expect((logged()[0].details as Record<string, string>).filePath).toBe('src/ evil .ts')
  })

  it('bounds a path and says so in the entry', () => {
    logCodingChange('run1', details({ filePath: `src/${'d/'.repeat(2000)}a.ts` }))
    const file = (logged()[0].details as Record<string, string>).filePath
    expect(file.length).toBeLessThanOrEqual(1100)
    expect(file).toContain('[truncated]')
  })
})

describe('logCodingGuardBlocked and logCodingRunUndone', () => {
  it('records a blocked guard as its own action', () => {
    logCodingGuardBlocked('run1', {
      projectPath: '/Users/dev/project',
      provider: 'anthropic',
      model: 'claude-opus-5',
      policyVersion: '2026-08-26.1'
    })
    expect(logged()).toHaveLength(1)
    expect(logged()[0]).toMatchObject({
      action: 'coding.guard_blocked',
      entityType: 'coding_run',
      entityId: 'run1',
      details: { guardBlocked: true, provider: 'anthropic' }
    })
    // No reason text: the guard's reason can quote the content it blocked.
    expect(JSON.stringify(logged()[0].details)).not.toContain('reason')
  })

  it('records an undo with counts and reason codes, never file names it could not vouch for', () => {
    logCodingRunUndone('run1', {
      projectPath: '/Users/dev/project',
      restored: ['a.ts', 'b.ts'],
      skipped: [
        { path: 'c.ts', reason: 'changed-since-apply' },
        { path: 'd.ts', reason: 'changed-since-apply' },
        { path: 'e.ts', reason: 'write-failed' }
      ],
      interrupted: false
    })
    expect(logged()[0]).toMatchObject({
      action: 'coding.run_undone',
      entityId: 'run1',
      details: {
        projectPath: '/Users/dev/project',
        restoredCount: 2,
        skippedCount: 3,
        interrupted: false,
        skippedReasons: { 'changed-since-apply': 2, 'write-failed': 1 }
      }
    })
  })

  it('maps a reason it does not know to "unknown" instead of storing its text', () => {
    logCodingRunUndone('run1', {
      projectPath: '/p',
      restored: [],
      skipped: [{ path: 'x', reason: SECRET_LINE as unknown as 'write-failed' }],
      interrupted: true
    })
    expect(JSON.stringify(logged())).not.toContain('sk-live')
    expect((logged()[0].details as { skippedReasons: Record<string, number> }).skippedReasons).toEqual({ [UNKNOWN]: 1 })
  })
})

describe('run audit context', () => {
  it('holds provider and model for a run, and the guard flags move only towards true', () => {
    recordRunAuditContext('ctx-run', { provider: 'anthropic', model: 'claude-opus-5' })
    expect(getRunAuditContext('ctx-run')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      guardRedirected: false,
      guardBlocked: false
    })
    markGuardRedirected('ctx-run')
    markGuardBlocked('ctx-run')
    expect(getRunAuditContext('ctx-run')).toMatchObject({ guardRedirected: true, guardBlocked: true })
    // The first record of a run wins: a later call cannot rewrite which model acted.
    recordRunAuditContext('ctx-run', { provider: 'openai', model: 'other' })
    expect(getRunAuditContext('ctx-run')).toMatchObject({ provider: 'anthropic', guardRedirected: true })
  })

  it('resolves an unknown run fail-closed: unknown names, and the guard assumed to have acted', () => {
    expect(resolveRunAuditContext('never-recorded')).toEqual({
      provider: UNKNOWN,
      model: UNKNOWN,
      guardRedirected: true,
      guardBlocked: true,
      known: false
    })
    recordRunAuditContext('known-run', { provider: 'p', model: 'm' })
    expect(resolveRunAuditContext('known-run').known).toBe(true)
  })

  it('is bounded: the oldest run drops when the table is full', () => {
    for (let i = 0; i < 1100; i++) recordRunAuditContext(`bound-${i}`, { provider: 'p', model: 'm' })
    expect(getRunAuditContext('bound-0')).toBeUndefined()
    expect(getRunAuditContext('bound-1099')).toBeDefined()
  })
})

describe('exportCodingAudit', () => {
  it('exports the entries as CSV with a header row and stable columns', () => {
    logCodingChange('run1', details())
    logCodingChange('run1', details({ filePath: 'b.ts', addedLines: 7, removedLines: 0 }))
    const rows = parseCsv(exportCodingAudit({}))
    expect(rows[0]).toEqual([...CODING_AUDIT_COLUMNS])
    expect(CODING_AUDIT_COLUMNS).toEqual([
      'id',
      'createdAt',
      'action',
      'runId',
      'projectPath',
      'filePath',
      'addedLines',
      'removedLines',
      'provider',
      'model',
      'policyVersion',
      'guardRedirected',
      'guardBlocked',
      'runContextKnown',
      'restoredCount',
      'skippedCount',
      'interrupted',
      'skippedReasons',
      'note'
    ])
    expect(rows).toHaveLength(3)
    const data = rows.slice(1)
    expect(data.map((r) => r[col('filePath')]).sort()).toEqual(['b.ts', 'src/a.ts'])
    const a = data.find((r) => r[col('filePath')] === 'src/a.ts') as string[]
    expect(a[col('action')]).toBe('coding.change_applied')
    expect(a[col('runId')]).toBe('run1')
    expect(a[col('addedLines')]).toBe('3')
    expect(a[col('policyVersion')]).toBe('2026-08-26.1')
    expect(a[col('runContextKnown')]).toBe('false')
  })

  it('exports a refused proposal with the user-typed reason in the note column', () => {
    logCodingChangeRejected('run1', {
      filePath: 'src/a.ts',
      addedLines: 3,
      removedLines: 1,
      provider: 'anthropic',
      model: 'claude-opus-5',
      policyVersion: '2026-08-26.1',
      runContextKnown: true,
      reason: 'Falsche Datei angepasst'
    })
    const rows = parseCsv(exportCodingAudit({}))
    expect(rows).toHaveLength(2)
    const row = rows[1]
    expect(row[col('action')]).toBe('coding.change_rejected')
    expect(row[col('runId')]).toBe('run1')
    expect(row[col('filePath')]).toBe('src/a.ts')
    expect(row[col('addedLines')]).toBe('3')
    expect(row[col('note')]).toBe('Falsche Datei angepasst')
  })

  it('neutralises the reason like every other cell: formula, newline, quote, length', () => {
    const payload = '=HYPERLINK("http://evil.example","x")\nand a "quote"' + 'y'.repeat(2000)
    logCodingChangeRejected('run1', {
      filePath: 'src/a.ts',
      addedLines: 0,
      removedLines: 0,
      provider: 'anthropic',
      model: 'm',
      policyVersion: '1',
      reason: payload
    })
    const csv = exportCodingAudit({})
    const rows = parseCsv(csv)
    // One row, one line: the newline in the reason did not forge a record.
    expect(rows).toHaveLength(2)
    const note = rows[1][col('note')]
    expect(note.startsWith("'=")).toBe(true)
    expect(note).not.toContain('\n')
    expect(note.length).toBeLessThanOrEqual(600)
  })

  it('a rejected entry never carries file text, whatever the caller passes', () => {
    logCodingChangeRejected('run1', {
      filePath: 'src/a.ts',
      addedLines: 0,
      removedLines: 0,
      provider: 'anthropic',
      model: 'm',
      policyVersion: '1',
      ...({ oldText: SECRET_LINE, newText: SECRET_LINE, diff: SECRET_LINE } as never)
    })
    expect(JSON.stringify(logged())).not.toContain('sk-live')
    expect(exportCodingAudit({})).not.toContain('sk-live')
  })

  it('has only the header when nothing was logged, and only coding entries are exported', () => {
    logged()
    store.rows.push({ id: 'x', createdAt: '2026-11-18T00:00:00.000Z', actorType: 'user', actorId: 'l', action: 'message.send', entityType: 'conversation', entityId: 'c', details: null })
    const rows = parseCsv(exportCodingAudit({}))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual([...CODING_AUDIT_COLUMNS])
  })

  it('escapes a comma and a quote in a path', () => {
    logCodingChange('run1', details({ filePath: 'src/a,"b".ts' }))
    const csv = exportCodingAudit({})
    expect(csv).toContain('"src/a,""b"".ts"')
    expect(parseCsv(csv)[1][col('filePath')]).toBe('src/a,"b".ts')
    // Still one record with the right number of cells.
    expect(parseCsv(csv)[1]).toHaveLength(CODING_AUDIT_COLUMNS.length)
  })

  it('replaces a newline in a path by a space, so a row is one line', () => {
    logCodingChange('run1', details({ filePath: 'src/a\nb.ts' }))
    const rows = parseCsv(exportCodingAudit({}))
    expect(rows).toHaveLength(2)
    expect(rows[1][col('filePath')]).toBe('src/a b.ts')
  })

  it('strips a right-to-left override and zero-width characters from a row written by someone else', () => {
    store.rows.push({
      id: 'bidi', createdAt: '2026-11-18T00:00:00.000Z', actorType: 'user', actorId: 'l',
      action: 'coding.change_applied', entityType: 'coding_run', entityId: 'run1',
      details: { filePath: 'src/\u202Egpj.ts\u200B\u2066x', provider: 'a\u202Eb' }
    })
    const csv = exportCodingAudit({})
    expect(csv).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/)
    expect(parseCsv(csv)[1][col('filePath')]).toBe('src/ gpj.ts  x')
  })

  describe('formula injection: a spreadsheet must not execute a path', () => {
    const payloads: Array<[string, string]> = [
      ['equals', '=HYPERLINK("http://evil.example","x")'],
      ['plus', '+cmd|calc'],
      ['minus', '-2+3'],
      ['at', '@SUM(1+1)'],
      ['tab', '\t=1+1'],
      ['carriage return', '\r=1+1'],
      ['leading space', ' =1+1'],
      ['leading newline', '\n=1+1']
    ]
    for (const [name, payload] of payloads) {
      it(`neutralises a cell that starts with ${name}`, () => {
        // Raw rows: the writer refuses such a path, but the table may hold rows
        // from any writer, and the export is the last line before the spreadsheet.
        store.rows.length = 0
        store.rows.push({
          id: 'inj', createdAt: '2026-11-18T00:00:00.000Z', actorType: 'user', actorId: 'l',
          action: 'coding.change_applied', entityType: 'coding_run', entityId: 'run1',
          details: { filePath: payload, projectPath: payload }
        })
        const rows = parseCsv(exportCodingAudit({}))
        for (const cell of rows.slice(1)[0]) {
          // No cell may begin (after whitespace) with a formula trigger.
          expect(cell).not.toMatch(/^\s*[=+\-@]/)
        }
        // The text is kept, only marked as text: the audit loses nothing.
        expect(rows[1][col('filePath')]).toBe(`'${payload.replace(/[\t\r\n]/g, ' ')}`)
      })
    }

    it('the writer refuses such a path before it ever reaches the table', () => {
      logCodingChange('run1', details({ filePath: '=HYPERLINK("http://evil.example","x")' }))
      expect((logged()[0].details as Record<string, string>).filePath).toBe(UNKNOWN)
    })

    it('also neutralises the run id and an unknown action coming from the database', () => {
      store.rows.push({
        id: '=1+1',
        createdAt: '2026-11-18T00:00:00.000Z',
        actorType: 'user',
        actorId: 'l',
        action: 'coding.change_applied',
        entityType: 'coding_run',
        entityId: '@evil',
        details: { filePath: '=x', provider: '+p', model: '-m', policyVersion: '@v', addedLines: -5 }
      })
      const row = parseCsv(exportCodingAudit({}))[1]
      for (const cell of row) expect(cell).not.toMatch(/^\s*[=+\-@]/)
    })

    it('leaves an ordinary path unchanged', () => {
      logCodingChange('run1', details({ filePath: 'src/-dash/a=b.ts' }))
      expect(parseCsv(exportCodingAudit({}))[1][col('filePath')]).toBe('src/-dash/a=b.ts')
    })
  })

  describe('the whole is bounded, not just the rows', () => {
    it('stops at the byte limit, keeps the NEWEST entries, and says which are missing', () => {
      // 4 000 rows of long paths exceed the cap although the row count is fine.
      for (let i = 0; i < 4000; i++) logCodingChange('run1', details({ filePath: `src/${'x'.repeat(900)}-n${i}.ts` }))
      const csv = exportCodingAudit({ limit: 10000 })
      expect(Buffer.byteLength(csv, 'utf8')).toBeLessThanOrEqual(CODING_EXPORT_MAX_BYTES)
      const rows = parseCsv(csv)
      expect(rows[1][col('action')]).toBe('export.truncated')
      expect(rows[1][col('note')]).toMatch(/size limit/i)
      expect(rows[1][col('note')]).toMatch(/older entries[^.]*missing/i)
      const indexes = rows.slice(2).map((r) => Number(/-n(\d+)\.ts$/.exec(r[col('filePath')])?.[1]))
      expect(indexes.length).toBeGreaterThan(0)
      expect(indexes.length).toBeLessThan(4000)
      // The newest entry is in, the kept ones are one unbroken run ending at it, in order.
      expect(indexes[indexes.length - 1]).toBe(3999)
      expect(indexes).toEqual(indexes.map((_, k) => 3999 - indexes.length + 1 + k))
    })

    it('marks a cut by the row limit too', () => {
      for (let i = 0; i < 5; i++) logCodingChange('run1', details({ filePath: `f${i}.ts` }))
      const rows = parseCsv(exportCodingAudit({ limit: 3 }))
      expect(rows).toHaveLength(1 + 1 + 3)
      expect(rows[1][col('action')]).toBe('export.truncated')
      expect(rows[1][col('note')]).toMatch(/row limit/i)
      // The newest three, oldest first.
      expect(rows.slice(2).map((r) => r[col('filePath')])).toEqual(['f2.ts', 'f3.ts', 'f4.ts'])
    })

    it('does not mark an export that is complete', () => {
      for (let i = 0; i < 3; i++) logCodingChange('run1', details({ filePath: `f${i}.ts` }))
      const rows = parseCsv(exportCodingAudit({ limit: 3 }))
      expect(rows).toHaveLength(1 + 3)
      expect(rows.some((r) => r[col('action')] === 'export.truncated')).toBe(false)
    })

    it('bounds a single oversized cell that was written by someone else', () => {
      store.rows.push({
        id: 'big',
        createdAt: '2026-11-18T00:00:00.000Z',
        actorType: 'user',
        actorId: 'l',
        action: 'coding.change_applied',
        entityType: 'coding_run',
        entityId: 'run1',
        details: { filePath: 'p'.repeat(5_000_000), provider: 'a', model: 'b', policyVersion: 'c' }
      })
      const csv = exportCodingAudit({})
      expect(Buffer.byteLength(csv, 'utf8')).toBeLessThanOrEqual(CODING_EXPORT_MAX_BYTES)
      expect(parseCsv(csv)[1][col('filePath')]).toContain('[truncated]')
    })
  })

  describe('fails closed on its own input', () => {
    it('refuses a since that is not a date instead of widening the export', () => {
      expect(() => exportCodingAudit({ since: 'yesterday-ish' })).toThrow(/since/)
      expect(() => exportCodingAudit({ since: 5 as unknown as string })).toThrow(/since/)
    })

    it('refuses text that Date.parse would read as some date: only strict ISO 8601 is a since', () => {
      for (const bad of ['5', 'Dec 1', '2026-02-31', '2026-13-01', '2026-11-18 10:00', '11/18/2026', '2026', '', '2026-11-18T10:00']) {
        expect(() => exportCodingAudit({ since: bad })).toThrow(/since/)
      }
      store.queries.length = 0
      exportCodingAudit({ since: '2026-11-18' })
      exportCodingAudit({ since: '2026-11-18T10:00+01:00' })
      expect((store.queries[0] as { since: string }).since).toBe('2026-11-18T00:00:00.000Z')
      expect((store.queries[1] as { since: string }).since).toBe('2026-11-18T09:00:00.000Z')
    })

    it('passes a valid since to the query as an ISO string', () => {
      exportCodingAudit({ since: '2026-11-18T00:00:00.000Z' })
      expect(store.queries.every((q) => (q as { since?: string }).since === '2026-11-18T00:00:00.000Z')).toBe(true)
    })

    it('falls back to the default limit for a limit that is not a positive integer, and caps a huge one', () => {
      for (const bad of [Number.NaN, -1, 0, 1.5, Infinity, '5' as unknown as number]) {
        store.queries.length = 0
        exportCodingAudit({ limit: bad })
        expect((store.queries[0] as { limit: number }).limit).toBe(1001)
      }
      store.queries.length = 0
      exportCodingAudit({ limit: 10 ** 9 })
      expect((store.queries[0] as { limit: number }).limit).toBe(10001)
    })

    it('exports the entries of every coding action, in the order they happened', () => {
      logCodingChange('run1', details({ filePath: 'first.ts' }))
      logCodingGuardBlocked('run1', { projectPath: '/p', provider: 'a', model: 'b', policyVersion: 'c' })
      logCodingRunUndone('run1', { projectPath: '/p', restored: ['first.ts'], skipped: [], interrupted: false })
      const rows = parseCsv(exportCodingAudit({})).slice(1)
      expect(rows.map((r) => r[col('action')])).toEqual([
        'coding.change_applied',
        'coding.guard_blocked',
        'coding.run_undone'
      ])
    })
  })
})

describe('IPC channel', () => {
  it('names the export channel', () => {
    expect(IPC_CHANNELS.CODING_EXPORT_AUDIT).toBe('coding:export-audit')
  })
})
