/**
 * What the coding UI shows. Pure functions, because the surfaces they feed are
 * approval surfaces: the human must not see something other than what is
 * written (R35 family), must be told the scope of a mode (R36), must be told
 * what undo did NOT restore, and must be able to see a granted write permission.
 */
import { describe, it, expect } from 'vitest'
import {
  displayText,
  diffLines,
  isCodingFeatureAllowed,
  describeUndo,
  getPermissionLabel,
  refusalText,
  CODING_ACCEPT_SCOPE_NOTICE,
  CODING_CONSENT_WAIT_NOTICE
} from '../../src/renderer/lib/coding-display'
import {
  CODING_CONSENT_ANSWER_TIMEOUT_MS,
  CODING_MODE_CHOICES,
  CODING_REFUSALS_MAY_HAVE_WRITTEN,
  CODING_REFUSAL_CODES
} from '../../src/shared/coding-types'

describe('approval surface text', () => {
  it('shows a right-to-left override in a path visibly instead of reordering it', () => {
    const shown = displayText('src/gnp.‮txt.ts')
    expect(shown).toBe('src/gnp.<U+202E>txt.ts')
    expect(shown).not.toContain('‮')
  })

  it('shows zero-width characters in a rejection reason', () => {
    expect(displayText('ok​')).toBe('ok<U+200B>')
  })

  it('diff lines never contain a raw bidi control, even if the main process let one through', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new‮')
    expect(lines.map((l) => l.text).join('\n')).not.toContain('‮')
    expect(lines.find((l) => l.kind === 'add')?.text).toBe('+new<U+202E>')
  })

  // Re-pinned against the requirement "only the header block is meta; after the
  // hunk header a line's kind follows its single prefix character". The earlier
  // test pinned the implementation (a prefix sniff on every line) and so encoded
  // the bug that a body line starting with `++` or `--` rendered as a header.
  it('classifies the header block as meta and the body by its single prefix character', () => {
    const kinds = diffLines('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new').map((l) => l.kind)
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'context', 'remove', 'add'])
  })

  it('renders an added line whose content starts with ++ as an addition, not a header', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n ctx\n+++ b/innocent.ts\n+++i')
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'context', 'add', 'add'])
  })

  it('renders a removed line whose content starts with -- as a removal, not neutral metadata', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -2,1 +1,0 @@\n--- DROP TABLE kunden\n-- comment')
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'remove', 'remove'])
  })

  it('never reads a body line as a hunk header or warning', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-@@ gone\n+!! new')
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'remove', 'add'])
  })

  it('without a hunk header, only a leading warning/--- /+++ block is meta (fail towards add/remove)', () => {
    const lines = diffLines('+++ looks like a header\n+added')
    // No hunk header was seen and no --- line opened a header block: nothing may hide as meta.
    expect(lines.map((l) => l.kind)).toEqual(['add', 'add'])
  })

  it('offers the coding picker only when agentic_mode is explicitly allowed', () => {
    expect(isCodingFeatureAllowed({ agentic_mode: { allowed: true } })).toBe(true)
    expect(isCodingFeatureAllowed({ agentic_mode: { allowed: false } })).toBe(false)
    expect(isCodingFeatureAllowed({})).toBe(false)
    expect(isCodingFeatureAllowed(undefined)).toBe(false)
    expect(isCodingFeatureAllowed({ agents: { allowed: true } })).toBe(false)
  })

  it('keeps a hidden-characters warning line from the main process as a meta line', () => {
    const lines = diffLines('!! This proposal adds invisible characters.\n--- a/x')
    expect(lines[0].kind).toBe('meta')
  })
})

