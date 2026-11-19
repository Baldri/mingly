/**
 * One definition of "hidden character", shared by the main process (diff
 * building, audit export) and the renderer (the approval dialog).
 *
 * The approval surface must not show the human something other than what is
 * written. The list that decides what is hidden therefore lives in ONE place
 * (src/shared) and edit-proposals.ts re-exports it instead of keeping its own.
 */
import { describe, it, expect } from 'vitest'
import {
  escapeHiddenCharacters,
  stripHiddenCharacters,
  escapeHiddenPerLine
} from '../../src/shared/hidden-characters'
import { stripHiddenCharacters as stripFromEditProposals } from '../../src/main/coding/edit-proposals'

describe('shared hidden-character handling', () => {
  it('edit-proposals re-exports the shared function, not a second copy', () => {
    expect(stripFromEditProposals).toBe(stripHiddenCharacters)
  })

  it('escapes a right-to-left override visibly instead of passing it through', () => {
    const shown = escapeHiddenCharacters('safe‮txt.exe')
    expect(shown).toBe('safe<U+202E>txt.exe')
    expect(shown).not.toContain('‮')
  })

  it('escapes zero-width and word-joiner characters', () => {
    expect(escapeHiddenCharacters('a​b⁠c')).toBe('a<U+200B>b<U+2060>c')
  })

  it('leaves plain space and tab alone', () => {
    expect(escapeHiddenCharacters('a b\tc')).toBe('a b\tc')
  })

  it('per-line escaping keeps the line structure of a diff', () => {
    const out = escapeHiddenPerLine('+one‮\n-two\n three')
    expect(out).toBe('+one<U+202E>\n-two\n three')
  })

  it('per-line escaping makes a carriage return visible (it can overwrite a line in a terminal)', () => {
    expect(escapeHiddenPerLine('+a\r-b')).toBe('+a<U+000D>-b')
  })

  it('strip replaces a hidden character with a space', () => {
    expect(stripHiddenCharacters('a‮b')).toBe('a b')
  })
})
