/**
 * @vitest-environment jsdom
 *
 * The coding picker as the human sees it, with and without `agentic_mode`.
 *
 * Ruling 8b: a lapsed subscription, a failed licence check or an entitlement
 * lookup without a network must never leave a user with files an agent changed
 * and no way back. The main process already honours it — CODING_UNDO_RUN and
 * the audit export carry no `requireFeature` — but the surface rendered ONLY
 * the upgrade button, so undo and the export were unreachable by hand. That is
 * the half this file pins.
 *
 * There is no React testing library here, so the component is mounted with
 * react-dom directly and the stores are replaced by plain objects. The expected
 * values are the German labels from the requirement, written out by hand; none
 * of them is read back from the component.
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
  useCodingStore: (select: (state: Record<string, unknown>) => unknown) => select(h.coding)
}))
vi.mock('../../src/renderer/stores/subscription-store', () => ({
  useSubscriptionStore: (select: (state: Record<string, unknown>) => unknown) => select(h.subscription)
}))

const { CodingModePicker } = await import('../../src/renderer/components/CodingModePicker')

const GRANT = {
  id: 'd1',
  path: '/Users/x/proj',
  name: 'proj',
  location: 'local',
  permissions: ['read', 'create', 'edit'],
  recursive: true,
  grantedAt: 1,
  confirmedAt: 1
}

/** An accepted package of an earlier run: the undo target the box offers. */
const APPLIED = { runId: 'run_1', directoryId: 'd1', paths: ['src/a.ts'] }

let container: HTMLDivElement
let root: Root
let undoLast: ReturnType<typeof vi.fn>
let exportAudit: ReturnType<typeof vi.fn>
let setMode: ReturnType<typeof vi.fn>

function render(allowed: boolean): void {
  h.subscription.features = allowed ? { agentic_mode: { allowed: true } } : {}
  act(() => {
    root.render(createElement(CodingModePicker))
  })
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')] as HTMLButtonElement[]
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? '').includes(text))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  undoLast = vi.fn()
  exportAudit = vi.fn(async () => null)
  setMode = vi.fn()
  h.coding = {
    grants: [GRANT],
    selectedDirectoryId: 'd1',
    modes: { d1: 'propose' },
    runInFlight: false,
    applied: APPLIED,
    undo: null,
    error: null,
    loadProjects: vi.fn(),
    addProject: vi.fn(),
    selectProject: vi.fn(),
    setMode,
    undoLast,
    exportAudit,
    clearError: vi.fn()
  }
  h.subscription = {
    features: {},
    loadAllFeatures: vi.fn(),
    openUpgradeDialog: vi.fn()
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
})

describe('CodingModePicker without agentic_mode', () => {
  it('still offers undo', () => {
    render(false)
    expect(buttonWith('Rückgängig machen')).toBeDefined()
  })

  it('still offers the audit export', () => {
    render(false)
    expect(buttonWith('Audit-Protokoll exportieren')).toBeDefined()
  })

  it('undo and the export actually call the store, they are not decoration', () => {
    render(false)
    act(() => {
      buttonWith('Rückgängig machen')?.click()
    })
    expect(undoLast).toHaveBeenCalledTimes(1)
    act(() => {
      buttonWith('Audit-Protokoll exportieren')?.click()
    })
    expect(exportAudit).toHaveBeenCalledTimes(1)
  })

  it('does not offer the level choice', () => {
    render(false)
    // The radio group IS the level choice; the project select starts a run.
    expect(container.querySelectorAll('input[name="coding-mode"]')).toHaveLength(0)
    expect(container.querySelector('#coding-project')).toBeNull()
    expect(setMode).not.toHaveBeenCalled()
  })

  it('offers the upgrade instead of the level choice', () => {
    render(false)
    expect(buttonWith('Upgrade')).toBeDefined()
  })

  it('reports an undo that did not restore everything', () => {
    // Without the feature the report of an undo is the only feedback there is.
    h.coding.undo = {
      headline: 'Nicht alles wiederhergestellt',
      complete: false,
      restored: ['src/a.ts'],
      skipped: [{ path: 'src/b.ts', reasonText: 'seit dem Anwenden geändert' }]
    }
    render(false)
    expect(container.textContent).toContain('Nicht alles wiederhergestellt')
    expect(container.textContent).toContain('src/b.ts')
  })
})

describe('CodingModePicker with agentic_mode (positive control)', () => {
  it('offers the level choice and the project select', () => {
    render(true)
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBeGreaterThan(0)
    expect(container.querySelector('#coding-project')).not.toBeNull()
  })

  it('offers undo and the export as well', () => {
    render(true)
    expect(buttonWith('Rückgängig machen')).toBeDefined()
    expect(buttonWith('Audit-Protokoll exportieren')).toBeDefined()
  })
})
