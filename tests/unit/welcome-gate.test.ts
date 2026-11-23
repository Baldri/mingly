/**
 * The welcome screen must always be escapable.
 *
 * Measured on 2026-11-20: a user with a working local-model setup and no cloud
 * API key could not reach the chat at all. `App.tsx` rendered the welcome
 * screen whenever no cloud key was configured, and the only two things that
 * cleared it were a cloud key or an existing conversation — which that screen
 * offers no way to create. The loop was closed, and it closed hardest on the
 * one user the product advertises to.
 */

import { describe, it, expect } from 'vitest'
import { shouldShowWelcome } from '../../src/renderer/lib/welcome-gate'

describe('shouldShowWelcome', () => {
  it('shows the screen on a fresh install', () => {
    expect(
      shouldShowWelcome({ dismissed: false, hasCloudApiKey: false, conversationCount: 0 })
    ).toBe(true)
  })

  it('lets a user without any cloud key step past it', () => {
    // The defect: before this, there was no input that produced `false` here.
    expect(
      shouldShowWelcome({ dismissed: true, hasCloudApiKey: false, conversationCount: 0 })
    ).toBe(false)
  })

  it('keeps it dismissed even while no provider is configured', () => {
    // A screen that comes back by itself is not a way out. This is the case a
    // local-model-only user lives in permanently.
    expect(
      shouldShowWelcome({ dismissed: true, hasCloudApiKey: false, conversationCount: 0 })
    ).toBe(false)
    expect(
      shouldShowWelcome({ dismissed: true, hasCloudApiKey: false, conversationCount: 12 })
    ).toBe(false)
  })

  it('hides it once a cloud key is configured', () => {
    expect(
      shouldShowWelcome({ dismissed: false, hasCloudApiKey: true, conversationCount: 0 })
    ).toBe(false)
  })

  it('hides it once conversations exist', () => {
    expect(
      shouldShowWelcome({ dismissed: false, hasCloudApiKey: false, conversationCount: 1 })
    ).toBe(false)
  })
})
