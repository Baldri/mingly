/**
 * Types the UI shares with the privacy layer in the main process.
 *
 * They live here rather than in `src/main/security/*` because the renderer
 * renders them. `tsconfig.json` covers only src/renderer, src/shared and
 * src/preload, but TypeScript follows imports past that boundary — so every
 * type the UI pulled from src/main grafted a piece of the main-process module
 * graph onto the renderer's type-check, and that graft grows on its own when
 * the main-process file gains an import.
 *
 * That happened: a guard import added to hybrid-orchestrator.ts extended the
 * renderer's graph down to the database layer and its untyped `sql.js`
 * dependency, and `npm run typecheck` failed in a file nobody had edited.
 *
 * `tests/unit/renderer-process-boundary.test.ts` keeps the boundary closed.
 * The defining modules re-export these names, so main-process importers are
 * unaffected.
 */

export type SensitiveDataType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit-card'
  | 'api-key'
  | 'password'
  | 'ip-address'
  | 'file-path'
  | 'url'
  | 'custom'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface SensitiveDataMatch {
  type: SensitiveDataType
  value: string // Partially redacted for display
  fullValue: string
  position: { start: number; end: number }
  riskLevel: RiskLevel
  confidence: number // 0-1
}

export interface SensitiveDataScanResult {
  hasSensitiveData: boolean
  matches: SensitiveDataMatch[]
  overallRiskLevel: RiskLevel
  recommendation: 'allow' | 'warn' | 'block'
}

export interface UploadPermissionRequest {
  fileId: string // Unique file identifier (hash or path)
  filePath: string
  directoryId: string
  destination: 'local' | 'cloud'
  provider: string // 'anthropic', 'openai', 'google', 'ollama', etc.
  scanResult: SensitiveDataScanResult
  timestamp: number
}
