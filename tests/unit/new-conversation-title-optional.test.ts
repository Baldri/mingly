/**
 * @vitest-environment jsdom
 *
 * Starting a conversation must not require typing a title first.
 *
 * `NewConversationModal` disabled Create on `!title.trim()` and `handleCreate`
 * returned early on the same condition, so an empty title blocked the only way
 * forward. Holger reported it from the acceptance run: "lieber einfach starten
 * und dann den Namen bei Bedarf ändern". The title is a label, not a
 * precondition — the app already names conversations `New Conversation` on the
 * API path (src/main/server/mingly-api-server.ts).
 *
 * The title is read off the IPC call rather than off the store, because what
 * matters is the name the conversation ends up with, not that some function was
 * reached. `'New Conversation'` is written out by hand here, never imported
 * from the component: a shared constant would make this test agree with
 * whatever the code does.
 *
 * Three cases, because "the button is enabled" alone would not distinguish
 * them: an empty title must be allowed, a typed title must still win, and a
 * MISSING API KEY must still disable the button. The last one is the false
 * alarm check — removing the title condition must not remove the other one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const { NewConversationModal } = await import(
  '../../src/renderer/components/NewConversationModal'
)
const { useSettingsStore } = await import('../../src/renderer/stores/settings-store')
const { useTemplateStore } = await import('../../src/renderer/stores/template-store')

/** Written out by hand — not imported from the component under test. */
const EXPECTED_DEFAULT_TITLE = 'New Conversation'

/** Titles handed to the conversations IPC channel, in order. */
let createdTitles: string[] = []

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createdTitles = []
  useSettingsStore.setState({ apiKeysConfigured: { anthropic: true } })
  useTemplateStore.setState({ templates: [] })
  // The four surfaces the modal and its stores actually reach for, read off
  // the source rather than guessed: a stub with invented names makes the test
  // red before the defect is reached, which looks exactly like a finding.
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    conversations: {
      create: async (title: string) => {
        createdTitles.push(title)
        return { success: true, conversation: { id: 'c1', title } }
      },
      list: async () => ({ success: true, conversations: [] })
    },
    ragWissen: { listProjects: async () => ({ success: true, projects: [] }) },
    localLLM: { discover: async () => ({ success: true, models: [] }) },
    templates: { list: async () => ({ success: true, templates: [] }) }
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

function mount(): void {
  act(() => {
    root.render(createElement(NewConversationModal, { isOpen: true, onClose: () => undefined }))
  })
}

/** The Create button, found by its label rather than by position. */
function createButton(): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'))
  const button = buttons.find((b) => b.textContent?.trim() === 'Create')
  if (!button) throw new Error('no Create button rendered')
  return button as HTMLButtonElement
}

function typeTitle(value: string): void {
  const input = container.querySelector('input[type="text"]') as HTMLInputElement
  if (!input) throw new Error('no title input rendered')
  act(() => {
    // React tracks the value on the DOM node, so setting .value alone is not
    // seen; the native setter plus a bubbling input event is what it listens to.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('NewConversationModal: the title is optional', () => {
  it('lets an empty title through and names the conversation itself', async () => {
    mount()
    await act(async () => {
      await Promise.resolve()
    })

    const button = createButton()
    expect(button.disabled, 'Create is disabled with an empty title').toBe(false)

    await act(async () => {
      button.click()
      await Promise.resolve()
    })

    expect(createdTitles).toEqual([EXPECTED_DEFAULT_TITLE])
  })

  it('POSITIVE CONTROL: a typed title is still the one that is used', async () => {
    mount()
    await act(async () => {
      await Promise.resolve()
    })

    typeTitle('Code Review Help')
    await act(async () => {
      createButton().click()
      await Promise.resolve()
    })

    // Without this, a fix that always writes the default would pass the test
    // above and silently throw the user's own title away.
    expect(createdTitles).toEqual(['Code Review Help'])
  })

  it('FALSE ALARM CHECK: a missing API key still disables Create', async () => {
    useSettingsStore.setState({ apiKeysConfigured: {} })
    mount()
    await act(async () => {
      await Promise.resolve()
    })

    // The other half of the original condition must survive: dropping the
    // title requirement must not let a conversation start with no key.
    expect(createButton().disabled).toBe(true)
  })
})
