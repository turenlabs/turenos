export function focusSessionRequestOption(input: {
  target: HTMLElement | undefined
  root: HTMLElement | undefined
  initial?: boolean
}) {
  if (!input.target) return
  const document = input.target.ownerDocument
  const active = document.activeElement
  // A new request must not take focus from an editor or another control. Explicit
  // navigation inside the request still moves focus to the selected option.
  if (input.initial && active && active !== document.body && !input.root?.contains(active)) return
  input.target.focus()
}
