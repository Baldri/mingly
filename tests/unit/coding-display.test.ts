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
  getPermissionLabel
} from '../../src/renderer/lib/coding-display'
import { CODING_MODE_CHOICES } from '../../src/shared/coding-types'

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
