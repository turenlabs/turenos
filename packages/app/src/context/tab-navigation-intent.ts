import { createSignal } from "solid-js"

export type TabNavigationIntent = {
  readonly generation: number
  readonly destinationKey: string
}

export function resolveCurrentTab<T>(input: {
  routing: boolean
  pending: T | undefined
  committed: T | undefined
}) {
  if (input.pending && (input.routing || !input.committed)) return input.pending
  return input.committed
}

export function createTabNavigationIntent() {
  const [current, setCurrent] = createSignal<TabNavigationIntent>()
  let generation = 0

  return {
    current,
    request(destinationKey: string) {
      const next = { generation: ++generation, destinationKey }
      setCurrent(next)
      return next
    },
  }
}
