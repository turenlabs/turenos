export const color = {
  bg: "#10151c",
  panel: "#18222e",
  text: "#f2f5f7",
  muted: "#b0bdca",
  // Keyboard focus, links and interactive labels. Amber and yellow are kept for attention.
  accent: "#7cc8f8",
  border: "#8092a5",
  selected: "#31465a",
  warning: "#f5d76d",
  error: "#ff9d97",
  added: "#8fe0a4",
  // Darker than `error` so removed lines stay apart from added ones under red-green colour blindness.
  removed: "#f47067",
}

export const layout = {
  sidebarWidth: 32,
  sidebarMinWidth: 24,
  narrowBreakpoint: 90,
  minWidth: 58,
  /** Below this many columns the top bar drops its buttons and names a local server by its port. */
  compactBreakpoint: 70,
  /** From this many columns the editor shows its tips and the full context meter. */
  wideBreakpoint: 100,
  minHeight: 24,
}
