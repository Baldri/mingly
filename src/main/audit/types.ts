// Shared ActivityLogEntry interface (Phase 4.1)
// Identical interface across Claude Remote, Mingly, and Nexbid.

export interface ActivityLogEntry {
  id: string
  actorType: string
  actorId: string
  action: string
  entityType: string
  entityId: string
  details: Record<string, unknown> | null
  createdAt: string
}

export interface ActivityLoggerInterface {
  log(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void
  query?(filter: {
    entityType?: string
    action?: string
    since?: string
    limit?: number
  }): ActivityLogEntry[]
}

// Mingly-specific known actions
export type KnownAction =
  | 'conversation.create'
  | 'conversation.delete'
  | 'message.send'
  | 'message.receive'
  | 'provider.switch'
  | 'provider.health_check'
  | 'budget.exceeded'
  | 'budget.warning'
  | 'session.create'
  | 'session.error'
