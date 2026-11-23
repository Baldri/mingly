/**
 * @vitest-environment jsdom
 *
 * MessageList must call the same hooks on every render.
 *
 * Measured on 2026-11-23 in the packed app: sending the first message in an
 * empty conversation crashed the whole renderer with React #310 ("Rendered
 * more hooks than during the previous render"), and returning to an empty one
 * gave #300 ("Rendered fewer hooks than expected"). Two messages, one defect.
 *
 * The cause: three `useAgentStore` calls sat BELOW the early return for the
 * empty state. Five hooks while the list is empty, eight once a message
 * arrives. React matches hooks by position, so the count must not depend on
 * the data.
 *
 * This file uses the REAL stores on purpose. A first attempt mocked them, and
 * the mock removed the very property under test twice over: a plain function
 * standing in for `useAgentStore` is not a hook, so no count could change —
 * and `MessageList` is `memo()` without props, so without a real subscription
 * React skips the second render entirely. The test was red, for reasons that
 * had nothing to do with the defect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Message } from '../../src/shared/types'

// react-virtuoso windows its children by measuring the DOM, which jsdom does
// not do. The list rendering is not under test here; the hook order is.
// `window` is NOT stubbed: replacing it wholesale breaks react-dom in jsdom.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data }: { data: unknown[] }) =>
    createElement('div', { 'data-testid': 'virtuoso' }, String(data.length))
}))

const { MessageList } = await import('../../src/renderer/components/MessageList')
const { useChatStore } = await import('../../src/renderer/stores/chat-store')

const MESSAGE = { id: 'm1', role: 'assistant', content: 'hallo' } as unknown as Message

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useChatStore.setState({ messages: [], isStreaming: false, streamingContent: '' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

/** Mount fresh inside the test, never in beforeEach: React objects to a render
 *  that is already in progress when the next act() opens. */
function mount(): void {
  act(() => { root.render(createElement(MessageList)) })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useChatStore.setState({ messages: [], isStreaming: false, streamingContent: '' })
})

describe('MessageList keeps its hook count', () => {
  it('survives the first message arriving in an empty conversation', () => {
    mount()
    expect(container.textContent).toContain('Start a conversation')

    // The real subscription re-renders the component in place — which is
    // exactly the step the defect lives in.
    act(() => { useChatStore.setState({ messages: [MESSAGE] }) })

    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull()
  })

  it('survives going back to an empty conversation', () => {
    mount()
    act(() => { useChatStore.setState({ messages: [MESSAGE] }) })
    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull()

    act(() => { useChatStore.setState({ messages: [] }) })

    expect(container.textContent).toContain('Start a conversation')
  })

  it('survives a stream starting while no message is stored yet', () => {
    mount()
    act(() => {
      useChatStore.setState({ isStreaming: true, streamingContent: 'teilweise' })
    })
    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull()
  })
})

/**
 * The empty-state placeholder must not swallow a running agent.
 *
 * A coding run stores no message. It reports through the step indicator in the
 * list footer, and through the diff dialog when it proposes edits. A run that
 * only executes a command proposes nothing and answers in prose — so while the
 * early return fired on message count alone, such a run had no surface at all.
 * Measured on 2026-11-23: four model calls in the audit log, "Start a
 * conversation" on screen, twice in a row.
 */
describe('MessageList shows a running agent even with no stored messages', () => {
  it('replaces the placeholder once the agent is running', async () => {
    const { useAgentStore } = await import('../../src/renderer/stores/agent-store')
    mount()
    expect(container.textContent).toContain('Start a conversation')

    act(() => { useAgentStore.setState({ isRunning: true }) })

    expect(container.textContent).not.toContain('Start a conversation')
    useAgentStore.setState({ isRunning: false, currentSteps: [] })
  })

  it('keeps the placeholder when nothing is happening', () => {
    // Positive control: without it the assertion above would also pass if the
    // placeholder had simply been deleted.
    mount()
    expect(container.textContent).toContain('Start a conversation')
  })
})
