/**
 * Keeping Tab inside a dialog that has no way out.
 *
 * The two coding dialogs carry a decision with no "later" state: there is no
 * Escape, because closing them would leave an open question or an unreviewed
 * package behind. That makes containment a correctness question rather than a
 * nicety — a keyboard user who tabs past the overlay reaches the message input
 * underneath, and a run started from there used to drop the package out of the
 * surface without a rejection and without an audit entry.
 *
 * Deliberately small: no library, no focus-visible bookkeeping, no restore of
 * the previously focused element (both dialogs are opened by the main process,
 * not by a click, so there is nothing meaningful to restore to).
 */

/**
 * Elements inside `container` that Tab can reach, in document order.
 *
 * `disabled` controls are left out (both dialogs disable their buttons while a
 * decision is in flight) and so is anything explicitly removed from the tab
 * order.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]'
].join(',')

export function focusableIn(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getAttribute('tabindex') !== '-1'
  )
}

/** The minimum of a keyboard event this needs; keeps the helper testable. */
export interface TabEvent {
  key: string
  shiftKey: boolean
  preventDefault(): void
}

/**
 * Cycle Tab and Shift+Tab inside `container`.
 *
 * Returns true when the focus was moved, so a caller can tell. Focus that is
 * already outside the container is pulled back in, which is what happens when
 * the browser put it on the document body.
 */
export function trapTab(event: TabEvent, container: Element | null): boolean {
  if (event.key !== 'Tab' || !container) return false
  const focusable = focusableIn(container)
  if (focusable.length === 0) return false
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = container.ownerDocument?.activeElement ?? null
  const inside = active !== null && container.contains(active)

  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault()
      last.focus()
      return true
    }
    return false
  }
  if (!inside || active === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
