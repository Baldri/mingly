/**
 * Health check types for LLM provider connectivity and status monitoring.
 */

export interface ProviderHealthCheck {
  provider: string
  status: 'pass' | 'warn' | 'fail'
  checks: HealthCheckItem[]
  testedAt: string
  latencyMs: number
}

export interface HealthCheckItem {
  code: string
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string | null
}
