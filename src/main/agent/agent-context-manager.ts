/**
 * AgentContextManager — File-based context externalization for long-running agents.
 *
 * When tool results exceed a size threshold, they are written to temp files
 * and replaced with a compact reference in the conversation context.
 * The agent can read the file later via the read_file built-in tool.
 *
 * This keeps the LLM context window small while allowing unlimited working memory.
 * Inspired by Manus AI's file-system-as-memory architecture.
 *
 * Lifecycle:
 * 1. After each tool result, check if it exceeds the compaction threshold
 * 2. If yes: write to temp file, replace content with file reference
 * 3. On run completion: optionally clean up temp files
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { nanoid } from 'nanoid'
import type { AgentToolResult, Message } from '../../shared/types'

export interface ContextManagerConfig {
  /** Minimum chars before a tool result is externalized (default: 2000) */
  compactionThreshold: number
  /** Whether to auto-cleanup temp files after run completion (default: true) */
  autoCleanup: boolean
  /** Base directory for temp files (default: os.tmpdir()/mingly-agent/) */
  tempDir: string
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  compactionThreshold: 2000,
  autoCleanup: true,
  tempDir: path.join(os.tmpdir(), 'mingly-agent')
}

export class AgentContextManager {
  private config: ContextManagerConfig
  private tempFiles: Map<string, string[]> = new Map() // runId → file paths

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.ensureTempDir()
  }

  /**
   * Process a tool result: if it's large, externalize to file.
   * Returns the (possibly modified) tool result.
   */
  compactToolResult(runId: string, result: AgentToolResult): AgentToolResult {
    // Don't externalize errors (they should stay visible for Error Preservation)
    if (result.isError) return result

    // Don't externalize small results
    if (result.content.length <= this.config.compactionThreshold) return result

    // Write to temp file
    const filename = `agent-${runId}-${nanoid(8)}.txt`
    const filepath = path.join(this.config.tempDir, filename)

    try {
      fs.writeFileSync(filepath, result.content, 'utf-8')
      this.trackFile(runId, filepath)

      // Replace content with compact reference
      const lineCount = result.content.split('\n').length
      const preview = result.content.substring(0, 200).replace(/\n/g, ' ')
      return {
        ...result,
        content:
          `[Large result externalized to file: ${filepath}]\n` +
          `Size: ${result.content.length} chars, ${lineCount} lines\n` +
          `Preview: ${preview}...\n` +
          `Use the read_file tool to access the full content if needed.`
      }
    } catch {
      // If file write fails, return original result
      return result
    }
  }

  /**
   * Compact an existing message array by externalizing large tool results.
   * Used for mid-run compaction when context grows too large.
   */
  compactMessages(runId: string, messages: Message[], threshold?: number): Message[] {
    const limit = threshold ?? this.config.compactionThreshold
    return messages.map((msg) => {
      if (msg.role !== 'tool') return msg
      if (msg.content.length <= limit) return msg

      // Externalize this tool result
      const filename = `agent-${runId}-${nanoid(8)}.txt`
      const filepath = path.join(this.config.tempDir, filename)

      try {
        fs.writeFileSync(filepath, msg.content, 'utf-8')
        this.trackFile(runId, filepath)

        const lineCount = msg.content.split('\n').length
        const preview = msg.content.substring(0, 200).replace(/\n/g, ' ')
        return {
          ...msg,
          content:
            `[Result externalized to: ${filepath}]\n` +
            `Size: ${msg.content.length} chars, ${lineCount} lines\n` +
            `Preview: ${preview}...\n` +
            `Use read_file to access full content.`
        }
      } catch {
        return msg
      }
    })
  }

  /**
   * Clean up temp files for a completed run.
   */
  cleanup(runId: string): void {
    const files = this.tempFiles.get(runId)
    if (!files) return

    for (const filepath of files) {
      try {
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath)
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    this.tempFiles.delete(runId)
  }

  /**
   * Clean up all temp files (e.g., on app shutdown).
   */
  cleanupAll(): void {
    for (const runId of this.tempFiles.keys()) {
      this.cleanup(runId)
    }
  }

  /**
   * Get total externalized data size for a run.
   */
  getExternalizedSize(runId: string): number {
    const files = this.tempFiles.get(runId)
    if (!files) return 0

    let total = 0
    for (const filepath of files) {
      try {
        const stat = fs.statSync(filepath)
        total += stat.size
      } catch {
        // File may already be cleaned up
      }
    }
    return total
  }

  // ── Private ────────────────────────────────────────────────────

  private ensureTempDir(): void {
    try {
      if (!fs.existsSync(this.config.tempDir)) {
        fs.mkdirSync(this.config.tempDir, { recursive: true })
      }
    } catch {
      // Fall back to os.tmpdir() if custom dir fails
      this.config.tempDir = os.tmpdir()
    }
  }

  private trackFile(runId: string, filepath: string): void {
    // Validate path stays within tempDir (prevent path traversal)
    const resolved = path.resolve(filepath)
    const tempDirResolved = path.resolve(this.config.tempDir)
    if (!resolved.startsWith(tempDirResolved + path.sep) && resolved !== tempDirResolved) {
      console.warn(`[AgentContextManager] Path escape blocked: ${filepath}`)
      return
    }

    const existing = this.tempFiles.get(runId)
    if (existing) {
      existing.push(resolved)
    } else {
      this.tempFiles.set(runId, [resolved])
    }
  }
}

// Singleton
let contextManagerInstance: AgentContextManager | null = null

export function getAgentContextManager(): AgentContextManager {
  if (!contextManagerInstance) {
    contextManagerInstance = new AgentContextManager()
  }
  return contextManagerInstance
}
