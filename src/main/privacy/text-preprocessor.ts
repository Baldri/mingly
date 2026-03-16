/**
 * Text Preprocessor for PII Detection Pipeline
 *
 * Normalizes text before detection to defeat evasion techniques:
 * - Zero-width character stripping (ZWS, ZWNJ, ZWJ, BOM)
 * - URL-encoding decoding (%40 -> @, %2E -> .)
 * - Unicode NFC normalization (decomposed umlauts -> composed)
 *
 * Maintains an offset map so entity positions can be mapped back
 * to the original text.
 */

/** Characters that should be stripped before detection */
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g

/** URL-encoded sequences that commonly appear in PII evasion */
const URL_ENCODED_PATTERN = /%[0-9A-Fa-f]{2}/g

/**
 * Result of preprocessing: normalized text + offset mapping.
 */
export interface PreprocessResult {
  /** Cleaned text for detection */
  normalized: string
  /**
   * Maps a position in normalized text back to the position in original text.
   * Used to correct entity.start/end after detection on normalized text.
   */
  toOriginalOffset(normalizedOffset: number): number
  /** Whether any normalization was applied */
  wasModified: boolean
}

/**
 * Preprocess text for PII detection.
 * Applies normalization steps that defeat common evasion techniques.
 */
export function preprocessText(text: string): PreprocessResult {
  // Build offset map: for each position in normalized text,
  // track corresponding position in original text.
  // Strategy: process character by character, tracking removals/replacements.

  const offsetMap: number[] = [] // offsetMap[normalizedIndex] = originalIndex
  let normalized = ''
  let wasModified = false

  // Step 1: Strip zero-width characters and build offset map
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ZERO_WIDTH_CHARS.test(ch)) {
      ZERO_WIDTH_CHARS.lastIndex = 0 // Reset after test
      wasModified = true
      continue // Skip this character
    }
    ZERO_WIDTH_CHARS.lastIndex = 0 // Reset after test
    offsetMap.push(i)
    normalized += ch
  }

  // Step 2: URL-decode common PII-relevant sequences
  // We need to re-build offset map after URL decoding
  const preUrlText = normalized
  const preUrlMap = [...offsetMap]

  const urlDecoded = decodeUrlEncoded(preUrlText)
  if (urlDecoded.text !== preUrlText) {
    wasModified = true
    // Rebuild offset map based on URL decoding changes
    normalized = urlDecoded.text
    const newOffsetMap: number[] = []
    for (let ni = 0; ni < urlDecoded.text.length; ni++) {
      const preUrlIndex = urlDecoded.toPreUrlIndex(ni)
      newOffsetMap.push(preUrlMap[preUrlIndex] ?? preUrlIndex)
    }
    offsetMap.length = 0
    offsetMap.push(...newOffsetMap)
  }

  // Step 3: Unicode NFC normalization
  const nfcNormalized = normalized.normalize('NFC')
  if (nfcNormalized !== normalized) {
    wasModified = true
    // NFC can change string length (e.g., decomposed a + combining umlaut -> ä)
    // For NFC, offsets are approximate but sufficient for PII detection
    normalized = nfcNormalized
    // Trim or extend offset map to match new length
    while (offsetMap.length < normalized.length) {
      offsetMap.push(offsetMap[offsetMap.length - 1] ?? 0)
    }
    offsetMap.length = normalized.length
  }

  // Add sentinel for end-of-string offset lookups
  const lastOriginalOffset = offsetMap.length > 0
    ? (offsetMap[offsetMap.length - 1] ?? 0) + 1
    : 0

  return {
    normalized,
    wasModified,
    toOriginalOffset(normalizedOffset: number): number {
      if (normalizedOffset >= offsetMap.length) {
        return lastOriginalOffset + (normalizedOffset - offsetMap.length)
      }
      return offsetMap[normalizedOffset] ?? normalizedOffset
    }
  }
}

/**
 * Decode URL-encoded characters commonly used in PII evasion.
 * Only decodes sequences that are relevant for PII patterns.
 */
function decodeUrlEncoded(text: string): {
  text: string
  toPreUrlIndex(decodedIndex: number): number
} {
  const offsetMap: number[] = [] // decodedIndex -> preUrlIndex
  let decoded = ''
  let i = 0

  while (i < text.length) {
    if (text[i] === '%' && i + 2 < text.length) {
      const hex = text.substring(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        const charCode = parseInt(hex, 16)
        const ch = String.fromCharCode(charCode)
        offsetMap.push(i) // Map decoded char to start of %XX
        decoded += ch
        i += 3
        continue
      }
    }
    offsetMap.push(i)
    decoded += text[i]
    i++
  }

  return {
    text: decoded,
    toPreUrlIndex(decodedIndex: number): number {
      return offsetMap[decodedIndex] ?? decodedIndex
    }
  }
}
