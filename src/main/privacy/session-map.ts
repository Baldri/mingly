/**
 * Privacy Session Map
 * Maintains bidirectional PII mappings per conversation session.
 * Enables consistent anonymization (original → fake) and
 * rehydration (fake → original) within a session.
 */

import type { PIICategory } from './pii-types'

/** A single PII mapping entry */
export interface PIIMapping {
  original: string
  replacement: string
  category: PIICategory
  createdAt: number
}

/**
 * Bidirectional session map for PII replacements.
 * Thread-safe within a single Electron main process.
 */
export class PrivacySessionMap {
  private sessionId: string
  /** original text → mapping */
  private forwardMap: Map<string, PIIMapping> = new Map()
  /** replacement text → mapping */
  private reverseMap: Map<string, PIIMapping> = new Map()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Register a PII replacement pair.
   */
  add(original: string, replacement: string, category: PIICategory): void {
    const mapping: PIIMapping = {
      original,
      replacement,
      category,
      createdAt: Date.now()
    }
    this.forwardMap.set(original, mapping)
    this.reverseMap.set(replacement, mapping)
  }

  /**
   * Bulk-import from an anonymizer's replacement map.
   */
  importFromAnonymizer(
    replacementMap: Map<string, string>,
    categoryMap: Map<string, PIICategory>
  ): void {
    for (const [original, replacement] of replacementMap) {
      const category = categoryMap.get(original) ?? 'CUSTOM'
      this.add(original, replacement, category)
    }
  }

  /**
   * Look up the replacement for an original PII value.
   */
  getReplacement(original: string): string | undefined {
    return this.forwardMap.get(original)?.replacement
  }

  /**
   * Look up the original PII value for a replacement.
   */
  getOriginal(replacement: string): string | undefined {
    return this.reverseMap.get(replacement)?.original
  }

  /**
   * Get all mappings (for debugging / UI display).
   */
  getAllMappings(): PIIMapping[] {
    return Array.from(this.forwardMap.values())
  }

  /**
   * Number of tracked PII items.
   */
  get size(): number {
    return this.forwardMap.size
  }

  /**
   * Get all replacement strings, sorted longest-first
   * (important for rehydration to avoid partial matches).
   */
  getReplacementsSortedByLength(): string[] {
    return Array.from(this.reverseMap.keys())
      .sort((a, b) => b.length - a.length)
  }

  /**
   * Clear all mappings (session end).
   */
  clear(): void {
    this.forwardMap.clear()
    this.reverseMap.clear()
  }

  /**
   * Export for persistence (e.g., session recovery).
   */
  export(): { sessionId: string; mappings: PIIMapping[] } {
    return {
      sessionId: this.sessionId,
      mappings: this.getAllMappings()
    }
  }

  /**
   * Restore from exported data.
   */
  static restore(data: { sessionId: string; mappings: PIIMapping[] }): PrivacySessionMap {
    const map = new PrivacySessionMap(data.sessionId)
    for (const m of data.mappings) {
      map.add(m.original, m.replacement, m.category)
    }
    return map
  }
}
