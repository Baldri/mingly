/**
 * @vitest-environment jsdom
 *
 * Re-render the SAME root through the transitions the real app makes.
 * Every existing picker test mounts a fresh root, so none of them can catch an
 * error that only appears on a LATER render — which is exactly what React #310
 * ("Rendered more hooks than during the previous render") is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => ({
  coding: {} as Record<string, unknown>,
  subscription: {} as Record<string, unknown>
}))

vi.mock('../../src/renderer/stores/coding-store', () => ({
  useCodingStore: (select: (s: Record<string, unknown>) => unknown) => select(h.coding)
}))
vi.mock('../../src/renderer/stores/subscription-store', () => ({
  useSubscriptionStore: (select: (s: Record<string, unknown>) => unknown) => select(h.subscription)
}))

const { CodingModePicker } = await import('../../src/renderer/components/CodingModePicker')

const GRANT = {
  id: 'd1', path: '/Users/x/proj', name: 'proj', location: 'local',
  permissions: ['read', 'create', 'edit'], recursive: true, grantedAt: 1, confirmedAt: 1
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.coding = {
    grants: [], selectedDirectoryId: null, modes: {}, runInFlight: false,
    applied: null, undo: null, error: null,
    loadProjects: vi.fn(), addProject: vi.fn(), selectProject: vi.fn(),
    setMode: vi.fn(), undoLast: vi.fn(), exportAudit: vi.fn(async () => null),
    clearError: vi.fn()
  }
  h.subscription = { features: {}, loadAllFeatures: vi.fn(), openUpgradeDialog: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function rerender(): void {
  act(() => { root.render(createElement(CodingModePicker)) })
}

describe('CodingModePicker survives the transitions the real app makes', () => {
  it('locked -> entitled on the same root', () => {
    rerender()
    h.subscription.features = { agentic_mode: { allowed: true } }
    rerender()
    expect(container.querySelector('[data-testid="coding-mode-picker"]')).not.toBeNull()
  })

  it('entitled -> grants arrive -> project selected, all on the same root', () => {
    h.subscription.features = { agentic_mode: { allowed: true } }
    rerender()
    h.coding.grants = [GRANT]
    rerender()
    h.coding.selectedDirectoryId = 'd1'
    h.coding.modes = { d1: 'propose' }
    rerender()
    expect(container.querySelector('[data-testid="coding-mode-summary"]')?.textContent).toBe('Vorschlagen')
  })

  it('entitled -> locked again (a lapsed subscription mid-session)', () => {
    h.subscription.features = { agentic_mode: { allowed: true } }
    h.coding.grants = [GRANT]
    h.coding.selectedDirectoryId = 'd1'
    h.coding.modes = { d1: 'propose' }
    rerender()
    h.subscription.features = {}
    rerender()
    expect(container.querySelector('[data-testid="coding-mode-locked"]')).not.toBeNull()
  })
})
