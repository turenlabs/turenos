import { createContext, createMemo, useContext, type Accessor } from "solid-js"

export const SessionPanelRenderContext = createContext<Accessor<boolean>>(() => false)

export function useSessionPanelRender() {
  return useContext(SessionPanelRenderContext)
}

export function createSessionPanelRenderHold<T>(
  deferRender: Accessor<boolean>,
  read: Accessor<T>,
  initial: T,
) {
  // Read the gate first. While it is closed, Solid drops every dependency captured
  // by read(), so destination data cannot reconcile the retained panel subtree.
  return createMemo<T>((current) => (deferRender() ? current : read()), initial)
}
