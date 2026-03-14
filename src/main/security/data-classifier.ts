/**
 * Data Classification & Routing Policy.
 *
 * Classifies message content by sensitivity level and enforces routing rules:
 * - PUBLIC: Any provider (including Google, third-party)
 * - INTERNAL: Trusted cloud providers only (Anthropic, OpenAI, Ollama)
 * - CONFIDENTIAL: Local only (Ollama)
 * - RESTRICTED: No LLM processing allowed
 *
 * Uses the existing SensitiveDataDetector for PII scanning and adds
 * keyword/pattern-based classification for domain-specific content.
 */

import { getSensitiveDataDetector } from './sensitive-data-detector'
import type { SensitiveDataScanResult } from './sensitive-data-detector'

// ── Types ──────────────────────────────────────────────────────

export enum DataSensitivity {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted'
}

export interface ClassificationResult {
  sensitivity: DataSensitivity
  reasons: string[]
  scanResult: SensitiveDataScanResult
  allowedProviders: string[]
}

export interface RoutingDecision {
  allowed: boolean
  reason?: string
  suggestedProvider?: string
  classification: ClassificationResult
}

// ── Provider Trust Levels ──────────────────────────────────────

const PROVIDER_TRUST: Record<string, DataSensitivity> = {
  ollama: DataSensitivity.CONFIDENTIAL,     // local — handles everything
  local: DataSensitivity.CONFIDENTIAL,       // local
  anthropic: DataSensitivity.INTERNAL,       // trusted cloud
  openai: DataSensitivity.INTERNAL,          // trusted cloud
  google: DataSensitivity.PUBLIC             // less trusted for sensitive data
}

// Sensitivity hierarchy: RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC
const SENSITIVITY_RANK: Record<DataSensitivity, number> = {
  [DataSensitivity.PUBLIC]: 0,
  [DataSensitivity.INTERNAL]: 1,
  [DataSensitivity.CONFIDENTIAL]: 2,
  [DataSensitivity.RESTRICTED]: 3
}

// ── Keyword Patterns for Domain Classification ─────────────────

const CONFIDENTIAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Health data (CH: besonders schuetzenswerte Personendaten, nDSG Art. 5)
  { pattern: /\b(diagnos[ei]|patient|medikament|therapie|krankheit|symptom|behandlung|arzt|spital|klinik)\b/i, reason: 'Health data detected (nDSG Art. 5)' },
  { pattern: /\b(ICD-?\d{1,2}|blood\s?type|medical\s?record|prescription)\b/i, reason: 'Medical terminology detected' },
  // Financial data
  { pattern: /\b(kontonummer|kreditkarte|bankverbindung|salary|gehalt|lohn|steuererkl[aä]rung|steuernummer)\b/i, reason: 'Financial data detected' },
  // Legal identifiers (Swiss-specific)
  { pattern: /\b756\.\d{4}\.\d{4}\.\d{2}\b/, reason: 'AHV number detected' },
  { pattern: /\bCH\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{1}\b/, reason: 'Swiss IBAN detected' },
  // Biometric / genetic
  { pattern: /\b(biometr|fingerabdruck|fingerprint|dna|genetisch|retina)\b/i, reason: 'Biometric/genetic data detected' }
]

const RESTRICTED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Credentials / secrets
  { pattern: /\b(password|passwort|private.?key|secret.?key|api.?key|token)\s*[:=]\s*\S+/i, reason: 'Credential pattern detected' },
  { pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/, reason: 'Private key detected' },
  // Swiss legal proceedings
  { pattern: /\b(strafverfahren|gerichtsurteil|anklage|beschuldigte[r]?)\b/i, reason: 'Legal proceeding data (nDSG Art. 5)' }
]

// ── Data Classifier ────────────────────────────────────────────

export class DataClassifier {
  /**
   * Classify the sensitivity of message content.
   */
  classify(content: string): ClassificationResult {
    const reasons: string[] = []
    let sensitivity = DataSensitivity.PUBLIC

    // 1. Run SensitiveDataDetector scan
    const detector = getSensitiveDataDetector()
    const scanResult = detector.scan(content)

    // Elevate based on PII findings
    if (scanResult.hasSensitiveData) {
      const riskLevel = scanResult.overallRiskLevel

      if (riskLevel === 'critical') {
        sensitivity = DataSensitivity.CONFIDENTIAL
        reasons.push(`Critical PII detected (${scanResult.matches.length} items)`)
      } else if (riskLevel === 'high') {
        sensitivity = DataSensitivity.INTERNAL
        reasons.push(`High-risk PII detected (${scanResult.matches.length} items)`)
      } else if (riskLevel === 'medium') {
        sensitivity = DataSensitivity.INTERNAL
        reasons.push(`Medium-risk PII detected (${scanResult.matches.length} items)`)
      }
    }

    // 2. Check RESTRICTED patterns (highest priority)
    for (const { pattern, reason } of RESTRICTED_PATTERNS) {
      if (pattern.test(content)) {
        sensitivity = DataSensitivity.RESTRICTED
        reasons.push(reason)
      }
    }

    // 3. Check CONFIDENTIAL patterns (if not already restricted)
    if (sensitivity !== DataSensitivity.RESTRICTED) {
      for (const { pattern, reason } of CONFIDENTIAL_PATTERNS) {
        if (pattern.test(content)) {
          if (SENSITIVITY_RANK[sensitivity] < SENSITIVITY_RANK[DataSensitivity.CONFIDENTIAL]) {
            sensitivity = DataSensitivity.CONFIDENTIAL
          }
          reasons.push(reason)
        }
      }
    }

    // 4. Determine allowed providers based on sensitivity
    const allowedProviders = this.getAllowedProviders(sensitivity)

    return { sensitivity, reasons, scanResult, allowedProviders }
  }

  /**
   * Check if a specific provider is allowed for the given content.
   * Returns a routing decision with fallback suggestion.
   */
  checkRouting(content: string, provider: string): RoutingDecision {
    const classification = this.classify(content)
    const providerTrust = PROVIDER_TRUST[provider] ?? DataSensitivity.PUBLIC

    // Check: provider trust level must be >= content sensitivity
    const providerRank = SENSITIVITY_RANK[providerTrust]
    const requiredRank = SENSITIVITY_RANK[classification.sensitivity]

    if (providerRank >= requiredRank) {
      return { allowed: true, classification }
    }

    // Provider not trusted enough — suggest local fallback
    const suggestedProvider = classification.allowedProviders[0]

    return {
      allowed: false,
      reason: `Content classified as "${classification.sensitivity}" but provider "${provider}" only handles "${providerTrust}" or below. ${classification.reasons.join('; ')}`,
      suggestedProvider,
      classification
    }
  }

  /**
   * Get list of providers that can handle content at the given sensitivity level.
   */
  private getAllowedProviders(sensitivity: DataSensitivity): string[] {
    const requiredRank = SENSITIVITY_RANK[sensitivity]

    return Object.entries(PROVIDER_TRUST)
      .filter(([, trust]) => SENSITIVITY_RANK[trust] >= requiredRank)
      .map(([provider]) => provider)
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: DataClassifier | null = null

export function getDataClassifier(): DataClassifier {
  if (!instance) instance = new DataClassifier()
  return instance
}
