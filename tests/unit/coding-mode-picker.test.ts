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

/**
 * Click the one control that opens and closes the level choice. Its label
 * changes with the state ("Ändern" when closed, "Fertig" when open), so the
 * helper looks for either — a test that only knew one of them would stop
 * working the moment it succeeded.
 */
function toggleLevels(): void {
  const toggle = buttonWith('Ändern') ?? buttonWith('Fertig')
  if (!toggle) throw new Error('no expand/collapse button found')
  act(() => {
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Open the level choice the way a user does. */
function expand(): void {
  toggleLevels()
}

describe('CodingModePicker with agentic_mode (positive control)', () => {
  it('offers the level choice and the project select once expanded', () => {
    render(true)
    expand()
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBeGreaterThan(0)
    expect(container.querySelector('#coding-project')).not.toBeNull()
  })

  it('offers undo and the export as well', () => {
    render(true)
    expect(buttonWith('Rückgängig machen')).toBeDefined()
    expand()
    expect(buttonWith('Audit-Protokoll exportieren')).toBeDefined()
  })
})

/**
 * The block sits ABOVE the message input. Expanded it is four levels of three
 * lines each, and on an ordinary window that pushed the text field off the
 * bottom of the screen — the user could not type at all. A control for an
 * occasional decision must not cost the surface the app exists for.
 */
describe('CodingModePicker takes no room it does not need', () => {
  it('shows no level choice until asked', () => {
    render(true)
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBe(0)
    expect(container.querySelector('#coding-project')).toBeNull()
  })

  it('names the current level while collapsed', () => {
    render(true)
    const summary = container.querySelector('[data-testid="coding-mode-summary"]')
    expect(summary?.textContent).toBe('Vorschlagen')
  })

  it('marks the raised level while collapsed, so nobody has to open it to find out', () => {
    h.coding.modes = { d1: 'propose-run' }
    render(true)
    const summary = container.querySelector('[data-testid="coding-mode-summary"]')
    expect(summary?.textContent).toBe('Vorschlagen und ausführen')
    expect(summary?.className).toContain('amber')
  })

  it('keeps undo reachable while collapsed — a state that needs an answer must not hide', () => {
    render(true)
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBe(0)
    expect(buttonWith('Rückgängig machen')).toBeDefined()
  })

  it('still shows the C1 disclosure at the moment of choosing', () => {
    render(true)
    expand()
    // Hand-written from the requirement, not read back from the component.
    expect(container.textContent).toContain('ohne Diff und ohne Ihre Zustimmung')
  })

  it('collapses again on a second click', () => {
    render(true)
    toggleLevels()
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBeGreaterThan(0)
    toggleLevels()
    expect(container.querySelectorAll('input[name="coding-mode"]').length).toBe(0)
  })
})

/**
 * When the store cannot restore a selection by itself — two graded projects,
 * say — the surface must say so. The silent fallback to a plain chat was the
 * defect that cost a whole acceptance run: a stored level, no selection, and
 * a model answering that it had no file access.
 */
describe('CodingModePicker says when the coding tools are off despite a graded project', () => {
  it('warns when a project is graded but none is selected', () => {
    h.coding.selectedDirectoryId = null
    h.coding.modes = { d1: 'propose' }
    render(true)
    const warning = container.querySelector('[data-testid="coding-off-despite-grades"]')
    expect(warning?.textContent).toBe('Kein Projekt gewählt – Coding-Werkzeuge aus')
  })

  it('stays quiet when a project is selected', () => {
    render(true)
    expect(container.querySelector('[data-testid="coding-off-despite-grades"]')).toBeNull()
  })

  it('stays quiet when nothing is graded — that is an ordinary chat, not a warning', () => {
    h.coding.selectedDirectoryId = null
    h.coding.modes = { d1: 'off' }
    render(true)
    expect(container.querySelector('[data-testid="coding-off-despite-grades"]')).toBeNull()
  })
})