describe('mode choices (R36 and fail-closed vocabulary)', () => {
  it('offers exactly off, read-only, propose, propose-run: never auto', () => {
    expect(CODING_MODE_CHOICES.map((c) => c.mode)).toEqual(['off', 'read-only', 'propose', 'propose-run'])
    expect(CODING_MODE_CHOICES.map((c) => c.mode as string)).not.toContain('auto')
  })

  it.each(CODING_MODE_CHOICES.filter((c) => c.mode !== 'off'))(
    '$mode says at the level itself that it concerns Minglys own tools, not MCP servers',
    (choice) => {
      const text = `${choice.label} ${choice.description} ${choice.scopeNote}`
      expect(text).toContain('Minglys eigene Werkzeuge')
      expect(text).toContain('MCP-Server')
    }
  )

  it('read-only never reads as risk-free', () => {
    const readOnly = CODING_MODE_CHOICES.find((c) => c.mode === 'read-only')
    const text = `${readOnly?.label} ${readOnly?.description} ${readOnly?.scopeNote}`
    expect(text).not.toMatch(/ohne (jedes )?risiko|risikolos|gefahrlos|völlig sicher|vollkommen sicher/i)
  })

  it('uses no Eszett in user-facing strings', () => {
    for (const c of CODING_MODE_CHOICES) {
      expect(`${c.label}${c.description}${c.scopeNote}`).not.toContain('ß')
    }
  })

  it('propose-run says that commands run project code which writes without a diff', () => {
    // This sentence is the only thing the user reads at the moment of
    // choosing, and it used to promise the opposite of the README of the same
    // branch: "Jede Änderung braucht weiterhin Ihre Annahme".
    const choice = CODING_MODE_CHOICES.find((c) => c.mode === 'propose-run')
    const text = `${choice?.label} ${choice?.description}`
    expect(text).not.toContain('Jede Änderung braucht')
    expect(text).not.toMatch(/braucht (weiterhin )?Ihre (Annahme|Zustimmung)/)
    expect(choice?.description).toMatch(/ohne Diff/)
    expect(choice?.description).toMatch(/Projektcode/)
    expect(choice?.description).toMatch(/Benutzerrechten/)
    expect(choice?.description).toMatch(/löschen|ändern/)
  })

  it('read-only promises only what exists: there is no search tool', () => {
    const choice = CODING_MODE_CHOICES.find((c) => c.mode === 'read-only')
    expect(choice?.description).not.toMatch(/such/i)
    expect(choice?.description).toMatch(/lesen/)
  })

  it('the accept notice says what «Annehmen» covers and what it does not', () => {
    expect(CODING_ACCEPT_SCOPE_NOTICE).toContain('Annehmen')
    // The old sentence ("es wird nichts geschrieben, was hier nicht steht")
    // was true of the accept and of nothing else.
    expect(CODING_ACCEPT_SCOPE_NOTICE).toMatch(/ohne Diff/)
    expect(CODING_ACCEPT_SCOPE_NOTICE).toMatch(/Vorschlagen und ausführen/)
    expect(CODING_ACCEPT_SCOPE_NOTICE).not.toContain('ß')
  })

  it('the consent notice names the deadline instead of claiming the run is paused', () => {
    // 300_000 ms is five minutes; the literal is the requirement, not a value
    // read back from the module under test.
    expect(CODING_CONSENT_ANSWER_TIMEOUT_MS).toBe(300_000)
    expect(CODING_CONSENT_WAIT_NOTICE).toContain('5 Minuten')
    expect(CODING_CONSENT_WAIT_NOTICE).toMatch(/ohne diese Datei weiter/)
    expect(CODING_CONSENT_WAIT_NOTICE).not.toMatch(/angehalten|pausiert/)
    expect(CODING_CONSENT_WAIT_NOTICE).not.toContain('ß')
  })
})

describe('refusalText: a German surface does not show English refusals', () => {
  it('maps every known code to a German sentence, with no Eszett', () => {
    for (const code of CODING_REFUSAL_CODES) {
      const text = refusalText(code)
      expect(text, code).toMatch(/[a-zäöü]/)
      expect(text, code).not.toContain('ß')
      // The English originals all contain one of these.
      expect(text, code).not.toMatch(/Nothing was|was withdrawn|A write failed/)
    }
  })

  it('every environment-dependent refusal keeps ONE shared text', () => {
    // The main process answers every file-system-dependent cause with `fs`.
    // Splitting it here would rebuild the oracle the single text removes.
    const distinct = new Set(CODING_REFUSAL_CODES.map((code) => refusalText(code)))
    expect(distinct.size).toBe(CODING_REFUSAL_CODES.length)
    expect(refusalText('fs')).toBe(refusalText('fs'))
  })

  it('an unknown code falls back to the text that came with it, never to a guess', () => {
    expect(refusalText('something-new', 'Nothing was written: new cause.')).toContain('new cause')
    expect(refusalText(undefined, 'plain error')).toBe('plain error')
    expect(refusalText(42, '')).toMatch(/abgelehnt/)
    expect(refusalText(undefined, undefined)).toMatch(/abgelehnt/)
  })

  it('escapes hidden characters in a fallback text from outside', () => {
    expect(refusalText(undefined, 'a‮b')).not.toContain('‮')
  })

  it('the three refusals after which files may be written are exactly these', () => {
    expect([...CODING_REFUSALS_MAY_HAVE_WRITTEN].sort()).toEqual([
      'interrupted',
      'partial',
      'withdrawn'
    ])
  })
})

