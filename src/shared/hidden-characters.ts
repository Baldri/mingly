/**
 * The one definition of a "hidden" character, shared by the main process (diff
 * building, audit export) and the renderer (the approval dialog). It lives in
 * src/shared so that the thing that DECIDES what is hidden and the thing that
 * SHOWS the human are provably the same list: a second copy would be exactly
 * the gap between "what is displayed" and "what is written".
 *
 * Pure vocabulary: no Electron, no node builtins.
 */

/**
 * Characters that render invisibly or confusably, built from that property and
 * not from one Unicode category: controls, format characters (bidi, zero-width,
 * soft hyphen, tags), lone surrogates, private use and unassigned code points,
 * line and paragraph separators, EVERY space separator (the plain space is
 * exempted below), and the letters and marks that draw nothing yet are valid in
 * identifiers: Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the blank
 * braille pattern U+2800, the combining grapheme joiner U+034F, the Khmer
 * inherent vowels, Mongolian and general variation selectors. Err towards
 * escaping: a visibly escaped harmless character costs the reviewer one glance,
 * a missed one costs the review. Tab and plain space stay as they are; a
 * newline never occurs inside one displayed line. Rendered visibly in the diff,
 * never removed from what is stored.
 *
 * REVISIT THIS LIST when the Unicode tables move (a new Unicode version adds
 * Default_Ignorable, variation-selector and join-control points). U+180F, the
 * Mongolian free variation selector four, slipped through an earlier version
 * because the range stopped one point short. The tests enumerate the points.
 */
const HIDDEN_SET =
  '\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Zs}' +
  '\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0' +
  '\\u{E0100}-\\u{E01EF}'
export const HIDDEN_CHAR = new RegExp(`[${HIDDEN_SET}]`, 'gu')
const HIDDEN_ONE = new RegExp(`[${HIDDEN_SET}]`, 'u')

/** True for a character that must be shown escaped. Plain space, tab and newline are not hidden. */
export function isHiddenCharacter(ch: string): boolean {
  return ch !== ' ' && ch !== '\t' && ch !== '\n' && HIDDEN_ONE.test(ch)
}

/** Every hidden character replaced by `<U+XXXX>`. Space and tab stay. For ONE line of text. */
export function escapeHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHAR, (ch) => {
    if (ch === ' ' || ch === '\t') return ch
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
    return `<U+${hex}>`
  })
}

/**
 * Escape a multi-line text (a diff) line by line: the line breaks that make it
 * a diff stay, a carriage return or any other break inside a line is escaped.
 */
export function escapeHiddenPerLine(text: string): string {
  return text.split('\n').map(escapeHiddenCharacters).join('\n')
}

/**
 * Invisible, direction-changing and control characters replaced by a space: for
 * single-line text that ends in an audit record. Not for diff content: it would
 * turn the line breaks of a diff into spaces. Use escapeHiddenPerLine there.
 */
export function stripHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHAR, ' ')
}
