// Headless coverage for the Wave 2 shell seam: terminal focus requests are
// broadcast from context/terminal.tsx (module-level channel, since terminal
// workspaces live inside per-route TerminalProvider instances) and the nav
// rail subscribes to auto-collapse the Agents panel. The wiring in
// components/nav-rail.tsx is a thin composition of this channel with the pure
// state machine in components/nav-rail-state.ts, so testing both together
// here covers the behavior without a DOM.

import { beforeAll, describe, expect, mock, test } from "bun:test"
import {
  collapseForTerminalFocus,
  releasePanelPin,
  togglePanelWithPin,
  type PanelState,
} from "@/components/nav-rail-state"

let onTerminalFocusRequest: typeof import("./terminal").onTerminalFocusRequest
let notifyTerminalFocusRequest: typeof import("./terminal").notifyTerminalFocusRequest

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@turenlabs/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  onTerminalFocusRequest = mod.onTerminalFocusRequest
  notifyTerminalFocusRequest = mod.notifyTerminalFocusRequest
})

describe("terminal focus request channel", () => {
  test("delivers a notification to every subscriber", () => {
    let first = 0
    let second = 0
    const offFirst = onTerminalFocusRequest(() => first++)
    const offSecond = onTerminalFocusRequest(() => second++)
    notifyTerminalFocusRequest()
    expect(first).toBe(1)
    expect(second).toBe(1)
    offFirst()
    offSecond()
  })

  test("unsubscribing stops delivery", () => {
    let calls = 0
    const off = onTerminalFocusRequest(() => calls++)
    notifyTerminalFocusRequest()
    off()
    notifyTerminalFocusRequest()
    expect(calls).toBe(1)
  })

  test("a throwing listener does not break the others", () => {
    let calls = 0
    const offBad = onTerminalFocusRequest(() => {
      throw new Error("listener exploded")
    })
    const offGood = onTerminalFocusRequest(() => calls++)
    expect(() => notifyTerminalFocusRequest()).not.toThrow()
    expect(calls).toBe(1)
    offBad()
    offGood()
  })
})

describe("focus → collapse subscription (nav-rail wiring, headless)", () => {
  // Mirrors components/nav-rail.tsx: a subscriber that applies
  // collapseForTerminalFocus to the persisted panel state, counting writes.
  function bindShell(initial: PanelState) {
    let state = initial
    let writes = 0
    const off = onTerminalFocusRequest(() => {
      const next = collapseForTerminalFocus(state)
      if (!next) return
      writes++
      state = { ...state, collapsed: next }
    })
    return {
      off,
      state: () => state,
      writes: () => writes,
      expand: (terminalFocusHeld: boolean) => {
        state = togglePanelWithPin(state, "agents", terminalFocusHeld)
      },
      focusLeft: () => {
        state = { ...state, pinned: releasePanelPin(state.pinned, "agents") }
      },
    }
  }

  test("a terminal focus request collapses the panel exactly once per transition", () => {
    const shell = bindShell({ collapsed: { agents: false }, pinned: { agents: false } })
    notifyTerminalFocusRequest()
    expect(shell.state().collapsed.agents).toBe(true)
    // Repeated focus requests inside the same transition do not rewrite state.
    notifyTerminalFocusRequest()
    notifyTerminalFocusRequest()
    expect(shell.writes()).toBe(1)
    shell.off()
  })

  test("manual expand during a focused terminal pins; later requests never fight the user", () => {
    const shell = bindShell({ collapsed: { agents: false }, pinned: { agents: false } })
    notifyTerminalFocusRequest()
    expect(shell.state().collapsed.agents).toBe(true)

    // User expands (rail click / mod+\) while the terminal still holds focus.
    shell.expand(true)
    expect(shell.state().collapsed.agents).toBe(false)
    expect(shell.state().pinned.agents).toBe(true)

    // Further focus requests must not re-collapse.
    notifyTerminalFocusRequest()
    notifyTerminalFocusRequest()
    expect(shell.state().collapsed.agents).toBe(false)
    expect(shell.writes()).toBe(1)

    // Focus leaves the terminal → the pin is released → the next focus
    // transition collapses again.
    shell.focusLeft()
    notifyTerminalFocusRequest()
    expect(shell.state().collapsed.agents).toBe(true)
    expect(shell.writes()).toBe(2)
    shell.off()
  })

  test("manual expand without terminal focus stays collapsible on the next transition", () => {
    const shell = bindShell({ collapsed: { agents: true }, pinned: { agents: false } })
    shell.expand(false)
    expect(shell.state().pinned.agents).toBe(false)
    notifyTerminalFocusRequest()
    expect(shell.state().collapsed.agents).toBe(true)
    shell.off()
  })
})
