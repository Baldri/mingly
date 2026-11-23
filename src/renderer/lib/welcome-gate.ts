/**
 * Whether the first-run welcome screen stands between the user and the app.
 *
 * The rule used to be "no cloud API key, no app": the screen rendered whenever
 * `apiKeysConfigured` was empty, and the only things that cleared it were an
 * API key or an existing conversation — which you cannot create from the
 * welcome screen. It was a closed loop, and it locked out precisely the user
 * this product is built for: someone running a local model and no cloud
 * provider at all. `listConfiguredProviders` knows `anthropic`, `openai` and
 * `google`; Ollama, the one provider whose residency is `on-device`, is not
 * among them and never counts as "set up".
 *
 * So the gate gets an explicit way out, and this function is where that is
 * stated rather than implied. Offering it is the caller's job; honouring it is
 * this one's.
 */

export interface WelcomeGateState {
  /** The user asked to go on without configuring a cloud provider. */
  readonly dismissed: boolean
  /** At least one cloud provider has a stored, usable API key. */
  readonly hasCloudApiKey: boolean
  /** Conversations already in the database. */
  readonly conversationCount: number
}

/**
 * True while the welcome screen should replace the app.
 *
 * `dismissed` wins over everything: a screen the user has stepped past must
 * not come back on its own, or the way out is not a way out.
 */
export function shouldShowWelcome(state: WelcomeGateState): boolean {
  if (state.dismissed) return false
  if (state.hasCloudApiKey) return false
  return state.conversationCount === 0
}
