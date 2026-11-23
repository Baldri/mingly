/**
 * @vitest-environment jsdom
 *
 * The focus trap of the two coding dialogs.
 *
 * Both carry a decision with no "later" state and no Escape, so a keyboard
 * user who tabs past the overlay reaches the message input underneath — and a
 * run started from there used to drop an unreviewed package out of the
 * surface without a rejection and without an audit entry.
 *
 * The components themselves are not rendered here (this project has no React
 * testing library); what is pinned is the trap's behaviour, which is where the
 * logic lives.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { focusableIn, trapTab } from '../../src/renderer/lib/focus-trap'

let dialog: HTMLDivElement
let outside: HTMLButtonElement

function tab(shiftKey = false): { prevented: boolean; moved: boolean } {
  let prevented = false
  const moved = trapTab(
    { key: 'Tab', shiftKey, preventDefault: () => (prevented = true) },
    dialog
  )
  return { prevented, moved }
}

beforeEach(() => {
  document.body.innerHTML = `
    <button id="outside">behind the overlay</button>
    <div id="dialog">
      <button id="reject">Ablehnen</button>
      <input id="reason" />
      <button id="accept">Annehmen</button>
    </div>
  `
  dialog = document.getElementById('dialog') as HTMLDivElement
  outside = document.getElementById('outside') as HTMLButtonElement
})

describe('focusableIn', () => {
  it('lists the dialog controls in document order', () => {
    expect(focusableIn(dialog).map((e) => e.id)).toEqual(['reject', 'reason', 'accept'])
  })

  it('leaves out disabled controls and anything taken out of the tab order', () => {
    document.getElementById('reason')?.setAttribute('disabled', '')
    document.getElementById('accept')?.setAttribute('tabindex', '-1')
    expect(focusableIn(dialog).map((e) => e.id)).toEqual(['reject'])
  })
})

describe('trapTab', () => {
  it('wraps from the last control to the first', () => {
    document.getElementById('accept')?.focus()
    const { prevented } = tab()
    expect(prevented).toBe(true)
    expect(document.activeElement?.id).toBe('reject')
  })

  it('wraps backwards from the first control to the last', () => {
    document.getElementById('reject')?.focus()
    const { prevented } = tab(true)
    expect(prevented).toBe(true)
    expect(document.activeElement?.id).toBe('accept')
  })

  it('lets Tab move normally inside the dialog', () => {
    document.getElementById('reject')?.focus()
    const { prevented, moved } = tab()
    expect(prevented).toBe(false)
    expect(moved).toBe(false)
    // The browser does the move; the trap did not interfere.
    expect(document.activeElement?.id).toBe('reject')
  })

  it('pulls focus back in when it sits outside the dialog', () => {
    outside.focus()
    expect(document.activeElement?.id).toBe('outside')
    tab()
    expect(document.activeElement?.id).toBe('reject')
  })

  it('ignores every key but Tab, and a missing container', () => {
    document.getElementById('accept')?.focus()
    let prevented = false
    const event = { key: 'Enter', shiftKey: false, preventDefault: () => (prevented = true) }
    expect(trapTab(event, dialog)).toBe(false)
    expect(prevented).toBe(false)
    expect(trapTab({ key: 'Tab', shiftKey: false, preventDefault: () => undefined }, null)).toBe(false)
    expect(document.activeElement?.id).toBe('accept')
  })

  it('does nothing when the dialog holds nothing focusable', () => {
    dialog.innerHTML = '<p>nothing to focus</p>'
    outside.focus()
    expect(tab().moved).toBe(false)
    expect(document.activeElement?.id).toBe('outside')
  })
})