describe('undo result', () => {
  it('names every file that was NOT restored with its reason', () => {
    const view = describeUndo({
      kind: 'restored',
      restored: ['a.ts'],
      skipped: [
        { path: 'b.ts', reason: 'changed-since-apply' },
        { path: 'c.ts', reason: 'some-future-reason' }
      ]
    })
    expect(view.complete).toBe(false)
    expect(view.restored).toEqual(['a.ts'])
    expect(view.skipped.map((s) => s.path)).toEqual(['b.ts', 'c.ts'])
    // A known reason is explained, an unknown one is shown as it came, never dropped.
    expect(view.skipped[0].reasonText).not.toBe('changed-since-apply')
    expect(view.skipped[0].reasonText.length).toBeGreaterThan(10)
    expect(view.skipped[1].reasonText).toContain('some-future-reason')
    expect(view.headline).not.toBe('Rückgängig gemacht')
  })

  it('a complete undo is reported as complete, with the files', () => {
    const view = describeUndo({ kind: 'restored', restored: ['a.ts', 'b.ts'], skipped: [] })
    expect(view.complete).toBe(true)
    expect(view.restored).toEqual(['a.ts', 'b.ts'])
  })

  it('an interrupted apply is never reported as complete', () => {
    const view = describeUndo({ kind: 'restored', restored: ['a.ts'], skipped: [], interrupted: true })
    expect(view.complete).toBe(false)
  })

  it('a refusal restores nothing and says why', () => {
    const view = describeUndo({ kind: 'refused', reason: 'no snapshot', skipped: [{ path: 'x', reason: 'batch-not-recorded' }] })
    expect(view.complete).toBe(false)
    expect(view.restored).toEqual([])
    expect(view.headline).toContain('no snapshot')
    expect(view.skipped).toHaveLength(1)
  })

  it('a refusal with a code reads as ONE German sentence, not two stacked ones', () => {
    // The old headline prefixed the English text and produced "Nichts wurde
    // rückgängig gemacht: Nothing was restored: …".
    const view = describeUndo({
      kind: 'refused',
      code: 'no-snapshot',
      reason: 'Nothing was restored: there is no snapshot for this run in this directory.',
      skipped: []
    })
    expect(view.headline).not.toMatch(/Nothing was restored/)
    expect(view.headline).not.toMatch(/rückgängig gemacht:.*:/)
    expect(view.headline).toMatch(/wiederhergestellt/)
  })

  it('escapes hidden characters in the paths it lists', () => {
    const view = describeUndo({ kind: 'restored', restored: ['a‮.ts'], skipped: [{ path: 'b​', reason: 'unreadable' }] })
    expect(view.restored[0]).not.toContain('‮')
    expect(view.skipped[0].path).not.toContain('​')
  })
})

describe('getPermissionLabel', () => {
  it('names edit when it is granted (the most dangerous permission is not hidden)', () => {
    expect(getPermissionLabel(['read', 'create', 'edit']).toLowerCase()).toContain('edit')
    expect(getPermissionLabel(['read', 'edit']).toLowerCase()).toContain('edit')
    expect(getPermissionLabel(['edit']).toLowerCase()).toContain('edit')
    expect(getPermissionLabel(['read-create', 'edit']).toLowerCase()).toContain('edit')
  })

  it('keeps the existing labels for grants without edit', () => {
    expect(getPermissionLabel(['read'])).toBe('Read Only')
    expect(getPermissionLabel(['create'])).toBe('Create Only')
    expect(getPermissionLabel(['read', 'create'])).toBe('Read + Create')
    expect(getPermissionLabel(['read-create'])).toBe('Read + Create')
    expect(getPermissionLabel([])).toBe('Unknown')
  })

  it('does not name edit when it is not granted', () => {
    expect(getPermissionLabel(['read', 'create']).toLowerCase()).not.toContain('edit')
  })
})
