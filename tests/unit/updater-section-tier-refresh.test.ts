/**
 * @vitest-environment jsdom
 *
 * The Updates panel must stop saying "Free plan" once the user is on Pro.
 *
 * `UpdaterSection` called `loadStatus()` once, from a `useEffect` keyed only on
 * the store actions. `autoUpdateEnabled` is decided in the main process from
 * the tier, so activating a license changed the answer — but nothing fetched it
 * again while the panel stayed mounted. The user saw "Free plan — manual
 * download from GitHub Releases." after paying.
 *
 * This asserts the SYMPTOM, not the mechanism: what the panel shows before and
 * after the tier changes. A test on "is loadStatus called again" would pass for
 * a fix that refetches and then renders the stale value anyway.
 *
 * The real stores are used, as in message-list-hooks.test.ts. Only
 * `window.electronAPI.updater` is stubbed, because there is no Electron here —
 * and it answers from the CURRENT tier, so the stub cannot be the thing that
 * makes the test pass: with the defect in place it is asked exactly once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const { UpdaterSection } = await import('../../src/renderer/components/UpdaterSection')
const { useUpdaterStore } = await import('../../src/renderer/stores/updater-store')
const { useSubscriptionStore } = await import('../../src/renderer/stores/subscription-store')

/** How often the panel asked the main process for the updater status. */
let statusCalls = 0

const INITIAL = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  error: null,
  info: null,
  progress: null,
  autoUpdateEnabled: false
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  statusCalls = 0
  useUpdaterStore.setState({ status: { ...INITIAL } })
  useSubscriptionStore.setState({ tier: 'free' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    updater: {
      // Answers from the tier the store holds right now, which is what the
      // main process does. So a stale answer here means a missing refetch,
      // not a rigged stub.
      getStatus: async () => {
        statusCalls++
        const tier = useSubscriptionStore.getState().tier
        return { ...INITIAL, autoUpdateEnabled: tier !== 'free' }
      },
      onStatus: () => () => undefined
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useSubscriptionStore.setState({ tier: 'free' })
  useUpdaterStore.setState({ status: { ...INITIAL } })
})

function mount(): void {
  act(() => {
    root.render(createElement(UpdaterSection))
  })
}

describe('UpdaterSection follows the tier', () => {
  it('switches from "Free plan" to the Pro wording when a license is activated', async () => {
    mount()
    await act(async () => {
      await Promise.resolve()
    })

    // POSITIVE CONTROL: the panel did ask, and it does render the free wording.
    // Without this, the assertion after the tier change could pass on a panel
    // that renders nothing at all.
    expect(statusCalls, 'the panel never asked for the status').toBeGreaterThan(0)
    expect(container.textContent).toContain('Free plan')

    const callsBefore = statusCalls

    act(() => {
      useSubscriptionStore.setState({ tier: 'pro' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(statusCalls, 'the status was not fetched again').toBeGreaterThan(callsBefore)
    expect(container.textContent).toContain('Auto-update enabled')
    expect(container.textContent).not.toContain('Free plan')
  })

  it('goes back to the free wording when the license is removed', async () => {
    useSubscriptionStore.setState({ tier: 'pro' })
    mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Auto-update enabled')

    act(() => {
      useSubscriptionStore.setState({ tier: 'free' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The other direction matters too: a deactivated license must not leave
    // the Pro wording standing.
    expect(container.textContent).toContain('Free plan')
  })
})
