/**
 * @vitest-environment jsdom
 *
 * What AgentStepIndicator puts in front of the human.
 *
 * C5: this panel renders a tool result's content, the model's thinking and the
 * tool names RAW. A zero-width space, a right-to-left override or a BOM is
 * therefore invisible exactly where the human is trying to judge what the agent
 * read — while the diff dialog has escaped such characters all along. Those
 * fields now go through the SAME `displayText`, and where the sanitizer had
 * something to clean the panel says so in one sentence.
 *
 * Broader than the coding feature on purpose: this panel shows the results of
 * EVERY agent run.
 *
 * Mounted with react-dom directly (no testing library in this project), the
 * pattern tests/unit/coding-mode-picker.test.ts established. Every expected
 * value is written out by hand; none is read back from the component.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const { AgentStepIndicator } = await import('../../src/renderer/components/AgentStepIndicator')

/** Invisible, zero width. Escaped as <U+200B>. */
const ZWSP = '​'
/** Right-to-left override: reorders what follows it on screen. */
const RLO = '‮'

let container: HTMLDivElement
let root: Root

interface StepInput {
  stepNumber: number
  thinking: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolResults: Array<{ toolCallId: string; content: string; isError: boolean; sanitizerCleaned?: true }>
  isFinal: boolean
}

function step(over: Partial<StepInput> = {}): StepInput {
  return {
    stepNumber: 1,
    thinking: 'Let me read that file.',
    toolCalls: [{ id: 'tc-1', name: 'mingly_read_file', arguments: { path: 'a.ts' } }],
    toolResults: [{ toolCallId: 'tc-1', content: 'export const a = 1', isError: false }],
    isFinal: false,
    ...over
  }
}

/** Render the chain and open the one step, which is what shows the detail. */
function renderExpanded(input: StepInput): void {
  act(() => {
    root.render(
      createElement(AgentStepIndicator, {
        steps: [input] as never,
        run: { status: 'completed' } as never,
        isRunning: false
      })
    )
  })
  const toggle = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(String(input.stepNumber))
  )
  expect(toggle).toBeDefined()
  act(() => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function text(): string {
  return container.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AgentStepIndicator: hidden characters are shown, not hidden', () => {
  it('escapes a zero-width space in a tool result', () => {
    renderExpanded(step({ toolResults: [{ toolCallId: 'tc-1', content: `a${ZWSP}b`, isError: false }] }))

    expect(text()).toContain('a<U+200B>b')
    expect(text()).not.toContain(ZWSP)
  })

  it('escapes a direction-changing character in the model thinking', () => {
    renderExpanded(step({ thinking: `patch${RLO}gnp.txt` }))

    expect(text()).toContain('patch<U+202E>gnp.txt')
    expect(text()).not.toContain(RLO)
  })

  it('escapes a tool NAME, which the model also supplies', () => {
    renderExpanded(
      step({ toolCalls: [{ id: 'tc-1', name: `mingly_read${ZWSP}_file`, arguments: { path: 'a.ts' } }] })
    )

    expect(text()).toContain('mingly_read<U+200B>_file')
    expect(text()).not.toContain(ZWSP)
  })

  it('escapes the tool name in the collapsed chain tooltip too', () => {
    act(() => {
      root.render(
        createElement(AgentStepIndicator, {
          steps: [step({ toolCalls: [{ id: 'tc-1', name: `read${ZWSP}file`, arguments: {} }] })] as never,
          run: { status: 'completed' } as never,
          isRunning: false
        })
      )
    })
    const titles = [...container.querySelectorAll('button')].map((b) => b.getAttribute('title') ?? '')
    expect(titles.join('\n')).toContain('read<U+200B>file')
    expect(titles.join('\n')).not.toContain(ZWSP)
  })

  it('false alarm direction: ordinary text and real umlauts are shown unchanged', () => {
    renderExpanded(
      step({
        thinking: 'Ich lese die Datei für die Prüfung.',
        toolResults: [{ toolCallId: 'tc-1', content: 'const grösse = 1', isError: false }]
      })
    )

    expect(text()).toContain('Ich lese die Datei für die Prüfung.')
    expect(text()).toContain('const grösse = 1')
    expect(text()).not.toContain('<U+')
  })
})

describe('AgentStepIndicator: a result the sanitizer would have cleaned says so', () => {
  it('shows one sentence on the flagged result, in CH-German with real umlauts', () => {
    renderExpanded(
      step({
        toolResults: [{ toolCallId: 'tc-1', content: `a${ZWSP}b`, isError: false, sanitizerCleaned: true }]
      })
    )

    // The two halves the sentence has to carry: the provider got it unchanged,
    // and what is shown here has the hidden characters made visible.
    expect(text()).toContain('unverändert')
    expect(text()).toContain('<U+200B>')
    expect(text()).not.toContain('ß')
  })

  it('says nothing when the result was not flagged', () => {
    renderExpanded(step({ toolResults: [{ toolCallId: 'tc-1', content: `a${ZWSP}b`, isError: false }] }))

    // The escape still happens — that is unconditional — but no notice.
    expect(text()).toContain('a<U+200B>b')
    expect(text()).not.toContain('unverändert')
  })
})
