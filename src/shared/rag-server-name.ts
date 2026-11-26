/**
 * Display name of the external knowledge server.
 *
 * The default is deliberately generic: a customer may run DocMind, a server of
 * their own, or none, and must not be told they are using someone's internal
 * knowledge base. Users can rename it under Settings → Knowledge Base.
 */
export const DEFAULT_RAG_SERVER_NAME = 'Knowledge Base'

/** The configured name, trimmed, or the generic default when none is set. */
export function resolveRagServerName(configured: string | undefined): string {
  const trimmed = configured?.trim()
  return trimmed ? trimmed : DEFAULT_RAG_SERVER_NAME
}
